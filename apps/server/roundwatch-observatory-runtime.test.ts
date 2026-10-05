import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';

import {
   createObservatoryRuntimeSnapshotBuilder,
   type CachedIndexerTip,
   type ObservatoryClocks,
   type ObservatoryRuntimeSources,
} from './roundwatch-observatory-runtime.js';
import type { Observation } from './roundwatch-observatory-types.js';
import { RoundWatchPoller, type PollerCapacitySnapshot } from './roundwatch-poller.js';
import { IndexerHealthProbe, type IndexerCapabilityEvidence } from './roundwatch-health-probe.js';
import { SettlementReconciler } from './roundwatch-reconciler.js';
import { IndexerRequestDispatcher, type IndexerDispatcherSnapshot } from './roundwatch-scheduler.js';
import type { RoundWatchStore, WatchRecord } from './roundwatch-store.js';
import type { RoundWatchIndexer } from './roundwatch-indexer.js';
import { WorkerHealthTracker, type WorkerHealthSnapshot } from './roundwatch-worker-health.js';

const WALL_MS = Date.parse('2026-10-05T12:00:00.000Z');
const WALL_ISO = new Date(WALL_MS).toISOString();
const clocks: ObservatoryClocks = {
   epochMilliseconds: () => WALL_MS,
   processMonotonicMilliseconds: () => 125.5,
};

function worker(): WorkerHealthSnapshot {
   return {
      started: true,
      running: false,
      ready: true,
      cycleNotStalled: true,
      providerHealth: 'healthy',
      consecutiveFailures: 2,
      generation: 9,
      lastCycleStartedAtMs: WALL_MS - 2_000,
      lastProgressAtMs: WALL_MS - 1_000,
      lastProviderEvidenceAtMs: WALL_MS - 500,
      lastErrorAtMs: WALL_MS - 3_000,
   };
}

function dispatcher(): IndexerDispatcherSnapshot {
   return {
      queued: 3, inFlight: 2,
      requests: { activation: 7, health: 4, unknown: 1_000 },
      successes: 5, failures: 3, timeouts: 2,
   };
}

function sources(overrides: Partial<ObservatoryRuntimeSources> = {}): ObservatoryRuntimeSources {
   return {
      network: 'testnet',
      assetId: '10458941',
      economicsMetricsEnabled: true,
      pollerHealthSnapshot: worker,
      reconcilerHealthSnapshot: worker,
      dispatcherSnapshot: dispatcher,
      cachedIndexerTip: () => ({}),
      pollCycleSnapshot: undefined,
      ...overrides,
   };
}

function assertEmpty(observation: Observation<unknown>, availability: string): void {
   assert.deepEqual(observation, {
      availability, observedAt: null, lastCollectionFailureAt: null, data: null,
   });
}

test('v0.1 serializes every required key and resolved safe runtime scalar', () => {
   for (const [network, assetId] of [['testnet', '10458941'], ['mainnet', '31566704']] as const) {
      const snapshot = createObservatoryRuntimeSnapshotBuilder(sources({ network, assetId }), clocks)();
      const serialized = JSON.parse(JSON.stringify(snapshot));
      assert.deepEqual(Object.keys(serialized), [
         'schemaVersion', 'observedAt', 'runtime', 'workers', 'indexer',
         'pollCycle', 'readiness', 'capacity', 'resources',
      ]);
      assert.equal(snapshot.schemaVersion, 'observatory-runtime-v0.1');
      assert.equal(snapshot.observedAt, WALL_ISO);
      assert.deepEqual(serialized.runtime, {
         network, assetId, economicsMetricsEnabled: true,
         processEpoch: snapshot.runtime.processEpoch,
         processMonotonicMs: 125.5,
         deployedCommit: null,
      });
      assert.deepEqual(Object.keys(serialized.workers), ['poller', 'reconciler']);
      assert.deepEqual(Object.keys(serialized.indexer), ['dispatcher', 'observedRound']);
   }
});

test('epoch is stable across reads and differs for newly wired counter lifetimes', () => {
   const build = createObservatoryRuntimeSnapshotBuilder(sources());
   const first = build();
   for (let i = 0; i < 20; i += 1) {
      const next = build();
      assert.equal(next.runtime.processEpoch, first.runtime.processEpoch);
      assert.ok(Number.isFinite(next.runtime.processMonotonicMs));
      assert.ok(next.runtime.processMonotonicMs! >= first.runtime.processMonotonicMs!);
      assert.ok(next.runtime.processMonotonicMs! >= 0);
      assert.ok(next.runtime.processMonotonicMs! < Date.parse(next.observedAt));
   }
   assert.match(first.runtime.processEpoch!, /^[0-9a-f-]{36}$/);
   assert.notEqual(createObservatoryRuntimeSnapshotBuilder(sources())().runtime.processEpoch, first.runtime.processEpoch);
});

test('epoch initialization failure is silent, isolated, and never retried by reads', t => {
   const forbidden = () => { assert.fail('Epoch failure caused logging or timing fallback'); };
   const logs = (['log', 'warn', 'error', 'info', 'debug'] as const).map(
      method => t.mock.method(console, method, forbidden),
   );
   const generateEpoch = t.mock.fn(() => { throw new Error('private epoch failure'); });
   const monotonicClock = t.mock.fn(forbidden);
   let build!: ReturnType<typeof createObservatoryRuntimeSnapshotBuilder>;
   assert.doesNotThrow(() => {
      build = createObservatoryRuntimeSnapshotBuilder(sources({
         cachedIndexerTip: () => ({ currentIndexerRound: 20, currentIndexerRoundObservedAt: WALL_ISO }),
      }), { ...clocks, processMonotonicMilliseconds: monotonicClock }, generateEpoch);
   });
   assert.equal(generateEpoch.mock.callCount(), 1);
   for (let i = 0; i < 20; i += 1) {
      const snapshot = build();
      assert.equal(snapshot.runtime.processEpoch, null);
      assert.equal(snapshot.runtime.processMonotonicMs, null);
      assert.equal(snapshot.runtime.network, 'testnet');
      assert.equal(snapshot.observedAt, WALL_ISO);
      assert.equal(snapshot.workers.poller.availability, 'available');
      assert.equal(snapshot.workers.reconciler.availability, 'available');
      assert.deepEqual(snapshot.indexer.dispatcher.data, {
         queued: 3, inFlight: 2,
         requests: { activation: 7, reconciliation: 0, 'absence-proof': 0, 'scan-page': 0, checkpoint: 0, health: 4 },
         successes: 5, failures: 3, timeouts: 2,
      });
      assert.equal(snapshot.indexer.observedRound.availability, 'available');
      assert.equal(JSON.stringify(snapshot).includes('private epoch failure'), false);
   }
   assert.equal(generateEpoch.mock.callCount(), 1);
   assert.equal(monotonicClock.mock.callCount(), 0);
   for (const spy of logs) assert.equal(spy.mock.callCount(), 0);
});

test('dispatcher and monotonic time are adjacent; assembly comparison time follows direct reads', () => {
   const calls: string[] = [];
   const build = createObservatoryRuntimeSnapshotBuilder(sources({
      pollerHealthSnapshot: () => { calls.push('poller'); return worker(); },
      reconcilerHealthSnapshot: () => { calls.push('reconciler'); return worker(); },
      dispatcherSnapshot: () => { calls.push('dispatcher'); return dispatcher(); },
      cachedIndexerTip: () => { calls.push('tip'); return {}; },
   }), {
      epochMilliseconds: () => { calls.push('wall'); return WALL_MS; },
      processMonotonicMilliseconds: () => { calls.push('monotonic'); return 0; },
   });
   const snapshot = build();
   assert.equal(snapshot.runtime.processMonotonicMs, 0);
   assert.deepEqual(calls, ['poller', 'wall', 'reconciler', 'wall', 'dispatcher', 'monotonic', 'wall', 'tip', 'wall']);
   assert.equal(snapshot.indexer.dispatcher.observedAt, WALL_ISO);
});

test('worker projection converts events, drops generation and preserves composite streak/health semantics', () => {
   const tracker = new WorkerHealthTracker(() => WALL_MS);
   tracker.markStarted();
   tracker.markProbeResult(true);
   tracker.markCycleFailed();
   tracker.markCycleFailed();
   tracker.markProbeResult(false);
   const before = tracker.snapshot(45_000);
   assert.equal(before.consecutiveFailures, 2); // max(cycle=2, probe=1), not their sum
   const build = createObservatoryRuntimeSnapshotBuilder(sources({
      pollerHealthSnapshot: () => tracker.snapshot(45_000),
   }), clocks);
   const snapshot = build();
   assert.deepEqual(snapshot.workers.poller.data, {
      started: true, running: false, ready: false, cycleNotStalled: true,
      providerHealth: 'unhealthy', consecutiveFailures: 2,
      lastCycleStartedAt: null, lastProgressAt: null,
      lastProviderEvidenceAt: WALL_ISO, lastErrorAt: WALL_ISO,
   });
   assert.deepEqual(snapshot.workers.reconciler.data, {
      started: true, running: false, ready: true, cycleNotStalled: true,
      providerHealth: 'healthy', consecutiveFailures: 2,
      lastCycleStartedAt: '2026-10-05T11:59:58.000Z',
      lastProgressAt: '2026-10-05T11:59:59.000Z',
      lastProviderEvidenceAt: '2026-10-05T11:59:59.500Z',
      lastErrorAt: '2026-10-05T11:59:57.000Z',
   });
   build();
   assert.deepEqual(tracker.snapshot(45_000), before);
});

test('future-looking valid worker events do not rewrite health booleans', () => {
   const snapshot = createObservatoryRuntimeSnapshotBuilder(sources({
      pollerHealthSnapshot: () => ({ ...worker(), lastProgressAtMs: WALL_MS + 100_000 }),
   }), clocks)();
   assert.equal(snapshot.workers.poller.availability, 'available');
   assert.equal(snapshot.workers.poller.data!.ready, true);
   assert.equal(snapshot.workers.poller.data!.lastProgressAt, new Date(WALL_MS + 100_000).toISOString());
});

test('dispatcher normalizes only known absent purposes and keeps timeout subset separate', () => {
   const source = dispatcher();
   const before = structuredClone(source);
   const build = createObservatoryRuntimeSnapshotBuilder(sources({ dispatcherSnapshot: () => source }), clocks);
   const observation = build().indexer.dispatcher;
   assert.deepEqual(observation.data, {
      queued: 3, inFlight: 2,
      requests: { activation: 7, reconciliation: 0, 'absence-proof': 0, 'scan-page': 0, checkpoint: 0, health: 4 },
      successes: 5, failures: 3, timeouts: 2,
   });
   observation.data!.requests.health = 99;
   assert.equal(build().indexer.dispatcher.data!.requests.health, 4);
   assert.deepEqual(source, before);
});

test('dispatcher purposes ignore inherited values and normalize only absent own keys', () => {
   const prototype = Object.defineProperty({}, 'health', {
      get() { assert.fail('Inherited purpose value must not be read'); },
   });
   const requests = Object.assign(Object.create(prototype), { activation: 7 });
   const source = { ...dispatcher(), requests };
   const observation = createObservatoryRuntimeSnapshotBuilder(sources({ dispatcherSnapshot: () => source }), clocks)().indexer.dispatcher;
   assert.equal(observation.availability, 'available');
   assert.deepEqual(observation.data!.requests, {
      activation: 7, reconciliation: 0, 'absence-proof': 0, 'scan-page': 0, checkpoint: 0, health: 0,
   });
   assert.equal(Object.hasOwn(requests, 'health'), false);
   assert.equal(Object.getPrototypeOf(requests), prototype);
   assert.deepEqual(Object.keys(requests), ['activation']);
});

test('dispatcher rejects present invalid purpose values without source mutation', () => {
   const purposes = ['activation', 'reconciliation', 'absence-proof', 'scan-page', 'checkpoint', 'health'];
   for (const purpose of purposes) {
      for (const value of [undefined, null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
         const source = { ...dispatcher(), requests: { [purpose]: value } } as IndexerDispatcherSnapshot;
         const before = structuredClone(source);
         assertEmpty(createObservatoryRuntimeSnapshotBuilder(sources({ dispatcherSnapshot: () => source }), clocks)().indexer.dispatcher, 'unavailable');
         assert.deepEqual(source, before);
         assert.equal(Object.hasOwn(source.requests, purpose), true);
      }
   }
});

test('dispatcher rejects timeouts above failures and preserves valid subset counters', () => {
   for (const [failures, timeouts] of [[0, 1], [2, 3], [0, 0], [3, 2], [3, 3]]) {
      const source = { ...dispatcher(), failures, timeouts };
      const before = structuredClone(source);
      const observation = createObservatoryRuntimeSnapshotBuilder(sources({ dispatcherSnapshot: () => source }), clocks)().indexer.dispatcher;
      if (timeouts > failures) {
         assertEmpty(observation, 'unavailable');
      } else {
         assert.equal(observation.availability, 'available');
         assert.equal(observation.data!.failures, failures);
         assert.equal(observation.data!.timeouts, timeouts);
      }
      assert.deepEqual(source, before);
   }
});

test('cached sweep-tip round preserves original provenance through repeated later reads, including round zero', () => {
   for (const round of [0, 12345]) {
      const observedAt = '2026-10-04T10:00:00.000Z';
      const build = createObservatoryRuntimeSnapshotBuilder(sources({
         cachedIndexerTip: () => ({ currentIndexerRound: round, currentIndexerRoundObservedAt: observedAt }),
      }), clocks);
      assert.deepEqual(build().indexer.observedRound, {
         availability: 'available', observedAt, lastCollectionFailureAt: null, data: { round },
      });
      assert.equal(build().indexer.observedRound.observedAt, observedAt);
   }
});

test('wired but empty cached tip is not yet sampled; unwired sections stay unavailable or disabled', () => {
   for (const economicsMetricsEnabled of [true, false]) {
      const snapshot = createObservatoryRuntimeSnapshotBuilder(sources({ economicsMetricsEnabled }), clocks)();
      assertEmpty(snapshot.indexer.observedRound, 'not_yet_sampled');
      assertEmpty(snapshot.pollCycle, 'unavailable');
      assertEmpty(snapshot.readiness, 'unavailable');
      assertEmpty(snapshot.capacity, economicsMetricsEnabled ? 'unavailable' : 'instrumentation_disabled');
      assertEmpty(snapshot.resources, economicsMetricsEnabled ? 'unavailable' : 'instrumentation_disabled');
      assert.equal(snapshot.runtime.economicsMetricsEnabled, economicsMetricsEnabled);
      assert.equal(snapshot.workers.poller.availability, 'available');
      assert.equal(snapshot.indexer.dispatcher.availability, 'available');
   }
});

test('malformed or partial cached tip candidates are unavailable without invented failure metadata', () => {
   const cases: CachedIndexerTip[] = [
      { currentIndexerRound: 12 },
      { currentIndexerRoundObservedAt: WALL_ISO },
      ...['bad', '2026-02-30T12:00:00.000Z', '2026-10-05T24:00:00Z', '2026-10-05T12:00:00', '2026-10-05T12:00:00+02:00'].map(currentIndexerRoundObservedAt => ({ currentIndexerRound: 12, currentIndexerRoundObservedAt })),
      ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(currentIndexerRound => ({ currentIndexerRound, currentIndexerRoundObservedAt: WALL_ISO })),
   ];
   for (const candidate of cases) {
      const before = { ...candidate };
      assertEmpty(createObservatoryRuntimeSnapshotBuilder(sources({ cachedIndexerTip: () => candidate }), clocks)().indexer.observedRound, 'unavailable');
      assert.deepEqual(candidate, before);
   }
});

test('valid UTC syntax and future cached provenance remain available without chronology inference', () => {
   for (const observedAt of ['2026-10-06T00:00:00Z', '2026-10-06T00:00:00.1Z', '2026-10-06T00:00:00.123456789Z']) {
      const snapshot = createObservatoryRuntimeSnapshotBuilder(sources({
         cachedIndexerTip: () => ({ currentIndexerRound: 12, currentIndexerRoundObservedAt: observedAt }),
      }), clocks)();
      assert.equal(snapshot.indexer.observedRound.availability, 'available');
      assert.equal(snapshot.indexer.observedRound.observedAt, observedAt);
   }
});

test('malformed required worker fields or supplied event times reject just that direct section', () => {
   const cases = [
      { started: undefined }, { running: 'false' }, { ready: 1 },
      { cycleNotStalled: null }, { providerHealth: 'other' },
      { consecutiveFailures: -1 }, { consecutiveFailures: 0.5 },
      ...[NaN, Infinity, 1e20, '2026-10-05T12:00:00.000Z'].map(lastProgressAtMs => ({ lastProgressAtMs })),
   ];
   for (const invalid of cases) {
      const candidate = { ...worker(), ...invalid } as WorkerHealthSnapshot;
      const before = structuredClone(candidate);
      const snapshot = createObservatoryRuntimeSnapshotBuilder(sources({ pollerHealthSnapshot: () => candidate }), clocks)();
      assertEmpty(snapshot.workers.poller, 'unavailable');
      assert.equal(snapshot.workers.reconciler.availability, 'available');
      assert.deepEqual(candidate, before);
   }
});

test('invalid dispatcher counters and malformed purpose objects are unavailable', () => {
   const cases = [
      { queued: -1 }, { inFlight: 0.5 }, { successes: NaN }, { failures: Infinity },
      { timeouts: Number.MAX_SAFE_INTEGER + 1 },
      { requests: { health: null } }, { requests: { activation: -1 } },
      { requests: null }, { requests: 0 }, { requests: [] },
   ];
   for (const invalid of cases) {
      const candidate = { ...dispatcher(), ...invalid } as IndexerDispatcherSnapshot;
      assertEmpty(createObservatoryRuntimeSnapshotBuilder(sources({ dispatcherSnapshot: () => candidate }), clocks)().indexer.dispatcher, 'unavailable');
   }
});

test('failed dispatcher observation supplies no monotonic rate timing or wall-clock fallback', t => {
   let unsafeCalls = 0;
   const forbidden = () => { unsafeCalls += 1; throw new Error('Forbidden operational work'); };
   const logs = (['log', 'warn', 'error', 'info', 'debug'] as const).map(
      method => t.mock.method(console, method, forbidden),
   );
   const failSnapshot = () => { throw new Error('private dispatcher failure'); };
   const failProjection = () => {
      const source = dispatcher();
      Object.defineProperty(source, 'requests', { get: failSnapshot });
      return source;
   };
   for (const dispatcherSnapshot of [
      failSnapshot, failProjection,
      () => ({ ...dispatcher(), requests: { health: undefined } } as unknown as IndexerDispatcherSnapshot),
      () => ({ ...dispatcher(), failures: 1, timeouts: 2 }),
   ]) {
      const guardedSources = new Proxy(sources({ dispatcherSnapshot }), {
         get(target, key, receiver) {
            if (!(key in target)) return forbidden();
            return Reflect.get(target, key, receiver);
         },
      });
      const build = createObservatoryRuntimeSnapshotBuilder(guardedSources, clocks);
      for (let i = 0; i < 3; i += 1) {
         const snapshot = build();
         assertEmpty(snapshot.indexer.dispatcher, 'unavailable');
         assert.ok(snapshot.runtime.processEpoch);
         assert.equal(snapshot.runtime.processMonotonicMs, null);
         assert.equal(snapshot.observedAt, WALL_ISO);
         assert.equal(snapshot.workers.poller.availability, 'available');
      }
   }
   assert.equal(unsafeCalls, 0);
   for (const spy of logs) assert.equal(spy.mock.callCount(), 0);
});

test('direct getter exceptions are isolated with no retention or producer failure writes', () => {
   const fail = () => { throw new Error('private source error'); };
   const build = createObservatoryRuntimeSnapshotBuilder(sources({
      pollerHealthSnapshot: fail, reconcilerHealthSnapshot: fail,
      dispatcherSnapshot: fail, cachedIndexerTip: fail,
   }), clocks);
   for (let i = 0; i < 3; i += 1) {
      const snapshot = build();
      for (const observation of [snapshot.workers.poller, snapshot.workers.reconciler, snapshot.indexer.dispatcher, snapshot.indexer.observedRound]) {
         assertEmpty(observation, 'unavailable');
      }
      assert.equal(snapshot.runtime.processMonotonicMs, null);
      assert.equal(JSON.stringify(snapshot).includes('private source error'), false);
   }
});

test('invalid direct observation time rejects the section; invalid assembly time rejects the DTO', () => {
   let reads = 0;
   const snapshot = createObservatoryRuntimeSnapshotBuilder(sources(), {
      ...clocks, epochMilliseconds: () => ++reads === 1 ? NaN : WALL_MS,
   })();
   assertEmpty(snapshot.workers.poller, 'unavailable');
   assert.equal(snapshot.workers.reconciler.availability, 'available');
   for (const invalid of [NaN, Infinity, 1e20]) {
      reads = 0;
      assert.throws(createObservatoryRuntimeSnapshotBuilder(sources(), {
         ...clocks, epochMilliseconds: () => ++reads === 4 ? invalid : WALL_MS,
      }));
   }
});

test('invalid monotonic clock yields null without inventing a date or losing valid counters', () => {
   for (const processMonotonicMilliseconds of [() => NaN, () => Infinity, () => -1, () => { throw new Error('clock'); }]) {
      const snapshot = createObservatoryRuntimeSnapshotBuilder(sources(), { ...clocks, processMonotonicMilliseconds })();
      assert.equal(snapshot.runtime.processMonotonicMs, null);
      assert.equal(snapshot.indexer.dispatcher.availability, 'available');
      assert.ok(snapshot.runtime.processEpoch);
   }
});

test('allowlisting never enumerates internal objects or reads unknown/high-cardinality fields', () => {
   const bounded = <T extends object>(value: T) => new Proxy(value, {
      ownKeys() { assert.fail('Unbounded source enumeration'); },
      get(target, key, receiver) {
         if (key === 'privatePayload') assert.fail('Private field read');
         return Reflect.get(target, key, receiver);
      },
   });
   const internalWorker = bounded({ ...worker(), privatePayload: 'private' });
   const internalDispatcher = bounded({ ...dispatcher(), requests: bounded(dispatcher().requests), privatePayload: 'private' });
   const internalTip = bounded({ currentIndexerRound: 20, currentIndexerRoundObservedAt: WALL_ISO, privatePayload: 'private' });
   const snapshot = createObservatoryRuntimeSnapshotBuilder(bounded(sources({
      pollerHealthSnapshot: () => internalWorker,
      reconcilerHealthSnapshot: () => internalWorker,
      dispatcherSnapshot: () => internalDispatcher,
      cachedIndexerTip: () => internalTip,
   })), clocks)();
   assert.equal(snapshot.workers.poller.availability, 'available');
   assert.equal(snapshot.indexer.dispatcher.availability, 'available');
   assert.equal(snapshot.indexer.observedRound.availability, 'available');
   assert.equal(JSON.stringify(snapshot).includes('private'), false);
});

test('repeated reads through real worker/dispatcher getters perform no operational acquisition or mutation', t => {
   let unsafeCalls = 0;
   const forbidden = () => { unsafeCalls += 1; throw new Error('Forbidden operational work'); };
   // Any SQLite/provider access, including queries/probes or watch mutation, fails.
   const store = new Proxy({} as RoundWatchStore, { get: forbidden });
   const indexer = new Proxy({} as RoundWatchIndexer, { get: forbidden });
   const poller = new RoundWatchPoller(store, indexer);
   const reconciler = new SettlementReconciler(store, indexer, {
      network: 'testnet', intervalMilliseconds: 5_000,
   });
   let dispatcherClockReads = 0;
   const realDispatcher = new IndexerRequestDispatcher({ now: () => { dispatcherClockReads += 1; return 100; } });
   const runOnce = t.mock.method(poller, 'runOnce', forbidden);
   const reconcileOnce = t.mock.method(reconciler, 'reconcileOnce', forbidden);
   const pollerReadiness = t.mock.method(poller, 'readinessCheck', forbidden);
   const reconcilerReadiness = t.mock.method(reconciler, 'readinessCheck', forbidden);
   const dispatch = t.mock.method(realDispatcher, 'dispatch', forbidden);
   const log = t.mock.method(console, 'log', forbidden);
   const warn = t.mock.method(console, 'warn', forbidden);
   const error = t.mock.method(console, 'error', forbidden);
   const info = t.mock.method(console, 'info', forbidden);
   // Test-scoped mocks are restored by node:test even when assertions fail.
   const debug = t.mock.method(console, 'debug', forbidden);
   const fetch = t.mock.method(globalThis, 'fetch', forbidden);
   const safeSources = sources({
      pollerHealthSnapshot: () => poller.healthSnapshot(),
      reconcilerHealthSnapshot: () => reconciler.healthSnapshot(),
      dispatcherSnapshot: () => realDispatcher.snapshot(),
      cachedIndexerTip: () => poller.capacitySnapshot(),
      pollCycleSnapshot: () => poller.capacitySnapshot(),
   });
   // These capabilities cannot enter the builder, even if offered by wiring.
   const guardedSources = new Proxy(safeSources, {
      get(target, key, receiver) {
         if (!(key in target)) return forbidden();
         return Reflect.get(target, key, receiver);
      },
   });
   const before = [poller.healthSnapshot(), reconciler.healthSnapshot(), poller.capacitySnapshot(), realDispatcher.snapshot()];
   const build = createObservatoryRuntimeSnapshotBuilder(guardedSources, clocks);
   for (let i = 0; i < 30; i += 1) {
      const snapshot = build();
      assert.equal(snapshot.workers.poller.availability, 'available');
      assert.equal(snapshot.workers.reconciler.availability, 'available');
      assert.equal(snapshot.indexer.dispatcher.availability, 'available');
      assertEmpty(snapshot.pollCycle, 'not_yet_sampled');
   }
   assert.deepEqual([poller.healthSnapshot(), reconciler.healthSnapshot(), poller.capacitySnapshot(), realDispatcher.snapshot()], before);
   assert.equal(dispatcherClockReads, 1); // no token refill or dispatcher clock mutation
   assert.equal(unsafeCalls, 0);
   for (const spy of [runOnce, reconcileOnce, pollerReadiness, reconcilerReadiness, dispatch, log, warn, error, info, debug, fetch]) {
      assert.equal(spy.mock.callCount(), 0);
   }
});

function cycleBuilder(poller: RoundWatchPoller, observationClocks = clocks) {
   return createObservatoryRuntimeSnapshotBuilder(sources({
      pollerHealthSnapshot: () => poller.healthSnapshot(),
      cachedIndexerTip: () => poller.capacitySnapshot(),
      pollCycleSnapshot: () => poller.capacitySnapshot(),
   }), observationClocks);
}

function emptyPoller(now: () => Date = () => new Date(WALL_MS), probe?: IndexerHealthProbe) {
   const store = { listPollingCandidates: () => [] } as unknown as RoundWatchStore;
   const indexer = new Proxy({} as RoundWatchIndexer, {
      get() { assert.fail('Empty cycle must not access the provider'); },
   });
   return new RoundWatchPoller(store, indexer, 60_000, 100, now,
      undefined, undefined, undefined, probe);
}

async function flushUntil(condition: () => boolean): Promise<void> {
   for (let i = 0; i < 100; i += 1) {
      if (condition()) return;
      await new Promise<void>(resolve => setImmediate(resolve));
   }
   assert.fail('Worker did not reach expected cycle boundary');
}

test('wired cycle starts not yet sampled; a completed empty cycle is a real observation and resets with a new poller', async () => {
   const poller = emptyPoller();
   const build = cycleBuilder(poller);
   assertEmpty(build().pollCycle, 'not_yet_sampled');
   assert.deepEqual(poller.capacitySnapshot(), {
      watchesAttemptedLastCycle: 0, watchesSucceededLastCycle: 0, watchesFailedLastCycle: 0,
   });
   const healthBefore = poller.healthSnapshot();
   assert.deepEqual(await poller.runOnce(), { attempted: 0, succeeded: 0, failed: 0 });
   const completed = build().pollCycle;
   assert.equal(completed.availability, 'available');
   assert.equal(completed.observedAt, WALL_ISO);
   assert.equal(completed.lastCollectionFailureAt, null);
   assert.deepEqual(completed.data, {
      durationMs: poller.capacitySnapshot().lastCycleDurationMs,
      attempted: 0, progressed: 0, failed: 0,
   });
   assert.deepEqual(poller.healthSnapshot(), healthBefore, 'runOnce does not manage scheduled worker health');
   assertEmpty(cycleBuilder(emptyPoller())().pollCycle, 'not_yet_sampled');
});

test('non-empty completion publishes one coherent cycle: progressed cursor advance, failure, no-op and evidence-only', async t => {
   t.mock.method(console, 'log', () => {});
   t.mock.method(console, 'warn', () => {});
   t.mock.method(console, 'error', () => {});
   let wall = WALL_MS;
   let monotonic = 100;
   t.mock.method(performance, 'now', () => monotonic);
   const watches = ['progress', 'failure', 'no-op', 'evidence-only'].map(id => ({
      id, evidenceVersion: 1, scanAfterRound: 100,
      expiresAt: new Date(WALL_MS + 60_000).toISOString(),
   } as WatchRecord));
   const store = {
      listPollingCandidates: () => watches,
      claimWorkUnit: (id: string) => id === 'no-op' ? 'inactive' : 'claimed',
      clearPollingFailure: () => {},
      advanceScanRound: () => true,
      getWatch: (id: string) => watches.find(watch => watch.id === id),
      recordPollingFailure: () => undefined,
      markMatched: () => assert.fail('Cursor progress is not a match'),
   } as unknown as RoundWatchStore;
   let release!: () => void;
   const held = new Promise<void>(resolve => { release = resolve; });
   let entered = false;
   const indexer = {
      async getCurrentRound() { return 101; },
      async searchWatchPage(watch: WatchRecord) {
         if (watch.id === 'progress') {
            entered = true;
            await held;
         }
         if (watch.id === 'failure') throw new Error('Provider failure');
         return { currentRound: 101, transactions: [],
            ...(watch.id === 'evidence-only' ? { nextToken: 'next' } : {}) };
      },
   } as unknown as RoundWatchIndexer;
   const poller = new RoundWatchPoller(store, indexer, 60_000, 100, () => new Date(wall));
   const build = cycleBuilder(poller);
   const pending = poller.runOnce();
   await flushUntil(() => entered);
   assertEmpty(build().pollCycle, 'not_yet_sampled');
   wall += 5_000;
   monotonic = 112.5;
   release();
   const outcome = await pending;
   assert.deepEqual(outcome, {
      attempted: 4, succeeded: 1, failed: 1, noOp: 1, providerEvidenceOnly: 1, providerEvidence: 2,
   });
   assert.deepEqual(build().pollCycle, {
      availability: 'available', observedAt: new Date(wall).toISOString(),
      lastCollectionFailureAt: null,
      data: { durationMs: 12.5, attempted: 4, progressed: 1, failed: 1 },
   });
   const retained = poller.capacitySnapshot();
   retained.lastCycleCompletedAt = 'mutated';
   retained.watchesSucceededLastCycle = 99;
   assert.equal(build().pollCycle.data!.progressed, 1);
   assert.equal(build().pollCycle.observedAt, new Date(wall).toISOString());
   assert.equal(poller.healthSnapshot().providerHealth, 'unhealthy', 'caught systemic turn failure still marks provider health');
});

test('completion is published before a held capability probe; probe duration and worker completion cannot redate it', async t => {
   let wall = WALL_MS;
   let monotonic = 100;
   let performanceReads = 0;
   t.mock.method(performance, 'now', () => {
      performanceReads += 1;
      return performanceReads === 1 ? 100 : monotonic;
   });
   // Enumeration is part of the cycle duration, unlike the subsequent probe.
   const store = { listPollingCandidates: () => { wall += 500; monotonic = 112.5; return []; } } as unknown as RoundWatchStore;
   let release!: (evidence: IndexerCapabilityEvidence) => void;
   let probeEntered = false;
   const probe = new IndexerHealthProbe({ probeReadinessCapabilities() {
      probeEntered = true;
      return new Promise(resolve => { release = resolve; });
   } }, 10458941, () => 100);
   const poller = new RoundWatchPoller(store, {} as RoundWatchIndexer, 60_000, 100,
      () => new Date(wall), undefined, undefined, undefined, probe);
   const build = cycleBuilder(poller);
   poller.start();
   try {
      await flushUntil(() => probeEntered);
      const completed = build().pollCycle;
      assert.deepEqual(completed, {
         availability: 'available', observedAt: new Date(WALL_MS + 500).toISOString(),
         lastCollectionFailureAt: null,
         data: { durationMs: 12.5, attempted: 0, progressed: 0, failed: 0 },
      });
      assert.equal(poller.healthSnapshot().running, true);
      assert.equal(poller.healthSnapshot().providerHealth, 'unknown');
      assert.equal(poller.readinessCheck(), false);
      wall += 30_000;
      monotonic += 30_000;
      release({ polling: true, reconciliation: true });
      await flushUntil(() => !poller.healthSnapshot().running);
      assert.deepEqual(build().pollCycle, completed);
      assert.equal(poller.healthSnapshot().providerHealth, 'healthy');
      assert.equal(poller.readinessCheck(), true);
      assert.equal(performanceReads, 2, 'duration clock is used only at runOnce start and finish');
   } finally {
      release?.({ polling: true, reconciliation: true });
      poller.stop();
   }
});

test('later outer candidate-read failure preserves completion while scheduled worker failure semantics remain intact', async t => {
   let failCandidates = false;
   const store = { listPollingCandidates() {
      if (failCandidates) throw new Error('Candidate read failed');
      return [];
   } } as unknown as RoundWatchStore;
   const poller = new RoundWatchPoller(store, {} as RoundWatchIndexer, 60_000, 100, () => new Date(WALL_MS));
   const build = cycleBuilder(poller);
   await poller.runOnce();
   const completed = build().pollCycle;
   const retained = poller.capacitySnapshot();
   // Candidate acquisition is an outer failure, before the normal finish boundary.
   failCandidates = true;
   await assert.rejects(poller.runOnce(), /Candidate read failed/);
   const error = t.mock.method(console, 'error', () => {});
   poller.start();
   try {
      await flushUntil(() => !poller.healthSnapshot().running);
      assert.deepEqual(poller.capacitySnapshot(), retained);
      assert.deepEqual(build().pollCycle, completed);
      assert.equal(poller.healthSnapshot().providerHealth, 'unhealthy');
      assert.equal(poller.healthSnapshot().consecutiveFailures, 1);
      assert.equal(poller.readinessCheck(), false);
      assert.equal(error.mock.callCount(), 1);
   } finally { poller.stop(); }
});

test('invalid or throwing completion clocks preserve the prior complete record without worker/probe/log failure', async t => {
   let invalid = false;
   const logs = (['log', 'warn', 'error', 'info', 'debug'] as const).map(
      method => t.mock.method(console, method, () => assert.fail('Telemetry failure logged')),
   );
   for (const badClock of [() => new Date(NaN), () => { throw new Error('Completion clock failed'); }]) {
      invalid = false;
      const probe = new IndexerHealthProbe({ async probeReadinessCapabilities() {
         return { polling: true, reconciliation: true };
      } }, 10458941, () => 100);
      const poller = emptyPoller(() => invalid ? badClock() : new Date(WALL_MS), probe);
      await poller.runOnce();
      const completed = cycleBuilder(poller)().pollCycle;
      invalid = true;
      const invalidate = t.mock.method(probe, 'invalidateForProviderFailure', () => assert.fail('Telemetry invalidated evidence'));
      poller.start();
      try {
         await flushUntil(() => !poller.healthSnapshot().running);
         assert.deepEqual(cycleBuilder(poller)().pollCycle, completed);
         assert.equal(poller.healthSnapshot().consecutiveFailures, 0);
         assert.equal(poller.healthSnapshot().providerHealth, 'healthy');
         assert.equal(poller.readinessCheck(), true);
         assert.equal(invalidate.mock.callCount(), 0);
      } finally { poller.stop(); }
      const fresh = emptyPoller(badClock);
      assert.deepEqual(await fresh.runOnce(), { attempted: 0, succeeded: 0, failed: 0 });
      assertEmpty(cycleBuilder(fresh)().pollCycle, 'not_yet_sampled');
   }
   for (const log of logs) assert.equal(log.mock.callCount(), 0);
});

for (const [label, start, end] of [
   ['start Infinity', Infinity, 212.5],
   ['end -Infinity', 200, -Infinity],
] as const) {
   test(`nonfinite monotonic ${label} preserves completion and operational outcomes`, async t => {
      const forbidden = () => assert.fail('Invalid duration caused an operational side effect');
      const logs = (['log', 'warn', 'error', 'info', 'debug'] as const).map(
         method => t.mock.method(console, method, forbidden),
      );
      const readings = [100, 112.5, start, end, start, end, 300, 310];
      const monotonic = t.mock.method(performance, 'now', () => {
         assert.ok(readings.length > 0, 'Unexpected extra duration clock read');
         return readings.shift()!;
      });
      let wall = WALL_MS;
      const probeSource = t.mock.fn(async () => ({ polling: true, reconciliation: true }));
      const probe = new IndexerHealthProbe({ probeReadinessCapabilities: probeSource }, 10458941, () => 100);
      const invalidate = t.mock.method(probe, 'invalidateForProviderFailure', forbidden);
      const poller = emptyPoller(() => new Date(wall), probe);
      const build = cycleBuilder(poller);
      const outcome = { attempted: 0, succeeded: 0, failed: 0 };

      assert.deepEqual(await poller.runOnce(), outcome);
      const completed = build().pollCycle;
      const retained = poller.capacitySnapshot();
      const health = poller.healthSnapshot();
      assert.equal(completed.data!.durationMs, 12.5);
      wall += 1_000;

      assert.deepEqual(await poller.runOnce(), outcome);
      assert.deepEqual(poller.capacitySnapshot(), retained);
      assert.deepEqual(build().pollCycle, completed);
      assert.deepEqual(poller.healthSnapshot(), health);
      assert.equal(probeSource.mock.callCount(), 0);

      poller.start();
      try {
         await flushUntil(() => !poller.healthSnapshot().running);
         assert.deepEqual(poller.capacitySnapshot(), retained);
         assert.deepEqual(build().pollCycle, completed);
         assert.equal(poller.healthSnapshot().consecutiveFailures, 0);
         assert.equal(poller.healthSnapshot().providerHealth, 'healthy');
         assert.equal(poller.readinessCheck(), true);
         assert.equal(probeSource.mock.callCount(), 1, 'Only the ordinary scheduled probe runs');
         assert.equal(invalidate.mock.callCount(), 0);

         wall += 1_000;
         assert.deepEqual(await poller.runOnce(), outcome);
         assert.equal(build().pollCycle.observedAt, new Date(wall).toISOString());
         assert.equal(build().pollCycle.data!.durationMs, 10);
         assert.equal(monotonic.mock.callCount(), 8);
         assert.equal(readings.length, 0);
      } finally { poller.stop(); }
      for (const log of logs) assert.equal(log.mock.callCount(), 0);
   });
}

test('finite backward duration still clamps to zero and ordinary completion publishes normally', async t => {
   const logs = (['log', 'warn', 'error', 'info', 'debug'] as const).map(
      method => t.mock.method(console, method, () => assert.fail('Duration telemetry logged')),
   );
   const readings = [100, 112.5, 200, 190, 300, 325];
   const monotonic = t.mock.method(performance, 'now', () => {
      assert.ok(readings.length > 0, 'Unexpected extra duration clock read');
      return readings.shift()!;
   });
   let wall = WALL_MS;
   const poller = emptyPoller(() => new Date(wall));
   const build = cycleBuilder(poller);
   const health = poller.healthSnapshot();
   for (const durationMs of [12.5, 0, 25]) {
      assert.deepEqual(await poller.runOnce(), { attempted: 0, succeeded: 0, failed: 0 });
      assert.deepEqual(build().pollCycle, {
         availability: 'available', observedAt: new Date(wall).toISOString(),
         lastCollectionFailureAt: null,
         data: { durationMs, attempted: 0, progressed: 0, failed: 0 },
      });
      assert.deepEqual(poller.healthSnapshot(), health);
      wall += 1_000;
   }
   assert.equal(monotonic.mock.callCount(), 6);
   assert.equal(readings.length, 0);
   for (const log of logs) assert.equal(log.mock.callCount(), 0);
});

test('repeated later snapshot reads keep completion provenance without operational or sampler work', async t => {
   const forbidden = () => assert.fail('Snapshot read performed operational work');
   const store = {
      listPollingCandidates: () => [], capacitySnapshot: forbidden, readinessCheck: forbidden,
   } as unknown as RoundWatchStore;
   const poller = new RoundWatchPoller(store, new Proxy({} as RoundWatchIndexer, { get: forbidden }),
      60_000, 100, () => new Date(WALL_MS));
   await poller.runOnce();
   const candidates = t.mock.method(store, 'listPollingCandidates', forbidden);
   const run = t.mock.method(poller, 'runOnce', forbidden);
   const readiness = t.mock.method(poller, 'readinessCheck', forbidden);
   const sampler = { sample: t.mock.fn(forbidden) };
   const publicReadiness = t.mock.fn(forbidden);
   const logs = (['log', 'warn', 'error', 'info', 'debug'] as const).map(
      method => t.mock.method(console, method, forbidden),
   );
   let readWall = WALL_MS + 60_000;
   const build = createObservatoryRuntimeSnapshotBuilder(Object.assign(sources({
      pollerHealthSnapshot: () => poller.healthSnapshot(),
      cachedIndexerTip: () => poller.capacitySnapshot(),
      pollCycleSnapshot: () => poller.capacitySnapshot(),
   }), { sampler, currentReadinessSnapshot: publicReadiness }),
   { ...clocks, epochMilliseconds: () => readWall });
   const first = build();
   first.pollCycle.data!.attempted = 99;
   const health = poller.healthSnapshot();
   const retained = poller.capacitySnapshot();
   for (let i = 0; i < 30; i += 1) {
      readWall += 1_000;
      const snapshot = build();
      assert.equal(snapshot.observedAt, new Date(readWall).toISOString());
      assert.equal(snapshot.pollCycle.observedAt, WALL_ISO);
      assert.equal(snapshot.pollCycle.data!.attempted, 0);
   }
   assert.deepEqual(poller.capacitySnapshot(), retained);
   assert.deepEqual(poller.healthSnapshot(), health);
   for (const spy of [candidates, run, readiness, sampler.sample, publicReadiness, ...logs]) {
      assert.equal(spy.mock.callCount(), 0);
   }
});

test('malformed or partial completed-cycle provenance and getter failures never serialize as available', () => {
   const valid: PollerCapacitySnapshot = {
      lastCycleCompletedAt: WALL_ISO, lastCycleDurationMs: 12.5,
      watchesAttemptedLastCycle: 4, watchesSucceededLastCycle: 1, watchesFailedLastCycle: 1,
   };
   const invalid: Partial<PollerCapacitySnapshot>[] = [
      ...[undefined, null, '', 'bad', '2026-02-30T12:00:00Z', '2026-10-05T24:00:00Z',
         '2026-10-05T12:00:00', '2026-10-05T12:00:00+02:00', 123].map(
         lastCycleCompletedAt => ({ lastCycleCompletedAt } as Partial<PollerCapacitySnapshot>)),
      ...[undefined, null, -1, NaN, Infinity, '1'].map(
         lastCycleDurationMs => ({ lastCycleDurationMs } as Partial<PollerCapacitySnapshot>)),
      ...['watchesAttemptedLastCycle', 'watchesSucceededLastCycle', 'watchesFailedLastCycle'].flatMap(
         field => [undefined, null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map(value => ({ [field]: value }))),
   ];
   for (const fields of invalid) {
      const candidate = { ...valid, ...fields };
      const before = structuredClone(candidate);
      const snapshot = createObservatoryRuntimeSnapshotBuilder(sources({ pollCycleSnapshot: () => candidate }), clocks)();
      assertEmpty(JSON.parse(JSON.stringify(snapshot)).pollCycle, 'unavailable');
      assert.deepEqual(candidate, before);
      assert.equal(snapshot.workers.poller.availability, 'available');
   }
   const startup = { watchesAttemptedLastCycle: 0, watchesSucceededLastCycle: 0, watchesFailedLastCycle: 0 };
   for (const candidate of [null, {}, { ...startup, lastCycleDurationMs: 0 },
      { ...startup, lastCycleCompletedAt: WALL_ISO }, { ...startup, watchesAttemptedLastCycle: 1 }]) {
      assertEmpty(createObservatoryRuntimeSnapshotBuilder(sources({
         pollCycleSnapshot: () => candidate as PollerCapacitySnapshot,
      }), clocks)().pollCycle, 'unavailable');
   }
   for (const getter of [
      () => { throw new Error('private cycle error'); },
      () => Object.defineProperty({ ...valid }, 'lastCycleCompletedAt', {
         get() { throw new Error('private provenance error'); },
      }),
   ]) {
      const snapshot = createObservatoryRuntimeSnapshotBuilder(sources({ pollCycleSnapshot: getter }), clocks)();
      assertEmpty(snapshot.pollCycle, 'unavailable');
      assert.equal(JSON.stringify(snapshot).includes('private'), false);
   }
});
