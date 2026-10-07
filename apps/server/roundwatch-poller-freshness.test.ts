import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { RoundWatchIndexer, TransactionPage } from './roundwatch-indexer.js';
import { RoundWatchEconomicsMetrics } from './roundwatch-metrics.js';
import { RoundWatchPoller } from './roundwatch-poller.js';
import { RoundWatchStore, type WatchRecord, type WorkClaim } from './roundwatch-store.js';

const NOW = new Date('2026-10-07T10:00:00.000Z');
const PAYER = 'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';
const RECEIVER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const ASSET = 10458941;
const NETWORK = 'algorand:testnet';

function gate<T>() {
   let resolve!: (value: T) => void;
   const promise = new Promise<T>(accept => { resolve = accept; });
   return { promise, resolve };
}

function active(store: RoundWatchStore, key: string): WatchRecord {
   const watch = store.prepareWatch({
      idempotencyKey: key, expectedSender: PAYER, expectedReceiver: RECEIVER,
      assetId: ASSET, atomicAmount: '1',
   }, {
      expectedTransaction: key, network: NETWORK, payer: PAYER, receiver: RECEIVER,
      assetId: ASSET, atomicAmount: '1000', firstValid: 80, lastValid: 120,
   }).watch;
   return store.activateWatch(watch.id, { transaction: key, network: NETWORK, payer: PAYER }, 100);
}

function pollingClaim(watch: WatchRecord): WorkClaim {
   return {
      purpose: 'polling', expectedScanAfterRound: watch.scanAfterRound!,
      expectedClosingRound: watch.closingRound ?? null,
      expectedPollingFailureCount: watch.pollingFailureCount ?? 0,
   };
}

interface RetainedSession {
   minRound: number;
   maxRound: number;
   nextToken?: string;
   seenTokens: Set<string>;
}

const sessions = (poller: RoundWatchPoller): ReadonlyMap<string, RetainedSession> =>
   (poller as unknown as { sessions: ReadonlyMap<string, RetainedSession> }).sessions;

function harness(options: { budget?: number; ttl?: number } = {}) {
   const clock = { now: NOW };
   const store = new RoundWatchStore(':memory:', {
      now: () => clock.now, workUnitBudget: options.budget,
      watchTtlMilliseconds: options.ttl,
   });
   const metrics = new RoundWatchEconomicsMetrics();
   const pages: { id: string; min: number; max: number; nextToken?: string }[] = [];
   const tips: { purpose: string; id?: string }[] = [];
   const blocks: { round: number; id?: string }[] = [];
   let onPage: ((watch: WatchRecord) => Promise<TransactionPage>) | undefined;
   let nextPage: TransactionPage = { transactions: [], currentRound: 105 };
   let checkpointRound = 105;
   const indexer: RoundWatchIndexer = {
      async getCurrentRound(purpose = 'health', id) {
         tips.push({ purpose, ...(id === undefined ? {} : { id }) });
         return purpose === 'checkpoint' ? checkpointRound : 105;
      },
      async getBlock(round, id) {
         blocks.push({ round, ...(id === undefined ? {} : { id }) });
         return { round, timestamp: clock.now.getTime() / 1_000 };
      },
      async lookupAssetTransfer() { assert.fail('Unexpected service lookup'); },
      async searchTransactionPage() { assert.fail('Unexpected absence search'); },
      async searchWatchPage(watch, min, max, nextToken) {
         pages.push({ id: watch.id, min, max, ...(nextToken === undefined ? {} : { nextToken }) });
         return onPage ? onPage(watch) : nextPage;
      },
   };
   const poller = new RoundWatchPoller(store, indexer, 60_000, 100, () => clock.now, metrics, 0, 0);
   return {
      store, metrics, poller, clock, pages, tips, blocks,
      setPage(value: TransactionPage) { nextPage = value; },
      setPageHandler(value: typeof onPage) { onPage = value; },
      setCheckpointRound(value: number) { checkpointRound = value; },
      async close() { await poller.drain(); store.close(); },
   };
}

type Harness = ReturnType<typeof harness>;

function holdEarlierCandidate(t: TestContext, h: Harness, blocker: WatchRecord) {
   const entered = gate<void>();
   const page = gate<TransactionPage>();
   const list = h.store.listPollingCandidates.bind(h.store);
   // Selection still materializes real SQLite records. Explicit ordering makes
   // the target wait behind a real provider await, without relying on wall time.
   const selection = t.mock.method(h.store, 'listPollingCandidates', () =>
      list().sort((a, b) => Number(b.id === blocker.id) - Number(a.id === blocker.id)));
   h.setPageHandler(async watch => {
      if (watch.id === blocker.id) { entered.resolve(); return page.promise; }
      return { transactions: [], currentRound: 105 };
   });
   return {
      entered: entered.promise,
      release() { page.resolve({ transactions: [], currentRound: 105 }); },
      restore() { selection.mock.restore(); h.setPageHandler(undefined); },
   };
}

function assertTargetUncharged(h: Harness, target: WatchRecord, expected: WatchRecord) {
   assert.deepEqual(h.store.getWatch(target.id), expected);
   assert.equal(h.pages.filter(call => call.id === target.id).length, 0);
   assert.equal(h.tips.filter(call => call.id === target.id).length, 0);
   assert.equal(h.blocks.filter(call => call.id === target.id).length, 0);
   assert.equal(h.metrics.snapshotWatch(target.id), undefined);
   assert.equal(h.poller.healthSnapshot().consecutiveFailures, 0);
   assert.notEqual(h.poller.healthSnapshot().providerHealth, 'unhealthy');
}

test('C5 polling stale cursor is rejected before claim without spending, provider work or cursor regression', async t => {
   const h = harness();
   const blocker = active(h.store, 'cursor-blocker');
   const target = active(h.store, 'cursor-target');
   const held = holdEarlierCandidate(t, h, blocker);
   const sweep = h.poller.runOnce();
   try {
      await held.entered;
      assert.equal(h.store.advanceScanRound(target.id, 100, 103), true);
      const current = h.store.getWatch(target.id)!;
      held.release();
      assert.equal((await sweep).noOp, 1);
      assertTargetUncharged(h, target, current);
      assert.equal(current.workUnitsUsed, 0);
      assert.equal(current.scanAfterRound, 103);
   } finally { held.release(); await sweep; await h.close(); }
});

test('C5 polling newly imposed backoff preserves newer failure metadata and never clears it', async t => {
   const h = harness();
   const blocker = active(h.store, 'backoff-blocker');
   const target = active(h.store, 'backoff-target');
   const clears = t.mock.method(h.store, 'clearPollingFailure');
   const failures = t.mock.method(h.store, 'recordPollingFailure');
   const held = holdEarlierCandidate(t, h, blocker);
   const sweep = h.poller.runOnce();
   try {
      await held.entered;
      h.store.recordPollingFailure(target.id, {
         code: 'newer_defer', disposition: 'transient', status: 429,
         retryAt: new Date(NOW.getTime() + 60_000),
      });
      const current = h.store.getWatch(target.id)!;
      held.release();
      await sweep;
      assertTargetUncharged(h, target, current);
      assert.equal(clears.mock.calls.filter(call => call.arguments[0] === target.id).length, 0);
      assert.equal(failures.mock.calls.filter(call => call.arguments[0] === target.id).length, 1);
      assert.equal(current.pollingFailureCount, 1);
      assert.equal(current.pollingRetryAt, new Date(NOW.getTime() + 60_000).toISOString());
   } finally { held.release(); await sweep; await h.close(); }
});

test('C5 polling changed failure count rejects a selected candidate even when the retry is currently due', async t => {
   const h = harness();
   const blocker = active(h.store, 'failures-blocker');
   const target = active(h.store, 'failures-target');
   const clears = t.mock.method(h.store, 'clearPollingFailure');
   const held = holdEarlierCandidate(t, h, blocker);
   const sweep = h.poller.runOnce();
   try {
      await held.entered;
      h.store.recordPollingFailure(target.id, {
         code: 'newer_failure', disposition: 'transient',
         retryAt: new Date(NOW.getTime() + 1_000),
      });
      h.clock.now = new Date(NOW.getTime() + 1_000);
      const current = h.store.getWatch(target.id)!;
      assert.ok(h.store.listPollingCandidates().some(watch => watch.id === target.id));
      held.release();
      await sweep;
      assertTargetUncharged(h, target, current);
      assert.equal(clears.mock.calls.filter(call => call.arguments[0] === target.id).length, 0);
   } finally { held.release(); await sweep; await h.close(); }
});

test('C5 polling closing metadata established before claim rejects obsolete checkpoint work and permits a fresh bounded turn', async t => {
   const h = harness({ ttl: 1_000 });
   const blocker = active(h.store, 'closing-blocker');
   const target = active(h.store, 'closing-target');
   h.clock.now = new Date(NOW.getTime() + 2_000);
   const held = holdEarlierCandidate(t, h, blocker);
   const sweep = h.poller.runOnce();
   try {
      await held.entered;
      h.store.setClosingRound(target.id, 103);
      const current = h.store.getWatch(target.id)!;
      held.release();
      await sweep;
      assertTargetUncharged(h, target, current);
      held.restore();
      h.store.markMatched(blocker.id, 'BLOCKER_DONE', 101);
      await h.poller.runOnce();
      assert.deepEqual(h.pages.filter(call => call.id === target.id), [{ id: target.id, min: 101, max: 103 }]);
      assert.equal(h.tips.filter(call => call.id === target.id).length, 0);
      assert.equal(h.blocks.filter(call => call.id === target.id).length, 0);
      assert.equal(h.store.getWatch(target.id)?.workUnitsUsed, 1);
      assert.equal(h.store.getWatch(target.id)?.state, 'expired');
      assert.equal(h.store.getWatch(target.id)?.scanAfterRound, 103);
   } finally { held.release(); await sweep; await h.close(); }
});

for (const staleField of ['cursor', 'closing', 'backoff', 'failure-count'] as const) {
   test(`C5 polling exhausted ${staleField} snapshot cannot terminalize the durable watch`, async t => {
      const h = harness({ budget: 1 });
      const blocker = active(h.store, `exhausted-${staleField}-blocker`);
      const target = active(h.store, `exhausted-${staleField}-target`);
      assert.equal(h.store.claimWorkUnit(target.id, pollingClaim(target)), 'claimed');
      const held = holdEarlierCandidate(t, h, blocker);
      const sweep = h.poller.runOnce();
      try {
         await held.entered;
         if (staleField === 'cursor') h.store.advanceScanRound(target.id, 100, 103);
         if (staleField === 'closing') h.store.setClosingRound(target.id, 103);
         if (staleField === 'backoff' || staleField === 'failure-count') {
            h.store.recordPollingFailure(target.id, {
               code: 'newer_failure', disposition: 'transient',
               retryAt: new Date(NOW.getTime() + 1_000),
            });
            if (staleField === 'failure-count') h.clock.now = new Date(NOW.getTime() + 1_000);
         }
         const current = h.store.getWatch(target.id)!;
         held.release();
         await sweep;
         assertTargetUncharged(h, target, current);
         assert.equal(current.state, 'active');
         assert.equal(current.terminalReason, undefined);
         assert.equal(current.workUnitsUsed, 1);
      } finally { held.release(); await sweep; await h.close(); }
   });
}

test('C5 polling cursor changes after legitimate claim retain the charge while cursor CAS preserves newer progress', async () => {
   const h = harness();
   const target = active(h.store, 'post-claim-cursor');
   const entered = gate<void>();
   const page = gate<TransactionPage>();
   h.setPageHandler(async () => { entered.resolve(); return page.promise; });
   const sweep = h.poller.runOnce();
   try {
      await entered.promise;
      assert.equal(h.store.getWatch(target.id)?.workUnitsUsed, 1);
      assert.equal(h.store.advanceScanRound(target.id, 100, 108), true);
      page.resolve({ transactions: [], currentRound: 105 });
      await sweep;
      assert.equal(h.store.getWatch(target.id)?.scanAfterRound, 108);
      assert.equal(h.store.getWatch(target.id)?.workUnitsUsed, 1);
      assert.equal(h.metrics.snapshotWatch(target.id)?.workUnitsClaimed, 1);
      assert.equal(h.metrics.snapshotWatch(target.id)?.roundsCovered, 0);
      assert.equal(h.pages.length, 1);
      assert.equal(sessions(h.poller).size, 0);
   } finally { page.resolve({ transactions: [], currentRound: 105 }); await sweep; await h.close(); }
});

test('C5 polling stale scheduling rejection retains pagination token and seen tokens and resumes when due', async t => {
   const h = harness();
   const target = active(h.store, 'retained-backoff-target');
   h.setPage({ transactions: [], currentRound: 105, nextToken: 'retained-page' });
   await h.poller.runOnce();
   const retained = sessions(h.poller).get(target.id)!;
   assert.equal(retained.nextToken, 'retained-page');
   assert.deepEqual([...retained.seenTokens], ['retained-page']);
   const blocker = active(h.store, 'retained-backoff-blocker');
   const held = holdEarlierCandidate(t, h, blocker);
   const sweep = h.poller.runOnce();
   try {
      await held.entered;
      h.store.recordPollingFailure(target.id, {
         code: 'newer_defer', disposition: 'transient',
         retryAt: new Date(NOW.getTime() + 60_000),
      });
      const current = h.store.getWatch(target.id)!;
      const metric = h.metrics.snapshotWatch(target.id);
      held.release();
      await sweep;
      assert.deepEqual(h.store.getWatch(target.id), current);
      assert.deepEqual(h.metrics.snapshotWatch(target.id), metric);
      assert.equal(h.pages.filter(call => call.id === target.id).length, 1);
      assert.equal(sessions(h.poller).get(target.id), retained);
      assert.deepEqual([...retained.seenTokens], ['retained-page']);
      held.restore();
      h.store.markMatched(blocker.id, 'BLOCKER_DONE', 101);
      assert.equal((await h.poller.runOnce()).attempted, 0);
      assert.equal(sessions(h.poller).get(target.id), retained);
      h.clock.now = new Date(NOW.getTime() + 60_000);
      h.setPage({ transactions: [], currentRound: 105 });
      await h.poller.runOnce();
      assert.deepEqual(h.pages.filter(call => call.id === target.id).at(-1), {
         id: target.id, min: 101, max: 105, nextToken: 'retained-page',
      });
      assert.equal(h.store.getWatch(target.id)?.scanAfterRound, 105);
      assert.equal(h.store.getWatch(target.id)?.workUnitsUsed, 2);
      assert.equal(h.metrics.snapshotWatch(target.id)?.workUnitsClaimed, 2);
      assert.equal(sessions(h.poller).size, 0);
   } finally { held.release(); await sweep; await h.close(); }
});

test('C5 polling sweep pruning discards a continuation beyond a newly established closing bound even while deferred', async () => {
   const h = harness();
   const target = active(h.store, 'closing-sweep');
   try {
      h.setPage({ transactions: [], currentRound: 105, nextToken: 'old-bound-token' });
      await h.poller.runOnce();
      assert.equal(sessions(h.poller).get(target.id)?.maxRound, 105);
      h.store.setClosingRound(target.id, 103);
      h.store.recordPollingFailure(target.id, {
         code: 'newer_defer', disposition: 'transient',
         retryAt: new Date(NOW.getTime() + 60_000),
      });
      const current = h.store.getWatch(target.id);
      assert.equal((await h.poller.runOnce()).attempted, 0);
      assert.equal(sessions(h.poller).size, 0);
      assert.deepEqual(h.store.getWatch(target.id), current);
      assert.equal(h.pages.length, 1);
      h.clock.now = new Date(NOW.getTime() + 60_000);
      h.setPage({ transactions: [], currentRound: 105 });
      await h.poller.runOnce();
      assert.deepEqual(h.pages.at(-1), { id: target.id, min: 101, max: 103 });
      assert.equal(h.store.getWatch(target.id)?.state, 'expired');
   } finally { await h.close(); }
});

test('C5 polling inactive revalidation discards closing-incompatible retained pagination before the final sweep pruning', async t => {
   const h = harness();
   const target = active(h.store, 'closing-inactive-target');
   h.setPage({ transactions: [], currentRound: 105, nextToken: 'old-bound-token' });
   await h.poller.runOnce();
   const blocker = active(h.store, 'closing-inactive-blocker');
   const held = holdEarlierCandidate(t, h, blocker);
   let turns = 0;
   const sweep = h.poller.runOnce(() => {
      turns += 1;
      if (turns === 2) {
         assert.equal(sessions(h.poller).has(target.id), false);
         // Skip generation-aware final pruning to isolate inactive revalidation.
         h.poller.stop();
      }
   });
   try {
      await held.entered;
      h.store.setClosingRound(target.id, 103);
      const current = h.store.getWatch(target.id);
      held.release();
      await sweep;
      assert.equal(turns, 2);
      assert.deepEqual(h.store.getWatch(target.id), current);
      assert.equal(h.pages.filter(call => call.id === target.id).length, 1);
      assert.equal(h.metrics.snapshotWatch(target.id)?.workUnitsClaimed, 1);
      held.restore();
      h.store.markMatched(blocker.id, 'BLOCKER_DONE', 101);
      h.setPage({ transactions: [], currentRound: 105 });
      await h.poller.runOnce();
      assert.deepEqual(h.pages.at(-1), { id: target.id, min: 101, max: 103 });
   } finally { held.release(); await sweep; await h.close(); }
});

test('C5 polling session reuse rebuilds query bounds after its legitimate checkpoint establishes a smaller closing round', async () => {
   const h = harness({ ttl: 1_000 });
   const target = active(h.store, 'closing-reuse');
   try {
      h.setPage({ transactions: [], currentRound: 105, nextToken: 'old-bound-token' });
      await h.poller.runOnce();
      assert.equal(sessions(h.poller).get(target.id)?.maxRound, 105);
      h.clock.now = new Date(NOW.getTime() + 2_000);
      h.setCheckpointRound(103);
      h.setPage({ transactions: [], currentRound: 105 });
      await h.poller.runOnce();
      assert.deepEqual(h.pages, [
         { id: target.id, min: 101, max: 105 },
         { id: target.id, min: 101, max: 103 },
      ]);
      assert.equal(h.store.getWatch(target.id)?.closingRound, 103);
      assert.equal(h.store.getWatch(target.id)?.scanAfterRound, 103);
      assert.equal(h.store.getWatch(target.id)?.workUnitsUsed, 2);
      assert.equal(h.store.getWatch(target.id)?.state, 'expired');
      assert.equal(sessions(h.poller).size, 0);
   } finally { await h.close(); }
});
