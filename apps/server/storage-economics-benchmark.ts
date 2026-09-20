import {
   existsSync,
   mkdtempSync,
   rmSync,
   statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

import { ALGORAND_TESTNET, TESTNET_USDC_ASSET_ID } from './app.js';
import {
   RoundWatchStore,
   type SettlementIntent,
   type WatchSpec,
} from './roundwatch-store.js';

type StorageState =
   | 'settlement_pending'
   | 'active'
   | 'matched'
   | 'expired'
   | 'indeterminate';

interface StorageResult {
   state: StorageState;
   rows: number;
   elapsedMs: number;
   sqliteBytesBeforeClose: number;
   walBytesBeforeClose: number;
   totalBytesBeforeClose: number;
   durableSqliteBytesAfterClose: number;
   bytesPerRowAfterClose: number;
   pageSize: number;
   pageCount: number;
   freelistCount: number;
   livePageBytes: number;
}

const ROW_COUNTS = parseCounts(
   process.env.ROUNDWATCH_STORAGE_BENCH_ROWS ?? '100,1000,5000',
);
const STATES = parseStates(
   process.env.ROUNDWATCH_STORAGE_BENCH_STATES ??
      'settlement_pending,active,matched,expired,indeterminate',
);
const results: StorageResult[] = [];

console.log(
   [
      'RoundWatch Storage Economics Benchmark v1',
      `rows: ${ROW_COUNTS.join(', ')}`,
      `states: ${STATES.join(', ')}`,
      'Measures isolated retained SQLite footprint plus outstanding WAL before close. WAL size is not cumulative write amplification.',
   ].join('\n'),
);

for (const state of STATES) {
   for (const rows of ROW_COUNTS) {
      const result = runScenario(state, rows);
      results.push(result);
      console.log(`STORAGE_BENCH_RESULT ${JSON.stringify(result)}`);
   }
}

console.table(
   results.map(result => ({
      state: result.state,
      rows: result.rows,
      'DB after close': result.durableSqliteBytesAfterClose,
      'B/row': round(result.bytesPerRowAfterClose, 1),
      'WAL pre-close': result.walBytesBeforeClose,
      'DB+WAL pre-close': result.totalBytesBeforeClose,
      pages: result.pageCount,
      freelist: result.freelistCount,
      'elapsed ms': round(result.elapsedMs, 1),
   })),
);

console.log(
   `STORAGE_BENCH_SUMMARY ${JSON.stringify({
      rowCounts: ROW_COUNTS,
      states: STATES,
      results,
   })}`,
);

function runScenario(
   state: StorageState,
   rows: number,
): StorageResult {
   const directory = mkdtempSync(
      join(tmpdir(), 'roundwatch-storage-bench-'),
   );
   const databasePath = join(directory, 'roundwatch.sqlite');
   const store = new RoundWatchStore(databasePath, {
      maxOpenWatches: Math.max(rows + 10, 100),
      maxOpenWatchesPerPayer: Math.max(rows + 10, 100),
      // Storage footprint is independent of how many turns were needed to
      // reach indeterminate. Use one turn there so this benchmark measures
      // retained row size instead of millions of historical UPDATE writes.
      workUnitBudget: state === 'indeterminate' ? 1 : 500,
      now: () => new Date('2026-09-20T12:00:00.000Z'),
   });

   const startedAt = performance.now();

   try {
      for (let index = 0; index < rows; index += 1) {
         createWatchInState(store, state, index);
      }

      const elapsedMs = performance.now() - startedAt;
      const sqliteBytesBeforeClose = fileSize(databasePath);
      const walBytesBeforeClose = fileSize(`${databasePath}-wal`);
      const totalBytesBeforeClose =
         sqliteBytesBeforeClose + walBytesBeforeClose;

      store.close();

      const durableSqliteBytesAfterClose = fileSize(databasePath);
      const database = new DatabaseSync(databasePath, {
         readOnly: true,
      });
      try {
         const pageSize = pragmaInteger(database, 'page_size');
         const pageCount = pragmaInteger(database, 'page_count');
         const freelistCount = pragmaInteger(database, 'freelist_count');

         return {
            state,
            rows,
            elapsedMs,
            sqliteBytesBeforeClose,
            walBytesBeforeClose,
            totalBytesBeforeClose,
            durableSqliteBytesAfterClose,
            bytesPerRowAfterClose:
               durableSqliteBytesAfterClose / rows,
            pageSize,
            pageCount,
            freelistCount,
            livePageBytes:
               (pageCount - freelistCount) * pageSize,
         };
      } finally {
         database.close();
      }
   } finally {
      try {
         store.close();
      } catch {
         // Store may already be closed after the deliberate WAL checkpoint.
      }
      rmSync(directory, { recursive: true, force: true });
   }
}

function createWatchInState(
   store: RoundWatchStore,
   state: StorageState,
   index: number,
): void {
   const suffix = index.toString().padStart(8, '0');
   const serviceTransaction = `SERVICE_TX_${suffix}`;
   const spec: WatchSpec = {
      idempotencyKey: `storage-${state}-${suffix}`,
      expectedSender:
         'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
      expectedReceiver:
         'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI',
      assetId: TESTNET_USDC_ASSET_ID,
      atomicAmount: '1000000',
      invoiceNote:
         index % 2 === 0
            ? `roundwatch:storage-benchmark:${suffix}`
            : undefined,
   };
   const intent: SettlementIntent = {
      expectedTransaction: serviceTransaction,
      network: ALGORAND_TESTNET,
      payer: spec.expectedSender,
      receiver: spec.expectedReceiver,
      assetId: TESTNET_USDC_ASSET_ID,
      atomicAmount: '1000',
      firstValid: 65_000_000 + index,
      lastValid: 65_001_000 + index,
   };

   const prepared = store.prepareWatch(spec, intent).watch;

   if (state === 'settlement_pending') {
      return;
   }

   const active = store.activateWatch(
      prepared.id,
      {
         transaction: serviceTransaction,
         network: ALGORAND_TESTNET,
         payer: spec.expectedSender,
      },
      65_000_100 + index,
   );

   if (state === 'active') {
      return;
   }

   if (state === 'matched') {
      store.markMatched(
         active.id,
         `INVOICE_TX_${suffix}`,
         65_000_200 + index,
      );
      return;
   }

   if (state === 'expired') {
      const closingRound = 65_000_300 + index;
      const currentRound = active.scanAfterRound;
      if (currentRound === undefined) {
         throw new Error('active watch lacks scan cursor');
      }
      if (!store.advanceScanRound(active.id, currentRound, closingRound)) {
         throw new Error('failed to advance synthetic expiry cursor');
      }
      store.setClosingRound(active.id, closingRound);
      if (!store.markExpired(active.id, closingRound, closingRound)) {
         throw new Error('failed to expire synthetic watch');
      }
      return;
   }

   const claimed = store.claimWorkUnit(active.id);
   if (claimed !== 'claimed') {
      throw new Error(
         `expected claimed work unit, got ${claimed}`,
      );
   }
   const exhausted = store.claimWorkUnit(active.id);
   if (exhausted !== 'exhausted') {
      throw new Error(
         `expected exhausted work budget, got ${exhausted}`,
      );
   }
}

function fileSize(path: string): number {
   if (!existsSync(path)) return 0;
   return statSync(path).size;
}

function pragmaInteger(
   database: DatabaseSync,
   name: 'page_size' | 'page_count' | 'freelist_count',
): number {
   const row = database.prepare(`PRAGMA ${name};`).get() as unknown as
      | Record<string, unknown>
      | undefined;
   const value = row?.[name];
   if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new Error(`PRAGMA ${name} did not return an integer`);
   }
   return value;
}

function parseCounts(raw: string): number[] {
   const counts = raw
      .split(',')
      .map(value => Number(value.trim()))
      .filter(value => Number.isSafeInteger(value) && value > 0);

   if (counts.length === 0) {
      throw new Error(
         'ROUNDWATCH_STORAGE_BENCH_ROWS must contain positive integers',
      );
   }

   return [...new Set(counts)];
}

function parseStates(raw: string): StorageState[] {
   const allowed = new Set<StorageState>([
      'settlement_pending',
      'active',
      'matched',
      'expired',
      'indeterminate',
   ]);
   const states = raw
      .split(',')
      .map(value => value.trim())
      .filter((value): value is StorageState =>
         allowed.has(value as StorageState),
      );

   if (states.length === 0) {
      throw new Error(
         'ROUNDWATCH_STORAGE_BENCH_STATES contains no supported states',
      );
   }

   return [...new Set(states)];
}

function round(value: number, digits = 2): number {
   const scale = 10 ** digits;
   return Math.round(value * scale) / scale;
}
