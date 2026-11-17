import type { DatabaseSync } from 'node:sqlite';
import { bloomForLogs, transferBloomResult } from './cp2c-bloom.ts';
import { verifyReceiptRoot } from './cp2c-receipts.ts';
import {
  CHAIN_ID, USDC, filterFor, inFilter, normalizeHeader, normalizeTransferTuple, requireEvidence, Unresolved,
} from './evidence.ts';
import type { Header, Log, WatchInput } from './evidence.ts';
import { configureObserverDatabase, writeObserverTransaction } from './sqlite.ts';

export type WeakEvidence = 'OBSERVED_ONLY' | 'RECEIPT_INCLUSION' | 'PROVIDER_CORROBORATED';
export type CoverageEvidence = WeakEvidence | 'VERIFIED_COMPLETE' | 'UNRESOLVED';

export interface ProofHeader extends Header {
  readonly logsBloom: string;
  readonly receiptsRoot: string;
}

type Watch = Readonly<Pick<WatchInput, 'id' | 'chainId' | 'token' | 'sender' | 'recipient' |
  'amountAtomic' | 'opensAtSec' | 'deadlineSec'>>;

// Only local fixtures may supply this input. This module does not derive live finality
// or authenticate a fixture supplied by a remote caller.
interface CanonicalFixture {
  readonly anchor: ProofHeader;
  readonly blocks: readonly {
    readonly header: ProofHeader;
    readonly depositRule?: 'canyon-v1';
  }[];
}

interface BlockEvidence {
  readonly header?: ProofHeader;
  readonly receipts?: unknown;
  readonly observation?: WeakEvidence;
}

interface AcceptedBlock {
  header: ProofHeader;
  evidence: 'VERIFIED_COMPLETE';
  method: 'OUTSIDE_WINDOW' | 'BLOOM_EXCLUSION' | 'RECEIPTS_ROOT';
  occurrences: Log[];
}

interface Decision {
  evidence: CoverageEvidence;
  reason: string;
}

function fixedHex(value: unknown, bytes: number, reason: string): string {
  requireEvidence(typeof value === 'string' && value.length === 2 + bytes * 2 && /^0x[0-9a-f]+$/i.test(value), reason);
  return value.toLowerCase();
}

function normalizeProofHeader(input: ProofHeader): ProofHeader {
  return Object.freeze({
    ...normalizeHeader(input),
    logsBloom: fixedHex(input.logsBloom, 256, 'invalid_header_bloom'),
    receiptsRoot: fixedHex(input.receiptsRoot, 32, 'invalid_header_receipts_root'),
  });
}

function normalizeFixtureWatch(input: Watch): Watch {
  const token = fixedHex(input.token, 20, 'invalid_watch');
  requireEvidence(input.chainId === CHAIN_ID && token === USDC && typeof input.id === 'string' &&
    /^[a-z0-9_-]{1,64}$/i.test(input.id) &&
    Number.isSafeInteger(input.opensAtSec) && input.opensAtSec > 0 &&
    Number.isSafeInteger(input.deadlineSec) && input.deadlineSec > input.opensAtSec, 'invalid_watch');
  return {
    id: input.id, chainId: CHAIN_ID, token, ...normalizeTransferTuple(input),
    opensAtSec: input.opensAtSec, deadlineSec: input.deadlineSec,
  };
}

function pending(input: BlockEvidence, reason: string): Decision {
  const evidence = input.observation;
  switch (evidence) {
    case 'OBSERVED_ONLY':
    case 'RECEIPT_INCLUSION':
    case 'PROVIDER_CORROBORATED':
      return { evidence, reason };
    default:
      return { evidence: 'UNRESOLVED', reason };
  }
}

export function openFixtureCoverage(db: DatabaseSync, input: Watch, fixture: CanonicalFixture) {
  const watch = normalizeFixtureWatch(input);
  const anchor = normalizeProofHeader(fixture.anchor);
  requireEvidence(anchor.timestamp < watch.opensAtSec, 'anchor_must_precede_open');
  const blocks = fixture.blocks.map(({ header, depositRule }) => {
    requireEvidence(depositRule === undefined || depositRule === 'canyon-v1', 'unsupported_fixture_fork');
    return { header: normalizeProofHeader(header), depositRule };
  }).sort((left, right) => left.header.height - right.header.height);
  const byHeight = new Map(blocks.map((block) => [block.header.height, block]));
  requireEvidence(byHeight.size === blocks.length && blocks.every(({ header }) => header.height > anchor.height),
    'invalid_fixture_heights');
  const definition = JSON.stringify({ watch, anchor, blocks });
  const filter = filterFor(watch);

  configureObserverDatabase(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cp2c_fixture (
      id INTEGER PRIMARY KEY CHECK (id = 1), definition TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS cp2c_coverage (
      height INTEGER PRIMARY KEY, accepted TEXT NOT NULL
    ) STRICT;
  `);
  writeObserverTransaction(db, () => {
    db.prepare('INSERT OR IGNORE INTO cp2c_fixture VALUES (1, ?)').run(definition);
    requireEvidence(db.prepare('SELECT definition FROM cp2c_fixture WHERE id = 1').get()?.definition === definition,
      'immutable_fixture_definition');
  });

  const last = db.prepare('SELECT accepted FROM cp2c_coverage ORDER BY height DESC LIMIT 1');
  const insert = db.prepare('INSERT INTO cp2c_coverage VALUES (?, ?)');

  return {
    advance(input: BlockEvidence): Decision {
      return writeObserverTransaction(db, () => {
        const row = last.get();
        const previous = row ? (JSON.parse(row.accepted as string) as AcceptedBlock).header : anchor;
        try {
          requireEvidence(previous.timestamp < watch.deadlineSec, 'deadline_already_verified');
          requireEvidence(input.header, 'missing_header');
          const header = normalizeProofHeader(input.header);
          requireEvidence(header.height === previous.height + 1, 'noncontiguous_height');
          requireEvidence(header.parentHash === previous.hash && header.timestamp >= previous.timestamp,
            'unlinked_header');
          const canonical = byHeight.get(header.height);
          if (!canonical) return pending(input, 'unauthenticated_header');
          requireEvidence(JSON.stringify(header) === JSON.stringify(canonical.header), 'canonical_header_mismatch');

          const receipts = input.receipts === undefined
            ? undefined
            : verifyReceiptRoot(header, input.receipts, canonical.depositRule);
          const logs = receipts?.flatMap((receipt) => receipt.logs);
          if (logs) {
            requireEvidence(`0x${bloomForLogs(logs).toString('hex')}` === header.logsBloom, 'receipt_block_bloom_mismatch');
          }

          const accepted: AcceptedBlock = { header, evidence: 'VERIFIED_COMPLETE', method: 'OUTSIDE_WINDOW', occurrences: [] };
          if (header.timestamp >= watch.opensAtSec && header.timestamp < watch.deadlineSec) {
            if (logs) {
              accepted.method = 'RECEIPTS_ROOT';
              for (const log of logs) {
                if (!inFilter(log, filter)) continue;
                requireEvidence(log.topics.length === 3 && log.data.length === 66, 'malformed_transfer');
                if (BigInt(log.data) === BigInt(watch.amountAtomic)) accepted.occurrences.push(log);
              }
            } else if (transferBloomResult(header.logsBloom, watch) === 'EXCLUDED') {
              accepted.method = 'BLOOM_EXCLUSION';
            } else {
              return pending(input, 'bloom_possible_receipts_required');
            }
          }

          insert.run(header.height, JSON.stringify(accepted));
          return { evidence: accepted.evidence, reason: accepted.method };
        } catch (error) {
          if (error instanceof Unresolved) return { evidence: 'UNRESOLVED', reason: error.message };
          throw error;
        }
      });
    },

    status() {
      const accepted = db.prepare('SELECT accepted FROM cp2c_coverage ORDER BY height').all()
        .map((row) => JSON.parse(row.accepted as string) as AcceptedBlock);
      const cursor = accepted.at(-1)?.header ?? anchor;
      const deadlineBoundary = cursor.timestamp >= watch.deadlineSec ? cursor : null;
      const occurrences = accepted.flatMap((block) => block.occurrences);
      return {
        accepted, cursor, deadlineBoundary, occurrences,
        negativeEligible: deadlineBoundary !== null && occurrences.length === 0,
      };
    },
  };
}
