import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import { currentWorkClaim } from './roundwatch-test-claims.js';
import { RoundWatchStore, type WatchRecord, type WatchState } from './roundwatch-store.js';

const OPEN_INDEX = 'roundwatch_open_obligations_idx';
const NOW = new Date('2026-10-06T12:00:00.000Z');
const BUDGET = 5;
const databaseOf = (store: RoundWatchStore) =>
   (store as unknown as { database: DatabaseSync }).database;
type Row = Record<string, SQLInputValue>;
const rowsOf = (database: DatabaseSync) => database.prepare(
   'SELECT * FROM roundwatch_watches ORDER BY id',
).all().map(row => ({ ...row })) as Row[];

interface Fixture {
   id: string;
   state: WatchState;
   terminal?: number;
   budget?: number;
   used?: number;
}

// Deliberately no payer, transaction, or proof terms; retry times are in the
// future and deadlines in the past. None may narrow the migration envelope.
const OPEN_ROWS: Fixture[] = [
   { id: 'pending-null', state: 'settlement_pending', used: 0 },
   { id: 'pending-flagged-null', state: 'settlement_pending', terminal: 1, used: 9 },
   { id: 'active-null', state: 'active', used: 4 },
   { id: 'active-flagged-null', state: 'active', terminal: 1, used: 5 },
   { id: 'unknown-null', state: 'settlement_unknown', used: 9 },
   { id: 'pending-budget', state: 'settlement_pending', budget: 13, used: 7 },
   { id: 'active-budget', state: 'active', budget: 17, used: 2 },
   { id: 'unknown-budget', state: 'settlement_unknown', budget: 19, used: 20 },
];

function insertRows(database: DatabaseSync, fixtures: Fixture[]): void {
   const insert = database.prepare(`
      INSERT INTO roundwatch_watches (
         id, idempotency_key, state, expected_sender, expected_receiver,
         asset_id, atomic_amount, created_at, settlement_reconciliation_terminal,
         work_unit_budget, work_units_used, expires_at,
         reconciliation_next_attempt_at, polling_retry_at
      ) VALUES (?, ?, ?, 'sender', 'receiver', 1, '1', ?, ?, ?, ?, ?, ?, ?)
   `);
   database.exec('BEGIN IMMEDIATE;');
   try {
      for (const fixture of fixtures) {
         insert.run(fixture.id, fixture.id, fixture.state, NOW.toISOString(),
            fixture.terminal ?? 0, fixture.budget ?? null, fixture.used ?? 0,
            '2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
      }
      database.exec('COMMIT;');
   } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
   }
}

interface Backfill {
   sql: string;
   bindings: SQLInputValue[];
   plan: string[];
   changes: number | bigint;
}

function captureBackfills(t: TestContext): Backfill[] {
   const prepare = DatabaseSync.prototype.prepare;
   const captured: Backfill[] = [];
   // Capture the constructor's actual production statement at its execution
   // boundary. Tests must fail if production is changed but a SQL copy is not.
   t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (/^\s*UPDATE\s+roundwatch_watches\b/i.test(sql) && /SET\s+work_unit_budget\s*=/i.test(sql)) {
         const run = statement.run.bind(statement);
         t.mock.method(statement, 'run', (...bindings: SQLInputValue[]) => {
            const plan = prepare.call(this, `EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{ detail: string }>;
            const result = run(...bindings);
            captured.push({ sql, bindings, plan: plan.map(row => row.detail), changes: result.changes });
            return result;
         });
      }
      return statement;
   });
   return captured;
}

function assertOpenPlan(plan: string[]): void {
   const accesses = plan.filter(detail => /\b(?:SCAN|SEARCH)\s+roundwatch_watches\b/i.test(detail));
   assert.ok(accesses.length > 0, `missing watch access: ${plan.join('; ')}`);
   for (const detail of accesses) {
      assert.match(detail, /\bUSING INDEX roundwatch_open_obligations_idx\b/i);
   }
}

function assertIndex(database: DatabaseSync): void {
   const indexes = database.prepare('PRAGMA index_list(roundwatch_watches)').all() as Array<{ name: string; partial: number }>;
   assert.equal(indexes.find(row => row.name === OPEN_INDEX)?.partial, 1);
   const index = database.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(OPEN_INDEX) as { sql: string };
   assert.match(index.sql, /ON roundwatch_watches\(COALESCE\(expected_service_payer, service_payer\)\)/i);
   assert.equal(index.sql.split(/\bWHERE\b/i)[1]!.trim().replace(/\s+/g, ' '),
      "state IN ('settlement_pending', 'active') OR (state = 'settlement_unknown' AND settlement_reconciliation_terminal = 0)");
   const columns = database.prepare('PRAGMA table_info(roundwatch_watches)').all() as Array<{
      name: string; notnull: number; dflt_value: string | null;
   }>;
   assert.deepEqual({ ...columns.find(column => column.name === 'work_unit_budget') }, {
      cid: columns.findIndex(column => column.name === 'work_unit_budget'),
      name: 'work_unit_budget', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0,
   });
   const usage = columns.find(column => column.name === 'work_units_used')!;
   assert.equal(usage.notnull, 1);
   assert.equal(usage.dflt_value, '0');
}

test('C4 startup repairs only the tiny open set beside 20,000 terminal rows', async t => {
   for (const openFirst of [true, false]) {
      await t.test(`open rows ${openFirst ? 'first, forward' : 'last, reversed'}`, t => {
         const directory = mkdtempSync(join(tmpdir(), 'roundwatch-budget-history-'));
         const path = join(directory, 'watch.sqlite');
         let store: RoundWatchStore | undefined;
         try {
            store = new RoundWatchStore(path);
            let database = databaseOf(store);
            const terminalStates: WatchState[] = ['matched', 'expired', 'indeterminate', 'settlement_unknown'];
            const history: Fixture[] = Array.from({ length: 20_000 }, (_, i) => ({
               id: `history-${i}`, state: terminalStates[i % 4]!,
               terminal: i % 4 === 3 ? 1 : i % 2,
               ...(i % 7 === 0 ? { budget: 23 } : {}), used: i % 11,
            }));
            insertRows(database, openFirst ? [...OPEN_ROWS, ...history] : [...history.reverse(), ...[...OPEN_ROWS].reverse()]);
            const before = rowsOf(database);
            assert.equal(before.length, 20_008);
            const openNullIds = new Set(OPEN_ROWS.filter(row => row.budget === undefined).map(row => row.id));
            const expected = before.map(row => openNullIds.has(row.id as string)
               ? { ...row, work_unit_budget: BUDGET } : row);
            store.close();
            store = undefined;

            const backfills = captureBackfills(t);
            store = new RoundWatchStore(path, { workUnitBudget: BUDGET });
            database = databaseOf(store);
            assert.equal(backfills.length, 1);
            const backfill = backfills[0]!;
            assert.match(backfill.sql, /\bINDEXED BY roundwatch_open_obligations_idx\b/);
            assert.deepEqual(backfill.bindings, [BUDGET]);
            assert.equal(backfill.changes, 5);
            assertOpenPlan(backfill.plan);
            assertIndex(database);
            assert.deepEqual(rowsOf(database), expected, 'every column except the five NULL open budgets is unchanged');
            t.diagnostic(`production backfill: ${backfill.plan.join('; ')}`);

            // Unforced choice is diagnostic only: a different SQLite optimizer
            // may legitimately select the open index. The production SQL
            // assertion above is the negative control for losing INDEXED BY.
            const unforced = backfill.sql.replace(/\s+INDEXED BY roundwatch_open_obligations_idx\b/i, '');
            const unforcedPlan = database.prepare(`EXPLAIN QUERY PLAN ${unforced}`).all(BUDGET) as Array<{ detail: string }>;
            t.diagnostic(`without forced index before statistics: ${unforcedPlan.map(row => row.detail).join('; ')}`);
            database.exec('ANALYZE;');
            const analyzedPlan = database.prepare(`EXPLAIN QUERY PLAN ${backfill.sql}`).all(BUDGET) as Array<{ detail: string }>;
            assertOpenPlan(analyzedPlan.map(row => row.detail));

            // Fail closed if the required path disappears; never table-scan.
            database.exec(`DROP INDEX ${OPEN_INDEX};`);
            assert.throws(() => database.prepare(backfill.sql).run(BUDGET), /no such index/i);
            database.exec(`CREATE INDEX ${OPEN_INDEX} ON roundwatch_watches(state) WHERE state = 'active';`);
            assert.throws(() => database.prepare(backfill.sql).run(BUDGET), /no query solution/i);
            database.exec(`DROP INDEX ${OPEN_INDEX};`);
            store.close();
            store = undefined;

            // Simulates pre-C2 index creation. Reopening ensures it before repair.
            for (const budget of [2, 31]) {
               store = new RoundWatchStore(path, { workUnitBudget: budget });
               database = databaseOf(store);
               assertIndex(database);
               assert.deepEqual(rowsOf(database), expected);
               assert.equal(backfills.at(-1)?.changes, 0);
               assert.deepEqual(backfills.at(-1)?.bindings, [budget]);
               assertOpenPlan(backfills.at(-1)!.plan);
               store.close();
               store = undefined;
            }
         } finally {
            store?.close();
            rmSync(directory, { recursive: true, force: true });
         }
      });
   }
});

test('C4 semantic assertions reject incorrect budget-repair variants', t => {
   const store = new RoundWatchStore(':memory:');
   const database = databaseOf(store);
   try {
      insertRows(database, [...OPEN_ROWS,
         ...(['matched', 'expired', 'indeterminate', 'settlement_unknown'] as const).map(state => ({
            id: `terminal-${state}`, state, terminal: 1, used: 8,
         })),
      ]);
      const before = rowsOf(database);
      const openNullIds = new Set(OPEN_ROWS.filter(row => row.budget === undefined).map(row => row.id));
      const expected = before.map(row => openNullIds.has(row.id as string) ? { ...row, work_unit_budget: BUDGET } : row);
      const captured = captureBackfills(t);
      // Observe the actual constructor SQL without requiring it to be exported.
      const probe = new RoundWatchStore(':memory:', { workUnitBudget: BUDGET });
      probe.close();
      const production = captured[0]!.sql;
      const unforced = production.replace(/\s+INDEXED BY roundwatch_open_obligations_idx\b/i, '');
      const open = "state IN ('settlement_pending', 'active') OR (state = 'settlement_unknown' AND settlement_reconciliation_terminal = 0)";
      const update = (where: string, set = 'work_unit_budget = ?') => `UPDATE roundwatch_watches SET ${set} WHERE ${where}`;
      const variants: Array<[string, string]> = [
         ['unconditional history repair', update('work_unit_budget IS NULL')],
         ['includes terminal unknown', update("state IN ('settlement_pending', 'active', 'settlement_unknown') AND work_unit_budget IS NULL")],
         ['global terminal flag', update("state IN ('settlement_pending', 'active', 'settlement_unknown') AND settlement_reconciliation_terminal = 0 AND work_unit_budget IS NULL")],
         ['incorrect OR grouping', update(`${open} AND work_unit_budget IS NULL`)],
         ['resets durable usage', update(`(${open}) AND work_unit_budget IS NULL`, 'work_unit_budget = ?, work_units_used = 0')],
         ...[
            'expected_service_payer IS NOT NULL', 'expected_service_transaction IS NOT NULL',
            'service_receiver IS NOT NULL', 'evidence_version > 0',
            "reconciliation_next_attempt_at <= '2026-10-06'", "polling_retry_at <= '2026-10-06'",
            "expires_at > '2026-10-06'", 'work_units_used < 5',
         ].map(filter => [filter, `${unforced} AND ${filter}`] as [string, string]),
      ];
      const executeAndCheck = (sql: string) => {
         database.exec('SAVEPOINT negative_control;');
         try {
            database.prepare(sql).run(BUDGET);
            assert.deepEqual(rowsOf(database), expected);
         } finally {
            database.exec('ROLLBACK TO negative_control; RELEASE negative_control;');
         }
      };
      executeAndCheck(production);
      for (const [label, sql] of variants) {
         assert.throws(() => executeAndCheck(sql), assert.AssertionError, label);
      }
      assert.deepEqual(rowsOf(database), before);
   } finally { store.close(); }
});

test('C4 changed configuration repairs newly encountered NULL opens without overwriting prior budgets', () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-budget-config-'));
   const path = join(directory, 'watch.sqlite');
   let store: RoundWatchStore | undefined;
   try {
      store = new RoundWatchStore(path);
      insertRows(databaseOf(store), [{ id: 'first-open', state: 'active', used: 7 }]);
      store.close();
      store = new RoundWatchStore(path, { workUnitBudget: 11 });
      assert.equal(store.getWatch('first-open')?.workUnitBudget, 11);
      insertRows(databaseOf(store), [
         { id: 'later-open', state: 'settlement_pending', used: 9 },
         { id: 'later-terminal', state: 'matched', used: 13 },
      ]);
      const before = rowsOf(databaseOf(store));
      store.close();
      store = new RoundWatchStore(path, { workUnitBudget: 17 });
      const expected = before.map(row => row.id === 'later-open' ? { ...row, work_unit_budget: 17 } : row);
      assert.deepEqual(rowsOf(databaseOf(store)), expected);
      store.close();
      store = new RoundWatchStore(path, { workUnitBudget: 23 });
      assert.deepEqual(rowsOf(databaseOf(store)), expected);
   } finally {
      store?.close();
      rmSync(directory, { recursive: true, force: true });
   }
});

const OPEN_PREDICATE = "state IN ('settlement_pending', 'active') OR (state = 'settlement_unknown' AND settlement_reconciliation_terminal = 0)";
const INDEX_KEY = 'COALESCE(expected_service_payer, service_payer)';
const equivalentIndexes = [
   { label: 'canonical C2', predicate: OPEN_PREDICATE },
   { label: 'lowercase keywords', predicate: "state in ('settlement_pending', 'active') or (state = 'settlement_unknown' and settlement_reconciliation_terminal = 0)" },
   { label: 'compact punctuation', predicate: "state IN('settlement_pending','active') OR(state='settlement_unknown' AND settlement_reconciliation_terminal=0)" },
   { label: 'double-quoted identifiers', predicate: '"state" IN (\'settlement_pending\', \'active\') OR ("state" = \'settlement_unknown\' AND "settlement_reconciliation_terminal" = 0)' },
   { label: 'identifier case', predicate: "STATE IN ('settlement_pending', 'active') OR (State = 'settlement_unknown' AND SETTLEMENT_RECONCILIATION_TERMINAL = 0)" },
   { label: 'redundant parentheses', predicate: `(((${OPEN_PREDICATE})))` },
   { label: 'case-equivalent index name', predicate: OPEN_PREDICATE, name: OPEN_INDEX.toUpperCase() },
   { label: 'whitespace and newlines', predicate: OPEN_PREDICATE.replace(/ /g, '\n\t') },
   { label: 'harmless comments and WHERE string in key', predicate: "state /* WHERE matched */ IN ('settlement_pending', 'active') -- WHERE expired\n OR (state = 'settlement_unknown' AND /* WHERE terminal */ settlement_reconciliation_terminal = 0)", key: "COALESCE(expected_service_payer, service_payer, 'WHERE harmless')" },
   { label: 'backtick and bracket identifiers', predicate: "`state` IN ('settlement_pending', 'active') OR ([state] = 'settlement_unknown' AND [settlement_reconciliation_terminal] = 0)" },
   { label: 'quoted uppercase table and key identifiers', predicate: OPEN_PREDICATE, table: '"ROUNDWATCH_WATCHES"', key: 'COALESCE("EXPECTED_SERVICE_PAYER", "SERVICE_PAYER")' },
   { label: 'EOF-terminated block comment', predicate: `${OPEN_PREDICATE}\n/* trailing comment` },
   { label: 'misleading WHERE inside EOF block comment', predicate: `${OPEN_PREDICATE}\n/* WHERE state = 'matched' WHERE ${OPEN_PREDICATE}` },
   { label: 'EOF block comment with trailing text and spaces', predicate: `${OPEN_PREDICATE}\n/* trailing ordinary text   ` },
   { label: 'standalone BOM before predicate', predicate: `\uFEFF${OPEN_PREDICATE}` },
   { label: 'standalone BOM after opening grouping parenthesis', predicate: `(\uFEFF${OPEN_PREDICATE})` },
   { label: 'standalone BOM between word tokens', predicate: OPEN_PREDICATE.replace('state IN', 'state \uFEFFIN') },
   { label: 'standalone BOM after closing string literal', predicate: OPEN_PREDICATE.replace("'settlement_unknown'", "'settlement_unknown'\uFEFF") },
   { label: 'BOM and misleading WHERE preserved inside string key', predicate: OPEN_PREDICATE, key: "COALESCE(expected_service_payer, service_payer, 'BOM\uFEFF WHERE harmless')" },
];

for (const variant of equivalentIndexes) {
   test(`C4 equivalent open index starts normally: ${variant.label}`, t => {
      const directory = mkdtempSync(join(tmpdir(), 'roundwatch-budget-equivalent-index-'));
      const path = join(directory, 'watch.sqlite');
      let store: RoundWatchStore | undefined;
      try {
         store = new RoundWatchStore(path);
         let database = databaseOf(store);
         insertRows(database, [...OPEN_ROWS, { id: 'terminal', state: 'matched', used: 8 }]);
         database.exec(`DROP INDEX ${OPEN_INDEX}; CREATE INDEX ${variant.name ?? OPEN_INDEX}
            ON ${variant.table ?? 'roundwatch_watches'}(${variant.key ?? INDEX_KEY})
            /* WHERE misleading header */ WHERE ${variant.predicate};`);
         const before = rowsOf(database);
         const ddl = database.prepare('SELECT sql FROM sqlite_schema WHERE name = ?')
            .get(variant.name ?? OPEN_INDEX);
         assert.ok(String(ddl!.sql).includes(variant.predicate), 'SQLite retains the predicate including comment/BOM contents');
         store.close();
         store = undefined;
         const backfills = captureBackfills(t);
         store = new RoundWatchStore(path, { workUnitBudget: BUDGET });
         database = databaseOf(store);
         const indexes = database.prepare('PRAGMA index_list(roundwatch_watches)').all();
         const resolved = indexes.filter(row => String(row.name).toLowerCase() === OPEN_INDEX);
         assert.equal(resolved.length, 1);
         assert.equal(resolved[0]!.partial, 1);
         const schema = database.prepare('SELECT sql, tbl_name FROM sqlite_schema WHERE name = ?')
            .get(resolved[0]!.name as string)!;
         assert.equal(String(schema.tbl_name).toLowerCase(), 'roundwatch_watches');
         assert.equal(schema.sql, ddl!.sql, 'equivalent existing DDL is preserved verbatim');
         assert.equal(backfills.length, 1);
         const repair = backfills[0]!;
         assert.match(repair.sql, /\bINDEXED BY roundwatch_open_obligations_idx\b/);
         assertOpenPlan(repair.plan);
         assert.ok(repair.plan.some(detail => /\bSCAN roundwatch_watches USING INDEX roundwatch_open_obligations_idx\b/i.test(detail)),
            `expected partial-index scan: ${repair.plan.join('; ')}`);
         assert.equal(repair.changes, 5);
         const openNullIds = new Set(OPEN_ROWS.filter(row => row.budget === undefined).map(row => row.id));
         assert.deepEqual(rowsOf(database), before.map(row => openNullIds.has(row.id as string)
            ? { ...row, work_unit_budget: BUDGET } : row));
         t.diagnostic(`partial=1; ${repair.plan.join('; ')}`);
      } finally {
         store?.close();
         rmSync(directory, { recursive: true, force: true });
      }
   });
}

const fakeWhere = `/* WHERE ${OPEN_PREDICATE} WHERE */`;
const wrongIndexes = [
   { label: 'full index', suffix: '', partial: 0, usable: true },
   { label: 'broader terminal unknown', suffix: "WHERE state IN ('settlement_pending', 'active', 'settlement_unknown')", partial: 1, usable: false },
   { label: 'narrower active only', suffix: "WHERE state = 'active'", partial: 1, usable: false },
   { label: 'full index with block-comment spoof', suffix: fakeWhere, partial: 0, usable: true, spoof: true },
   { label: 'broader matched with block-comment spoof', suffix: `${fakeWhere} WHERE (${OPEN_PREDICATE}) OR state = 'matched'`, partial: 1, usable: true, spoof: true },
   { label: 'actual extra terminal OR term', suffix: `WHERE (${OPEN_PREDICATE}) OR state = 'expired'`, partial: 1, usable: true },
   { label: 'actual extra narrowing condition', suffix: `WHERE (${OPEN_PREDICATE}) AND settlement_reconciliation_terminal = 0`, partial: 1, usable: false },
   { label: 'line-comment spoof before broader predicate', suffix: `-- WHERE ${OPEN_PREDICATE} WHERE\n WHERE (${OPEN_PREDICATE}) OR state = 'matched'`, partial: 1, usable: true, spoof: true },
   { label: 'WHERE inside string key before broader predicate', suffix: `WHERE (${OPEN_PREDICATE}) OR state = 'matched'`, key: `COALESCE(expected_service_payer, 'WHERE ${OPEN_PREDICATE.replace(/'/g, "''")} WHERE')`, partial: 1, usable: true },
   { label: 'WHERE inside quoted key before broader predicate', suffix: `WHERE (${OPEN_PREDICATE}) OR state = 'matched'`, key: '"WHERE misleading"', partial: 1, usable: true, quotedColumn: true },
   { label: 'case-changed literal data', suffix: `WHERE ${OPEN_PREDICATE.replace('settlement_pending', 'SETTLEMENT_PENDING')}`, partial: 1, usable: false },
   { label: 'escaped literal with misleading WHERE', suffix: `WHERE ${OPEN_PREDICATE.replace("'active'", "'active'' WHERE matched'")}`, partial: 1, usable: false },
   { label: 'unknown additional column', suffix: `WHERE (${OPEN_PREDICATE}) AND work_units_used = 0`, partial: 1, usable: false },
   { label: 'unsupported operator', suffix: `WHERE ${OPEN_PREDICATE.replace('settlement_reconciliation_terminal = 0', 'settlement_reconciliation_terminal != 1')}`, partial: 1, usable: false },
   { label: 'wrong integer literal', suffix: `WHERE ${OPEN_PREDICATE.replace('= 0', '= 1')}`, partial: 1, usable: false },
   { label: 'non-SQL whitespace disguises a different column', suffix: `WHERE ${OPEN_PREDICATE.replace(/\bstate\b/g, 'state\u00a0')}`, partial: 1, usable: false, extraColumn: 'state\u00a0' },
   { label: 'broader real predicate before EOF block comment', suffix: `WHERE (${OPEN_PREDICATE}) OR state = 'matched'\n/* harmless trailing comment`, partial: 1, usable: true },
   { label: 'full index with EOF block-comment spoof', suffix: `/* WHERE ${OPEN_PREDICATE}`, partial: 0, usable: true },
   { label: 'broader predicate with EOF block-comment spoof', suffix: `WHERE (${OPEN_PREDICATE}) OR state = 'matched'\n/* WHERE ${OPEN_PREDICATE} WHERE`, partial: 1, usable: true },
   { label: 'BOM embedded within unquoted column', suffix: `WHERE ${OPEN_PREDICATE.replace(/\bstate\b/g, 'st\uFEFFate')}`, partial: 1, usable: false, extraColumn: 'st\uFEFFate' },
   { label: 'BOM at end of unquoted column', suffix: `WHERE ${OPEN_PREDICATE.replace(/\bstate\b/g, 'state\uFEFF')}`, partial: 1, usable: false, extraColumn: 'state\uFEFF' },
   ...['"', '`', '['].map(quote => ({
      label: `BOM preserved inside ${quote} quoted column`,
      suffix: `WHERE ${OPEN_PREDICATE.replace(/\bstate\b/g, `${quote}state\uFEFF${quote === '[' ? ']' : quote}`)}`,
      partial: 1, usable: false, extraColumn: 'state\uFEFF',
   })),
   { label: 'BOM preserved inside string literal', suffix: `WHERE ${OPEN_PREDICATE.replace("'active'", "'active\uFEFF'")}`, partial: 1, usable: false },
   { label: 'reordered OR', suffix: "WHERE (state = 'settlement_unknown' AND settlement_reconciliation_terminal = 0) OR state IN ('settlement_pending', 'active')", partial: 1, usable: false, equivalent: true },
   { label: 'reordered AND', suffix: "WHERE state IN ('settlement_pending', 'active') OR (settlement_reconciliation_terminal = 0 AND state = 'settlement_unknown')", partial: 1, usable: false, equivalent: true },
   { label: 'reordered IN', suffix: `WHERE ${OPEN_PREDICATE.replace("'settlement_pending', 'active'", "'active', 'settlement_pending'")}`, partial: 1, usable: false, equivalent: true },
];

for (const variant of wrongIndexes) {
   test(`C4 normal startup ${variant.equivalent ? 'checks native compatibility' : 'rejects incompatible index'}: ${variant.label}`, t => {
      const directory = mkdtempSync(join(tmpdir(), 'roundwatch-budget-wrong-index-'));
      const path = join(directory, 'watch.sqlite');
      let database: DatabaseSync | undefined;
      try {
         const backfills = captureBackfills(t);
         const initial = new RoundWatchStore(path);
         const production = backfills[0]!.sql;
         insertRows(databaseOf(initial), OPEN_ROWS);
         initial.close();
         database = new DatabaseSync(path);
         database.exec(`DROP INDEX ${OPEN_INDEX};`);
         if (variant.quotedColumn) database.exec('ALTER TABLE roundwatch_watches ADD COLUMN "WHERE misleading" TEXT;');
         if (variant.extraColumn) database.exec(`ALTER TABLE roundwatch_watches ADD COLUMN "${variant.extraColumn}" TEXT;`);
         database.exec(`CREATE INDEX ${OPEN_INDEX} ON roundwatch_watches(${variant.key ?? INDEX_KEY}) ${variant.suffix};`);
         const before = rowsOf(database);
         const metadata = database.prepare('PRAGMA index_list(roundwatch_watches)').all()
            .find(row => row.name === OPEN_INDEX)!;
         assert.equal(metadata.partial, variant.partial);
         const ddl = database.prepare('SELECT sql, tbl_name FROM sqlite_schema WHERE name = ?').get(OPEN_INDEX)!;
         assert.equal(ddl.tbl_name, 'roundwatch_watches');
         if (variant.spoof) {
            assert.equal(String(ddl.sql).split(/\bWHERE\b/i)[1]!.trim().replace(/\s+/g, ' '), OPEN_PREDICATE,
               'this adversarial DDL would pass the old text validator');
         }
         let forcedPlan: string[] | undefined;
         try {
            const plan = database.prepare(`EXPLAIN QUERY PLAN ${production}`).all(BUDGET) as Array<{ detail: string }>;
            forcedPlan = plan.map(row => row.detail);
         } catch (error) {
            assert.match((error as Error).message, /no query solution/i);
         }
         // Demonstrate that the spoof/full/broader cases can execute the forced
         // repair. Other native planner outcomes are observations, not required
         // failures: future SQLite versions may prove more implications.
         if (variant.usable) assert.ok(forcedPlan, 'adversarial index must support the forced SQL');
         if (forcedPlan) {
            assertOpenPlan(forcedPlan);
            database.exec('SAVEPOINT forced_probe;');
            try {
               assert.equal(database.prepare(production).run(BUDGET).changes, 5);
            } finally {
               database.exec('ROLLBACK TO forced_probe; RELEASE forced_probe;');
            }
            t.diagnostic(`partial=${metadata.partial}; forced SQL prepares/runs`);
         } else {
            t.diagnostic(`partial=${metadata.partial}; native forced SQL has no query solution`);
         }
         const executedRepairs = backfills.length;
         // Capture the failed constructor's connection so the test closes it.
         const prepare = DatabaseSync.prototype.prepare;
         const captured: DatabaseSync[] = [];
         const mock = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
            if (this !== database && !captured.includes(this)) captured.push(this);
            return prepare.call(this, sql);
         });
         try {
            if (variant.equivalent && forcedPlan) {
               const accepted = new RoundWatchStore(path, { workUnitBudget: BUDGET });
               try {
                  assert.equal(backfills.length, executedRepairs + 1);
                  assert.match(backfills.at(-1)!.sql, /\bINDEXED BY roundwatch_open_obligations_idx\b/);
                  assertOpenPlan(backfills.at(-1)!.plan);
                  assert.equal(backfills.at(-1)!.changes, 5);
                  const openNullIds = new Set(OPEN_ROWS.filter(row => row.budget === undefined).map(row => row.id));
                  assert.deepEqual(rowsOf(database), before.map(row => openNullIds.has(row.id as string)
                     ? { ...row, work_unit_budget: BUDGET } : row));
               } finally { accepted.close(); }
            } else {
               assert.throws(() => new RoundWatchStore(path, { workUnitBudget: BUDGET }),
                  variant.equivalent
                     ? /partial predicate usable by the forced repair/
                     : /requires roundwatch_open_obligations_idx with the open-obligation partial predicate$/);
               assert.equal(captured.length, 1);
               assert.equal(captured[0]!.isOpen, false, 'failed index validation closes the constructor connection');
               assert.equal(backfills.length, executedRepairs, 'rejected startup executes no budget repair');
               assert.deepEqual(rowsOf(database), before, 'bad index must fail before changing any budget');
            }
         } finally {
            mock.mock.restore();
            for (const connection of captured) if (connection.isOpen) connection.close();
         }
      } finally {
         database?.close();
         rmSync(directory, { recursive: true, force: true });
      }
   });
}

test('C4 normal startup rejects an identically named partial index on another table', t => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-budget-index-owner-'));
   const path = join(directory, 'watch.sqlite');
   let database: DatabaseSync | undefined;
   try {
      const backfills = captureBackfills(t);
      const initial = new RoundWatchStore(path);
      insertRows(databaseOf(initial), OPEN_ROWS);
      initial.close();
      database = new DatabaseSync(path);
      database.exec(`DROP INDEX ${OPEN_INDEX};
         CREATE TABLE other_watches (state TEXT, settlement_reconciliation_terminal INTEGER,
            expected_service_payer TEXT, service_payer TEXT);
         CREATE INDEX ${OPEN_INDEX} ON other_watches(${INDEX_KEY}) WHERE ${OPEN_PREDICATE};`);
      assert.equal(database.prepare('PRAGMA index_list(roundwatch_watches)').all()
         .some(row => row.name === OPEN_INDEX), false);
      assert.equal(database.prepare('PRAGMA index_list(other_watches)').all()
         .find(row => row.name === OPEN_INDEX)!.partial, 1);
      assert.equal(database.prepare('SELECT tbl_name FROM sqlite_schema WHERE name = ?')
         .get(OPEN_INDEX)!.tbl_name, 'other_watches');
      const before = rowsOf(database);
      assert.throws(() => new RoundWatchStore(path, { workUnitBudget: BUDGET }),
         /requires roundwatch_open_obligations_idx with the open-obligation partial predicate/);
      assert.equal(backfills.length, 1, 'only the initial valid constructor ran its repair');
      assert.deepEqual(rowsOf(database), before);
   } finally {
      database?.close();
      rmSync(directory, { recursive: true, force: true });
   }
});

test('C4 missing required index at startup fails explicitly without a fallback repair', t => {
   const exec = DatabaseSync.prototype.exec;
   let database: DatabaseSync | undefined;
   t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
      exec.call(this, sql);
      if (/CREATE INDEX IF NOT EXISTS roundwatch_open_obligations_idx/.test(sql)) {
         database = this;
         exec.call(this, `DROP INDEX ${OPEN_INDEX};`);
      }
   });
   try {
      assert.throws(() => new RoundWatchStore(':memory:'),
         /requires roundwatch_open_obligations_idx with the open-obligation partial predicate/);
      assert.equal(database?.isOpen, false);
   } finally { if (database?.isOpen) database.close(); }
});

test('C4 NULL repairs preserve B4 purpose eligibility and usage below, at, and above budget', () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-budget-claim-'));
   const path = join(directory, 'watch.sqlite');
   let store: RoundWatchStore | undefined;
   try {
      store = new RoundWatchStore(path);
      const fixtures: Fixture[] = [];
      for (const state of ['settlement_pending', 'active', 'settlement_unknown'] as const) {
         for (const used of [BUDGET - 1, BUDGET, BUDGET + 1]) {
            fixtures.push({ id: `${state}-${used}`, state, used });
         }
      }
      fixtures.push({ id: 'pending-flagged', state: 'settlement_pending', terminal: 1, used: 1 },
         { id: 'active-flagged', state: 'active', terminal: 1, used: 1 });
      insertRows(databaseOf(store), fixtures);
      store.close();
      store = new RoundWatchStore(path, { workUnitBudget: BUDGET });
      for (const fixture of fixtures) {
         const repaired: WatchRecord = store.getWatch(fixture.id)!;
         assert.equal(repaired.workUnitBudget, BUDGET);
         assert.equal(repaired.workUnitsUsed, fixture.used);
         const purpose = fixture.state === 'active' ? 'polling' : 'reconciliation';
         // Migration eligibility deliberately includes missing proof/transaction
         // terms and future retries. C5 claim admission must still reject them.
         assert.equal(store.claimWorkUnit(fixture.id, currentWorkClaim(store, fixture.id, purpose)), 'inactive');
         assert.deepEqual(store.getWatch(fixture.id), repaired);
         if (purpose === 'polling') {
            databaseOf(store).prepare(`UPDATE roundwatch_watches
               SET evidence_version = 1, scan_after_round = 100, polling_retry_at = NULL
               WHERE id = ?`).run(fixture.id);
         } else {
            databaseOf(store).prepare(`UPDATE roundwatch_watches
               SET expected_service_transaction = ?, reconciliation_next_attempt_at = NULL
               WHERE id = ?`).run(`service-${fixture.id}`, fixture.id);
         }
         const before: WatchRecord = store.getWatch(fixture.id)!;
         assert.equal(before.workUnitBudget, BUDGET);
         assert.equal(before.workUnitsUsed, fixture.used);
         const wrongPurpose = purpose === 'polling' ? 'reconciliation' : 'polling';
         assert.equal(store.claimWorkUnit(fixture.id, currentWorkClaim(store, fixture.id, wrongPurpose)), 'inactive');
         assert.deepEqual(store.getWatch(fixture.id), before);
         if (fixture.id === 'pending-flagged') {
            assert.equal(store.claimWorkUnit(fixture.id, currentWorkClaim(store, fixture.id, purpose)), 'inactive');
            assert.deepEqual(store.getWatch(fixture.id), before);
         } else if (fixture.used! < BUDGET) {
            assert.equal(store.claimWorkUnit(fixture.id, currentWorkClaim(store, fixture.id, purpose)), 'claimed');
            assert.deepEqual(store.getWatch(fixture.id), { ...before, workUnitsUsed: fixture.used! + 1 });
         } else {
            assert.equal(store.claimWorkUnit(fixture.id, currentWorkClaim(store, fixture.id, purpose)), 'exhausted');
            const terminal = { ...before, state: 'indeterminate', terminalReason: 'work_budget_exhausted', settlementReconciliationTerminal: true };
            assert.deepEqual(store.getWatch(fixture.id), terminal);
            assert.equal(store.claimWorkUnit(fixture.id, currentWorkClaim(store, fixture.id, purpose)), 'inactive');
            assert.deepEqual(store.getWatch(fixture.id), terminal);
         }
      }
   } finally {
      store?.close();
      rmSync(directory, { recursive: true, force: true });
   }
});
