import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import { currentWorkClaim } from './roundwatch-test-claims.js';
import { ALGORAND_TESTNET_CAIP2 } from './network-config.js';
import {
   RoundWatchStore,
   WatchCapacityError,
   type RoundWatchCapacitySnapshot,
   type WatchState,
} from './roundwatch-store.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const PAYER = 'capacity-payer';
const OTHER_PAYER = 'other-capacity-payer';
const OPEN_INDEX = 'roundwatch_open_obligations_idx';
const SPEC = {
   idempotencyKey: 'capacity-new', expectedSender: 'sender',
   expectedReceiver: 'receiver', assetId: 1, atomicAmount: '1',
};
const intent = (key: string, payer = PAYER) => ({
   expectedTransaction: `service-${key}`, network: ALGORAND_TESTNET_CAIP2,
   payer, receiver: 'receiver', assetId: 1, atomicAmount: '1',
   firstValid: 1, lastValid: 2,
});
const time = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const databaseOf = (store: RoundWatchStore) =>
   (store as unknown as { database: DatabaseSync }).database;

interface FixtureRow {
   id: string;
   state: WatchState;
   terminal?: number;
   payer?: string | null;
   servicePayer?: string | null;
   scan?: number;
   closing?: number;
   activated?: string;
   created?: string;
   expires?: string;
}

function insertRows(database: DatabaseSync, rows: FixtureRow[]): void {
   const insert = database.prepare(`
      INSERT INTO roundwatch_watches (
         id, idempotency_key, state, expected_sender, expected_receiver,
         asset_id, atomic_amount, expected_service_payer, service_payer,
         settlement_reconciliation_terminal, scan_after_round, closing_round,
         activated_at, created_at, expires_at, work_unit_budget
      ) VALUES (?, ?, ?, 'sender', 'receiver', 1, '1', ?, ?, ?, ?, ?, ?, ?, ?, 500)
   `);
   database.exec('BEGIN IMMEDIATE;');
   try {
      for (const row of rows) {
         insert.run(
            row.id, row.id, row.state, row.payer === undefined ? PAYER : row.payer,
            row.servicePayer ?? null, row.terminal ?? 0, row.scan ?? null,
            row.closing ?? null, row.activated ?? null, row.created ?? time(-60),
            row.expires ?? null,
         );
      }
      database.exec('COMMIT;');
   } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
   }
}

// Independent expected values below cover legacy rows and all metric branches.
const CURRENT_ROWS: FixtureRow[] = [
   { id: 'missing', state: 'active', activated: time(-5), expires: time(-60) },
   { id: 'missing-fixed', state: 'active', payer: null, closing: 140,
      created: time(-45), expires: time(0) },
   { id: 'before', state: 'active', scan: 100, activated: time(-30), expires: time(1) },
   { id: 'past-no-close', state: 'active', scan: 110, activated: time(-20), expires: time(-1) },
   { id: 'past-incomplete', state: 'active', scan: 120, closing: 140,
      activated: time(-15), expires: time(-1) },
   { id: 'past-covered', state: 'active', scan: 140, closing: 140,
      activated: time(-10), expires: time(0) },
   { id: 'closing-ahead', state: 'active', scan: 120, closing: 180,
      activated: time(-8), expires: time(1) },
   { id: 'scan-ahead', state: 'active', terminal: 1, scan: 170, activated: time(1), expires: time(-1) },
   { id: 'invalid-age-expiry', state: 'active', servicePayer: OTHER_PAYER,
      scan: 145, closing: 150, activated: 'invalid', expires: 'invalid' },
   { id: 'legacy-no-expiry', state: 'active', payer: null, servicePayer: PAYER,
      scan: 150, created: time(-55) },
   { id: 'pending', state: 'settlement_pending' },
   // The terminal flag excludes only settlement_unknown, never pending/active.
   { id: 'pending-flagged', state: 'settlement_pending', terminal: 1, payer: OTHER_PAYER },
   { id: 'unknown', state: 'settlement_unknown' },
   { id: 'unknown-other', state: 'settlement_unknown', payer: OTHER_PAYER },
];
const EXPECTED_BASE: RoundWatchCapacitySnapshot = {
   unfinishedWatches: 14, activeWatches: 10, settlementPendingWatches: 2,
   unresolvedSettlementUnknownWatches: 2, activeWatchesMissingScanBaseline: 2,
   watchesPastDeadlineAwaitingCoverage: 5, oldestActiveWatchAgeMs: 55 * 60_000,
};

function assertMixedSnapshot(store: RoundWatchStore): void {
   assert.deepEqual(store.capacitySnapshot(), EXPECTED_BASE);
   assert.deepEqual(store.capacitySnapshot(0), {
      ...EXPECTED_BASE, currentIndexerRound: 0,
      scanLagRounds: { samples: 8, p50: 0, p95: 0, max: 0 },
   });
   assert.deepEqual(store.capacitySnapshot(125), {
      ...EXPECTED_BASE, currentIndexerRound: 125,
      scanLagRounds: { samples: 8, p50: 0, p95: 25, max: 25 },
   });
   assert.deepEqual(store.capacitySnapshot(150), {
      ...EXPECTED_BASE, currentIndexerRound: 150,
      // Sorted lags: 0, 0, 0, 5, 20, 30, 40, 50. Nearest-rank percentiles.
      scanLagRounds: { samples: 8, p50: 5, p95: 50, max: 50 },
   });
}

interface CapturedRead {
   kind: 'capacity' | 'global' | 'payer';
   sql: string;
   bindings: SQLInputValue[];
   plan: string[];
   count?: number;
}

function captureReads(t: TestContext, database: DatabaseSync): CapturedRead[] {
   const prepare = database.prepare.bind(database);
   const reads: CapturedRead[] = [];
   // Explain production SQL at its actual get/all boundary, with actual bindings.
   t.mock.method(database, 'prepare', (sql: string) => {
      const statement = prepare(sql);
      if (/^\s*SELECT/i.test(sql) && /FROM roundwatch_watches\b/i.test(sql) &&
          (/COUNT\s*\(\s*\*\s*\)/i.test(sql) || /scan_after_round|SUM\s*\(/i.test(sql))) {
         for (const method of ['get', 'all'] as const) {
            const execute = statement[method].bind(statement);
            t.mock.method(statement, method, (...bindings: SQLInputValue[]) => {
               const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{ detail: string }>;
               const result = execute(...bindings);
               const counting = /COUNT\s*\(\s*\*\s*\)/i.test(sql);
               reads.push({
                  kind: counting ? (bindings.length === 0 ? 'global' : 'payer') : 'capacity',
                  sql, bindings, plan: plan.map(row => row.detail),
                  ...(counting ? { count: (result as { count: number }).count } : {}),
               });
               return result;
            });
         }
      }
      return statement;
   });
   return reads;
}

function assertOpenOnlyPlan(plan: string[], payer = false): void {
   const accesses = plan.filter(detail => /\b(?:SCAN|SEARCH)\s+roundwatch_watches\b/i.test(detail));
   assert.ok(accesses.length > 0, `missing watch access: ${plan.join('; ')}`);
   for (const detail of accesses) {
      assert.match(detail, /\bUSING (?:COVERING )?INDEX roundwatch_open_obligations_idx\b/i);
   }
   if (payer) {
      assert.ok(accesses.some(detail => /\bSEARCH\b/i.test(detail) && /<expr>\s*=\s*\?/.test(detail)),
         `payer must constrain the open-only expression index: ${plan.join('; ')}`);
   }
}

function assertOpenIndex(database: DatabaseSync): void {
   const indexes = database.prepare('PRAGMA index_list(roundwatch_watches)').all() as Array<{
      name: string; partial: number;
   }>;
   assert.equal(indexes.find(row => row.name === OPEN_INDEX)?.partial, 1);
   assert.equal(indexes.some(row => row.name === 'roundwatch_open_payer_idx'), false);
   const { sql } = database.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(OPEN_INDEX) as { sql: string };
   // A broader partial predicate can still give an indexed plan but scan history.
   assert.equal(sql.split(/\bWHERE\b/i)[1]!.trim().replace(/\s+/g, ' '),
      "state IN ('settlement_pending', 'active') OR (state = 'settlement_unknown' AND settlement_reconciliation_terminal = 0)");
}

test('capacity snapshot and admission stay on the open subset with 10,000 durable terminal rows', async t => {
   for (const currentFirst of [true, false]) {
      await t.test(`current rows ${currentFirst ? 'before' : 'after'} history; ${currentFirst ? 'forward' : 'reverse'} order`, t => {
         const directory = mkdtempSync(join(tmpdir(), 'roundwatch-capacity-history-'));
         const path = join(directory, 'watch.sqlite');
         const store = new RoundWatchStore(path, {
            now: () => NOW, maxOpenWatches: 15, maxOpenWatchesPerPayer: 12,
         });
         const database = databaseOf(store);
         try {
            const terminalStates: WatchState[] = ['matched', 'expired', 'indeterminate', 'settlement_unknown'];
            const history: FixtureRow[] = Array.from({ length: 10_000 }, (_, i) => ({
               id: `history-${i}`, state: terminalStates[i % terminalStates.length]!, terminal: 1,
               // Even the queried payer has thousands of terminal rows.
               payer: i % 5 === 0 ? OTHER_PAYER : PAYER,
            }));
            insertRows(database, currentFirst ? [...CURRENT_ROWS, ...history] : [...history.reverse(), ...[...CURRENT_ROWS].reverse()]);
            assert.equal((database.prepare('SELECT COUNT(*) AS n FROM roundwatch_watches').get() as { n: number }).n, 10_014);
            assertOpenIndex(database);
            const reads = captureReads(t, database);
            assertMixedSnapshot(store);
            assert.equal(reads.filter(row => row.kind === 'capacity').length, 4, 'one bounded row read per snapshot');
            const added = store.prepareWatch(SPEC, intent(SPEC.idempotencyKey));
            assert.equal(added.created, true);
            assert.deepEqual(reads.filter(row => row.count !== undefined).map(row => [row.kind, row.count]),
               [['global', 14], ['payer', 11]]);
            assert.equal(store.prepareWatch(SPEC, intent(SPEC.idempotencyKey)).created, false);
            assert.throws(() => store.prepareWatch({ ...SPEC, idempotencyKey: 'global-overflow' }, intent('global-overflow', OTHER_PAYER)),
               (error: unknown) => error instanceof WatchCapacityError && error.scope === 'global');
            assert.equal(reads.at(-1)?.count, 15);
            assert.deepEqual(store.capacitySnapshot(), { ...EXPECTED_BASE, unfinishedWatches: 15, settlementPendingWatches: 3 });

            for (const read of reads) assertOpenOnlyPlan(read.plan, read.kind === 'payer');
            for (const kind of ['capacity', 'global', 'payer'] as const) {
               const read = reads.find(row => row.kind === kind)!;
               assert.ok(read, `must observe ${kind} production SQL`);
               t.diagnostic(`${kind}: ${read.plan.join('; ')}`);
            }
            // The access-path contract must hold both before and after statistics.
            database.exec('ANALYZE;');
            for (const read of reads) {
               const plan = database.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all(...read.bindings) as Array<{ detail: string }>;
               assertOpenOnlyPlan(plan.map(row => row.detail), read.kind === 'payer');
            }

            // Local negative control: missing index cannot silently restore a
            // history scan. Also show the fallback if the required path is removed.
            database.exec(`DROP INDEX ${OPEN_INDEX};`);
            for (const kind of ['capacity', 'global', 'payer'] as const) {
               const read = reads.find(row => row.kind === kind)!;
               assert.throws(() => database.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all(...read.bindings), /no such index/i);
               const fallbackSql = read.sql.replace(/\s+INDEXED BY roundwatch_open_obligations_idx\b/i, '');
               const fallback = database.prepare(`EXPLAIN QUERY PLAN ${fallbackSql}`).all(...read.bindings) as Array<{ detail: string }>;
               const plan = fallback.map(row => row.detail);
               assert.throws(() => assertOpenOnlyPlan(plan, kind === 'payer'), assert.AssertionError);
               t.diagnostic(`removed index and access-path requirement, ${kind}: ${plan.join('; ')}`);
            }
            assert.throws(() => store.capacitySnapshot(), /no such index/i);
            assert.throws(() => store.prepareWatch({ ...SPEC, idempotencyKey: 'missing-index' }, intent('missing-index')), /no such index/i);
            assert.equal((database.prepare('SELECT COUNT(*) AS n FROM roundwatch_watches').get() as { n: number }).n, 10_015);
         } finally {
            store.close();
            rmSync(directory, { recursive: true, force: true });
         }
      });
   }
});

test('payer admission preserves expected-payer precedence, legacy fallback, and exact limits', t => {
   const store = new RoundWatchStore(':memory:', {
      now: () => NOW, maxOpenWatches: 50, maxOpenWatchesPerPayer: 11,
   });
   const database = databaseOf(store);
   try {
      insertRows(database, CURRENT_ROWS);
      insertRows(database, [
         { id: 'terminal-unknown', state: 'settlement_unknown', terminal: 1 },
         { id: 'terminal-matched', state: 'matched' },
         { id: 'terminal-expired', state: 'expired' },
         { id: 'terminal-indeterminate', state: 'indeterminate' },
      ]);
      const reads = captureReads(t, database);
      assert.throws(() => store.prepareWatch(SPEC, intent(SPEC.idempotencyKey)),
         (error: unknown) => error instanceof WatchCapacityError && error.scope === 'payer');
      assert.deepEqual(reads.map(row => [row.kind, row.count]), [['global', 14], ['payer', 11]]);
      const other = store.prepareWatch({ ...SPEC, idempotencyKey: 'other-new' }, intent('other-new', OTHER_PAYER));
      assert.equal(other.created, true);
      assert.deepEqual(reads.slice(-2).map(row => [row.kind, row.count]), [['global', 14], ['payer', 2]]);
      const legacy = store.prepareWatch({ ...SPEC, idempotencyKey: 'ownerless-new' });
      assert.equal(legacy.created, true);
      assert.equal(reads.at(-1)?.kind, 'global');
      assert.equal(reads.at(-1)?.count, 15);
      // Release one PAYER obligation; durable rows immediately authorize one slot.
      store.markSettlementInvalid('unknown');
      assert.equal(store.prepareWatch(SPEC, intent(SPEC.idempotencyKey)).created, true);
      assert.deepEqual(reads.slice(-2).map(row => [row.kind, row.count]), [['global', 15], ['payer', 10]]);
      assert.throws(() => store.prepareWatch({ ...SPEC, idempotencyKey: 'payer-overflow' }, intent('payer-overflow')),
         (error: unknown) => error instanceof WatchCapacityError && error.scope === 'payer');
      assert.equal(store.capacitySnapshot().unfinishedWatches, 16);
   } finally {
      store.close();
   }
});

test('capacity validates retained tips and omits unavailable active metrics', () => {
   const store = new RoundWatchStore(':memory:', { now: () => NOW });
   try {
      const empty = {
         unfinishedWatches: 0, activeWatches: 0, settlementPendingWatches: 0,
         unresolvedSettlementUnknownWatches: 0, activeWatchesMissingScanBaseline: 0,
         watchesPastDeadlineAwaitingCoverage: 0,
      };
      assert.deepEqual(store.capacitySnapshot(), empty);
      assert.deepEqual(store.capacitySnapshot(0), { ...empty, currentIndexerRound: 0 });
      assert.deepEqual(store.capacitySnapshot(Number.MAX_SAFE_INTEGER), { ...empty, currentIndexerRound: Number.MAX_SAFE_INTEGER });
      for (const invalid of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
         assert.throws(() => store.capacitySnapshot(invalid), /non-negative safe integer/);
      }
      insertRows(databaseOf(store), [{ id: 'invalid-active', state: 'active', activated: 'invalid' }]);
      assert.deepEqual(store.capacitySnapshot(150), {
         ...empty, unfinishedWatches: 1, activeWatches: 1,
         activeWatchesMissingScanBaseline: 1, currentIndexerRound: 150,
      });
   } finally {
      store.close();
   }
});

test('open index follows durable lifecycle transitions without counters', () => {
   const store = new RoundWatchStore(':memory:', {
      now: () => NOW, maxOpenWatches: 1, maxOpenWatchesPerPayer: 1, workUnitBudget: 1,
   });
   const prepare = (key: string) => store.prepareWatch({ ...SPEC, idempotencyKey: key }, intent(key)).watch;
   const activate = (id: string, key: string) => store.activateWatch(id, {
      transaction: `service-${key}`, network: ALGORAND_TESTNET_CAIP2, payer: PAYER,
   }, 100);
   try {
      const matched = prepare('matched');
      assert.equal(store.capacitySnapshot().settlementPendingWatches, 1);
      store.markSettlementUnknown(matched.id);
      assert.equal(store.capacitySnapshot().unresolvedSettlementUnknownWatches, 1);
      activate(matched.id, 'matched');
      assert.equal(store.capacitySnapshot().activeWatches, 1);
      assert.throws(() => prepare('too-soon'), WatchCapacityError);
      store.markMatched(matched.id, 'invoice', 101);
      assert.equal(store.capacitySnapshot().unfinishedWatches, 0);

      const expired = prepare('expired');
      activate(expired.id, 'expired');
      assert.equal(store.setClosingRound(expired.id, 110), 110);
      assert.equal(store.advanceScanRound(expired.id, 100, 110), true);
      assert.equal(store.markExpired(expired.id, 110, 110), true);
      assert.equal(store.capacitySnapshot().unfinishedWatches, 0);

      const indeterminate = prepare('indeterminate');
      assert.equal(store.claimWorkUnit(indeterminate.id, currentWorkClaim(store, indeterminate.id, 'reconciliation')), 'claimed');
      assert.equal(store.claimWorkUnit(indeterminate.id, currentWorkClaim(store, indeterminate.id, 'reconciliation')), 'exhausted');
      assert.equal(store.capacitySnapshot().unfinishedWatches, 0);

      const unknown = prepare('terminal-unknown');
      store.markSettlementUnknown(unknown.id);
      assert.equal(store.capacitySnapshot().unfinishedWatches, 1);
      store.markSettlementInvalid(unknown.id);
      assert.equal(store.capacitySnapshot().unfinishedWatches, 0);
      assert.equal(prepare('replacement').state, 'settlement_pending');
   } finally {
      store.close();
   }
});

test('normal migration replaces the historical payer index idempotently; refund audit never migrates', () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-capacity-migration-'));
   const path = join(directory, 'watch.sqlite');
   let store: RoundWatchStore | undefined;
   const schema = (database: DatabaseSync) => database.prepare(`
      SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master ORDER BY type, name
   `).all();
   try {
      store = new RoundWatchStore(path, { now: () => NOW });
      let database = databaseOf(store);
      insertRows(database, [...CURRENT_ROWS, { id: 'migration-terminal', state: 'matched' }]);
      // Simulate the actual pre-C2 index layout on an otherwise current schema.
      database.exec(`
         DROP INDEX ${OPEN_INDEX};
         CREATE INDEX roundwatch_open_payer_idx ON roundwatch_watches(
            COALESCE(expected_service_payer, service_payer), state, settlement_reconciliation_terminal
         );
      `);
      const beforeSchema = schema(database);
      const beforeRows = database.prepare('SELECT * FROM roundwatch_watches ORDER BY id').all();
      const beforeVersion = database.prepare('PRAGMA schema_version').get();
      store.close();
      store = undefined;

      store = new RoundWatchStore(path, { schemaMode: 'existing-refund-audit' });
      database = databaseOf(store);
      store.recordRefundEvidence('migration-terminal', {
         transaction: 'A'.repeat(51) + 'Q', network: ALGORAND_TESTNET_CAIP2, atomicAmount: '1',
      });
      assert.deepEqual(schema(database), beforeSchema);
      assert.deepEqual(database.prepare('PRAGMA schema_version').get(), beforeVersion);
      assert.deepEqual(database.prepare('SELECT * FROM roundwatch_watches ORDER BY id').all(), beforeRows);
      store.close();
      store = undefined;

      let migratedSchema: unknown;
      for (let restart = 0; restart < 2; restart++) {
         store = new RoundWatchStore(path, { now: () => NOW });
         database = databaseOf(store);
         assertOpenIndex(database);
         assertMixedSnapshot(store);
         assert.deepEqual(database.prepare('SELECT * FROM roundwatch_watches ORDER BY id').all(), beforeRows);
         const afterSchema = schema(database);
         // Only this nonunique capacity index changes; table rootpages, unique
         // indexes, refunds, and existing worker indexes all remain intact.
         assert.deepEqual(afterSchema.filter(row => row.name !== OPEN_INDEX),
            beforeSchema.filter(row => row.name !== 'roundwatch_open_payer_idx'));
         if (restart === 0) migratedSchema = afterSchema;
         else assert.deepEqual(afterSchema, migratedSchema);
         assert.equal(store.listRefundEvidence('migration-terminal').length, 1);
         store.close();
         store = undefined;
      }
   } finally {
      store?.close();
      rmSync(directory, { recursive: true, force: true });
   }
});
