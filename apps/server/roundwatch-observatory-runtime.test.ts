import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
import { RoundWatchStore, type WatchRecord } from './roundwatch-store.js';
import { RoundWatchEconomicsMetrics } from './roundwatch-metrics.js';
import {
   RoundWatchRuntimeSampler,
   type CapacityRuntimeSnapshot,
   type EconomicsRuntimeSamplerOptions,
   type EconomicsRuntimeSnapshot,
   type RuntimeCpuInterval,
   type ScheduledRuntimeSampleObserver,
} from './roundwatch-runtime-metrics.js';
import {
   createObservatorySampleRetention,
   type RetainedRuntimeSample,
} from './roundwatch-observatory-retention.js';
import type { RoundWatchIndexer } from './roundwatch-indexer.js';
import { initializeObservatorySampleRetention, createObservatoryRuntimeSampler } from './roundwatch-observatory-initialization.js';
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
      retainedRuntimeSample: undefined,
      retainedPublicReadiness: undefined,
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

// Slice 3: controlled producer work is kept separate from passive builder reads.
function sampledCapacity(): CapacityRuntimeSnapshot {
   return {
      unfinishedWatches: 3, activeWatches: 2, settlementPendingWatches: 1,
      unresolvedSettlementUnknownWatches: 0, activeWatchesMissingScanBaseline: 0,
      watchesPastDeadlineAwaitingCoverage: 1, oldestActiveWatchAgeMs: 123.5,
      scanLagRounds: { samples: 2, p50: 0, p95: 7, max: 7 },
      currentIndexerRound: 150, currentIndexerRoundObservedAt: WALL_ISO,
      watchesAttemptedLastCycle: 5, watchesSucceededLastCycle: 2, watchesFailedLastCycle: 1,
   };
}

function rawRuntimeSample(): EconomicsRuntimeSnapshot {
   return {
      resources: {
         sampledAt: WALL_ISO, elapsedMs: 10, rssBytes: 100, heapUsedBytes: 20,
         heapTotalBytes: 50, externalBytes: 0, cpuUserMicros: 5, cpuSystemMicros: 2,
         sqliteBytes: 0, dispatcher: dispatcher(),
      },
      capacity: sampledCapacity(), activeWatchMetrics: 10,
      freeWork: {} as EconomicsRuntimeSnapshot['freeWork'],
   };
}

const verifiedCpu: RuntimeCpuInterval = { userMicros: 5, systemMicros: 2, elapsedMs: 10 };

function retainedBuilder(getter: () => RetainedRuntimeSample, overrides: Partial<ObservatoryRuntimeSources> = {}) {
   return createObservatoryRuntimeSnapshotBuilder(sources({ retainedRuntimeSample: getter, ...overrides }), clocks);
}

function samplerFixture(t: TestContext, overrides: EconomicsRuntimeSamplerOptions = {}, databasePath = '/fixture/database') {
   t.mock.timers.enable({ apis: ['setInterval'] });
   const state = { wall: WALL_MS, monotonic: 100, user: 100, system: 50, fail: '' };
   const calls = { wall: 0, monotonic: 0, cpu: 0, memory: 0, file: 0, sqlite: 0, wal: 0,
      activeMetrics: 0, freeWork: 0, capacity: 0, dispatcher: 0, log: 0 };
   const filePaths: string[] = [];
   const retention = createObservatorySampleRetention(() => new Date(state.wall));
   const logged: EconomicsRuntimeSnapshot[] = [];
   const metrics = new RoundWatchEconomicsMetrics();
   t.mock.method(metrics, 'activeWatchMetricCount', () => { calls.activeMetrics += 1; return 0; });
   const snapshotFreeWork = metrics.snapshotAllFreeWork.bind(metrics);
   t.mock.method(metrics, 'snapshotAllFreeWork', () => { calls.freeWork += 1; return snapshotFreeWork(); });
   const dispatchSource = new IndexerRequestDispatcher();
   const dispatcherSnapshot = t.mock.method(dispatchSource, 'snapshot', () => {
      calls.dispatcher += 1;
      if (state.fail === 'dispatcher') throw new Error('fixture dispatcher failure');
      return dispatcher();
   });
   const options: EconomicsRuntimeSamplerOptions = {
      intervalMilliseconds: 100,
      now: () => {
         calls.wall += 1;
         if (state.fail === 'wall') throw new Error('fixture wall failure');
         return new Date(state.wall);
      },
      monotonicNow: () => {
         calls.monotonic += 1;
         if (state.fail === 'monotonic') throw new Error('fixture monotonic failure');
         return state.monotonic;
      },
      cpuUsage: () => {
         calls.cpu += 1;
         if (state.fail === 'cpu') throw new Error('fixture cpu failure');
         return { user: state.user, system: state.system };
      },
      memoryUsage: () => {
         calls.memory += 1;
         if (state.fail === 'memory') throw new Error('fixture memory failure');
         return { rss: 100, heapUsed: 20, heapTotal: 50, external: 0, arrayBuffers: 0 };
      },
      fileSize: path => {
         calls.file += 1;
         filePaths.push(path);
         if (path === databasePath) calls.sqlite += 1;
         else if (path === `${databasePath}-wal`) calls.wal += 1;
         else assert.fail(`Unexpected fixture path: ${path}`);
         if (state.fail === 'file') throw new Error('fixture file failure');
         return path.endsWith('-wal') ? undefined : 0;
      },
      capacitySnapshot: () => {
         calls.capacity += 1;
         if (state.fail === 'capacity') throw new Error('fixture capacity failure');
         return sampledCapacity();
      },
      observer: retention.observer,
      log: snapshot => { calls.log += 1; logged.push(snapshot); },
      ...overrides,
   };
   const sampler = new RoundWatchRuntimeSampler(metrics, dispatchSource, databasePath, options);
   t.after(() => sampler.stop());
   const advance = () => { state.wall += 100; state.monotonic += 100; state.user += 5; state.system += 2; };
   const scheduled = () => { advance(); t.mock.timers.tick(100); };
   const build = retainedBuilder(retention.snapshot);
   return { sampler, retention, build, state, calls, filePaths, logged, metrics, dispatchSource, dispatcherSnapshot, advance, scheduled };
}

test('sample retention distinguishes unwired, disabled, before-first-sample and new lifetime', t => {
   const retention = createObservatorySampleRetention();
   assertEmpty(retainedBuilder(retention.snapshot)().capacity, 'not_yet_sampled');
   assertEmpty(retainedBuilder(retention.snapshot)().resources, 'not_yet_sampled');
   const getter = t.mock.fn(() => { throw new Error('Disabled source must not be read'); });
   const disabled = retainedBuilder(getter, { economicsMetricsEnabled: false })();
   assertEmpty(disabled.capacity, 'instrumentation_disabled');
   assertEmpty(disabled.resources, 'instrumentation_disabled');
   assert.equal(getter.mock.callCount(), 0);
   retention.observer.sampleCompleted(rawRuntimeSample(), verifiedCpu);
   assert.equal(retainedBuilder(retention.snapshot)().capacity.availability, 'available');
   assertEmpty(retainedBuilder(createObservatorySampleRetention().snapshot)().capacity, 'not_yet_sampled');
   assertEmpty(createObservatoryRuntimeSnapshotBuilder(sources(), clocks)().resources, 'unavailable');
});

test('scheduled sample publishes one pair before logging, preserves its provenance and never duplicates acquisition', t => {
   const fixture = samplerFixture(t);
   const delivery = t.mock.method(fixture.retention.observer, 'sampleCompleted');
   fixture.advance();
   fixture.sampler.start();
   const sampled = fixture.build();
   assert.equal(sampled.capacity.observedAt, new Date(WALL_MS + 100).toISOString());
   assert.equal(sampled.capacity.observedAt, sampled.resources.observedAt);
   assert.deepEqual(sampled.resources.data, {
      sampledAt: sampled.resources.observedAt, rssBytes: 100, heapUsedBytes: 20,
      heapTotalBytes: 50, externalBytes: 0, cpu: { ...verifiedCpu, elapsedMs: 100 },
      sqliteBytes: 0, walBytes: null,
   });
   assert.equal(sampled.capacity.data!.observedIndexerRoundAt, WALL_ISO);
   assert.equal(sampled.capacity.data!.oldestActiveWatchAgeMs, 123.5);
   assert.deepEqual(fixture.calls, { wall: 1, monotonic: 2, cpu: 2, memory: 1, file: 2, sqlite: 1, wal: 1,
      activeMetrics: 1, freeWork: 1, capacity: 1, dispatcher: 1, log: 1 });
   assert.deepEqual(fixture.filePaths, ['/fixture/database', '/fixture/database-wal']);
   for (let i = 0; i < 5; i += 1) fixture.sampler.start();
   assert.equal(delivery.mock.callCount(), 1);
   fixture.scheduled();
   assert.equal(delivery.mock.callCount(), 2);
   assert.deepEqual(fixture.calls, { wall: 2, monotonic: 3, cpu: 3, memory: 2, file: 4, sqlite: 2, wal: 2,
      activeMetrics: 2, freeWork: 2, capacity: 2, dispatcher: 2, log: 2 });
   fixture.sampler.stop();
   const stopped = { ...fixture.calls };
   t.mock.timers.tick(500);
   assert.deepEqual(fixture.calls, stopped);
   fixture.advance();
   fixture.sampler.start();
   fixture.sampler.start();
   assert.equal(delivery.mock.callCount(), 3, 'Restart keeps the existing one immediate sample');
   fixture.scheduled();
   assert.equal(delivery.mock.callCount(), 4, 'Exactly one restarted interval');
   fixture.sampler.stop();
});

test('retained capacity keeps its own tip and time when the live tip changes; real zero differs from absence', () => {
   const retention = createObservatorySampleRetention();
   const candidate = rawRuntimeSample();
   Object.assign(candidate.capacity!, {
      currentIndexerRound: 0, oldestActiveWatchAgeMs: 0,
      scanLagRounds: { samples: 2, p50: 0, p95: 0, max: 0 },
   });
   retention.observer.sampleCompleted(candidate, null);
   let tip = { currentIndexerRound: 200, currentIndexerRoundObservedAt: new Date(WALL_MS + 100).toISOString() };
   const build = retainedBuilder(retention.snapshot, { cachedIndexerTip: () => tip });
   const first = build();
   assert.equal(first.capacity.data!.observedIndexerRound, 0);
   assert.equal(first.capacity.data!.observedIndexerRoundAt, WALL_ISO);
   assert.equal(first.capacity.data!.oldestActiveWatchAgeMs, 0);
   assert.equal(first.capacity.data!.scanLagRounds!.max, 0);
   assert.equal(first.resources.data!.sqliteBytes, 0);
   assert.equal(first.resources.data!.walBytes, null);
   tip = { currentIndexerRound: 300, currentIndexerRoundObservedAt: new Date(WALL_MS + 500).toISOString() };
   assert.deepEqual(build().capacity, first.capacity);
   assert.equal(build().indexer.observedRound.data!.round, 300);
   const empty = rawRuntimeSample();
   empty.capacity = {
      unfinishedWatches: 0, activeWatches: 0, settlementPendingWatches: 0,
      unresolvedSettlementUnknownWatches: 0, activeWatchesMissingScanBaseline: 0,
      watchesPastDeadlineAwaitingCoverage: 0,
      watchesAttemptedLastCycle: 0, watchesSucceededLastCycle: 0, watchesFailedLastCycle: 0,
   };
   retention.observer.sampleCompleted(empty, null);
   assert.equal(build().capacity.availability, 'available');
   assert.equal(build().capacity.data!.unfinishedWatches, 0);
   for (const field of ['oldestActiveWatchAgeMs', 'scanLagRounds', 'observedIndexerRound', 'observedIndexerRoundAt'] as const) {
      assert.equal(build().capacity.data![field], null);
   }
});

test('retention failure and recovery use event order even across wall-clock rollback and retain the last failure time', () => {
   let wall = WALL_MS;
   const retention = createObservatorySampleRetention(() => new Date(wall));
   const build = retainedBuilder(retention.snapshot);
   retention.observer.collectionFailed();
   assert.deepEqual(build().capacity, {
      availability: 'collection_failed', observedAt: null, lastCollectionFailureAt: WALL_ISO, data: null,
   });
   const candidate = rawRuntimeSample();
   retention.observer.sampleCompleted(candidate, verifiedCpu);
   const accepted = build();
   assert.equal(accepted.resources.availability, 'available');
   assert.equal(accepted.resources.lastCollectionFailureAt, WALL_ISO);
   wall -= 1_000;
   retention.observer.collectionFailed();
   const failed = build();
   assert.equal(failed.capacity.availability, 'collection_failed');
   assert.deepEqual(failed.capacity.data, accepted.capacity.data);
   assert.deepEqual(failed.resources.data, accepted.resources.data);
   assert.equal(failed.resources.observedAt, WALL_ISO);
   assert.equal(failed.resources.lastCollectionFailureAt, new Date(wall).toISOString());
   candidate.resources.sampledAt = new Date(wall - 1_000).toISOString();
   retention.observer.sampleCompleted(candidate, null);
   const recovered = build();
   assert.equal(recovered.capacity.availability, 'available');
   assert.equal(recovered.resources.lastCollectionFailureAt, failed.resources.lastCollectionFailureAt);
   assert.equal(recovered.capacity.observedAt, candidate.resources.sampledAt);
   assert.equal(recovered.capacity.data!.observedIndexerRoundAt, WALL_ISO, 'Valid future-looking provenance is preserved');
   assert.equal(recovered.workers.poller.data!.ready, true);
});

for (const failurePoint of ['wall', 'monotonic', 'cpu', 'memory', 'file', 'dispatcher', 'capacity']) {
   test(`scheduled ${failurePoint} failure preserves the pair, then CPU recovers on the subsequent normal interval`, t => {
      const warning = t.mock.method(console, 'warn', () => {});
      const fixture = samplerFixture(t);
      fixture.advance();
      fixture.sampler.start();
      const accepted = fixture.build();
      fixture.state.fail = failurePoint;
      fixture.scheduled();
      const failed = fixture.build();
      assert.equal(failed.resources.availability, 'collection_failed');
      assert.deepEqual(failed.resources.data, accepted.resources.data);
      assert.deepEqual(failed.capacity.data, accepted.capacity.data);
      assert.equal(failed.resources.observedAt, accepted.resources.observedAt);
      assert.equal(failed.resources.lastCollectionFailureAt, new Date(fixture.state.wall).toISOString());
      assert.equal(fixture.calls.log, 1, 'Failed acquisition does not log a raw sample');
      assert.equal(warning.mock.callCount(), 1, 'Existing acquisition warning remains');
      fixture.state.fail = '';
      fixture.scheduled();
      const recovered = fixture.build();
      assert.equal(recovered.resources.availability, 'available');
      assert.equal(recovered.resources.data!.cpu, null);
      assert.equal(recovered.resources.lastCollectionFailureAt, failed.resources.lastCollectionFailureAt);
      assert.equal(recovered.capacity.data!.observedIndexerRoundAt, WALL_ISO);
      fixture.scheduled();
      assert.deepEqual(fixture.build().resources.data!.cpu, { ...verifiedCpu, elapsedMs: 100 });
      assert.equal(fixture.calls.log, 3);
      fixture.sampler.stop();
   });
}

test('acquisition failure before first publication retains null data; normal recovery establishes CPU', t => {
   t.mock.method(console, 'warn', () => {});
   const fixture = samplerFixture(t);
   fixture.state.fail = 'cpu';
   fixture.advance();
   fixture.sampler.start();
   const failed = fixture.build();
   assert.equal(failed.capacity.availability, 'collection_failed');
   assert.equal(failed.resources.data, null);
   assert.equal(failed.resources.observedAt, null);
   fixture.state.fail = '';
   fixture.scheduled();
   assert.equal(fixture.build().resources.data!.cpu, null);
   fixture.scheduled();
   assert.deepEqual(fixture.build().resources.data!.cpu, { ...verifiedCpu, elapsedMs: 100 });
});

test('logging failure cannot cancel prior publication, set failure metadata, or invalidate CPU pairing', t => {
   const warning = t.mock.method(console, 'warn', () => {});
   const fixture = samplerFixture(t);
   const log = t.mock.fn(() => {
      assert.equal(fixture.build().resources.availability, 'available', 'Publication precedes logging');
      throw new Error('fixture logger failure');
   });
   // Constructor log injection uses a closure so each scheduled call reaches it.
   const loggingSampler = new RoundWatchRuntimeSampler(new RoundWatchEconomicsMetrics(), fixture.dispatchSource, ':memory:', {
      now: () => new Date(fixture.state.wall), monotonicNow: () => fixture.state.monotonic,
      cpuUsage: () => ({ user: fixture.state.user, system: fixture.state.system }),
      memoryUsage: () => ({ rss: 1, heapUsed: 1, heapTotal: 1, external: 0, arrayBuffers: 0 }),
      capacitySnapshot: sampledCapacity, observer: fixture.retention.observer, log, intervalMilliseconds: 100,
   });
   t.after(() => loggingSampler.stop());
   fixture.advance();
   loggingSampler.start();
   const first = fixture.build();
   fixture.advance();
   t.mock.timers.tick(100);
   const second = fixture.build();
   assert.equal(first.resources.lastCollectionFailureAt, null);
   assert.equal(second.capacity.lastCollectionFailureAt, null);
   assert.deepEqual(second.resources.data!.cpu, { ...verifiedCpu, elapsedMs: 100 });
   assert.equal(second.resources.data!.sqliteBytes, null);
   assert.equal(second.resources.data!.walBytes, null);
   assert.equal(warning.mock.callCount(), 2);
   assert.equal(log.mock.callCount(), 2);
});

test('observer and failure-hook exceptions do not affect operational logging, return values, or cadence', t => {
   const warnings = t.mock.method(console, 'warn', () => {});
   const sampleCompleted = t.mock.fn(() => { throw new Error('private observer error'); });
   const collectionFailed = t.mock.fn(() => { throw new Error('private failure hook error'); });
   const fixture = samplerFixture(t, { observer: { sampleCompleted, collectionFailed } });
   fixture.advance();
   fixture.sampler.start();
   fixture.scheduled();
   assert.equal(fixture.calls.log, 2);
   assert.equal(sampleCompleted.mock.callCount(), 2);
   assert.equal(collectionFailed.mock.callCount(), 2);
   assert.equal(warnings.mock.callCount(), 0, 'Optional observer errors add no logs');
   fixture.state.fail = 'memory';
   fixture.scheduled();
   assert.equal(collectionFailed.mock.callCount(), 3);
   assert.equal(warnings.mock.callCount(), 1, 'Only the legacy acquisition warning');
   fixture.state.fail = '';
   fixture.scheduled();
   assert.equal(fixture.calls.log, 3);
   fixture.advance();
   const raw = fixture.sampler.sample();
   assert.equal(raw.resources.rssBytes, 100);
   assert.equal(sampleCompleted.mock.callCount(), 3, 'Public sample does not deliver scheduled observer');
});

test('optional observer option getter cannot abort sampler construction', t => {
   const logs = (['log', 'warn', 'error', 'info', 'debug'] as const).map(method => t.mock.method(console, method, () => assert.fail('Optional wiring logged')));
   const options: EconomicsRuntimeSamplerOptions = {
      cpuUsage: () => ({ user: 0, system: 0 }), monotonicNow: () => 0,
      get observer(): ScheduledRuntimeSampleObserver | undefined { throw new Error('private boot wiring error'); },
   };
   assert.doesNotThrow(() => new RoundWatchRuntimeSampler(new RoundWatchEconomicsMetrics(), new IndexerRequestDispatcher(), ':memory:', options));
   for (const log of logs) assert.equal(log.mock.callCount(), 0);
});

test('observer types reject ordinary async callbacks for both hooks', () => {
   const unsupported: ScheduledRuntimeSampleObserver = {
      // @ts-expect-error Async publication is not a supported observer.
      sampleCompleted: async () => {},
      // @ts-expect-error Async failure notification is not a supported observer.
      collectionFailed: async () => {},
   };
   assert.equal(typeof unsupported.sampleCompleted, 'function');
   assert.equal(typeof unsupported.collectionFailed, 'function');
});

for (const hook of ['sampleCompleted', 'collectionFailed'] as const) {
   test(`runtime-bypassed rejecting ${hook} is locally contained in an isolated process`, () => {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
         import assert from 'node:assert/strict';
         import { RoundWatchRuntimeSampler } from './roundwatch-runtime-metrics.ts';
         import { RoundWatchEconomicsMetrics } from './roundwatch-metrics.ts';
         import { IndexerRequestDispatcher } from './roundwatch-scheduler.ts';
         const calls = { cpu: 0, monotonic: 0, memory: 0, completed: 0, failed: 0, log: 0 };
         const hook = ${JSON.stringify(hook)};
         const sampler = new RoundWatchRuntimeSampler(new RoundWatchEconomicsMetrics(),
            new IndexerRequestDispatcher(), ':memory:', {
               intervalMilliseconds: 5,
               cpuUsage: () => ({ user: ++calls.cpu, system: 0 }),
               monotonicNow: () => ++calls.monotonic,
               memoryUsage: () => {
                  ++calls.memory;
                  if (hook === 'collectionFailed' && calls.memory === 1) throw Error('acquisition');
                  return { rss: 1, heapUsed: 1, heapTotal: 1, external: 0, arrayBuffers: 0 };
               },
               observer: {
                  sampleCompleted() {
                     ++calls.completed;
                     if (hook === 'sampleCompleted') return (async () => { throw Error('unsupported publication'); })();
                  },
                  collectionFailed() {
                     ++calls.failed;
                     if (hook === 'collectionFailed') return Promise.reject(Error('unsupported failure'));
                  },
               },
               log: () => { ++calls.log; },
            });
         sampler.start();
         assert.equal(calls.log, hook === 'sampleCompleted' ? 1 : 0, 'Logging is synchronous');
         setTimeout(() => {
            sampler.stop();
            assert.ok(calls.log >= 2, 'Scheduled sampling continues');
            assert.equal(calls.completed, calls.log);
            assert.equal(calls.cpu, calls.memory + 1, 'Only the constructor CPU baseline is extra');
            assert.equal(calls.monotonic, calls.memory + 1);
            assert.equal(calls.failed, hook === 'sampleCompleted' ? calls.completed : 1,
               'Failure notification never recurses');
            console.log('isolated rejection containment passed');
         }, 40);
      `], { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', timeout: 15_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /isolated rejection containment passed/);
      assert.doesNotMatch(result.stderr, /unsupported publication|unsupported failure|unhandled/i);
   });
}

for (const hook of ['sampleCompleted', 'collectionFailed'] as const) {
   test(`delayed ${hook} rejection cannot overwrite a newer accepted observation`, async t => {
      const warning = t.mock.method(console, 'warn', () => {});
      const fixture = samplerFixture(t);
      let reject!: (reason: Error) => void;
      const pending = new Promise<never>((_, rejectPromise) => { reject = rejectPromise; });
      const original = fixture.retention.observer[hook];
      const misuse = t.mock.method(fixture.retention.observer, hook,
         (() => pending) as unknown as typeof original);
      const failure = t.mock.method(fixture.retention.observer, 'collectionFailed');
      fixture.advance();
      if (hook === 'collectionFailed') fixture.state.fail = 'memory';
      fixture.sampler.start();
      assert.equal(failure.mock.callCount(), 1, 'Classified immediately at invocation');
      assert.equal(fixture.calls.log, hook === 'sampleCompleted' ? 1 : 0);
      if (hook === 'sampleCompleted') {
         assert.equal(fixture.build().resources.availability, 'collection_failed');
         assert.equal(fixture.build().resources.lastCollectionFailureAt, new Date(fixture.state.wall).toISOString());
      }
      failure.mock.restore();
      misuse.mock.restore();
      fixture.state.fail = '';
      fixture.scheduled();
      assert.equal(fixture.build().resources.availability, 'available');
      // Acquisition failure clears CPU confidence, observer failure does not.
      assert.deepEqual(fixture.build().resources.data!.cpu,
         hook === 'sampleCompleted' ? { ...verifiedCpu, elapsedMs: 100 } : null);
      fixture.scheduled();
      const newer = fixture.retention.snapshot();
      assert.deepEqual(newer.resources.data!.cpu, { ...verifiedCpu, elapsedMs: 100 });
      const beforeRejection = { ...fixture.calls };
      reject(new Error('late unsupported rejection'));
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(fixture.retention.snapshot(), newer, 'No settlement-time metadata writes');
      assert.deepEqual(fixture.calls, beforeRejection, 'Rejection causes no acquisition or log');
      assert.equal(warning.mock.callCount(), hook === 'sampleCompleted' ? 0 : 1);
      assert.equal(fixture.calls.cpu, 4, 'Constructor baseline plus three scheduled attempts');
      assert.equal(fixture.calls.monotonic, 4);
      fixture.scheduled();
      assert.equal(fixture.calls.log, hook === 'sampleCompleted' ? 4 : 3);
      assert.deepEqual(fixture.build().resources.data!.cpu, { ...verifiedCpu, elapsedMs: 100 });
   });
}

for (const enabled of [true, false]) {
   test(`throwing production retention factory preserves economics-${enabled ? 'enabled' : 'disabled'} boot lifecycle`, t => {
      t.mock.timers.enable({ apis: ['setInterval'] });
      const logs = (['log', 'warn', 'error', 'info', 'debug'] as const).map(
         method => t.mock.method(console, method, () => assert.fail('Optional boot failure logged')));
      t.mock.method(globalThis, 'fetch', () => assert.fail('Offline boot accessed a provider'));
      const factory = t.mock.fn(() => { throw new Error('retention initialization failed'); });
      const samples = initializeObservatorySampleRetention(factory);
      const retainedRuntimeSample = samples?.snapshot;
      const continueOperationalStartup = t.mock.fn(() => {});
      continueOperationalStartup();
      assert.equal(continueOperationalStartup.mock.callCount(), 1);
      assert.equal(samples, undefined, 'No fabricated retention');
      assert.equal(factory.mock.callCount(), 1);
      const cpu = t.mock.fn(() => ({ user: 0, system: 0 }));
      const monotonic = t.mock.fn(() => 100);
      const memory = t.mock.fn(() => ({ rss: 1, heapUsed: 1, heapTotal: 1, external: 0, arrayBuffers: 0 }));
      const log = t.mock.fn(() => {});
      const interval = t.mock.method(globalThis, 'setInterval');
      const sampler = createObservatoryRuntimeSampler(enabled ? new RoundWatchEconomicsMetrics() : undefined,
         new IndexerRequestDispatcher(), ':memory:', samples, {
            intervalMilliseconds: 100, cpuUsage: cpu, monotonicNow: monotonic, memoryUsage: memory, log,
            fileSize: () => assert.fail('Boot touched a database file'),
         });
      t.after(() => sampler?.stop());
      const build = createObservatoryRuntimeSnapshotBuilder(sources({
         economicsMetricsEnabled: enabled, retainedRuntimeSample,
      }), clocks);
      assertEmpty(build().capacity, enabled ? 'unavailable' : 'instrumentation_disabled');
      assertEmpty(build().resources, enabled ? 'unavailable' : 'instrumentation_disabled');
      assert.equal(cpu.mock.callCount(), enabled ? 1 : 0, 'Constructor baseline only');
      assert.equal(monotonic.mock.callCount(), enabled ? 1 : 0);
      assert.equal(interval.mock.callCount(), 0, 'No timer before listening/start');
      assert.equal(memory.mock.callCount(), 0);
      if (enabled) {
         assert.ok(sampler);
         sampler.start();
         sampler.start();
         assert.equal(log.mock.callCount(), 1, 'One immediate sample');
         assert.equal(interval.mock.callCount(), 1);
         t.mock.timers.tick(100);
         assert.equal(log.mock.callCount(), 2);
         sampler.stop();
         t.mock.timers.tick(500);
         assert.equal(log.mock.callCount(), 2);
         sampler.start();
         assert.equal(log.mock.callCount(), 3);
         assert.equal(interval.mock.callCount(), 2);
      } else {
         assert.equal(sampler, undefined);
         t.mock.timers.tick(500);
         assert.equal(log.mock.callCount(), 0);
         assert.equal(interval.mock.callCount(), 0);
      }
      for (const spy of logs) assert.equal(spy.mock.callCount(), 0);
   });
}

for (const databasePath of ['/fixture/database', ':memory:']) {
   test(`scheduled acquisition counts are identical with/without retention for ${databasePath}`, async t => {
      const runs: Array<{ calls: ReturnType<typeof samplerFixture>['calls']; logged: EconomicsRuntimeSnapshot[] }> = [];
      for (const observed of [true, false]) {
         await t.test(observed ? 'with retention' : 'without retention', t => {
            const fixture = samplerFixture(t, observed ? {} : { observer: undefined }, databasePath);
            assert.deepEqual(fixture.calls, {
               wall: 0, monotonic: 1, cpu: 1, memory: 0, file: 0, sqlite: 0, wal: 0,
               activeMetrics: 0, freeWork: 0, capacity: 0, dispatcher: 0, log: 0,
            }, 'Constructor CPU/monotonic baseline reads are separate');
            fixture.advance();
            fixture.sampler.start();
            const files = databasePath === ':memory:' ? 0 : 1;
            assert.deepEqual(fixture.calls, {
               wall: 1, monotonic: 2, cpu: 2, memory: 1, file: files * 2, sqlite: files, wal: files,
               activeMetrics: 1, freeWork: 1, capacity: 1, dispatcher: 1, log: 1,
            });
            assert.deepEqual(fixture.filePaths, files ? [databasePath, `${databasePath}-wal`] : []);
            const beforeReads = { ...fixture.calls };
            for (let i = 0; i < 30; ++i) fixture.build();
            assert.deepEqual(fixture.calls, beforeReads, 'Builder reads add zero acquisitions');
            fixture.scheduled();
            assert.deepEqual(fixture.calls, {
               wall: 2, monotonic: 3, cpu: 3, memory: 2, file: files * 4, sqlite: files * 2, wal: files * 2,
               activeMetrics: 2, freeWork: 2, capacity: 2, dispatcher: 2, log: 2,
            });
            assert.deepEqual(fixture.filePaths, files
               ? [databasePath, `${databasePath}-wal`, databasePath, `${databasePath}-wal`] : []);
            runs.push({ calls: { ...fixture.calls }, logged: structuredClone(fixture.logged) });
         });
      }
      assert.deepEqual(runs[0], runs[1], 'Retention adds no acquisition and preserves legacy output');
   });
}

test('projection rejection is isolated from logging/cadence and cannot poison an acquired CPU baseline', t => {
   const fixture = samplerFixture(t);
   const publish = fixture.retention.observer.sampleCompleted;
   t.mock.method(fixture.retention.observer, 'sampleCompleted', (source: EconomicsRuntimeSnapshot, cpu: RuntimeCpuInterval | null): undefined => {
      if (fixture.state.fail === 'projection') source.capacity!.scanLagRounds!.p50 = 99;
      publish(source, cpu);
   });
   fixture.advance();
   fixture.sampler.start();
   const accepted = fixture.build();
   fixture.state.fail = 'projection';
   fixture.scheduled();
   assert.equal(fixture.build().resources.availability, 'collection_failed');
   assert.deepEqual(fixture.build().capacity.data, accepted.capacity.data);
   assert.equal(fixture.calls.log, 2);
   fixture.state.fail = '';
   fixture.scheduled();
   assert.deepEqual(fixture.build().resources.data!.cpu, { ...verifiedCpu, elapsedMs: 100 });
   assert.equal(fixture.calls.log, 3);
});

test('public sample preserves legacy raw output but invalidates the next scheduled CPU interval', t => {
   const fixture = samplerFixture(t);
   fixture.advance();
   fixture.sampler.start();
   const retained = fixture.retention.snapshot();
   const delivery = t.mock.method(fixture.retention.observer, 'sampleCompleted');
   fixture.advance();
   const raw = fixture.sampler.sample();
   assert.equal(raw.resources.elapsedMs, 100);
   assert.equal(raw.resources.cpuUserMicros, 5);
   assert.equal(fixture.retention.snapshot(), retained);
   assert.equal(delivery.mock.callCount(), 0);
   fixture.scheduled();
   assert.equal(fixture.build().resources.data!.cpu, null);
   fixture.scheduled();
   assert.deepEqual(fixture.build().resources.data!.cpu, { ...verifiedCpu, elapsedMs: 100 });
   fixture.state.fail = 'cpu';
   fixture.advance();
   assert.throws(() => fixture.sampler.sample(), /cpu failure/);
   const beforeRecovery = fixture.retention.snapshot();
   fixture.state.fail = '';
   fixture.scheduled();
   assert.equal(fixture.build().resources.data!.cpu, null);
   assert.notEqual(fixture.retention.snapshot(), beforeRecovery);
   fixture.scheduled();
   assert.notEqual(fixture.build().resources.data!.cpu, null);
});

for (const [label, mutate] of [
   ['zero elapsed', (state: { monotonic: number }) => { state.monotonic -= 100; }],
   ['rollback', (state: { monotonic: number }) => { state.monotonic -= 110; }],
   ['decreasing CPU', (state: { user: number }) => { state.user = 0; }],
] as const) {
   test(`CPU ${label} publishes null CPU, retains legacy clamping, and recovers without repair sampling`, t => {
      const fixture = samplerFixture(t);
      fixture.advance();
      fixture.sampler.start();
      fixture.advance();
      mutate(fixture.state);
      t.mock.timers.tick(100);
      assert.equal(fixture.build().resources.availability, 'available');
      assert.equal(fixture.build().resources.data!.cpu, null);
      if (label !== 'decreasing CPU') assert.equal(fixture.logged[1].resources.elapsedMs, 0);
      else assert.equal(fixture.logged[1].resources.cpuUserMicros, 0);
      fixture.scheduled();
      assert.deepEqual(fixture.build().resources.data!.cpu, { ...verifiedCpu, elapsedMs: 100 });
   });
}

test('nonfinite/unsafe/negative raw operands fail before clamping and recover with a null interval', t => {
   t.mock.method(console, 'warn', () => {});
   const fixture = samplerFixture(t);
   fixture.advance();
   fixture.sampler.start();
   for (const field of ['monotonic', 'user', 'system'] as const) {
      for (const invalid of [NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1, ...(field === 'monotonic' ? [] : [0.5])]) {
         const accepted = fixture.build().resources;
         const valid = fixture.state[field];
         fixture.state[field] = invalid;
         t.mock.timers.tick(100);
         const failed = fixture.build().resources;
         assert.equal(failed.availability, 'collection_failed', `${field}=${invalid}`);
         assert.deepEqual(failed.data, accepted.data);
         fixture.state[field] = valid;
         fixture.scheduled();
         assert.equal(fixture.build().resources.data!.cpu, null);
         fixture.scheduled();
         assert.deepEqual(fixture.build().resources.data!.cpu, { ...verifiedCpu, elapsedMs: 100 });
      }
   }
});

test('CPU baseline copies acquisition totals rather than retaining mutable fixture objects', t => {
   const totals = { user: 100, system: 50 };
   const fixture = samplerFixture(t, { cpuUsage: () => totals });
   totals.user = 105;
   totals.system = 52;
   fixture.advance();
   fixture.sampler.start();
   assert.deepEqual(fixture.build().resources.data!.cpu, { ...verifiedCpu, elapsedMs: 100 });
   totals.user += 5;
   totals.system += 2;
   fixture.scheduled();
   assert.deepEqual(fixture.build().resources.data!.cpu, { ...verifiedCpu, elapsedMs: 100 });
});

test('retention and returned DTO are detached; private wrappers and unknown getters are never read or retained', () => {
   const retention = createObservatorySampleRetention();
   const raw = rawRuntimeSample();
   const fail = () => { throw new Error('Forbidden raw field read'); };
   for (const field of ['freeWork', 'activeWatchMetrics', 'watchIds', 'path', 'error']) Object.defineProperty(raw, field, { get: fail });
   for (const field of ['dispatcher', 'elapsedMs', 'cpuUserMicros', 'cpuSystemMicros', 'private']) Object.defineProperty(raw.resources, field, { get: fail });
   for (const field of ['watchesAttemptedLastCycle', 'private']) Object.defineProperty(raw.capacity!, field, { get: fail });
   const cpu = { ...verifiedCpu };
   retention.observer.sampleCompleted(raw, cpu);
   const cached = retention.snapshot();
   assert.equal(cached.resources.availability, 'available');
   for (const object of [cached, cached.capacity, cached.resources, cached.capacity.data,
      cached.capacity.data!.scanLagRounds, cached.resources.data, cached.resources.data!.cpu]) assert.ok(Object.isFrozen(object));
   assert.equal(Object.isFrozen(raw.resources), false);
   assert.equal(Object.isFrozen(raw.capacity!.scanLagRounds), false);
   const build = retainedBuilder(retention.snapshot);
   const accepted = build();
   raw.resources.rssBytes = 900;
   raw.capacity!.scanLagRounds!.p95 = 100;
   cpu.userMicros = 100;
   const output = build();
   output.resources.data!.rssBytes = 500;
   output.resources.data!.cpu!.userMicros = 200;
   output.capacity.data!.scanLagRounds!.max = 300;
   output.capacity.lastCollectionFailureAt = 'mutated';
   assert.deepEqual(build().resources, accepted.resources);
   assert.deepEqual(build().capacity, accepted.capacity);
   assert.deepEqual(Object.keys(cached.capacity.data!), [
      'sampledAt', 'unfinishedWatches', 'activeWatches', 'settlementPendingWatches',
      'unresolvedSettlementUnknownWatches', 'activeWatchesMissingScanBaseline',
      'watchesPastDeadlineAwaitingCoverage', 'oldestActiveWatchAgeMs', 'scanLagRounds',
      'observedIndexerRound', 'observedIndexerRoundAt',
   ]);
   assert.deepEqual(Object.keys(cached.resources.data!), [
      'sampledAt', 'rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes', 'cpu', 'sqliteBytes', 'walBytes',
   ]);
});

test('invalid required/optional timestamps, fields and distributions preserve previous complete pair', () => {
   let wall = WALL_MS;
   const retention = createObservatorySampleRetention(() => new Date(wall));
   retention.observer.sampleCompleted(rawRuntimeSample(), verifiedCpu);
   const original = retention.snapshot();
   const reject = (mutate: (raw: EconomicsRuntimeSnapshot) => void, cpu: RuntimeCpuInterval | null = verifiedCpu) => {
      const raw = rawRuntimeSample();
      mutate(raw);
      wall += 1;
      retention.observer.sampleCompleted(raw, cpu);
      const failed = retention.snapshot();
      assert.equal(failed.resources.availability, 'collection_failed');
      assert.equal(failed.capacity.data, original.capacity.data);
      assert.equal(failed.resources.data, original.resources.data);
      assert.equal(failed.resources.observedAt, WALL_ISO);
      assert.equal(failed.resources.lastCollectionFailureAt, new Date(wall).toISOString());
   };
   for (const invalid of ['', 'bad', '2026-02-30T12:00:00Z', '2026-10-05T24:00:00Z', '2026-10-05T12:00:00', '2026-10-05T12:00:00+02:00', 123]) {
      reject(raw => { raw.resources.sampledAt = invalid as string; });
      reject(raw => { raw.capacity!.currentIndexerRoundObservedAt = invalid as string; });
   }
   reject(raw => { delete raw.capacity!.currentIndexerRoundObservedAt; });
   reject(raw => { delete raw.capacity!.currentIndexerRound; });
   reject(raw => { delete raw.capacity; });
   for (const field of ['unfinishedWatches', 'activeWatches', 'settlementPendingWatches', 'unresolvedSettlementUnknownWatches', 'activeWatchesMissingScanBaseline', 'watchesPastDeadlineAwaitingCoverage', 'currentIndexerRound'] as const) {
      for (const invalid of [undefined, null, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, '1']) reject(raw => { raw.capacity![field] = invalid as number; });
   }
   for (const field of ['rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes', 'sqliteBytes', 'walBytes'] as const) {
      for (const invalid of [...(['sqliteBytes', 'walBytes'].includes(field) ? [] : [undefined, null]), -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, '1']) reject(raw => { raw.resources[field] = invalid as number; });
   }
   for (const invalid of [-1, NaN, Infinity, '1']) reject(raw => { raw.capacity!.oldestActiveWatchAgeMs = invalid as number; });
   for (const lag of [
      { samples: 0, p50: 0, p95: 0, max: 0 }, { samples: 1, p50: 2, p95: 1, max: 2 },
      { samples: 1, p50: 1, p95: 3, max: 2 }, { samples: NaN, p50: 0, p95: 0, max: 0 },
      { samples: 1, p50: 0, p95: 0, max: Infinity },
   ]) reject(raw => { raw.capacity!.scanLagRounds = lag; });
   for (const cpu of [
      { userMicros: NaN, systemMicros: 0, elapsedMs: 1 }, { userMicros: 0, systemMicros: -1, elapsedMs: 1 },
      { userMicros: 0, systemMicros: 0, elapsedMs: 0 }, { userMicros: 0, systemMicros: 0, elapsedMs: -1 },
      { userMicros: 0, systemMicros: 0, elapsedMs: Infinity },
   ]) reject(() => {}, cpu);
});

test('invalid or throwing failure clocks and publication freezing failures preserve previous state silently', t => {
   const logs = (['log', 'warn', 'error', 'info', 'debug'] as const).map(method => t.mock.method(console, method, () => assert.fail('Passive retention failure logged')));
   let failure = false;
   for (const badClock of [() => new Date(NaN), () => { throw new Error('private failure clock'); },
      () => ({ toISOString: () => 'bad' }) as Date]) {
      failure = false;
      const retention = createObservatorySampleRetention(() => failure ? badClock() : new Date(WALL_MS));
      retention.observer.sampleCompleted(rawRuntimeSample(), verifiedCpu);
      const before = retention.snapshot();
      failure = true;
      retention.observer.collectionFailed();
      assert.equal(retention.snapshot(), before);
      const invalid = rawRuntimeSample();
      invalid.resources.sampledAt = 'bad';
      retention.observer.sampleCompleted(invalid, verifiedCpu);
      assert.equal(retention.snapshot(), before);
   }
   const retention = createObservatorySampleRetention(() => new Date(WALL_MS));
   retention.observer.sampleCompleted(rawRuntimeSample(), verifiedCpu);
   const before = retention.snapshot();
   const freeze = t.mock.method(Object, 'freeze', () => { throw new Error('private freezing failure'); });
   retention.observer.sampleCompleted(rawRuntimeSample(), verifiedCpu);
   retention.observer.collectionFailed();
   assert.equal(retention.snapshot(), before);
   freeze.mock.restore();
   for (const log of logs) assert.equal(log.mock.callCount(), 0);
});

test('publication freezing rejection keeps the pair, existing logging and the next acquired CPU interval', t => {
   const fixture = samplerFixture(t);
   fixture.advance();
   fixture.sampler.start();
   const before = fixture.build();
   const originalFreeze = Object.freeze;
   let rejectPublication = true;
   const freeze = t.mock.method(Object, 'freeze', <T>(value: T): Readonly<T> => {
      if (rejectPublication) {
         rejectPublication = false;
         throw new Error('fixture publication failure');
      }
      return originalFreeze(value);
   });
   fixture.scheduled();
   freeze.mock.restore();
   const failed = fixture.build();
   assert.equal(failed.capacity.availability, 'collection_failed');
   assert.deepEqual(failed.capacity.data, before.capacity.data);
   assert.deepEqual(failed.resources.data, before.resources.data);
   assert.equal(fixture.calls.log, 2);
   fixture.scheduled();
   assert.equal(fixture.build().resources.availability, 'available');
   assert.deepEqual(fixture.build().resources.data!.cpu, { ...verifiedCpu, elapsedMs: 100 });
   assert.equal(fixture.calls.log, 3);
});

test('in-memory producer skips file measurements and Observatory never fills the missing file sizes', t => {
   const fixture = samplerFixture(t, {}, ':memory:');
   fixture.advance();
   fixture.sampler.start();
   assert.equal(fixture.calls.file, 0);
   for (let i = 0; i < 20; i += 1) {
      const resources = fixture.build().resources.data!;
      assert.equal(resources.sqliteBytes, null);
      assert.equal(resources.walBytes, null);
   }
   assert.equal(fixture.calls.file, 0);
   assert.equal(fixture.calls.memory, 1);
   assert.equal(fixture.calls.cpu, 2, 'One constructor baseline plus one scheduled CPU read');
});

test('getter/read-validation failures return unavailable without changing retained data or failure metadata', t => {
   const retention = createObservatorySampleRetention();
   retention.observer.sampleCompleted(rawRuntimeSample(), verifiedCpu);
   const before = retention.snapshot();
   const malformed = structuredClone(before);
   malformed.resources.observedAt = 'bad';
   const candidates = [
      malformed,
      { ...structuredClone(before), capacity: { ...before.capacity, lastCollectionFailureAt: 'bad' } },
      { ...structuredClone(before), capacity: { ...before.capacity, availability: 'collection_failed', lastCollectionFailureAt: null } },
      { ...structuredClone(before), resources: { ...before.resources, data: null } },
      { ...structuredClone(before), capacity: { ...before.capacity, observedAt: new Date(WALL_MS + 1).toISOString() } },
   ];
   for (const candidate of candidates) {
      const getter = t.mock.fn(() => candidate as RetainedRuntimeSample);
      const build = retainedBuilder(getter);
      const snapshot = build();
      assertEmpty(snapshot.capacity, 'unavailable');
      assertEmpty(snapshot.resources, 'unavailable');
      assert.equal(snapshot.workers.poller.availability, 'available');
      assert.equal(getter.mock.callCount(), 1);
      assert.equal(retention.snapshot(), before);
   }
   const build = retainedBuilder(() => { throw new Error('private memory getter'); });
   for (let i = 0; i < 20; i += 1) {
      assertEmpty(build().capacity, 'unavailable');
      assert.equal(retention.snapshot(), before);
   }
});

test('repeated reads after scheduled success and failure have no acquisition, logs, or baseline/metadata mutation', t => {
   const fixture = samplerFixture(t);
   fixture.advance();
   fixture.sampler.start();
   let readWall = WALL_MS + 10_000;
   const get = t.mock.fn(fixture.retention.snapshot);
   const forbidden = () => assert.fail('Passive read performed operational work');
   const build = createObservatoryRuntimeSnapshotBuilder(Object.assign(sources({
      retainedRuntimeSample: get,
   }), { sampler: fixture.sampler, store: { capacitySnapshot: forbidden, readinessCheck: forbidden },
      currentReadinessSnapshot: forbidden, runOnce: forbidden, reconcileOnce: forbidden }),
   { ...clocks, epochMilliseconds: () => readWall });
   const globals = [
      t.mock.method(process, 'cpuUsage', forbidden), t.mock.method(process, 'memoryUsage', forbidden),
      t.mock.method(globalThis, 'fetch', forbidden),
   ];
   const acquisitionWarning = t.mock.method(console, 'warn', () => {});
   const readMany = () => {
      const retained = fixture.retention.snapshot();
      const calls = { ...fixture.calls };
      const baselines = { ...(fixture.sampler as unknown as { previousCpu: NodeJS.CpuUsage; previousMonotonic: number; pairedCpuBaseline: unknown }) };
      const logs = (['log', 'warn', 'error', 'info', 'debug'] as const).map(method => t.mock.method(console, method, forbidden));
      const sample = t.mock.method(fixture.sampler, 'sample', forbidden);
      for (let i = 0; i < 30; i += 1) {
         readWall += 1_000;
         const snapshot = build();
         assert.equal(snapshot.capacity.observedAt, retained.capacity.observedAt);
         assert.equal(snapshot.resources.lastCollectionFailureAt, retained.resources.lastCollectionFailureAt);
         assert.equal(snapshot.observedAt, new Date(readWall).toISOString());
      }
      assert.equal(fixture.retention.snapshot(), retained);
      assert.deepEqual(fixture.calls, calls);
      const producer = fixture.sampler as unknown as { previousCpu: NodeJS.CpuUsage; previousMonotonic: number; pairedCpuBaseline: unknown };
      assert.equal(producer.previousCpu, baselines.previousCpu);
      assert.equal(producer.previousMonotonic, baselines.previousMonotonic);
      assert.equal(producer.pairedCpuBaseline, baselines.pairedCpuBaseline);
      assert.equal(sample.mock.callCount(), 0);
      sample.mock.restore();
      for (const log of logs) { assert.equal(log.mock.callCount(), 0); log.mock.restore(); }
   };
   readMany();
   fixture.state.fail = 'cpu';
   fixture.scheduled();
   assert.equal(fixture.build().resources.availability, 'collection_failed');
   assert.equal(acquisitionWarning.mock.callCount(), 1, 'Ordinary scheduled failure is counted separately from reads');
   readMany();
   assert.equal(get.mock.callCount(), 60, 'Exactly one retained pair getter per build');
   fixture.state.fail = '';
   fixture.scheduled();
   assert.equal(fixture.build().resources.data!.cpu, null);
   fixture.scheduled();
   assert.notEqual(fixture.build().resources.data!.cpu, null);
   for (const global of globals) assert.equal(global.mock.callCount(), 0);
});

test('real in-memory store capacity remains closing-clipped and cross-watch percentiles are passed through once', t => {
   const fixture = samplerFixture(t);
   const store = new RoundWatchStore(':memory:', { now: () => new Date(WALL_MS), watchTtlMilliseconds: 1_000 });
   t.after(() => store.close());
   const sender = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
   const receiver = 'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';
   for (const [suffix, scanAfter, closing] of [['first', 100, 110], ['second', 120, 150]] as const) {
      const prepared = store.prepareWatch({ idempotencyKey: suffix, expectedSender: sender, expectedReceiver: receiver, assetId: 10458941, atomicAmount: '1' },
         { expectedTransaction: suffix, network: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=', payer: suffix, receiver, assetId: 10458941, atomicAmount: '1000', firstValid: 1, lastValid: 1_000 });
      store.activateWatch(prepared.watch.id, { transaction: suffix, network: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=', payer: suffix }, scanAfter);
      store.setClosingRound(prepared.watch.id, closing);
   }
   const capacity = t.mock.method(store, 'capacitySnapshot');
   let tip = { currentIndexerRound: 200, currentIndexerRoundObservedAt: WALL_ISO };
   const sampler = new RoundWatchRuntimeSampler(new RoundWatchEconomicsMetrics(), fixture.dispatchSource, ':memory:', {
      intervalMilliseconds: 100, now: () => new Date(fixture.state.wall), monotonicNow: () => fixture.state.monotonic,
      cpuUsage: () => ({ user: fixture.state.user, system: fixture.state.system }),
      memoryUsage: () => ({ rss: 1, heapUsed: 1, heapTotal: 1, external: 0, arrayBuffers: 0 }),
      observer: fixture.retention.observer, log: () => {},
      capacitySnapshot: () => {
         const sampledTip = { ...tip };
         return { ...store.capacitySnapshot(sampledTip.currentIndexerRound), ...sampledTip,
            watchesAttemptedLastCycle: 0, watchesSucceededLastCycle: 0, watchesFailedLastCycle: 0 };
      },
   });
   t.after(() => sampler.stop());
   fixture.advance();
   sampler.start();
   const observed = fixture.build().capacity;
   assert.equal(observed.availability, 'available');
   assert.deepEqual(observed.data!.scanLagRounds, { samples: 2, p50: 10, p95: 30, max: 30 });
   assert.equal(capacity.mock.callCount(), 1);
   tip = { currentIndexerRound: 999, currentIndexerRoundObservedAt: new Date(WALL_MS + 5_000).toISOString() };
   for (let i = 0; i < 20; i += 1) assert.deepEqual(fixture.build().capacity, observed);
   assert.equal(capacity.mock.callCount(), 1);
});
