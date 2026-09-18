import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ALGORAND_TESTNET, TESTNET_USDC_ASSET_ID } from './app.js';
import type { TransactionIdPage } from './roundwatch-indexer.js';
import {
   SettlementReconciler,
   type IndexedAssetTransfer,
   type SettlementLookupIndexer,
} from './roundwatch-reconciler.js';
import { RoundWatchStore, type SettlementIntent, type WatchSpec } from './roundwatch-store.js';

const PAYER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const RECEIVER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBAR7CWY';
const SPEC: WatchSpec = { idempotencyKey: 'reconcile-1', expectedSender: PAYER,
   expectedReceiver: RECEIVER, assetId: TESTNET_USDC_ASSET_ID, atomicAmount: '1' };
const terms = (tx: string): SettlementIntent => ({ expectedTransaction: tx, network: ALGORAND_TESTNET,
   payer: PAYER, receiver: RECEIVER, assetId: TESTNET_USDC_ASSET_ID,
   atomicAmount: '1000', firstValid: 800, lastValid: 900 });
const transfer = (tx: string, overrides: Partial<IndexedAssetTransfer> = {}): IndexedAssetTransfer => ({
   transaction: tx, sender: PAYER, receiver: RECEIVER, assetId: TESTNET_USDC_ASSET_ID,
   atomicAmount: '1000', round: 850, ...overrides,
});

test('confirmed exact service transaction establishes the activation baseline from its round', async () => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new FakeLookup(); indexer.lookups.set('SERVICE', transfer('SERVICE'));
   try {
      const watch = store.prepareWatch(SPEC, terms('SERVICE')).watch;
      await reconciler(store, indexer).reconcileOnce();
      const active = store.getWatch(watch.id);
      assert.equal(active?.state, 'active');
      assert.equal(active?.activationRound, 850);
      assert.equal(active?.scanAfterRound, 850);
      assert.equal(active?.serviceAtomicAmount, '1000');
   } finally { store.close(); }
});

test('one candidate error is isolated and a later due candidate still progresses', async () => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new FakeLookup(); indexer.throwFor.add('FAIL'); indexer.lookups.set('GOOD', transfer('GOOD'));
   try {
      const failed = store.prepareWatch(SPEC, terms('FAIL')).watch;
      const good = store.prepareWatch({ ...SPEC, idempotencyKey: 'reconcile-2' }, terms('GOOD')).watch;
      await reconciler(store, indexer).reconcileOnce();
      assert.equal(store.getWatch(failed.id)?.state, 'settlement_pending');
      assert.equal(store.getWatch(failed.id)?.reconciliationAttempts, 1);
      assert.equal(store.getWatch(good.id)?.state, 'active');
   } finally { store.close(); }
});

test('ordinary 404 within validity remains recoverable with persisted capped-backoff state', async () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-backoff-'));
   const path = join(directory, 'watch.sqlite');
   let now = new Date('2026-09-18T10:00:00Z');
   try {
      const store = new RoundWatchStore(path, { now: () => now });
      const watch = store.prepareWatch(SPEC, terms('MISSING')).watch;
      const indexer = new FakeLookup(); indexer.round = 850;
      await reconciler(store, indexer, () => now).reconcileOnce();
      const deferred = store.getWatch(watch.id)!;
      assert.equal(deferred.state, 'settlement_pending');
      assert.equal(deferred.reconciliationAttempts, 1);
      assert.equal(deferred.reconciliationNextAttemptAt, '2026-09-18T10:00:01.000Z');
      store.close();
      const restarted = new RoundWatchStore(path, { now: () => now });
      assert.equal(restarted.listSettlementReconciliationCandidates().length, 0);
      now = new Date('2026-09-18T10:00:01Z');
      assert.equal(restarted.listSettlementReconciliationCandidates().length, 1);
      restarted.close();
   } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('restart after settlement candidate persistence activates without another payment', async () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-activation-'));
   const path = join(directory, 'watch.sqlite');
   try {
      const first = new RoundWatchStore(path);
      const watch = first.prepareWatch(SPEC, terms('RECOVER_AFTER_RESTART')).watch;
      first.recordSettlementCandidate(watch.id, {
         transaction: 'RECOVER_AFTER_RESTART', network: ALGORAND_TESTNET, payer: PAYER,
      });
      first.close();
      const restarted = new RoundWatchStore(path);
      const indexer = new FakeLookup();
      indexer.lookups.set('RECOVER_AFTER_RESTART', transfer('RECOVER_AFTER_RESTART', { round: 875 }));
      await reconciler(restarted, indexer).reconcileOnce();
      assert.equal(restarted.getWatch(watch.id)?.activationRound, 875);
      assert.equal(indexer.lookups.size, 1);
      restarted.close();
   } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('covered historical absence after LastValid terminalizes nonpayment but inadequate coverage does not', async () => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new FakeLookup(); indexer.round = 901;
   try {
      const unresolved = store.prepareWatch(SPEC, terms('ABSENT')).watch;
      indexer.pages.push({ transactions: [], currentRound: 900 });
      await reconciler(store, indexer).reconcileOnce();
      assert.equal(store.getWatch(unresolved.id)?.state, 'settlement_pending');
      const next = store.getWatch(unresolved.id)!;
      store.recordReconciliationFailure(unresolved.id, new Date(0));
      indexer.pages.push({ transactions: [], currentRound: 901 });
      await reconciler(store, indexer).reconcileOnce();
      assert.equal(store.getWatch(unresolved.id)?.state, 'settlement_unknown');
      assert.ok(next.reconciliationAttempts >= 1);
   } finally { store.close(); }
});

test('confirmed incompatible immutable terms fail closed and runtime values cannot rewrite the purchase', async () => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new FakeLookup(); indexer.lookups.set('WRONG', transfer('WRONG', { atomicAmount: '9999' }));
   try {
      const watch = store.prepareWatch(SPEC, terms('WRONG')).watch;
      await reconciler(store, indexer).reconcileOnce();
      const failed = store.getWatch(watch.id);
      assert.equal(failed?.state, 'settlement_unknown');
      assert.equal(failed?.serviceAtomicAmount, '1000');
      assert.equal(store.listSettlementReconciliationCandidates().length, 0);
   } finally { store.close(); }
});

test('legacy candidate lacking immutable evidence stays unresolved instead of receiving fabricated proof', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const watch = store.prepareWatch(SPEC).watch;
      store.recordSettlementCandidate(watch.id, { transaction: 'LEGACY', network: ALGORAND_TESTNET, payer: PAYER });
      // Simulate a pre-hardening record by leaving immutable service terms absent.
      await reconciler(store, new FakeLookup()).reconcileOnce();
      assert.equal(store.getWatch(watch.id)?.state, 'settlement_pending');
   } finally { store.close(); }
});

function reconciler(store: RoundWatchStore, indexer: SettlementLookupIndexer, now = () => new Date('2026-09-18T10:00:00Z')): SettlementReconciler {
   return new SettlementReconciler(store, indexer, {
      network: ALGORAND_TESTNET, intervalMilliseconds: 5_000,
      baseBackoffMilliseconds: 1_000, maxBackoffMilliseconds: 4_000, now,
   });
}

class FakeLookup implements SettlementLookupIndexer {
   round = 0;
   lookups = new Map<string, IndexedAssetTransfer>();
   throwFor = new Set<string>();
   pages: TransactionIdPage[] = [];
   async lookupAssetTransfer(transactionId: string): Promise<IndexedAssetTransfer | undefined> {
      if (this.throwFor.has(transactionId)) throw new Error('synthetic lookup failure');
      return this.lookups.get(transactionId);
   }
   async getCurrentRound(): Promise<number> { return this.round; }
   async searchTransactionPage(): Promise<TransactionIdPage> {
      const page = this.pages.shift(); if (!page) throw new Error('missing fake absence page'); return page;
   }
}
