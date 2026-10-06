import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import test from 'node:test';

import { ALGORAND_TESTNET_CAIP2 } from './network-config.js';
import { RoundWatchStore } from './roundwatch-store.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const BUDGET = 29;
const OPEN_INDEX = 'roundwatch_open_obligations_idx';
const databaseOf = (store: RoundWatchStore) =>
   (store as unknown as { database: DatabaseSync }).database;
type StoredRow = Record<string, SQLOutputValue>;
type SeedRow = Record<string, SQLInputValue>;

// Actual table DDL from commit 2902c46 (first durable store), before expiry,
// expected settlement metadata, reconciliation terminal state, or work budgets.
const EARLY_SCHEMA = `
   CREATE TABLE roundwatch_watches (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (
         state IN ('settlement_pending', 'active', 'matched', 'settlement_unknown')
      ),
      expected_sender TEXT NOT NULL,
      expected_receiver TEXT NOT NULL,
      asset_id INTEGER NOT NULL,
      atomic_amount TEXT NOT NULL,
      invoice_note TEXT,
      service_transaction TEXT UNIQUE,
      service_network TEXT,
      service_payer TEXT,
      activation_round INTEGER,
      activated_at TEXT,
      scan_after_round INTEGER,
      created_at TEXT NOT NULL,
      matched_transaction TEXT,
      matched_round INTEGER
   );
`;

// Actual expiry-capable, pre-budget table DDL from commit 0299023. Keeping
// these historical shapes explicit exercises real ADD COLUMN/table rebuild
// paths instead of deriving an allegedly old schema from today's table.
const EXPIRY_SCHEMA = `
   CREATE TABLE roundwatch_watches (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (
         state IN ('settlement_pending', 'active', 'matched', 'settlement_unknown', 'expired')
      ),
      expected_sender TEXT NOT NULL,
      expected_receiver TEXT NOT NULL,
      asset_id INTEGER NOT NULL,
      atomic_amount TEXT NOT NULL,
      invoice_note TEXT,
      expected_service_transaction TEXT,
      expected_service_network TEXT,
      expected_service_payer TEXT,
      service_transaction TEXT UNIQUE,
      service_network TEXT,
      service_payer TEXT,
      activation_round INTEGER,
      activated_at TEXT,
      scan_after_round INTEGER,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      matched_transaction TEXT,
      matched_round INTEGER,
      settlement_reconciliation_terminal INTEGER NOT NULL DEFAULT 0,
      closing_round INTEGER,
      evidence_version INTEGER NOT NULL DEFAULT 0,
      service_receiver TEXT,
      service_asset_id INTEGER,
      service_atomic_amount TEXT,
      service_first_valid INTEGER,
      service_last_valid INTEGER,
      reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
      reconciliation_next_attempt_at TEXT
   );
`;

const MIGRATION_DEFAULTS: StoredRow = {
   expected_service_transaction: null,
   expected_service_network: null,
   expected_service_payer: null,
   settlement_reconciliation_terminal: 0,
   expires_at: null,
   closing_round: null,
   evidence_version: 0,
   service_receiver: null,
   service_asset_id: null,
   service_atomic_amount: null,
   service_first_valid: null,
   service_last_valid: null,
   reconciliation_attempts: 0,
   reconciliation_next_attempt_at: null,
   work_unit_budget: null,
   work_units_used: 0,
   terminal_reason: null,
   polling_failure_code: null,
   polling_failure_status: null,
   polling_failure_disposition: null,
   polling_failure_count: 0,
   polling_last_failure_at: null,
   polling_retry_at: null,
};

function row(id: string, state: string, extra: SeedRow = {}): SeedRow {
   return {
      id, idempotency_key: `key-${id}`, state,
      expected_sender: 'stored-sender', expected_receiver: 'stored-receiver',
      asset_id: 10458941, atomic_amount: '100',
      created_at: '2026-06-01T00:00:00.000Z', ...extra,
   };
}

function insertRows(database: DatabaseSync, rows: SeedRow[]): void {
   for (const value of rows) {
      const columns = Object.keys(value);
      database.prepare(`
         INSERT INTO roundwatch_watches (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})
      `).run(...Object.values(value));
   }
}

function allRows(database: DatabaseSync): StoredRow[] {
   // Convert SQLite's null-prototype row objects for stable whole-row comparison.
   return database.prepare('SELECT * FROM roundwatch_watches ORDER BY id').all()
      .map(value => ({ ...value }));
}

function schema(database: DatabaseSync) {
   return database.prepare(`
      SELECT type, name, tbl_name, rootpage, sql
      FROM sqlite_master ORDER BY type, name
   `).all();
}

function assertBudgetColumnSemantics(database: DatabaseSync): void {
   const columns = database.prepare('PRAGMA table_info(roundwatch_watches)').all();
   const budget = columns.find(column => column.name === 'work_unit_budget');
   const usage = columns.find(column => column.name === 'work_units_used');
   assert.equal(budget?.type, 'INTEGER');
   assert.equal(budget?.notnull, 0);
   assert.equal(budget?.dflt_value, null);
   assert.equal(usage?.type, 'INTEGER');
   assert.equal(usage?.notnull, 1);
   assert.equal(usage?.dflt_value, '0');
}

function expectedMigration(rows: StoredRow[], openIds: Set<string>): StoredRow[] {
   return rows.map(value => ({
      ...MIGRATION_DEFAULTS, ...value,
      work_unit_budget: openIds.has(String(value.id)) ? BUDGET : null,
   }));
}

function assertIdempotencyPreserved(store: RoundWatchStore, rows: StoredRow[]): void {
   for (const value of rows) {
      const watch = store.getWatch(String(value.id))!;
      const spec = {
         idempotencyKey: watch.idempotencyKey,
         expectedSender: watch.expectedSender,
         expectedReceiver: watch.expectedReceiver,
         assetId: watch.assetId,
         atomicAmount: watch.atomicAmount,
         ...(watch.invoiceNote === undefined ? {} : { invoiceNote: watch.invoiceNote }),
      };
      const replay = store.prepareWatch(spec, watch.expectedServicePayer === undefined ? undefined : {
         expectedTransaction: watch.expectedServiceTransaction!, network: watch.expectedServiceNetwork!,
         payer: watch.expectedServicePayer, receiver: watch.serviceReceiver!,
         assetId: watch.serviceAssetId!, atomicAmount: watch.serviceAtomicAmount!,
         firstValid: watch.serviceFirstValid!, lastValid: watch.serviceLastValid!,
      });
      assert.equal(replay.created, false);
      assert.equal(replay.watch.id, value.id);
      assert.equal(store.getByIdempotencyKey(watch.idempotencyKey)?.id, value.id);
   }
}

test('early pre-budget schema preserves every legacy value and unknown default interpretation', () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-budget-early-'));
   const path = join(directory, 'watch.sqlite');
   let store: RoundWatchStore | undefined;
   try {
      const database = new DatabaseSync(path);
      database.exec(EARLY_SCHEMA);
      insertRows(database, [
         row('early-pending', 'settlement_pending'),
         row('early-active', 'active', {
            service_transaction: 'early-active-service', service_network: ALGORAND_TESTNET_CAIP2,
            service_payer: 'early-owner', activation_round: 40, scan_after_round: 43,
            activated_at: '2026-06-01T00:01:00.000Z', invoice_note: 'legacy-invoice',
         }),
         row('early-matched', 'matched', {
            service_transaction: 'early-matched-service', service_network: ALGORAND_TESTNET_CAIP2,
            service_payer: 'matched-owner', activation_round: 70, scan_after_round: 77,
            activated_at: '2026-06-01T00:02:00.000Z',
            matched_transaction: 'early-invoice-match', matched_round: 76,
         }),
         row('early-unknown', 'settlement_unknown'),
      ]);
      const before = allRows(database);
      assert.equal(database.prepare('PRAGMA table_info(roundwatch_watches)').all()
         .some(column => column.name === 'work_unit_budget'), false);
      assert.equal(database.prepare('PRAGMA table_info(roundwatch_watches)').all()
         .some(column => column.name === 'settlement_reconciliation_terminal'), false);
      database.close();

      const expected = expectedMigration(before, new Set([
         'early-pending', 'early-active', 'early-unknown',
      ]));
      for (const configuredBudget of [BUDGET, 73]) {
         store = new RoundWatchStore(path, { workUnitBudget: configuredBudget, now: () => NOW });
         const migrated = databaseOf(store);
         assert.deepEqual(allRows(migrated), expected,
            'only new migration defaults and open budgets may differ from historical storage');
         assert.equal(store.getWatch('early-unknown')?.settlementReconciliationTerminal, false);
         assert.equal(store.getWatch('early-unknown')?.workUnitBudget, BUDGET,
            'historical missing terminal flag still defaults to a nonterminal open obligation');
         assert.equal(store.getWatch('early-matched')?.workUnitBudget, undefined);
         assertBudgetColumnSemantics(migrated);
         assertIdempotencyPreserved(store, before);
         assert.deepEqual(allRows(migrated), expected, 'replay must not manufacture proof or mutate rows');
         store.close();
         store = undefined;
      }
   } finally {
      store?.close();
      rmSync(directory, { recursive: true, force: true });
   }
});

test('expiry-capable pre-budget schema preserves evidence, expiry, lifecycle, and idempotency', () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-budget-expiry-'));
   const path = join(directory, 'watch.sqlite');
   let store: RoundWatchStore | undefined;
   try {
      const database = new DatabaseSync(path);
      database.exec(EXPIRY_SCHEMA);
      const proof = {
         expected_service_transaction: 'prepared-proof', expected_service_network: ALGORAND_TESTNET_CAIP2,
         expected_service_payer: 'historical-owner', service_receiver: 'historical-service-receiver',
         service_asset_id: 10458941, service_atomic_amount: '20000', service_first_valid: 50,
         service_last_valid: 70, evidence_version: 1,
      };
      insertRows(database, [
         row('later-pending', 'settlement_pending', {
            ...proof, expires_at: '2026-06-01T00:30:00.000Z', reconciliation_attempts: 7,
            reconciliation_next_attempt_at: '2027-01-01T00:00:00.000Z',
         }),
         row('later-pending-terminal-flag', 'settlement_pending', { settlement_reconciliation_terminal: 1 }),
         row('later-active-terminal-flag', 'active', { settlement_reconciliation_terminal: 1 }),
         row('later-active', 'active', {
            service_transaction: 'later-service', service_network: ALGORAND_TESTNET_CAIP2,
            service_payer: 'service-owner', activation_round: 91, scan_after_round: 101,
            activated_at: '2026-06-01T00:01:00.000Z', expires_at: '2026-06-01T00:30:00.000Z',
            closing_round: 120, invoice_note: 'retained-note',
         }),
         row('later-unknown-open', 'settlement_unknown', {
            reconciliation_attempts: 9, reconciliation_next_attempt_at: '2027-01-01T00:00:00.000Z',
         }),
         row('later-unknown-terminal', 'settlement_unknown', {
            settlement_reconciliation_terminal: 1, reconciliation_attempts: 11,
         }),
         row('later-matched', 'matched', {
            expected_service_transaction: 'later-matched-proof', expected_service_network: ALGORAND_TESTNET_CAIP2,
            expected_service_payer: 'matched-owner', evidence_version: 1,
            service_receiver: 'stored-service-receiver', service_asset_id: 10458941,
            service_atomic_amount: '20000', service_first_valid: 80, service_last_valid: 99,
            service_transaction: 'later-matched-service', service_network: ALGORAND_TESTNET_CAIP2,
            service_payer: 'matched-owner', activation_round: 98, scan_after_round: 105,
            activated_at: '2026-06-01T00:02:00.000Z', expires_at: '2026-06-01T00:30:00.000Z',
            matched_transaction: 'later-invoice-match', matched_round: 104, closing_round: 110,
         }),
         row('later-expired', 'expired', {
            evidence_version: 1, closing_round: 200, scan_after_round: 201,
            expires_at: '2026-06-01T00:30:00.000Z',
         }),
      ]);
      const before = allRows(database);
      assert.equal(database.prepare('PRAGMA table_info(roundwatch_watches)').all()
         .some(column => column.name === 'work_unit_budget'), false);
      database.close();
      const expected = expectedMigration(before, new Set([
         'later-pending', 'later-pending-terminal-flag', 'later-active',
         'later-active-terminal-flag', 'later-unknown-open',
      ]));

      for (const configuredBudget of [BUDGET, 83]) {
         store = new RoundWatchStore(path, { workUnitBudget: configuredBudget, now: () => NOW });
         const migrated = databaseOf(store);
         assert.deepEqual(allRows(migrated), expected,
            'migration must preserve all stored proof, expiry, scan, reconciliation, and state columns');
         assert.equal(store.getWatch('later-unknown-terminal')?.workUnitBudget, undefined);
         assert.equal(store.getWatch('later-matched')?.workUnitBudget, undefined);
         assert.equal(store.getWatch('later-expired')?.workUnitBudget, undefined);
         assert.equal(store.getWatch('later-unknown-open')?.evidenceVersion, 0);
         assert.equal(store.getWatch('later-unknown-open')?.expectedServiceTransaction, undefined);
         assertBudgetColumnSemantics(migrated);
         assertIdempotencyPreserved(store, before);
         assert.deepEqual(allRows(migrated), expected);
         store.close();
         store = undefined;
      }
   } finally {
      store?.close();
      rmSync(directory, { recursive: true, force: true });
   }
});

test('already populated terminal budgets and durable usage survive changed startup configuration', () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-budget-terminal-'));
   const path = join(directory, 'watch.sqlite');
   let store: RoundWatchStore | undefined;
   try {
      store = new RoundWatchStore(path, { workUnitBudget: BUDGET, now: () => NOW });
      const database = databaseOf(store);
      insertRows(database, [
         row('terminal-matched', 'matched', { work_unit_budget: 37, work_units_used: 2 }),
         row('terminal-expired', 'expired', { work_unit_budget: 41, work_units_used: 41 }),
         row('terminal-indeterminate', 'indeterminate', {
            work_unit_budget: 43, work_units_used: 44, terminal_reason: 'work_budget_exhausted',
         }),
         row('terminal-unknown', 'settlement_unknown', {
            settlement_reconciliation_terminal: 1, work_unit_budget: 47, work_units_used: 17,
         }),
         row('null-matched', 'matched', { work_units_used: 7 }),
         row('null-expired', 'expired', { work_units_used: 9 }),
         row('null-indeterminate', 'indeterminate', { work_units_used: 11 }),
         row('null-unknown-terminal', 'settlement_unknown', {
            settlement_reconciliation_terminal: 1, work_units_used: 13,
         }),
         row('open-active-below', 'active', { work_units_used: BUDGET - 1 }),
         row('open-pending-equal', 'settlement_pending', { work_units_used: BUDGET }),
         row('open-unknown-above', 'settlement_unknown', { work_units_used: BUDGET + 1 }),
      ]);
      const before = allRows(database);
      const expected = before.map(value => ({
         ...value,
         work_unit_budget: String(value.id).startsWith('open-') ? BUDGET : value.work_unit_budget!,
      }));
      store.close();
      store = undefined;

      for (const configuredBudget of [BUDGET, 97]) {
         store = new RoundWatchStore(path, { workUnitBudget: configuredBudget, now: () => NOW });
         assert.deepEqual(allRows(databaseOf(store)), expected,
            'only NULL open budgets change; every usage count and existing terminal budget survives');
         assertBudgetColumnSemantics(databaseOf(store));
         store.close();
         store = undefined;
      }
   } finally {
      store?.close();
      rmSync(directory, { recursive: true, force: true });
   }
});

for (const indexLayout of ['current', 'pre-C2', 'altered-existing'] as const) {
   test(`refund audit preserves NULL budgets, every row, and exact ${indexLayout} schema`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'roundwatch-budget-refund-'));
      const path = join(directory, 'watch.sqlite');
      let store: RoundWatchStore | undefined;
      try {
         store = new RoundWatchStore(path, { workUnitBudget: BUDGET, now: () => NOW });
         let database = databaseOf(store);
         insertRows(database, [
            row('audit-pending', 'settlement_pending', { work_units_used: 3 }),
            row('audit-active', 'active', { work_units_used: 31 }),
            row('audit-unknown-open', 'settlement_unknown', { work_units_used: 7 }),
            row('audit-unknown-terminal', 'settlement_unknown', {
               settlement_reconciliation_terminal: 1, work_units_used: 8,
            }),
            row('audit-matched', 'matched', { work_units_used: 9 }),
            row('audit-expired', 'expired', { work_units_used: 11 }),
            row('audit-indeterminate', 'indeterminate', {
               work_unit_budget: 23, work_units_used: 24, terminal_reason: 'work_budget_exhausted',
            }),
         ]);
         if (indexLayout !== 'current') {
            database.exec(`
               DROP INDEX ${OPEN_INDEX};
               CREATE INDEX roundwatch_open_payer_idx ON roundwatch_watches(
                  COALESCE(expected_service_payer, service_payer), state, settlement_reconciliation_terminal
               );
            `);
         }
         if (indexLayout === 'altered-existing') {
            // Audit mode must preserve existing index definitions verbatim,
            // even if normal migration would reject this incompatible index.
            database.exec(`
               CREATE INDEX ${OPEN_INDEX} ON roundwatch_watches(created_at)
               WHERE state = 'matched';
            `);
         }
         const beforeRows = allRows(database);
         const beforeSchema = schema(database);
         const beforeVersion = database.prepare('PRAGMA schema_version').get();
         const beforeRefunds = database.prepare('SELECT * FROM roundwatch_refunds ORDER BY id').all();
         store.close();
         store = undefined;

         store = new RoundWatchStore(path, {
            schemaMode: 'existing-refund-audit', workUnitBudget: 101, now: () => NOW,
         });
         database = databaseOf(store);
         assert.deepEqual(allRows(database), beforeRows, 'opening audit mode never repairs a NULL budget');
         assert.deepEqual(schema(database), beforeSchema, 'opening audit mode never creates or replaces an index');
         assert.deepEqual(database.prepare('PRAGMA schema_version').get(), beforeVersion);
         assert.deepEqual(database.prepare('SELECT * FROM roundwatch_refunds ORDER BY id').all(), beforeRefunds);

         const evidence = store.recordRefundEvidence('audit-matched', {
            transaction: 'A'.repeat(51) + 'Q', network: ALGORAND_TESTNET_CAIP2,
            atomicAmount: '20000', reason: 'offline operator refund evidence',
         });
         assert.deepEqual(evidence, {
            id: 1, watchId: 'audit-matched', transaction: 'A'.repeat(51) + 'Q',
            network: ALGORAND_TESTNET_CAIP2, atomicAmount: '20000',
            reason: 'offline operator refund evidence', recordedAt: NOW.toISOString(),
         });
         assert.deepEqual(store.listRefundEvidence('audit-matched'), [evidence]);
         assert.deepEqual(allRows(database), beforeRows, 'refund evidence remains separate from every lifecycle field');
         assert.deepEqual(schema(database), beforeSchema);
         assert.deepEqual(database.prepare('PRAGMA schema_version').get(), beforeVersion);
         store.close();
         store = undefined;

         store = new RoundWatchStore(path, {
            schemaMode: 'existing-refund-audit', workUnitBudget: 103, now: () => NOW,
         });
         assert.deepEqual(allRows(databaseOf(store)), beforeRows);
         assert.deepEqual(schema(databaseOf(store)), beforeSchema);
         assert.deepEqual(store.listRefundEvidence('audit-matched'), [evidence]);
      } finally {
         store?.close();
         rmSync(directory, { recursive: true, force: true });
      }
   });
}
