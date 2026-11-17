import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  addressTopic, CHAIN_ID, normalizeHeader, normalizeTransferTuple, requireEvidence, sameHeader, TRANSFER, USDC,
} from './evidence.ts';
import type { Header, Log, Receipt } from './evidence.ts';
import { configureObserverDatabase, writeObserverTransaction } from './sqlite.ts';

export const MAX_LIVE_RANGE_BLOCKS = 3;
const MAX_WORK_LIMIT = 64;
const MAX_CANDIDATES = MAX_LIVE_RANGE_BLOCKS * 256;
const DATABASE_PREFIX = 'roundwatch-base-sepolia-cp2b-';
const DATABASE_FILENAME = 'observations.sqlite';
const MARKER_FILENAME = 'cp2b.marker';
const APPLICATION_ID = 0x43503242;
const APPLICATION_ID_OFFSET = 68;
const SQLITE_MAGIC = 'SQLite format 3\0';
const INITIALIZE = Symbol('initialize_live_database');
const PROVIDER_ID = /^[a-z0-9_-]{1,64}$/i;
const REASON = /^[a-z0-9_]{1,96}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const HASH = /^0x[a-f0-9]{64}$/;

type ProviderIds = readonly [string, string];
type FaultPoint = 'before_observation_commit' | 'after_observation_commit';
type Fault = (point: FaultPoint) => void;
type ReadKind = 'eth_chainId' | 'eth_getBlockByNumber' | 'eth_getLogs' | 'eth_getTransactionReceipt';
type DatabaseHandle = Readonly<{ kind: 'base-sepolia-cp2b'; token: string }>;

export interface LiveDiagnostic {
  readonly source?: string;
  readonly stage?: string;
}

export interface LiveWatchTuple {
  readonly sender: string;
  readonly recipient: string;
  readonly amountAtomic: string;
  readonly opensAtSec: number;
  readonly deadlineSec: number;
}

export interface LivePlan {
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly finalizedHeads: readonly [Header, Header];
}

export interface LiveCandidate {
  readonly log: Log;
  readonly receipt: Omit<Receipt, 'logs'>;
}

export interface LiveSourceEvidence {
  readonly id: string;
  readonly rangeLogDigest: string;
  readonly singleLogDigest: string;
  readonly receiptDigests: readonly { readonly transactionHash: string; readonly digest: string }[];
}

export interface LiveObservation {
  readonly predecessor: Header;
  readonly blocks: readonly Header[];
  readonly watch: LiveWatchTuple | null;
  readonly candidates: readonly LiveCandidate[];
  readonly sources: readonly [LiveSourceEvidence, LiveSourceEvidence];
}

interface RunRow {
  provider_ids: string;
  requested_watch: string | null;
  watch: string | null;
  plan: string | null;
  observation: string | null;
  reason: string;
  diagnostic: string | null;
  work_used: number;
  work_limit: number;
}

function databaseDirectory(database: DatabaseHandle): string {
  requireEvidence(database?.kind === 'base-sepolia-cp2b' && typeof database.token === 'string' &&
    /^[a-f0-9]{32}$/.test(database.token), 'invalid_live_database');
  return join(tmpdir(), DATABASE_PREFIX + database.token);
}

function verifyDatabase(database: DatabaseHandle): string {
  const directory = databaseDirectory(database);
  const filename = join(directory, DATABASE_FILENAME);
  const marker = join(directory, MARKER_FILENAME);
  const reason = 'invalid_live_database';
  try {
    requireEvidence(lstatSync(directory).isDirectory(), reason);
    for (const entry of [filename, marker, ...['-wal', '-shm', '-journal'].map((suffix) => filename + suffix)]) {
      const stat = lstatSync(entry, { throwIfNoEntry: false });
      requireEvidence(stat ? stat.isFile() && stat.nlink === 1 : entry !== filename && entry !== marker, reason);
    }
    requireEvidence(lstatSync(marker).size === 32 && readFileSync(marker, 'utf8') === database.token, reason);
    const fd = openSync(filename, 'r');
    try {
      const header = Buffer.alloc(APPLICATION_ID_OFFSET + 4);
      requireEvidence(readSync(fd, header, 0, header.length, 0) === header.length &&
        header.toString('utf8', 0, SQLITE_MAGIC.length) === SQLITE_MAGIC &&
        header.readInt32BE(APPLICATION_ID_OFFSET) === APPLICATION_ID, reason);
    } finally {
      closeSync(fd);
    }
  } catch {
    requireEvidence(false, reason);
  }
  return filename;
}

function removeDatabase(directory: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(join(directory, DATABASE_FILENAME + suffix), { force: true });
  }
  rmSync(join(directory, MARKER_FILENAME), { force: true });
  rmdirSync(directory);
}

function normalizeTuple(watch: LiveWatchTuple): LiveWatchTuple {
  const { opensAtSec, deadlineSec } = watch;
  const reason = 'invalid_live_watch';
  const tuple = normalizeTransferTuple(watch, reason);
  requireEvidence(Number.isSafeInteger(opensAtSec) && opensAtSec >= 0 && Number.isSafeInteger(deadlineSec) &&
    opensAtSec < deadlineSec, reason);
  return { ...tuple, opensAtSec, deadlineSec };
}

function normalizePlan(plan: LivePlan): LivePlan {
  const { fromBlock, toBlock } = plan;
  const reason = 'invalid_live_plan';
  requireEvidence(Number.isSafeInteger(fromBlock) && Number.isSafeInteger(toBlock) && fromBlock >= 1 &&
    toBlock >= fromBlock && toBlock - fromBlock < MAX_LIVE_RANGE_BLOCKS && plan.finalizedHeads.length === 2, reason);
  const finalizedHeads = [normalizeHeader(plan.finalizedHeads[0]), normalizeHeader(plan.finalizedHeads[1])] as const;
  requireEvidence(finalizedHeads.every(({ height }) => height === toBlock) &&
    sameHeader(finalizedHeads[0], finalizedHeads[1]), reason);
  return { fromBlock, toBlock, finalizedHeads };
}

function validateObservation(plan: LivePlan, observation: LiveObservation, ids: ProviderIds): void {
  const reason = 'invalid_live_observation';
  const transactions = [...new Set(observation.candidates.map(({ log }) => log.transactionHash))];
  const [left, right] = observation.sources;
  requireEvidence(observation.predecessor.height === plan.fromBlock - 1 &&
    observation.blocks.length === plan.toBlock - plan.fromBlock + 1 &&
    observation.sources.length === 2 && observation.sources.every((source, index) => source.id === ids[index] &&
      DIGEST.test(source.rangeLogDigest) && source.rangeLogDigest === source.singleLogDigest &&
      source.receiptDigests.length === transactions.length && source.receiptDigests.every(({ transactionHash, digest }, i) =>
        transactionHash === transactions[i] && HASH.test(transactionHash) && DIGEST.test(digest))) &&
    left.rangeLogDigest === right.rangeLogDigest &&
    left.receiptDigests.every(({ digest }, index) => digest === right.receiptDigests[index].digest), reason);
  let prior = observation.predecessor;
  for (const block of observation.blocks) {
    requireEvidence(block.height === prior.height + 1 && block.parentHash === prior.hash &&
      block.timestamp >= prior.timestamp && plan.finalizedHeads.every((head) =>
        block.height === head.height ? sameHeader(block, head) : block.timestamp <= head.timestamp), reason);
    prior = block;
  }
}

function validateCandidate(candidate: LiveCandidate, observation: LiveObservation, watch: LiveWatchTuple | null): void {
  const reason = 'invalid_live_candidate';
  const { log, receipt } = candidate;
  const block = observation.blocks.find(({ height }) => height === log.blockNumber);
  requireEvidence(watch && block && block.timestamp >= watch.opensAtSec && block.timestamp < watch.deadlineSec &&
    Number.isSafeInteger(log.transactionIndex) && log.transactionIndex >= 0 &&
    log.blockHash === block.hash && block.transactions[log.transactionIndex] === log.transactionHash &&
    Number.isSafeInteger(log.logIndex) && log.logIndex >= 0 && log.removed === false &&
    log.address === USDC && log.topics.length === 3 && log.topics[0] === TRANSFER &&
    log.topics[1] === addressTopic(watch.sender) && log.topics[2] === addressTopic(watch.recipient) &&
    HASH.test(log.data) && BigInt(log.data) === BigInt(watch.amountAtomic) &&
    receipt.status === 1 && receipt.blockHash === log.blockHash && receipt.blockNumber === log.blockNumber &&
    receipt.transactionHash === log.transactionHash && receipt.transactionIndex === log.transactionIndex, reason);
}

export class LiveStore {
  readonly database: DatabaseHandle;
  private readonly db: DatabaseSync;
  private readonly fault?: Fault;

  // Only a token for a disposable database minted here can be reopened. The caller cannot supply a filename.
  static create(fault?: Fault): LiveStore {
    const database = Object.freeze({ kind: 'base-sepolia-cp2b', token: randomBytes(16).toString('hex') } as const);
    const directory = databaseDirectory(database);
    const filename = join(directory, DATABASE_FILENAME);
    mkdirSync(directory, { mode: 0o700 });
    try {
      closeSync(openSync(filename, 'wx', 0o600));
      writeFileSync(join(directory, MARKER_FILENAME), database.token, { flag: 'wx', mode: 0o600 });
      return new LiveStore(database, INITIALIZE, fault);
    } catch (error) {
      removeDatabase(directory);
      throw error;
    }
  }

  static open(database: DatabaseHandle, fault?: Fault): LiveStore {
    return new LiveStore(database, undefined, fault);
  }

  static dispose(database: DatabaseHandle): void {
    verifyDatabase(database);
    removeDatabase(databaseDirectory(database));
  }

  private constructor(database: DatabaseHandle, initialize: typeof INITIALIZE | undefined, fault?: Fault) {
    const filename = initialize === INITIALIZE ? join(databaseDirectory(database), DATABASE_FILENAME) : verifyDatabase(database);
    this.database = Object.freeze({ kind: database.kind, token: database.token });
    this.fault = fault;
    this.db = new DatabaseSync(filename);
    try {
      // Write the format identifier to the database header before enabling WAL.
      if (initialize === INITIALIZE) this.db.exec(`PRAGMA application_id = ${APPLICATION_ID};`);
      configureObserverDatabase(this.db);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS live_runs (
          id TEXT PRIMARY KEY, provider_ids TEXT NOT NULL,
          requested_watch TEXT, watch TEXT, sender TEXT, recipient TEXT, amount TEXT, opens INTEGER, deadline INTEGER,
          plan TEXT, observation TEXT, reason TEXT NOT NULL, diagnostic TEXT,
          work_used INTEGER NOT NULL DEFAULT 0, work_limit INTEGER NOT NULL,
          CHECK (work_used BETWEEN 0 AND work_limit)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS live_occurrences (
          chain_id INTEGER NOT NULL, block_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
          run_id TEXT NOT NULL REFERENCES live_runs(id),
          PRIMARY KEY (chain_id, block_hash, log_index)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS live_work (
          run_id TEXT NOT NULL REFERENCES live_runs(id), seq INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL,
          PRIMARY KEY (run_id, seq)
        ) STRICT;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  start(id: string, providerIds: ProviderIds, workLimit: number, watch?: LiveWatchTuple): void {
    requireEvidence(PROVIDER_ID.test(id), 'invalid_live_run');
    requireEvidence(providerIds.length === 2 && providerIds.every((value) => typeof value === 'string' &&
      PROVIDER_ID.test(value)) && providerIds[0].toLowerCase() !== providerIds[1].toLowerCase(),
    'invalid_live_sources');
    requireEvidence(Number.isSafeInteger(workLimit) && workLimit >= 1 && workLimit <= MAX_WORK_LIMIT, 'invalid_work_limit');
    const tuple = watch === undefined ? null : normalizeTuple(watch);
    const spec = tuple === null ? null : JSON.stringify(tuple);
    const ids = JSON.stringify(providerIds);
    writeObserverTransaction(this.db, () => {
      const previous = this.db.prepare('SELECT provider_ids, requested_watch, work_limit FROM live_runs WHERE id = ?').get(id);
      if (previous) {
        requireEvidence(previous.provider_ids === ids && previous.requested_watch === spec && previous.work_limit === workLimit,
          'immutable_live_run');
        return;
      }
      if (tuple) this.reserve(id, tuple);
      this.db.prepare(`
        INSERT INTO live_runs (id, provider_ids, requested_watch, watch, sender, recipient, amount, opens, deadline,
          reason, work_limit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_evidence', ?)
      `).run(id, ids, spec, spec, tuple?.sender ?? null, tuple?.recipient ?? null, tuple?.amountAtomic ?? null,
        tuple?.opensAtSec ?? null, tuple?.deadlineSec ?? null, workLimit);
    });
  }

  pin(id: string, input: LivePlan): void {
    const plan = JSON.stringify(normalizePlan(input));
    writeObserverTransaction(this.db, () => {
      const prior = this.row(id);
      requireEvidence(prior.plan === null || prior.plan === plan, 'immutable_live_plan');
      if (prior.plan === null) {
        this.db.prepare(`
          UPDATE live_runs SET plan = ?, reason = 'awaiting_observation', diagnostic = NULL WHERE id = ?
        `).run(plan, id);
      }
    });
  }

  // An interrupted attempt can spend units without receiving a response. A replay cannot recover those units.
  charge(id: string, source: string, kind: ReadKind): void {
    writeObserverTransaction(this.db, () => {
      const prior = this.row(id);
      requireEvidence((JSON.parse(prior.provider_ids) as ProviderIds).includes(source), 'live_sources_changed');
      requireEvidence(prior.observation === null, 'live_observation_committed');
      requireEvidence(prior.work_used < prior.work_limit, 'work_budget_exhausted');
      const next = prior.work_used + 1;
      this.db.prepare('UPDATE live_runs SET work_used = ? WHERE id = ?').run(next, id);
      this.db.prepare('INSERT INTO live_work VALUES (?, ?, ?, ?)').run(id, next, source, kind);
    });
  }

  commit(id: string, input: LiveObservation): void {
    requireEvidence(input.blocks.length <= MAX_LIVE_RANGE_BLOCKS && input.candidates.length <= MAX_CANDIDATES,
      'invalid_live_observation');
    const tuple = input.watch === null ? null : normalizeTuple(input.watch);
    const spec = tuple === null ? null : JSON.stringify(tuple);
    const observation: LiveObservation = {
      predecessor: normalizeHeader(input.predecessor), blocks: input.blocks.map(normalizeHeader), watch: tuple,
      candidates: input.candidates, sources: input.sources,
    };
    const serialized = JSON.stringify(observation);
    const inserted = writeObserverTransaction(this.db, () => {
      const prior = this.row(id);
      if (prior.observation !== null) {
        requireEvidence(prior.observation === serialized, 'immutable_live_observation');
        return false;
      }
      requireEvidence(prior.plan, 'live_plan_missing');
      requireEvidence(prior.requested_watch === null || prior.requested_watch === spec, 'immutable_live_watch');
      validateObservation(JSON.parse(prior.plan), observation, JSON.parse(prior.provider_ids));
      if (tuple) this.reserve(id, tuple);
      const insertOccurrence = this.db.prepare(`
        INSERT INTO live_occurrences VALUES (?, ?, ?, ?) ON CONFLICT (chain_id, block_hash, log_index) DO NOTHING
      `);
      for (const candidate of observation.candidates) {
        validateCandidate(candidate, observation, tuple);
        const result = insertOccurrence.run(CHAIN_ID, candidate.log.blockHash, candidate.log.logIndex, id);
        requireEvidence(result.changes === 1, 'occurrence_already_reserved');
      }
      const reason = observation.candidates.length > 0 ? 'receipt_inclusion_only' : 'coverage_unproven';
      this.db.prepare(`
        UPDATE live_runs SET observation = ?, watch = ?, sender = ?, recipient = ?, amount = ?, opens = ?, deadline = ?,
          reason = ?, diagnostic = NULL WHERE id = ?
      `).run(serialized, spec, tuple?.sender ?? null, tuple?.recipient ?? null, tuple?.amountAtomic ?? null,
        tuple?.opensAtSec ?? null, tuple?.deadlineSec ?? null, reason, id);
      this.fault?.('before_observation_commit');
      return true;
    });
    if (inserted) this.fault?.('after_observation_commit');
  }

  stall(id: string, reason: string, diagnostic?: LiveDiagnostic): void {
    requireEvidence(REASON.test(reason) && (diagnostic?.stage === undefined || REASON.test(diagnostic.stage)),
      'invalid_live_diagnostic');
    writeObserverTransaction(this.db, () => {
      const row = this.row(id);
      requireEvidence(diagnostic?.source === undefined || (JSON.parse(row.provider_ids) as ProviderIds).includes(diagnostic.source),
        'invalid_live_diagnostic');
      const details = diagnostic ? JSON.stringify({ source: diagnostic.source, stage: diagnostic.stage }) : null;
      this.db.prepare('UPDATE live_runs SET reason = ?, diagnostic = ? WHERE id = ? AND observation IS NULL')
        .run(reason, details, id);
    });
  }

  status(id: string) {
    const row = this.row(id);
    return {
      id,
      providerIds: JSON.parse(row.provider_ids) as ProviderIds,
      watch: row.watch === null ? null : JSON.parse(row.watch) as LiveWatchTuple,
      outcome: 'unresolved' as const,
      reason: row.reason,
      diagnostic: row.diagnostic === null ? null : JSON.parse(row.diagnostic) as LiveDiagnostic,
      plan: row.plan === null ? null : JSON.parse(row.plan) as LivePlan,
      observation: row.observation === null ? null : JSON.parse(row.observation) as LiveObservation,
      verifiedCoverageBlocks: 0 as const,
      verifiedCoverageCursor: null,
      work: {
        used: row.work_used,
        limit: row.work_limit,
        byRead: this.db.prepare(`
          SELECT source, kind, count(*) AS attempts FROM live_work
          WHERE run_id = ? GROUP BY source, kind ORDER BY source, kind
        `).all(id),
      },
    };
  }

  private row(id: string): RunRow {
    const row = this.db.prepare('SELECT * FROM live_runs WHERE id = ?').get(id);
    if (!row) throw new Error('Unknown live run');
    return row as unknown as RunRow;
  }

  private reserve(id: string, watch: LiveWatchTuple): void {
    const overlap = this.db.prepare(`
      SELECT 1 FROM live_runs WHERE id <> ? AND sender = ? AND recipient = ? AND amount = ? AND opens < ? AND deadline > ?
    `).get(id, watch.sender, watch.recipient, watch.amountAtomic, watch.deadlineSec, watch.opensAtSec);
    requireEvidence(!overlap, 'overlapping_reservation');
  }
}
