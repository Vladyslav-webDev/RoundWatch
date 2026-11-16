import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  CHAIN_ID, filterFor, logsByHeight, normalizeHeader, normalizeWatch, requireEvidence, sameHeader, Unresolved,
  verifyLogs,
} from './evidence.ts';
import type { EvidenceIds, FixtureEvidence, Header, RangeFixtureEvidence, WatchInput } from './evidence.ts';

export const MAX_RANGE_BLOCKS = 16;
type Outcome = 'unresolved' | 'matched' | 'ambiguous' | 'expired';
type ReadKind = 'chain_id' | 'finalized' | 'header' | 'logs' | 'range_logs' | 'receipts';
type FaultPoint = 'before_arm_commit' | 'before_coverage_commit' | 'after_coverage_commit';
type VerifiedLogs = ReturnType<typeof verifyLogs>;
type Scan = { fixtures: FixtureEvidence } | { fixtures: RangeFixtureEvidence; maxBlocks: number };

interface BlockCoverage {
  block: Header;
  basis: 'deadline' | 'verified_logs' | 'excluded_by_boundary';
  verified?: VerifiedLogs;
}

interface WatchRow {
  spec: string;
  evidence_ids: string;
  cursor: string;
  finalized_heads: string | null;
  status: Outcome;
  reason: string | null;
  cutoff: string | null;
  work_used: number;
}

export class Observer {
  private readonly db: DatabaseSync;
  private readonly fault?: (point: FaultPoint) => void;

  constructor(filename: string, fault?: (point: FaultPoint) => void) {
    this.fault = fault;
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS watches (
        id TEXT PRIMARY KEY, spec TEXT NOT NULL,
        sender TEXT NOT NULL, recipient TEXT NOT NULL, amount TEXT NOT NULL,
        opens INTEGER NOT NULL, deadline INTEGER NOT NULL, evidence_ids TEXT NOT NULL,
        cursor TEXT NOT NULL, finalized_heads TEXT,
        status TEXT NOT NULL CHECK (status IN ('unresolved', 'matched', 'ambiguous', 'expired')),
        reason TEXT, cutoff TEXT, work_used INTEGER NOT NULL DEFAULT 0, work_limit INTEGER NOT NULL,
        CHECK (work_used BETWEEN 0 AND work_limit)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS coverage (
        watch_id TEXT NOT NULL REFERENCES watches(id), height INTEGER NOT NULL,
        header TEXT NOT NULL, finalized_heads TEXT NOT NULL, evidence_ids TEXT NOT NULL,
        filter TEXT NOT NULL, basis TEXT NOT NULL, filter_log_count INTEGER, filter_log_digest TEXT, receipt_count INTEGER,
        PRIMARY KEY (watch_id, height)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS occurrences (
        chain_id INTEGER NOT NULL, block_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
        watch_id TEXT NOT NULL, height INTEGER NOT NULL, evidence TEXT NOT NULL,
        PRIMARY KEY (chain_id, block_hash, log_index),
        FOREIGN KEY (watch_id, height) REFERENCES coverage(watch_id, height)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS watch_occurrences ON occurrences(watch_id, height, log_index);
      CREATE TABLE IF NOT EXISTS work (
        watch_id TEXT NOT NULL REFERENCES watches(id), seq INTEGER NOT NULL,
        source TEXT NOT NULL, kind TEXT NOT NULL, target TEXT,
        PRIMARY KEY (watch_id, seq)
      ) STRICT;
    `);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(write: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = write();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  arm(input: WatchInput, evidenceIds: EvidenceIds): Readonly<WatchInput> {
    const watch = normalizeWatch(input);
    const ids = evidenceKey(evidenceIds);
    const spec = JSON.stringify(watch);
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT spec, evidence_ids FROM watches WHERE id = ?').get(watch.id);
      if (prior) {
        requireEvidence(prior.spec === spec && prior.evidence_ids === ids, 'immutable_watch');
        return watch;
      }
      // The fixed chain and token are implicit in the reservation. Keep it even after resolution.
      const overlap = this.db.prepare(`
        SELECT 1 FROM watches WHERE sender = ? AND recipient = ? AND amount = ? AND opens < ? AND deadline > ?
      `).get(watch.sender, watch.recipient, watch.amountAtomic, watch.deadlineSec, watch.opensAtSec);
      requireEvidence(!overlap, 'overlapping_reservation');
      this.db.prepare(`
        INSERT INTO watches (id, spec, sender, recipient, amount, opens, deadline, evidence_ids,
          cursor, status, reason, work_limit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', 'awaiting_evidence', ?)
      `).run(watch.id, spec, watch.sender, watch.recipient, watch.amountAtomic, watch.opensAtSec,
        watch.deadlineSec, ids, JSON.stringify(watch.finalizedAtArm), watch.workLimit);
      this.fault?.('before_arm_commit');
      return watch;
    });
  }

  private row(id: string): WatchRow {
    const row = this.db.prepare('SELECT * FROM watches WHERE id = ?').get(id);
    if (!row) throw new Error(`Unknown watch ${id}`);
    return row as unknown as WatchRow;
  }

  status(id: string) {
    const row = this.row(id);
    const watch = normalizeWatch(JSON.parse(row.spec));
    return {
      watch,
      outcome: row.status,
      reason: row.reason,
      cursor: JSON.parse(row.cursor) as Header,
      cutoff: row.cutoff ? JSON.parse(row.cutoff) as Header : null,
      finalizedHeads: row.finalized_heads ? JSON.parse(row.finalized_heads) as [Header, Header] : null,
      coverageBlocks: this.db.prepare('SELECT count(*) AS count FROM coverage WHERE watch_id = ?').get(id)!.count,
      occurrences: this.db.prepare(`
        SELECT evidence FROM occurrences WHERE watch_id = ? ORDER BY height, log_index
      `).all(id).map(({ evidence }) => JSON.parse(evidence as string) as VerifiedLogs['candidates'][number]),
      work: {
        used: row.work_used,
        limit: watch.workLimit,
        byRead: this.db.prepare(`
          SELECT source, kind, count(*) AS attempts FROM work WHERE watch_id = ? GROUP BY source, kind ORDER BY source, kind
        `).all(id),
      },
    };
  }

  // Charge before the fixture read. A retry or a crash after charging consumes a fresh unit on replay.
  private read<T>(id: string, source: string, kind: ReadKind, target: string | null, read: () => T): T {
    this.transaction(() => {
      const charged = this.db.prepare(`
        UPDATE watches SET work_used = work_used + 1 WHERE id = ? AND status = 'unresolved' AND work_used < work_limit
        RETURNING work_used
      `).get(id);
      requireEvidence(charged, 'work_budget_exhausted');
      this.db.prepare('INSERT INTO work VALUES (?, ?, ?, ?, ?)').run(id, charged.work_used, source, kind, target);
    });
    try {
      return read();
    } catch {
      throw new Unresolved(`${kind}_unavailable`);
    }
  }

  private stall(id: string, reason: string) {
    this.db.prepare("UPDATE watches SET reason = ? WHERE id = ? AND status = 'unresolved'").run(reason, id);
    return this.status(id);
  }

  // CP1 keeps its single-height entry point and evidence contract.
  step(id: string, fixtures: FixtureEvidence): ReturnType<Observer['status']> {
    return this.scan(id, { fixtures });
  }

  stepRange(id: string, fixtures: RangeFixtureEvidence, maxBlocks = MAX_RANGE_BLOCKS): ReturnType<Observer['status']> {
    requireEvidence(Number.isInteger(maxBlocks) && maxBlocks >= 1 && maxBlocks <= MAX_RANGE_BLOCKS,
      'invalid_range_limit');
    return this.scan(id, { fixtures, maxBlocks });
  }

  // A retry starts at the durable cursor. Every block in the proposed range commits together.
  private scan(id: string, scan: Scan): ReturnType<Observer['status']> {
    const row = this.row(id);
    if (row.status !== 'unresolved') return this.status(id);
    const watch = normalizeWatch(JSON.parse(row.spec));
    const cursor = JSON.parse(row.cursor) as Header;
    const priorHeads = row.finalized_heads ? JSON.parse(row.finalized_heads) as [Header, Header] : null;
    const { views, oracle } = scan.fixtures;
    const ids: EvidenceIds = [views[0].id, views[1].id, oracle.id];

    try {
      requireEvidence(evidenceKey(ids) === row.evidence_ids, 'evidence_sources_changed');
      for (const source of [...views, oracle]) {
        requireEvidence(this.read(id, source.id, 'chain_id', null, () => source.chainId()) === CHAIN_ID, 'wrong_chain');
      }

      const heads = views.map((view) => {
        const header = this.read(id, view.id, 'finalized', null, () => view.finalized());
        requireEvidence(header, 'awaiting_finality');
        return normalizeHeader(header);
      });
      const headers = new Map<string, Header>();
      const headerAt = (source: string, height: number, fetch: () => Header | undefined) => {
        const key = `${source}:${height}`;
        const existing = headers.get(key);
        if (existing) return existing;
        const raw = this.read(id, source, 'header', String(height), fetch);
        requireEvidence(raw, 'missing_finalized_header');
        const header = normalizeHeader(raw);
        requireEvidence(header.height === height, 'invalid_header');
        headers.set(key, header);
        return header;
      };
      const oracleHeader = (height: number) => headerAt(oracle.id, height, () => oracle.finalizedHeader(height));
      const checkAt = (height: number) => {
        const canonical = oracleHeader(height);
        for (const view of views) {
          requireEvidence(sameHeader(headerAt(view.id, height, () => view.header(height)), canonical),
            'finalized_header_disagreement');
        }
        return canonical;
      };
      const commonHeight = Math.min(...heads.map((head) => head.height));
      for (const [index, head] of heads.entries()) {
        const previous = priorHeads?.[index];
        const view = views[index];
        requireEvidence(head.height >= cursor.height && (!previous || head.height >= previous.height), 'finality_regressed');
        for (const checkpoint of previous ? [previous, head] : [head]) {
          const numbered = headerAt(view.id, checkpoint.height, () => view.header(checkpoint.height));
          requireEvidence(sameHeader(numbered, checkpoint) && sameHeader(oracleHeader(checkpoint.height), checkpoint),
            'finality_conflict');
        }
      }
      requireEvidence(sameHeader(checkAt(cursor.height), cursor), 'finality_conflict');
      const commonHead = checkAt(commonHeight);
      const finality = JSON.stringify(heads);
      // Retain valid finality checkpoints even when log or receipt evidence later stalls this step.
      const accepted = this.db.prepare(`
        UPDATE watches SET finalized_heads = ?
        WHERE id = ? AND status = 'unresolved' AND cursor = ? AND finalized_heads IS ?
      `).run(finality, id, row.cursor, row.finalized_heads);
      requireEvidence(accepted.changes === 1, 'stale_step');
      requireEvidence(commonHeight > cursor.height, 'awaiting_finality');

      const filter = filterFor(watch);
      const count = Math.min(commonHeight - cursor.height, 'maxBlocks' in scan ? scan.maxBlocks : 1);
      const coverage: BlockCoverage[] = [];
      let last = cursor;
      for (let offset = 1; offset <= count; offset++) {
        const block = checkAt(cursor.height + offset);
        requireEvidence(block.parentHash === last.hash && block.timestamp >= last.timestamp &&
          block.timestamp <= commonHead.timestamp, 'non_contiguous_chain');
        const isCutoff = block.timestamp >= watch.deadlineSec;
        const eligible = block.height > watch.latestAtArm.height && block.timestamp >= watch.opensAtSec && !isCutoff;
        coverage.push({ block, basis: isCutoff ? 'deadline' : eligible ? 'verified_logs' : 'excluded_by_boundary' });
        last = block;
        if (isCutoff) break;
      }

      const eligible = coverage.filter(({ basis }) => basis === 'verified_logs');
      const verify = (entry: BlockCoverage, responses: Parameters<typeof verifyLogs>[3]) => {
        const receipts = this.read(id, oracle.id, 'receipts', entry.block.hash, () => oracle.receipts(entry.block.hash));
        entry.verified = verifyLogs(entry.block, filter, watch.amountAtomic, responses, receipts);
      };
      if (eligible.length > 0 && 'maxBlocks' in scan) {
        const from = eligible[0].block.height;
        const to = eligible[eligible.length - 1].block.height;
        const responses = scan.fixtures.views.map((view) => this.read(id, view.id, 'range_logs', `${from}:${to}`,
          () => view.logsRange(from, to, filter)));
        const left = logsByHeight(responses[0], from, to);
        const right = logsByHeight(responses[1], from, to);
        for (const entry of eligible) verify(entry, [left.get(entry.block.height) ?? [], right.get(entry.block.height) ?? []]);
      } else if (eligible.length > 0) {
        const entry = eligible[0];
        const responses = views.map((view) => this.read(id, view.id, 'logs', String(entry.block.height),
          () => view.logs(entry.block.height, filter)));
        verify(entry, [responses[0], responses[1]]);
      }

      const isCutoff = coverage[coverage.length - 1].basis === 'deadline';
      const nextCursor = JSON.stringify(last);
      this.transaction(() => {
        const current = this.row(id);
        requireEvidence(current.status === 'unresolved' && current.cursor === row.cursor &&
          current.finalized_heads === finality, 'stale_step');
        const insertCoverage = this.db.prepare('INSERT INTO coverage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        const insertOccurrence = this.db.prepare('INSERT INTO occurrences VALUES (?, ?, ?, ?, ?, ?)');
        for (const { block, basis, verified } of coverage) {
          const digest = verified ? createHash('sha256').update(JSON.stringify(verified.logs)).digest('hex') : null;
          insertCoverage.run(
            id, block.height, JSON.stringify(block), finality, row.evidence_ids, JSON.stringify(filter), basis,
            verified?.logs.length ?? null, digest, verified?.receiptCount ?? null,
          );
          for (const candidate of verified?.candidates ?? []) {
            insertOccurrence.run(CHAIN_ID, block.hash, candidate.log.logIndex, id, block.height, JSON.stringify(candidate));
          }
        }
        let status: Outcome = 'unresolved';
        if (isCutoff) {
          const count = this.db.prepare('SELECT count(*) AS count FROM occurrences WHERE watch_id = ?').get(id)!.count;
          status = count === 0 ? 'expired' : count === 1 ? 'matched' : 'ambiguous';
        }
        this.db.prepare(`
          UPDATE watches SET cursor = ?, status = ?, reason = ?, cutoff = ?
          WHERE id = ?
        `).run(nextCursor, status, isCutoff ? null : 'awaiting_coverage', isCutoff ? nextCursor : null, id);
        this.fault?.('before_coverage_commit');
      });
      this.fault?.('after_coverage_commit');
      return this.status(id);
    } catch (error) {
      if (error instanceof Unresolved) return this.stall(id, error.message);
      // Surface storage and crash failures. SQLite remains the authority for the last durable state.
      throw error;
    }
  }
}

function evidenceKey(ids: EvidenceIds): string {
  requireEvidence(ids.length === 3 && new Set(ids).size === 3 &&
    ids.every((id) => typeof id === 'string' && /^[a-z0-9_-]{1,32}$/i.test(id)), 'invalid_evidence_sources');
  return JSON.stringify(ids);
}
