import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import type { FacilitatorClient } from '@x402/core/server';
import { createApp, type AppDependencies, type ReadinessSnapshot } from './app.js';
import { MAINNET_NETWORK_CONFIG } from './network-config.js';
import {
   createObservatoryReadinessRetention, observePublicReadinessOutcome, readRetainedPublicReadiness,
   type PublicReadinessObserver,
} from './roundwatch-observatory-readiness.js';
import { initializeObservatoryReadinessRetention } from './roundwatch-observatory-initialization.js';
import { createObservatoryRuntimeSnapshotBuilder, type ObservatoryRuntimeSources } from './roundwatch-observatory-runtime.js';
import type { Observation, PublicReadinessObservationV01 } from './roundwatch-observatory-types.js';
import type { RoundWatchStore } from './roundwatch-store.js';
import type { RoundWatchIndexer } from './roundwatch-indexer.js';
import { IndexerRequestDispatcher } from './roundwatch-scheduler.js';
import { RoundWatchRuntimeSampler } from './roundwatch-runtime-metrics.js';
import { RoundWatchPoller } from './roundwatch-poller.js';
import { SettlementReconciler } from './roundwatch-reconciler.js';
import { IndexerHealthProbe } from './roundwatch-health-probe.js';

const TIME = '2026-10-08T12:00:00.000Z';
const FAILURE = '2026-10-08T12:00:01.000Z';
function outcome(ready = true) {
   return { ready, checks: {
      storage: true, poller: ready, reconciler: true,
      backgroundWorkers: ready, diskHeadroom: true,
   } };
}
const empty = (availability: string) => ({
   availability, observedAt: null, lastCollectionFailureAt: null, data: null,
});
const forbidden = () => { throw new Error('Unexpected operational acquisition'); };

/** No real store or provider: every unapproved dependency access fails. */
function routeFixture(overrides: Partial<AppDependencies> = {}, observerGetter?: () => PublicReadinessObserver) {
   const events: string[] = [];
   const store = new Proxy({
      configuredWorkUnitBudget: () => 1_000,
      configuredWatchTtlMilliseconds: () => 60_000,
      readinessCheck: () => { events.push('storage'); return true; },
   }, {
      get(target, key) {
         if (Object.hasOwn(target, key)) return Reflect.get(target, key);
         throw new Error(`Unexpected store access: ${String(key)}`);
      },
   }) as unknown as RoundWatchStore;
   const dependencies: AppDependencies = {
      avmAddress: 'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI',
      facilitatorClient: new Proxy({}, { get: forbidden }) as FacilitatorClient,
      indexer: new Proxy({}, { get: forbidden }) as RoundWatchIndexer,
      store, syncFacilitatorOnStart: false,
      readinessCheck: () => { events.push('callback'); return outcome() as ReadinessSnapshot; },
      paidAdmissionReadinessCheck: Object.assign(forbidden, { validateCurrent: forbidden }),
      ...overrides,
   };
   if (observerGetter !== undefined) Object.defineProperty(dependencies, 'publicReadinessObserver', { get: observerGetter });
   const app = createApp(dependencies);
   return { app, events, store };
}

function sources(overrides: Partial<ObservatoryRuntimeSources> = {}): ObservatoryRuntimeSources {
   const worker = () => ({ started: true, running: false, ready: true,
      cycleNotStalled: true, providerHealth: 'healthy' as const, consecutiveFailures: 0 });
   const dispatcher = new IndexerRequestDispatcher();
   return {
      network: 'testnet', assetId: '10458941', economicsMetricsEnabled: false,
      pollerHealthSnapshot: worker, reconcilerHealthSnapshot: worker,
      dispatcherSnapshot: () => dispatcher.snapshot(), cachedIndexerTip: () => ({}),
      ...overrides,
   };
}
function builder(overrides: Partial<ObservatoryRuntimeSources> = {}) {
   return createObservatoryRuntimeSnapshotBuilder(sources(overrides), {
      epochMilliseconds: () => Date.parse(TIME), processMonotonicMilliseconds: () => 100,
   }, () => 'test-process-epoch');
}

test('readiness is unavailable when unwired and indefinitely not_yet_sampled when wired, independent of economics', () => {
   const retention = createObservatoryReadinessRetention(() => new Date(TIME));
   assert.deepEqual(builder()().readiness, empty('unavailable'));
   const build = builder({ retainedPublicReadiness: retention.snapshot });
   for (let i = 0; i < 20; i += 1) assert.deepEqual(build().readiness, empty('not_yet_sampled'));
   assert.deepEqual(createObservatoryReadinessRetention().snapshot(), empty('not_yet_sampled'));
});

for (const ready of [true, false]) {
   test(`public complete ready=${ready} retains available data and preserves HTTP status, body, headers and probe order`, async () => {
      const retention = createObservatoryReadinessRetention(() => new Date(TIME));
      const events: string[] = [];
      const fixture = routeFixture({
         readinessCheck: () => {
            events.push('callback');
            // Production callback itself performs a second store check. Preserve it.
            fixture.store.readinessCheck();
            return outcome(ready) as ReadinessSnapshot;
         },
         publicReadinessObserver: {
            outcomeCompleted: data => { events.push('publication'); retention.observer.outcomeCompleted(data); },
            collectionFailed: retention.observer.collectionFailed,
         },
      });
      const response = await fixture.app.request('/ready');
      assert.equal(response.status, ready ? 200 : 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), {
         status: ready ? 'ready' : 'not_ready', network: 'testnet', checks: outcome(ready).checks,
      });
      assert.deepEqual(fixture.events, ['storage', 'storage']);
      assert.deepEqual(events, ['callback', 'publication']);
      assert.deepEqual(builder({ retainedPublicReadiness: retention.snapshot })().readiness, {
         availability: 'available', observedAt: TIME, lastCollectionFailureAt: null, data: outcome(ready),
      });
   });
}

test('actual route acquisition is ordered storage, callback, callback storage, then publication', async () => {
   const events: string[] = [];
   const fixture = routeFixture({
      readinessCheck: () => {
         events.push('callback'); fixture.store.readinessCheck();
         return outcome() as ReadinessSnapshot;
      },
      publicReadinessObserver: { outcomeCompleted: () => { events.push('publication'); }, collectionFailed: forbidden },
   });
   fixture.store.readinessCheck = () => { events.push('storage'); return false; };
   assert.equal((await fixture.app.request('/ready')).status, 200, 'Callback result remains authoritative');
   assert.deepEqual(events, ['storage', 'callback', 'storage', 'publication']);
});

for (const failureSource of ['store', 'callback', 'serialization'] as const) {
   test(`operational ${failureSource} exception still returns original 503 and retains available exception outcome`, async () => {
      const retention = createObservatoryReadinessRetention(() => new Date(TIME));
      const fixture = routeFixture({
         publicReadinessObserver: retention.observer,
         readinessCheck: failureSource === 'callback' ? forbidden : () => {
            if (failureSource === 'serialization') {
               return { ready: true, checks: { toJSON: forbidden } } as unknown as ReadinessSnapshot;
            }
            return outcome() as ReadinessSnapshot;
         },
      });
      if (failureSource === 'store') fixture.store.readinessCheck = forbidden;
      const response = await fixture.app.request('/ready');
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { status: 'not_ready', network: 'testnet', checks: { readinessCheck: false } });
      assert.deepEqual(retention.snapshot(), { availability: 'available', observedAt: TIME,
         lastCollectionFailureAt: null, data: { ready: false, checks: { readinessCheck: false } } });
   });
}

test('storage-only fallback retains no fabricated complete outcome, including negative fallback', async () => {
   for (const ready of [true, false]) {
      const retention = createObservatoryReadinessRetention(() => new Date(TIME));
      const fixture = routeFixture({ readinessCheck: undefined, publicReadinessObserver: retention.observer });
      fixture.store.readinessCheck = () => { fixture.events.push('storage'); return ready; };
      const response = await fixture.app.request('/ready');
      assert.equal(response.status, ready ? 200 : 503);
      assert.deepEqual(await response.json(), { status: ready ? 'ready' : 'not_ready', network: 'testnet', checks: { storage: ready } });
      assert.deepEqual(fixture.events, ['storage']);
      assert.deepEqual(retention.snapshot(), empty('not_yet_sampled'));
   }
});

test('allowlisted projection is independent, deeply immutable and excludes raw response fields', async () => {
   const retention = createObservatoryReadinessRetention(() => new Date(TIME));
   const raw = { ...outcome(), status: 'ready', network: 'private', rawError: 'private',
      checks: { ...outcome().checks, secret: true } };
   let received: unknown;
   const fixture = routeFixture({
      readinessCheck: () => raw,
      publicReadinessObserver: { outcomeCompleted: data => {
         received = data; retention.observer.outcomeCompleted(data);
      }, collectionFailed: retention.observer.collectionFailed },
   });
   await fixture.app.request('/ready');
   assert.deepEqual(received, outcome());
   assert.notEqual(received, raw);
   const retained = retention.snapshot();
   assert.ok(Object.isFrozen(retained));
   assert.ok(Object.isFrozen(retained.data));
   assert.ok(Object.isFrozen(retained.data!.checks));
   raw.ready = false;
   raw.checks.storage = false;
   assert.deepEqual(retained.data, outcome());
   assert.throws(() => { retained.data!.ready = false; }, TypeError);
   const built = builder({ retainedPublicReadiness: retention.snapshot })();
   built.readiness.data!.ready = false;
   assert.deepEqual(retention.snapshot().data, outcome(), 'Builder returns an independent projection');
});

test('malformed/incomplete candidates preserve previous result and provenance; valid recovery preserves failure time', () => {
   const retention = createObservatoryReadinessRetention(() => new Date(FAILURE));
   retention.observer.outcomeCompleted(outcome(), TIME);
   const valid = retention.snapshot();
   const malformed: unknown[] = [null, [], { ready: true, checks: { storage: true } },
      { ready: 'true', checks: outcome().checks }, { ready: true, checks: { readinessCheck: false } },
      { ready: false, checks: { readinessCheck: true } },
      { ready: false, checks: { ...outcome().checks, readinessCheck: false } },
      { get ready() { throw new Error('projection'); } }];
   for (const key of ['storage', 'poller', 'reconciler', 'backgroundWorkers', 'diskHeadroom']) {
      for (const value of [undefined, null, 0, 'false']) malformed.push({ ready: true, checks: { ...outcome().checks, [key]: value } });
   }
   for (const candidate of malformed) {
      retention.observer.outcomeCompleted(candidate as PublicReadinessObservationV01, TIME);
      assert.deepEqual(retention.snapshot(), { ...valid, availability: 'collection_failed', lastCollectionFailureAt: FAILURE });
   }
   retention.observer.outcomeCompleted(outcome(false), '2026-10-08T11:00:00Z');
   assert.deepEqual(retention.snapshot(), { availability: 'available', observedAt: '2026-10-08T11:00:00Z',
      lastCollectionFailureAt: FAILURE, data: outcome(false) });
   retention.observer.outcomeCompleted(outcome(), '2099-01-01T00:00:00Z');
   assert.equal(retention.snapshot().data!.ready, true, 'Future chronology does not rewrite source booleans');
});

for (const defect of ['missing', 'inherited', 'accessor', 'non-enumerable', 'invalid'] as const) {
   test(`${defect} required properties reject complete and exception candidates without accessing or mutating them`, () => {
      for (const exception of [false, true]) {
         const make = () => exception
            ? { ready: false, checks: { readinessCheck: false } }
            : outcome();
         for (const key of ['ready', 'checks', ...Object.keys(make().checks)]) {
            const raw = make();
            const target = key === 'ready' || key === 'checks' ? raw : raw.checks;
            const value = Object.getOwnPropertyDescriptor(target, key)!.value;
            let accesses = 0;
            if (defect === 'missing' || defect === 'inherited') {
               Reflect.deleteProperty(target, key);
               if (defect === 'inherited') Object.setPrototypeOf(target, { [key]: value });
            } else {
               Object.defineProperty(target, key, defect === 'accessor'
                  ? { enumerable: true, get: () => { accesses += 1; return value; } }
                  : { value: defect === 'invalid' ? 'false' : value, enumerable: defect !== 'non-enumerable' });
            }
            const descriptors = Object.getOwnPropertyDescriptors(target);
            const prototype = Object.getPrototypeOf(target);
            for (const viaPublicObserver of [false, true]) {
               const retention = createObservatoryReadinessRetention(() => new Date(FAILURE));
               const publish = () => viaPublicObserver
                  ? observePublicReadinessOutcome(retention.observer, raw)
                  : retention.observer.outcomeCompleted(raw as PublicReadinessObservationV01);
               publish();
               assert.deepEqual(retention.snapshot(), { ...empty('collection_failed'), lastCollectionFailureAt: FAILURE }, key);
               retention.observer.outcomeCompleted(outcome(false), TIME);
               const accepted = retention.snapshot();
               publish();
               assert.deepEqual(retention.snapshot(), { ...accepted,
                  availability: 'collection_failed', lastCollectionFailureAt: FAILURE }, key);
               assert.equal(retention.snapshot().data, accepted.data, 'Previous accepted data is preserved');
            }
            assert.equal(accesses, 0, key);
            assert.deepEqual(Object.getOwnPropertyDescriptors(target), descriptors, key);
            assert.equal(Object.getPrototypeOf(target), prototype);
         }
      }
   });
}

test('own, inherited and accessor serialization hooks are rejected on outcomes and both checks shapes without invocation', () => {
   for (const exception of [false, true]) {
      for (const targetName of ['outcome', 'checks']) {
         for (const hook of ['own', 'inherited', 'accessor', 'non-enumerable']) {
            const raw = exception ? { ready: false, checks: { readinessCheck: false } } : outcome();
            const target = targetName === 'outcome' ? raw : raw.checks;
            let calls = 0;
            const toJSON = () => { calls += 1; return { storage: false }; };
            if (hook === 'inherited') Object.setPrototypeOf(target, { toJSON });
            else Object.defineProperty(target, 'toJSON', hook === 'accessor'
               ? { get: () => { calls += 1; return toJSON; } }
               : { value: toJSON, enumerable: hook !== 'non-enumerable' });
            const descriptors = Object.getOwnPropertyDescriptors(target);
            const retention = createObservatoryReadinessRetention(() => new Date(FAILURE));
            retention.observer.outcomeCompleted(outcome(), TIME);
            const before = retention.snapshot();
            observePublicReadinessOutcome(retention.observer, raw);
            assert.deepEqual(retention.snapshot(), { ...before,
               availability: 'collection_failed', lastCollectionFailureAt: FAILURE });
            assert.equal(calls, 0);
            assert.deepEqual(Object.getOwnPropertyDescriptors(target), descriptors);
         }
      }
   }
});

const malformedPublicOutcomes = [
   { name: 'inherited storage', make: () => {
      const raw = outcome();
      Reflect.deleteProperty(raw.checks, 'storage');
      Object.setPrototypeOf(raw.checks, { storage: true });
      return raw;
   }, checks: { poller: true, reconciler: true, backgroundWorkers: true, diskHeadroom: true } },
   { name: 'non-enumerable storage', make: () => {
      const raw = outcome();
      Object.defineProperty(raw.checks, 'storage', { enumerable: false });
      return raw;
   }, checks: { poller: true, reconciler: true, backgroundWorkers: true, diskHeadroom: true } },
   { name: 'incomplete checks.toJSON', make: () => ({ ...outcome(),
      checks: { ...outcome().checks, toJSON: () => ({ storage: true }) } }), checks: { storage: true } },
   { name: 'contradictory checks.toJSON', make: () => ({ ...outcome(),
      checks: { ...outcome().checks, toJSON: () => outcome(false).checks } }), checks: outcome(false).checks },
   { name: 'accessor storage', make: () => {
      const raw = outcome();
      let accesses = 0;
      Object.defineProperty(raw.checks, 'storage', { enumerable: true, get: () => ++accesses === 1 });
      return raw;
   }, checks: outcome().checks },
   { name: 'accessor checks', make: () => {
      const raw = outcome();
      let accesses = 0;
      Object.defineProperty(raw, 'checks', { enumerable: true,
         get: () => ++accesses === 1 ? outcome().checks : outcome(false).checks });
      return raw;
   }, checks: outcome().checks },
];

for (const candidate of malformedPublicOutcomes) {
   test(`${candidate.name} preserves public HTTP bytes while rejecting misleading available readiness`, async () => {
      const readinessCheck = () => candidate.make() as unknown as ReadinessSnapshot;
      const baseline = await routeFixture({ readinessCheck }).app.request('/ready');
      const body = await baseline.text();
      assert.equal(baseline.status, 200);
      assert.deepEqual(JSON.parse(body), { status: 'ready', network: 'testnet', checks: candidate.checks });
      const retention = createObservatoryReadinessRetention(() => new Date(FAILURE));
      retention.observer.outcomeCompleted(outcome(false), TIME);
      const before = retention.snapshot();
      const fixture = routeFixture({ readinessCheck, publicReadinessObserver: retention.observer });
      const response = await fixture.app.request('/ready');
      assert.equal(response.status, baseline.status);
      assert.deepEqual([...response.headers], [...baseline.headers]);
      assert.equal(await response.text(), body);
      assert.deepEqual(retention.snapshot(), { ...before,
         availability: 'collection_failed', lastCollectionFailureAt: FAILURE });
      assert.deepEqual(fixture.events, ['storage']);
      const build = builder({ retainedPublicReadiness: retention.snapshot });
      for (let i = 0; i < 5; i += 1) assert.deepEqual(build().readiness, retention.snapshot());
      assert.deepEqual(fixture.events, ['storage'], 'Observatory reads do not reacquire public readiness');
   });
}

test('timestamps and failures before first acceptance are validated without fabricated provenance', () => {
   const retention = createObservatoryReadinessRetention(() => new Date(FAILURE));
   for (const time of ['', 'not-a-date', '2026-02-30T00:00:00Z', '2026-10-08T12:00:00+00:00', null, 123]) {
      retention.observer.outcomeCompleted(outcome(), time as string);
      assert.deepEqual(retention.snapshot(), { ...empty('collection_failed'), lastCollectionFailureAt: FAILURE });
   }
   let failClock = false;
   const faulty = createObservatoryReadinessRetention(() => {
      if (failClock) throw new Error('clock');
      return new Date(TIME);
   });
   faulty.observer.outcomeCompleted(outcome());
   const before = faulty.snapshot();
   failClock = true;
   faulty.observer.outcomeCompleted(outcome(false));
   faulty.observer.collectionFailed();
   assert.equal(faulty.snapshot(), before);
   const never = createObservatoryReadinessRetention(() => new Date(NaN));
   never.observer.outcomeCompleted(outcome());
   assert.deepEqual(never.snapshot(), empty('not_yet_sampled'));
});

test('timestamp conversion and immutable publication faults preserve prior record and recover', t => {
   let clockCalls = 0;
   const retention = createObservatoryReadinessRetention(() => {
      clockCalls += 1;
      if (clockCalls === 1) return { toISOString: forbidden } as unknown as Date;
      return new Date(FAILURE);
   });
   retention.observer.outcomeCompleted(outcome());
   assert.deepEqual(retention.snapshot(), { ...empty('collection_failed'), lastCollectionFailureAt: FAILURE });
   retention.observer.outcomeCompleted(outcome(), TIME);
   const before = retention.snapshot();
   const freeze = t.mock.method(Object, 'freeze', forbidden);
   retention.observer.outcomeCompleted(outcome(false), TIME);
   assert.equal(retention.snapshot(), before, 'Failed publication and failure recording are both isolated');
   freeze.mock.restore();
   retention.observer.outcomeCompleted(outcome(false), TIME);
   assert.equal(retention.snapshot().availability, 'available');
   assert.equal(retention.snapshot().data!.ready, false);
});

test('actual public route preserves healthy response through retention clock/conversion/publication faults', async t => {
   const clocks = [forbidden, () => new Date(NaN), () => ({ toISOString: forbidden }) as unknown as Date];
   for (const now of clocks) {
      const retention = createObservatoryReadinessRetention(now);
      retention.observer.outcomeCompleted(outcome(false), TIME);
      const before = retention.snapshot();
      const response = await routeFixture({ publicReadinessObserver: retention.observer }).app.request('/ready');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ready', network: 'testnet', checks: outcome().checks });
      assert.equal(retention.snapshot(), before);
   }
   const retention = createObservatoryReadinessRetention(() => new Date(FAILURE));
   retention.observer.outcomeCompleted(outcome(false), TIME);
   const fixture = routeFixture({ publicReadinessObserver: retention.observer });
   const originalFreeze = Object.freeze;
   let rejected = false;
   const freeze = t.mock.method(Object, 'freeze', ((value: object) => {
      if (!rejected && Object.hasOwn(value, 'diskHeadroom')) {
         rejected = true;
         throw new Error('publication');
      }
      return originalFreeze(value);
   }) as typeof Object.freeze);
   const response = await fixture.app.request('/ready');
   freeze.mock.restore();
   assert.equal(rejected, true);
   assert.equal(response.status, 200);
   assert.deepEqual(await response.json(), { status: 'ready', network: 'testnet', checks: outcome().checks });
   assert.deepEqual(retention.snapshot(), { availability: 'collection_failed', observedAt: TIME,
      lastCollectionFailureAt: FAILURE, data: outcome(false) });
});

test('MainNet public network field and genuine operational 503 remain intact even with a throwing observer', async () => {
   for (const operationalFailure of [false, true]) {
      const response = await routeFixture({
         networkConfig: MAINNET_NETWORK_CONFIG,
         readinessCheck: operationalFailure ? forbidden : () => outcome(),
         publicReadinessObserver: { outcomeCompleted: forbidden, collectionFailed: forbidden },
      }).app.request('/ready');
      assert.equal(response.status, operationalFailure ? 503 : 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { status: operationalFailure ? 'not_ready' : 'ready', network: 'mainnet',
         checks: operationalFailure ? { readinessCheck: false } : outcome().checks });
   }
});

test('throwing or malformed memory getters are unavailable and never mutate producer failure metadata', () => {
   const retention = createObservatoryReadinessRetention(() => new Date(TIME));
   retention.observer.outcomeCompleted(outcome());
   const before = retention.snapshot();
   const candidates: unknown[] = [null, { ...before, observedAt: 'bad' },
      { ...before, lastCollectionFailureAt: 'bad' }, { ...before, data: null },
      { ...before, data: { ready: true, checks: { storage: true } } },
      { ...before, availability: 'not_yet_sampled' },
      { ...before, availability: 'collection_failed', lastCollectionFailureAt: null },
      { ...before, availability: 'instrumentation_disabled' }];
   for (const candidate of candidates) {
      assert.deepEqual(builder({ retainedPublicReadiness: () => candidate as Observation<PublicReadinessObservationV01> })().readiness,
         empty('unavailable'));
   }
   assert.deepEqual(readRetainedPublicReadiness(forbidden), empty('unavailable'));
   assert.equal(retention.snapshot(), before);
});

for (const ready of [true, false]) {
   test(`observer/projection/failure-recorder faults cannot change completed ready=${ready} public response`, async () => {
      const baseline = await routeFixture({ readinessCheck: () => outcome(ready) as ReadinessSnapshot }).app.request('/ready');
      const expected = await baseline.text();
      for (const observer of [
         { outcomeCompleted: forbidden, collectionFailed: forbidden },
         { get outcomeCompleted(): PublicReadinessObserver['outcomeCompleted'] { throw new Error('observer getter'); }, collectionFailed: forbidden },
      ]) {
         const actual = await routeFixture({ readinessCheck: () => outcome(ready) as ReadinessSnapshot,
            publicReadinessObserver: observer }).app.request('/ready');
         assert.equal(actual.status, baseline.status);
         assert.equal(await actual.text(), expected);
         assert.equal(actual.headers.get('cache-control'), 'no-store');
      }
      const retention = createObservatoryReadinessRetention(() => new Date(FAILURE));
      const raw = { ready, checks: { ...outcome(ready).checks,
         toJSON: () => outcome(ready).checks } };
      Object.defineProperty(raw.checks, 'storage', { get: forbidden });
      const response = await routeFixture({ readinessCheck: () => raw as unknown as ReadinessSnapshot,
         publicReadinessObserver: retention.observer }).app.request('/ready');
      assert.equal(response.status, baseline.status);
      assert.equal(await response.text(), expected);
      assert.equal(retention.snapshot().availability, 'collection_failed');
   });
}

test('constructor failure leaves operational app wiring usable and memory source unwired', async () => {
   let constructions = 0;
   const retention = initializeObservatoryReadinessRetention(() => { constructions += 1; throw new Error('construction'); });
   const observer = retention?.observer;
   const getter = retention?.snapshot;
   assert.equal(retention, undefined);
   const fixture = routeFixture({ publicReadinessObserver: observer });
   assert.equal((await fixture.app.request('/ready')).status, 200);
   assert.deepEqual(fixture.events, ['storage', 'callback']);
   assert.equal(builder({ retainedPublicReadiness: getter })().readiness.availability, 'unavailable');
   assert.equal(constructions, 1);
   assert.ok(initializeObservatoryReadinessRetention());
   const boot = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
   assert.match(boot, /const observatoryReadiness = initializeObservatoryReadinessRetention\(\)/);
   assert.match(boot, /publicReadinessObserver: observatoryReadiness\?\.observer/);
   assert.match(boot, /retainedPublicReadiness: observatoryReadiness === undefined/);
});

test('observer types reject asynchronous callbacks', () => {
   const unsupported: PublicReadinessObserver = {
      // @ts-expect-error Publication must be synchronous.
      outcomeCompleted: async () => {},
      // @ts-expect-error Failure notification must be synchronous.
      collectionFailed: async () => {},
   };
   assert.equal(typeof unsupported.outcomeCompleted, 'function');
});

test('throwing optional observer dependency getter cannot abort app construction or public readiness', async () => {
   const fixture = routeFixture({}, forbidden);
   const response = await fixture.app.request('/ready');
   assert.equal(response.status, 200);
   assert.deepEqual(await response.json(), { status: 'ready', network: 'testnet', checks: outcome().checks });
   assert.deepEqual(fixture.events, ['storage', 'callback']);
});

for (const hook of ['outcomeCompleted', 'collectionFailed'] as const) {
   test(`runtime-bypassed ${hook} Promise rejection is contained without deferred failure mutation`, async () => {
      const retention = createObservatoryReadinessRetention(() => new Date(TIME));
      let reject!: (error: Error) => void;
      const pending = new Promise<never>((_, fail) => { reject = fail; });
      let failures = 0;
      const observer: PublicReadinessObserver = {
         outcomeCompleted: hook === 'outcomeCompleted' ? (() => pending) as unknown as PublicReadinessObserver['outcomeCompleted'] : forbidden,
         collectionFailed: (() => {
            failures += 1;
            retention.observer.collectionFailed();
            return hook === 'collectionFailed' ? pending : undefined;
         }) as PublicReadinessObserver['collectionFailed'],
      };
      const response = await routeFixture({ publicReadinessObserver: observer }).app.request('/ready');
      assert.equal(response.status, 200);
      assert.equal(failures, 1);
      retention.observer.outcomeCompleted(outcome(false));
      const recovered = retention.snapshot();
      reject(new Error('unsupported delayed observer'));
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(retention.snapshot(), recovered);
      assert.equal(failures, 1);
   });
}

test('repeated snapshot reads preserve timestamps, all other sections and producer state with zero acquisition/logging/timers', async t => {
   let nowCalls = 0;
   const retention = createObservatoryReadinessRetention(() => { nowCalls += 1; return new Date(TIME); });
   const fixture = routeFixture({ publicReadinessObserver: retention.observer });
   await fixture.app.request('/ready');
   const before = retention.snapshot();
   const baseline = builder()();
   let reads = 0;
   const build = builder({ retainedPublicReadiness: () => { reads += 1; return retention.snapshot(); } });
   const guards = [
      t.mock.method(fixture.store, 'readinessCheck', forbidden),
      t.mock.method(DatabaseSync.prototype, 'prepare', forbidden),
      t.mock.method(DatabaseSync.prototype, 'exec', forbidden),
      t.mock.method(fs, 'statSync', forbidden),
      t.mock.method(fs, 'statfsSync', forbidden),
      t.mock.method(fsPromises, 'stat', forbidden),
      t.mock.method(fsPromises, 'statfs', forbidden),
      t.mock.method(globalThis, 'fetch', forbidden),
      t.mock.method(globalThis, 'setInterval', forbidden),
      t.mock.method(globalThis, 'setTimeout', forbidden),
      t.mock.method(process, 'cpuUsage', forbidden),
      t.mock.method(process, 'memoryUsage', forbidden),
      t.mock.method(RoundWatchRuntimeSampler.prototype, 'sample', forbidden),
      t.mock.method(RoundWatchPoller.prototype, 'runOnce', forbidden),
      t.mock.method(SettlementReconciler.prototype, 'reconcileOnce', forbidden),
      t.mock.method(IndexerHealthProbe.prototype, 'runIfDue', forbidden),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map(key => t.mock.method(console, key, forbidden)),
   ];
   for (let i = 0; i < 50; i += 1) {
      const snapshot = build();
      assert.deepEqual(snapshot.readiness, before);
      const { readiness: ignored, ...rest } = snapshot;
      const { readiness: oldIgnored, ...oldRest } = baseline;
      assert.deepEqual(rest, oldRest);
   }
   assert.equal(reads, 50);
   assert.equal(nowCalls, 1);
   assert.equal(retention.snapshot(), before);
   assert.deepEqual(fixture.events, ['storage', 'callback']);
   for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
});

/** Run against an in-memory mutant; the working source is never changed. */
test('regression detects removal of the observer failure-isolation boundary', () => {
   const script = `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      import { readFileSync } from 'node:fs';
      registerHooks({ load(url, context, nextLoad) {
         if (url.endsWith('/roundwatch-observatory-readiness.ts')) {
            const source = readFileSync(new URL(url), 'utf8');
            const start = source.indexOf('   try {\\n      // Never pass');
            const end = source.indexOf('\\n}\\n', start);
            assert.ok(start >= 0 && end > start, 'Mutation target must exist');
            return { format: 'module-typescript', shortCircuit: true,
               source: source.slice(0, start) + '   observer.outcomeCompleted(projectReadiness(outcome));' + source.slice(end) };
         }
         return nextLoad(url, context);
      }});
      const { createApp } = await import('./app.ts');
      const app = createApp({ avmAddress: 'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI',
         store: { configuredWorkUnitBudget: () => 1000, configuredWatchTtlMilliseconds: () => 60000, readinessCheck: () => true },
         indexer: {}, facilitatorClient: {}, syncFacilitatorOnStart: false,
         readinessCheck: () => ({ ready: true, checks: { storage: true, poller: true, reconciler: true, backgroundWorkers: true, diskHeadroom: true } }),
         publicReadinessObserver: { outcomeCompleted: () => { throw new Error('injected publication fault'); }, collectionFailed: () => {} } });
      const response = await app.request('/ready');
      assert.equal(response.status, 200, 'Observer fault changed a completed healthy response');
   `;
   const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: new URL('.', import.meta.url), encoding: 'utf8', timeout: 20_000,
   });
   assert.equal(result.error, undefined);
   assert.notEqual(result.status, 0, 'Unprotected mutant must fail the public-response regression');
   assert.match(result.stderr, /Observer fault changed a completed healthy response/);
});
