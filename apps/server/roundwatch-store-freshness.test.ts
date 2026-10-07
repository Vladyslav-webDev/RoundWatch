import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { ALGORAND_TESTNET_CAIP2 } from './network-config.js';
import { RoundWatchStore, type WatchRecord, type WorkClaim } from './roundwatch-store.js';

const START = new Date('2026-10-07T10:00:00.000Z');
const PAYER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const RECEIVER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBAR7CWY';

function databaseOf(store: RoundWatchStore): DatabaseSync {
   return (store as unknown as { database: DatabaseSync }).database;
}

function fixture(store: RoundWatchStore, purpose: WorkClaim['purpose']): WatchRecord {
   const watch = store.prepareWatch({
      idempotencyKey: 'freshness', expectedSender: PAYER, expectedReceiver: RECEIVER,
      assetId: 10458941, atomicAmount: '1',
   }, {
      expectedTransaction: 'SERVICE', network: ALGORAND_TESTNET_CAIP2, payer: PAYER,
      receiver: RECEIVER, assetId: 10458941, atomicAmount: '1000', firstValid: 80, lastValid: 120,
   }).watch;
   return purpose === 'polling'
      ? store.activateWatch(watch.id, { transaction: 'SERVICE', network: ALGORAND_TESTNET_CAIP2, payer: PAYER }, 100)
      : watch;
}

function expectation(watch: WatchRecord, purpose: WorkClaim['purpose']): WorkClaim {
   return purpose === 'polling' ? {
      purpose, expectedScanAfterRound: watch.scanAfterRound!,
      expectedClosingRound: watch.closingRound ?? null,
      expectedPollingFailureCount: watch.pollingFailureCount ?? 0,
   } : {
      purpose, expectedServiceTransaction: watch.expectedServiceTransaction!,
      expectedReconciliationAttempts: watch.reconciliationAttempts,
   };
}

// Mutate one durable field at a time to ensure that every fence independently
// rejects the actual store's SQL, including its separate exhaustion mutation.
const stalePolling = [
   ['cursor advanced', 'scan_after_round = 101'],
   ['closing round established', 'closing_round = 103'],
   ['failure count changed while due', 'polling_failure_count = 1'],
   ['retry deferred without failure change', "polling_retry_at = '2026-10-07T10:01:00.000Z'"],
   ['proof incompatible', 'evidence_version = 0'],
   ['expiry missing', 'expires_at = NULL'],
   ['cursor missing', 'scan_after_round = NULL'],
   ['lifecycle inactive', "state = 'matched'"],
] as const;
const staleReconciliation = [
   ['transaction changed', "expected_service_transaction = 'NEW_SERVICE'"],
   ['attempts changed while due', 'reconciliation_attempts = 1'],
   ['retry deferred without attempt change', "reconciliation_next_attempt_at = '2026-10-07T10:01:00.000Z'"],
   ['terminal obligation', 'settlement_reconciliation_terminal = 1'],
   ['lifecycle inactive', "state = 'active'"],
] as const;

for (const purpose of ['polling', 'reconciliation'] as const) {
   for (const exhausted of [false, true]) {
      for (const [label, mutation] of purpose === 'polling' ? stalePolling : staleReconciliation) {
         test(`C5 store ${purpose} ${exhausted ? 'exhaustion' : 'increment'} rejects ${label} unchanged`, () => {
            const store = new RoundWatchStore(':memory:', { now: () => START, workUnitBudget: 1 });
            try {
               const watch = fixture(store, purpose);
               const claim = expectation(watch, purpose);
               if (exhausted) assert.equal(store.claimWorkUnit(watch.id, claim), 'claimed');
               databaseOf(store).prepare(`UPDATE roundwatch_watches SET ${mutation} WHERE id = ?`).run(watch.id);
               const current = store.getWatch(watch.id)!;
               assert.equal(store.claimWorkUnit(watch.id, claim), 'inactive');
               assert.deepEqual(store.getWatch(watch.id), current);
               assert.equal(current.workUnitsUsed, exhausted ? 1 : 0);
               assert.equal(current.terminalReason, undefined);
            } finally { store.close(); }
         });
      }
   }

   test(`C5 store ${purpose} permits two still-fresh claims and preserves final-unit exhaustion`, () => {
      const store = new RoundWatchStore(':memory:', { now: () => START, workUnitBudget: 2 });
      try {
         const watch = fixture(store, purpose);
         const claim = expectation(watch, purpose);
         assert.equal(store.claimWorkUnit(watch.id, claim), 'claimed');
         assert.equal(store.claimWorkUnit(watch.id, claim), 'claimed', 'usage alone is not plan staleness');
         assert.equal(store.getWatch(watch.id)?.state, watch.state, 'final permitted unit stays usable');
         assert.equal(store.getWatch(watch.id)?.workUnitsUsed, 2);
         assert.equal(store.claimWorkUnit(watch.id, claim), 'exhausted');
         assert.equal(store.getWatch(watch.id)?.state, 'indeterminate');
         assert.equal(store.getWatch(watch.id)?.terminalReason, 'work_budget_exhausted');
         assert.equal(store.getWatch(watch.id)?.workUnitsUsed, 2);
         assert.equal(store.claimWorkUnit(watch.id, claim), 'inactive');
      } finally { store.close(); }
   });

   test(`C5 store ${purpose} uses claim clock and permits retry exactly when due`, () => {
      let now = START;
      const store = new RoundWatchStore(':memory:', { now: () => now, workUnitBudget: 2 });
      try {
         const watch = fixture(store, purpose);
         const selected = purpose === 'polling'
            ? store.listPollingCandidates()[0]!
            : store.listSettlementReconciliationCandidates()[0]!;
         const due = '2026-10-07T10:01:00.000Z';
         const column = purpose === 'polling' ? 'polling_retry_at' : 'reconciliation_next_attempt_at';
         databaseOf(store).prepare(`UPDATE roundwatch_watches SET ${column} = ? WHERE id = ?`).run(due, watch.id);
         assert.equal(store.claimWorkUnit(watch.id, expectation(selected, purpose)), 'inactive');
         now = new Date(due);
         assert.equal(store.claimWorkUnit(watch.id, expectation(selected, purpose)), 'claimed', 'selection time is not the due boundary');
      } finally { store.close(); }
   });
}

test('C5 store polling allows closing work after wall-clock expiry and matches a non-null closing round', () => {
   let now = START;
   const store = new RoundWatchStore(':memory:', { now: () => now });
   try {
      const watch = fixture(store, 'polling');
      store.setClosingRound(watch.id, 103);
      const current = store.getWatch(watch.id)!;
      now = new Date(Date.parse(current.expiresAt!) + 1);
      assert.equal(store.claimWorkUnit(watch.id, expectation(current, 'polling')), 'claimed');
      assert.equal(store.getWatch(watch.id)?.workUnitsUsed, 1);
   } finally { store.close(); }
});

test('C5 store reconciliation keeps pending-to-nonterminal-unknown eligible without immutable terms', () => {
   const store = new RoundWatchStore(':memory:', { now: () => START });
   try {
      const watch = fixture(store, 'reconciliation');
      const claim = expectation(watch, 'reconciliation');
      store.markSettlementUnknown(watch.id);
      databaseOf(store).prepare(`UPDATE roundwatch_watches SET service_receiver = NULL,
         service_asset_id = NULL, service_atomic_amount = NULL, service_first_valid = NULL,
         service_last_valid = NULL WHERE id = ?`).run(watch.id);
      assert.equal(store.claimWorkUnit(watch.id, claim), 'claimed');
      assert.equal(store.getWatch(watch.id)?.state, 'settlement_unknown');
      assert.equal(store.getWatch(watch.id)?.workUnitsUsed, 1);
   } finally { store.close(); }
});
