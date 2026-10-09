import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import { createAppRuntime } from './app.js';
import { ApplicationLifetime } from './roundwatch-application-lifetime.js';
import { SignedPaymentGate } from './free-payment-gate.js';
import { MAINNET_NETWORK_CONFIG, TESTNET_NETWORK_CONFIG } from './network-config.js';
import { RoundWatchFacilitatorClient } from './roundwatch-facilitator.js';
import { IndexerHealthProbe } from './roundwatch-health-probe.js';
import { AlgorandIndexerClient } from './roundwatch-indexer.js';
import { RoundWatchEconomicsMetrics } from './roundwatch-metrics.js';
import { createObservatoryRuntimeSnapshotBuilder } from './roundwatch-observatory-runtime.js';
import { createObservatoryReadinessRetention } from './roundwatch-observatory-readiness.js';
import { createObservatorySampleRetention } from './roundwatch-observatory-retention.js';
import { RoundWatchPoller } from './roundwatch-poller.js';
import { createPaidAdmissionReadinessCheck } from './roundwatch-paid-readiness.js';
import { SettlementReconciler } from './roundwatch-reconciler.js';
import { RoundWatchRuntimeSampler, type EconomicsRuntimeSnapshot } from './roundwatch-runtime-metrics.js';
import { IndexerRequestDispatcher } from './roundwatch-scheduler.js';
import { createShutdownCoordinator } from './roundwatch-shutdown-coordinator.js';
import { startProductionRuntime } from './roundwatch-startup.js';
import { RoundWatchStore } from './roundwatch-store.js';
import type { ObservatoryRuntimeV01 } from './roundwatch-observatory-types.js';
import {
   createRoundWatchHttpFetch, OBSERVATORY_RUNTIME_PATH, type ObservatoryTransportOptions,
} from './roundwatch-observatory-transport.js';

// Deliberately synthetic test credentials, never installed in an environment.
const TOKEN = 'a'.repeat(64);
const WRONG_TOKEN = 'b'.repeat(64);
const READ_TIME = '2026-10-08T12:00:00.000Z';
const SAMPLE_TIME = '2026-10-08T11:50:00.000Z';
const FAILURE_TIME = '2026-10-08T11:51:00.000Z';
const RECEIVER = 'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';
const forbidden = () => { throw new Error('Unexpected operational work'); };

function completeReadiness() {
   return { ready: false, checks: {
      storage: true, poller: false, reconciler: true, backgroundWorkers: false, diskHeadroom: true,
   } };
}

function rawSample(): EconomicsRuntimeSnapshot {
   return {
      resources: {
         sampledAt: SAMPLE_TIME, elapsedMs: 12.5, rssBytes: 100, heapUsedBytes: 20,
         heapTotalBytes: 50, externalBytes: 0, cpuUserMicros: 5, cpuSystemMicros: 2,
         sqliteBytes: 0, dispatcher: { queued: 0, inFlight: 0, requests: {}, successes: 0, failures: 0, timeouts: 0 },
      },
      capacity: {
         unfinishedWatches: 3, activeWatches: 2, settlementPendingWatches: 1,
         unresolvedSettlementUnknownWatches: 0, activeWatchesMissingScanBaseline: 0,
         watchesPastDeadlineAwaitingCoverage: 1, oldestActiveWatchAgeMs: 123.5,
         scanLagRounds: { samples: 2, p50: 0, p95: 7, max: 7 },
         currentIndexerRound: 150, currentIndexerRoundObservedAt: SAMPLE_TIME,
         watchesAttemptedLastCycle: 5, watchesSucceededLastCycle: 2, watchesFailedLastCycle: 1,
      },
      activeWatchMetrics: 0, freeWork: {} as EconomicsRuntimeSnapshot['freeWork'],
   };
}

function fixture(t: TestContext, networkConfig = TESTNET_NETWORK_CONFIG) {
   const store = new RoundWatchStore(':memory:');
   t.after(() => store.close());
   const lifetime = new ApplicationLifetime();
   const metrics = new RoundWatchEconomicsMetrics();
   const providerFetch = t.mock.fn(forbidden);
   const facilitator = new RoundWatchFacilitatorClient({ url: 'https://facilitator.example.test', fetch: providerFetch });
   const dispatcher = new IndexerRequestDispatcher();
   const indexer = new AlgorandIndexerClient('https://indexer.example.test', dispatcher, providerFetch);
   const probe = new IndexerHealthProbe(indexer, networkConfig.usdcAssetIdNumber);
   const poller = new RoundWatchPoller(store, indexer, 5_000, 100, undefined, metrics, undefined, undefined, probe);
   const reconciler = new SettlementReconciler(store, indexer, { network: networkConfig.network, intervalMilliseconds: 5_000 }, metrics, probe);
   const samples = createObservatorySampleRetention(() => new Date(FAILURE_TIME));
   samples.observer.sampleCompleted(rawSample(), { userMicros: 5, systemMicros: 2, elapsedMs: 12.5 });
   samples.observer.collectionFailed();
   const readiness = createObservatoryReadinessRetention(() => new Date(FAILURE_TIME));
   readiness.observer.outcomeCompleted(completeReadiness(), SAMPLE_TIME);
   readiness.observer.collectionFailed();
   const build = createObservatoryRuntimeSnapshotBuilder({
      network: networkConfig.name, assetId: networkConfig.usdcAssetId, economicsMetricsEnabled: true,
      pollerHealthSnapshot: () => poller.healthSnapshot(), reconcilerHealthSnapshot: () => reconciler.healthSnapshot(),
      dispatcherSnapshot: () => dispatcher.snapshot(), cachedIndexerTip: () => poller.capacitySnapshot(),
      pollCycleSnapshot: () => poller.capacitySnapshot(), retainedRuntimeSample: samples.snapshot,
      retainedPublicReadiness: readiness.snapshot,
   }, { epochMilliseconds: () => Date.parse(READ_TIME), processMonotonicMilliseconds: () => 125.5 }, () => 'test-process-epoch');
   const snapshot = t.mock.fn(build);
   const telemetry = {
      requestId: t.mock.fn(() => 'test-request-id'), now: t.mock.fn(() => new Date(READ_TIME)),
      monotonicNow: t.mock.fn(() => 100), log: t.mock.fn((_line: string) => {}),
      hmacKey: 'test-only-hmac-key',
   };
   const publicReadiness = t.mock.fn(completeReadiness);
   const paidReadiness = Object.assign(t.mock.fn(async () => completeReadiness()), {
      validateCurrent: t.mock.fn(completeReadiness),
   });
   const runtime = createAppRuntime({
      avmAddress: RECEIVER, networkConfig, facilitatorClient: facilitator, store, indexer,
      syncFacilitatorOnStart: false, economicsMetrics: metrics, requestTelemetry: telemetry,
      readinessCheck: publicReadiness, paidAdmissionReadinessCheck: paidReadiness,
      publicReadinessObserver: readiness.observer,
   });
   const hono = t.mock.fn(runtime.app.fetch);
   const sampler = new RoundWatchRuntimeSampler(metrics, dispatcher, ':memory:', {
      cpuUsage: () => ({ user: 0, system: 0 }), monotonicNow: () => 0,
      observer: samples.observer, capacitySnapshot: () => ({ ...store.capacitySnapshot(), ...poller.capacitySnapshot() }),
   });
   const compose = (options: Partial<ObservatoryTransportOptions> = {}, factory?: Parameters<typeof createRoundWatchHttpFetch>[3]) =>
      createRoundWatchHttpFetch(lifetime, hono, { token: TOKEN, runtimeSnapshot: snapshot, ...options }, factory);
   return { store, lifetime, metrics, providerFetch, facilitator, dispatcher, indexer, probe, poller, reconciler,
      samples, readiness, build, snapshot, telemetry, publicReadiness, paidReadiness, runtime, hono, sampler, compose };
}

function request(path = OBSERVATORY_RUNTIME_PATH, authorization: string | null = `Bearer ${TOKEN}`, method = 'GET', init: RequestInit = {}) {
   const headers = new Headers(init.headers);
   headers.set('origin', 'https://browser.example.test');
   headers.set('x-forwarded-for', '192.0.2.1');
   headers.set('payment-signature', 'test-only-payment-header');
   if (authorization !== null) headers.set('authorization', authorization);
   return new Request(`http://offline.example.test${path}`, { ...init, method, headers });
}

function assertTransportHeaders(response: Response) {
   assert.equal(response.headers.get('cache-control'), 'no-store');
   for (const [key] of response.headers) assert.equal(key.startsWith('access-control-'), false, key);
}

function guardOperationalWork(t: TestContext, f: ReturnType<typeof fixture>) {
   const temporaryDatabase = new DatabaseSync(':memory:');
   const statementPrototype = Object.getPrototypeOf(temporaryDatabase.prepare('SELECT 1'));
   temporaryDatabase.close();
   const guards = [
      t.mock.method(DatabaseSync.prototype, 'prepare', forbidden), t.mock.method(DatabaseSync.prototype, 'exec', forbidden),
      ...(['all', 'get', 'run', 'iterate'] as const).map(key => t.mock.method(statementPrototype, key, forbidden)),
      ...(['statSync', 'statfsSync', 'readFileSync'] as const).map(key => t.mock.method(fs, key, forbidden)),
      ...(['stat', 'statfs', 'readFile'] as const).map(key => t.mock.method(fsPromises, key, forbidden)),
      t.mock.method(globalThis, 'fetch', forbidden),
      t.mock.method(globalThis, 'setInterval', forbidden), t.mock.method(globalThis, 'setTimeout', forbidden),
      t.mock.method(process, 'cpuUsage', forbidden), t.mock.method(process, 'memoryUsage', forbidden),
      t.mock.method(f.store, 'readinessCheck', forbidden), t.mock.method(f.store, 'capacitySnapshot', forbidden),
      t.mock.method(f.sampler, 'sample', forbidden),
      t.mock.method(f.poller, 'runOnce', forbidden), t.mock.method(f.poller, 'readinessCheck', forbidden),
      t.mock.method(f.reconciler, 'reconcileOnce', forbidden), t.mock.method(f.reconciler, 'readinessCheck', forbidden),
      t.mock.method(f.probe, 'runIfDue', forbidden), t.mock.method(f.dispatcher, 'dispatch', forbidden),
      t.mock.method(f.facilitator, 'getSupported', forbidden), t.mock.method(f.facilitator, 'verify', forbidden),
      t.mock.method(f.facilitator, 'settle', forbidden),
      t.mock.method(f.indexer, 'getCurrentRound', forbidden), t.mock.method(f.indexer, 'lookupAssetTransfer', forbidden),
      t.mock.method(SignedPaymentGate.prototype, 'tryAcquire', forbidden), t.mock.method(SignedPaymentGate.prototype, 'snapshot', forbidden),
      t.mock.method(f.metrics, 'recordFreeRequest', forbidden),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map(key => t.mock.method(console, key, forbidden)),
   ];
   // Update named built-in imports too, including production statSync/statfsSync.
   syncBuiltinESMExports();
   t.after(() => { for (const guard of guards) guard.mock.restore(); syncBuiltinESMExports(); });
   return () => {
      for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
      for (const mock of [f.hono, f.publicReadiness, f.paidReadiness, f.paidReadiness.validateCurrent, f.providerFetch,
         f.telemetry.requestId, f.telemetry.now, f.telemetry.monotonicNow, f.telemetry.log]) assert.equal(mock.mock.callCount(), 0);
   };
}

for (const token of [undefined, '', 'short', 'x'.repeat(64), TOKEN.slice(1), `${TOKEN}0`, ` ${TOKEN}`, `${TOKEN}\n`, 'é'.repeat(64)]) {
   test(`missing/invalid startup configuration (${token === undefined ? 'absent' : `case ${[...token].length}`}) disables all internal dispatch`, async t => {
      const f = fixture(t);
      const fetch = f.compose({ token });
      const assertNoWork = guardOperationalWork(t, f);
      for (const method of ['GET', 'POST', 'OPTIONS']) {
         const response = await fetch(request(undefined, undefined, method));
         assert.equal(response.status, 404);
         assert.deepEqual(await response.json(), { error: 'not_found' });
         assertTransportHeaders(response);
      }
      assert.equal(f.snapshot.mock.callCount(), 0);
      assertNoWork();
   });
}

test('missing snapshot initialization also disables the endpoint', async t => {
   const f = fixture(t);
   const response = await f.compose({ runtimeSnapshot: undefined })(request());
   assert.equal(response.status, 404);
   assert.equal(f.snapshot.mock.callCount(), 0);
   assert.equal(f.hono.mock.callCount(), 0);
   assertTransportHeaders(response);
});

test('bounded missing, malformed, wrong and oversized bearer credentials never acquire a snapshot or operational work', async t => {
   const f = fixture(t);
   const fetch = f.compose();
   const assertNoWork = guardOperationalWork(t, f);
   for (const authorization of [null, '', 'Basic test', 'Bearer', `Bearer  ${TOKEN}`, `Bearer\t${TOKEN}`,
      `Bearer ${TOKEN}, Bearer ${TOKEN}`, `Bearer ${TOKEN} extra`, `Bearer ${WRONG_TOKEN}`,
      'Bearer 0', `Bearer ${TOKEN.slice(1)}`, `Bearer ${TOKEN}0`, `Bearer ${'f'.repeat(2_000)}`]) {
      const response = await fetch(request(undefined, authorization));
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'unauthorized' });
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
      assertTransportHeaders(response);
   }
   assert.equal(f.snapshot.mock.callCount(), 0);
   assertNoWork();
});

test('query, cookie and body credentials are never authentication mechanisms', async t => {
   const f = fixture(t);
   const fetch = f.compose();
   const assertNoWork = guardOperationalWork(t, f);
   for (const path of [`${OBSERVATORY_RUNTIME_PATH}?token=${TOKEN}`, `${OBSERVATORY_RUNTIME_PATH}?authorization=Bearer%20${TOKEN}`]) {
      const response = await fetch(request(path, null, 'GET', { headers: { cookie: `token=${TOKEN}` } }));
      assert.equal(response.status, 401);
      assertTransportHeaders(response);
      assert.equal((await response.text()).includes(TOKEN), false);
   }
   const bodyRequest = request(undefined, null, 'POST', { body: JSON.stringify({ token: TOKEN }) });
   const response = await fetch(bodyRequest);
   assert.equal(response.status, 405);
   assert.equal(bodyRequest.bodyUsed, false);
   assert.equal(f.snapshot.mock.callCount(), 0);
   assertNoWork();
});

test('all bounded auth attempts compare 32-byte digests regardless of credential length or syntax', async t => {
   const f = fixture(t);
   const original = crypto.timingSafeEqual;
   const compare = t.mock.method(crypto, 'timingSafeEqual', (left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView) => {
      assert.equal(left.byteLength, 32);
      assert.equal(right.byteLength, 32);
      return original(left, right);
   });
   syncBuiltinESMExports();
   t.after(() => { compare.mock.restore(); syncBuiltinESMExports(); });
   const fetch = f.compose();
   for (const authorization of [null, 'Basic test', 'Bearer 0', `Bearer ${TOKEN.slice(1)}`, `Bearer ${TOKEN}0`, `Bearer ${WRONG_TOKEN}`, `Bearer ${TOKEN}`]) {
      await fetch(request(undefined, authorization));
   }
   assert.equal(compare.mock.callCount(), 7);
});

for (const network of [TESTNET_NETWORK_CONFIG, MAINNET_NETWORK_CONFIG]) {
   test(`50 authenticated ${network.name} reads preserve the existing DTO and retained failure/timestamps with zero operational work`, async t => {
      const f = fixture(t, network);
      const expected = f.build();
      const retained = f.samples.snapshot();
      const health = f.poller.healthSnapshot();
      const counters = f.dispatcher.snapshot();
      const economics = f.metrics.snapshotAllFreeWork();
      const fetch = f.compose();
      const assertNoWork = guardOperationalWork(t, f);
      for (let i = 0; i < 50; i += 1) {
         const response = await fetch(request(undefined, `${i % 2 ? 'bEaReR' : 'Bearer'} ${TOKEN}`));
         assert.equal(response.status, 200);
         assertTransportHeaders(response);
         assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
         assert.deepEqual(await response.json(), expected);
      }
      assert.equal(f.snapshot.mock.callCount(), 50);
      assert.equal(f.samples.snapshot(), retained);
      assert.deepEqual(f.poller.healthSnapshot(), health);
      assert.deepEqual(f.dispatcher.snapshot(), counters);
      assert.deepEqual(f.metrics.snapshotAllFreeWork(), economics);
      assertNoWork();
   });
}

test('startup configuration is captured and cannot be enabled/rekeyed by later option mutation', async t => {
   const f = fixture(t);
   const options = { token: TOKEN, runtimeSnapshot: f.snapshot };
   const fetch = createRoundWatchHttpFetch(f.lifetime, f.hono, options);
   options.token = WRONG_TOKEN;
   assert.equal((await fetch(request())).status, 200);
   assert.equal((await fetch(request(undefined, `Bearer ${WRONG_TOKEN}`))).status, 401);
   const disabledOptions = { token: undefined as string | undefined, runtimeSnapshot: f.snapshot };
   const disabled = createRoundWatchHttpFetch(f.lifetime, f.hono, disabledOptions);
   disabledOptions.token = TOKEN;
   assert.equal((await disabled(request())).status, 404);
});

test('every unsupported method bypasses Hono, auth acquisition, body reads and operational gates', async t => {
   const f = fixture(t);
   const fetch = f.compose();
   const assertNoWork = guardOperationalWork(t, f);
   for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (const authorization of [null, `Bearer ${TOKEN}`]) {
         const incoming = request(undefined, authorization, method, method === 'POST' ? { body: 'private-body' } : {});
         const response = await fetch(incoming);
         assert.equal(response.status, 405);
         assert.equal(response.headers.get('allow'), 'GET');
         assertTransportHeaders(response);
         assert.equal(incoming.bodyUsed, false);
      }
   }
   assert.equal(f.snapshot.mock.callCount(), 0);
   assertNoWork();
});

test('reserved roots, aliases, unexpected and malformed paths cannot fall through to operational Hono', async t => {
   const f = fixture(t);
   const fetch = f.compose();
   const assertNoWork = guardOperationalWork(t, f);
   for (const path of ['/internal/observatory', '/internal/observatory/', `${OBSERVATORY_RUNTIME_PATH}/`,
      '/internal/observatory/watch/customer-id', '/internal/observatory/%ZZ',
      '/INTERNAL/OBSERVATORY/runtime', '/internal//observatory/runtime', '/internal/observatory//runtime',
      '/%69nternal/observatory/runtime', '/internal%2fobservatory%2fruntime',
      '/internal%5cobservatory/runtime', '/%2569nternal/observatory/runtime',
      '/internal/observatory/runtime%2f..%2fready', '/internal/observatory/runtime%00']) {
      for (const method of ['GET', 'OPTIONS', 'POST']) {
         const response = await fetch(request(path, `Bearer ${TOKEN}`, method));
         assert.equal(response.status, 404, `${method} ${path}`);
         assertTransportHeaders(response);
         assert.deepEqual(await response.json(), { error: 'not_found' });
      }
   }
   assert.equal(f.snapshot.mock.callCount(), 0);
   assertNoWork();
});

test('raw Node adapter targets remain reserved even when Fetch normalizes dot segments outside the namespace', async t => {
   const f = fixture(t);
   const fetch = f.compose();
   const assertNoWork = guardOperationalWork(t, f);
   for (const rawPath of ['/internal/observatory/../ready', '/internal/observatory/../../ready',
      '/internal/observatory/%2e%2e/%2e%2e/health', '/internal/observatory/runtime/../../../mcp',
      '/public/../internal/observatory/runtime', 'http://offline.example.test/internal/observatory/../../ready']) {
      const normalized = new Request(new URL(rawPath, 'http://offline.example.test'), { headers: { authorization: `Bearer ${TOKEN}` } });
      const response = await fetch(normalized, { incoming: { url: rawPath } });
      assert.equal(response.status, 404, rawPath);
      assertTransportHeaders(response);
   }
   const canonical = await fetch(request(), { incoming: { url: `${OBSERVATORY_RUNTIME_PATH}?ignored=true` } });
   assert.equal(canonical.status, 200);
   assert.equal(f.snapshot.mock.callCount(), 1);
   assertNoWork();
});

for (const enabled of [false, true]) {
   test(`nested reserved and ordinary targets obey a fixed decode budget (${enabled ? 'enabled' : 'disabled'})`, async t => {
      const f = fixture(t);
      const fetch = f.compose({ token: enabled ? TOKEN : undefined });
      const assertNoWork = guardOperationalWork(t, f);
      const original = String.prototype.replace;
      let passes = 0;
      t.mock.method(String.prototype, 'replace', function(this: string, pattern: string | RegExp, ...args: unknown[]) {
         if (pattern instanceof RegExp && pattern.source === '%([0-9a-f]{2})') {
            passes += 1;
            assert.ok(this.length <= 8_192, 'decode input must be capped');
         }
         return Reflect.apply(original, this, [pattern, ...args]);
      });
      for (const tail of ['69nternal/observatory/runtime', '41']) {
         for (const depth of [4, 32, 128, 4_000, 7_500]) {
            const path = `/%${'25'.repeat(depth)}${tail}`;
            // Cover raw-only aliases escaping Fetch normalization, normalized-only
            // aliases, and both targets together, independently of endpoint enablement.
            for (const [normalizedPath, rawPath] of [[path, path], ['/health', path], [path, '/health']]) {
               const incoming = request(normalizedPath);
               passes = 0;
               const response = await fetch(incoming, { incoming: { url: rawPath } });
               assert.equal(response.status, 404, `${depth} ${tail}`);
               assert.ok(passes <= 8, `at most four decodes per target, received ${passes}`);
               if (path.length <= 8_192) assert.equal(passes, 4);
               else assert.equal(passes, 0, 'oversized targets rejected before classification');
               assert.deepEqual(await response.json(), { error: 'not_found' });
               assertTransportHeaders(response);
            }
         }
      }
      assert.equal(f.snapshot.mock.callCount(), 0);
      assertNoWork();
   });

   test(`oversized and ambiguous targets reject before Hono or snapshots (${enabled ? 'enabled' : 'disabled'})`, async t => {
      const f = fixture(t);
      const fetch = f.compose({ token: enabled ? TOKEN : undefined });
      const assertNoWork = guardOperationalWork(t, f);
      for (const [normalized, raw] of [
         ['/health', `/health?${'x'.repeat(8_192)}`],
         ['/health', `http://${'x'.repeat(8_192)}.test/health`],
         [`/health?${'x'.repeat(8_192)}`, '/health'],
         [`/${'x'.repeat(8_192)}`, '/health'],
         ['/health', `/${'x'.repeat(8_192)}`],
         ['/health', '/ordinary%ZZ'], ['/ordinary%', '/health'],
         ['/ordinary%2541%ZZ', '/ordinary%2541%ZZ'],
      ]) {
         const response = await fetch(request(normalized), { incoming: { url: raw } });
         assert.equal(response.status, 404);
         assert.deepEqual(await response.json(), { error: 'not_found' });
         assertTransportHeaders(response);
      }
      assert.equal(f.snapshot.mock.callCount(), 0);
      assertNoWork();
   });
}

test('four-pass boundary preserves ordinary forwarding and rejects supported reserved aliases', async t => {
   const snapshot = t.mock.fn(forbidden);
   const operational = t.mock.fn((_request: Request, _bindings: { incoming: { url: string } }) => new Response('ordinary'));
   const fetch = createRoundWatchHttpFetch(new ApplicationLifetime(), operational, { token: TOKEN, runtimeSnapshot: snapshot });
   for (let depth = 0; depth < 4; depth += 1) {
      const alias = `/%${'25'.repeat(depth)}69nternal/observatory/runtime`;
      const response = await fetch(request(alias), { incoming: { url: alias } });
      assert.equal(response.status, 404);
      assertTransportHeaders(response);
      assert.equal(operational.mock.callCount(), depth);
      const ordinary = `/%${'25'.repeat(depth)}41`;
      const incoming = request(ordinary);
      const bindings = { incoming: { url: ordinary } };
      assert.equal(await (await fetch(incoming, bindings)).text(), 'ordinary');
      assert.equal(operational.mock.calls[depth]!.arguments[0], incoming);
      assert.equal(operational.mock.calls[depth]!.arguments[1], bindings);
   }
   assert.equal(snapshot.mock.callCount(), 0);
});

test('nonzero counters, cached round, completed cycle and worker event timestamps are preserved verbatim', async t => {
   const f = fixture(t);
   t.mock.method(f.poller, 'capacitySnapshot', () => ({
      currentIndexerRound: 150, currentIndexerRoundObservedAt: SAMPLE_TIME,
      lastCycleCompletedAt: SAMPLE_TIME, lastCycleDurationMs: 12.5,
      watchesAttemptedLastCycle: 5, watchesSucceededLastCycle: 2, watchesFailedLastCycle: 1,
   }));
   t.mock.method(f.dispatcher, 'snapshot', () => ({
      queued: 3, inFlight: 2, requests: { activation: 7, reconciliation: 2, 'absence-proof': 3, 'scan-page': 4, checkpoint: 5, health: 6 },
      successes: 12, failures: 4, timeouts: 2,
   }));
   t.mock.method(f.poller, 'healthSnapshot', () => ({
      started: true, running: false, ready: false, cycleNotStalled: true,
      providerHealth: 'unhealthy' as const, consecutiveFailures: 2,
      lastCycleStartedAtMs: Date.parse(SAMPLE_TIME), lastProgressAtMs: Date.parse(SAMPLE_TIME),
      lastProviderEvidenceAtMs: Date.parse(SAMPLE_TIME), lastErrorAtMs: Date.parse(FAILURE_TIME),
   }));
   const expected = f.build();
   const fetch = f.compose();
   const assertNoWork = guardOperationalWork(t, f);
   assert.deepEqual(await (await fetch(request())).json(), expected);
   assert.equal(expected.workers.poller.data!.ready, false);
   assert.equal(expected.indexer.observedRound.observedAt, SAMPLE_TIME);
   assert.equal(expected.pollCycle.observedAt, SAMPLE_TIME);
   assert.equal(expected.runtime.processMonotonicMs, 125.5);
   assertNoWork();
});

for (const asynchronous of [false, true]) {
   test(`${asynchronous ? 'async' : 'sync'} snapshot failure is bounded, silent and non-sensitive`, async t => {
      const f = fixture(t);
      const sensitive = `private-error ${TOKEN} /data/private.sqlite https://provider.example.test`;
      const failed = t.mock.fn(() => {
         if (asynchronous) return Promise.reject(new Error(sensitive));
         throw new Error(sensitive);
      });
      const fetch = f.compose({ runtimeSnapshot: failed });
      const assertNoWork = guardOperationalWork(t, f);
      for (let i = 0; i < 50; i += 1) {
         const response = await fetch(request());
         assert.equal(response.status, 500);
         assertTransportHeaders(response);
         assert.equal(await response.text(), '{"error":"observatory_unavailable"}');
      }
      assert.equal(failed.mock.callCount(), 50);
      assertNoWork();
   });
}

test('serialization exposes only fixed DTO fields and never invokes raw extras or toJSON', async t => {
   const f = fixture(t);
   const expected = f.build();
   const raw = structuredClone(expected);
   const privateData = { token: TOKEN, watchId: 'customer-id', sender: RECEIVER, providerUrl: 'https://private.example.test' };
   Object.assign(raw, privateData, { toJSON: forbidden });
   Object.assign(raw.runtime, privateData, { toJSON: forbidden });
   Object.assign(raw.readiness.data!.checks, privateData, { toJSON: forbidden });
   Object.defineProperty(raw, 'privateQueue', { get: forbidden });
   const fetch = f.compose({ runtimeSnapshot: () => raw });
   const assertNoWork = guardOperationalWork(t, f);
   const response = await fetch(request());
   assert.equal(response.status, 200);
   assert.deepEqual(await response.json(), expected);
   assertNoWork();
});

test('malformed DTOs and contract accessors fail generically without changing the source or operational state', async t => {
   const f = fixture(t);
   const good = f.build();
   const candidates: ObservatoryRuntimeV01[] = [];
   const changed = (mutate: (value: ObservatoryRuntimeV01) => void) => {
      const raw = structuredClone(good); mutate(raw); candidates.push(raw);
   };
   changed(value => { value.schemaVersion = 'private-schema' as ObservatoryRuntimeV01['schemaVersion']; });
   changed(value => { value.observedAt = '2026-02-30T00:00:00Z'; });
   changed(value => { value.runtime.assetId = 'https://private.example.test'; });
   changed(value => { value.capacity.data!.activeWatches = Infinity; });
   changed(value => { value.capacity.data!.sampledAt = READ_TIME; });
   changed(value => { value.readiness.lastCollectionFailureAt = null; });
   changed(value => { value.resources.data!.rssBytes = -1; });
   changed(value => { value.workers.poller.observedAt = null; });
   changed(value => { Object.defineProperty(value.runtime, 'processEpoch', { get: forbidden }); });
   const assertNoWork = guardOperationalWork(t, f);
   for (const raw of candidates) {
      const descriptors = Object.getOwnPropertyDescriptors(raw.runtime);
      const response = await f.compose({ runtimeSnapshot: () => raw })(request());
      assert.equal(response.status, 500);
      assert.equal(await response.text(), '{"error":"observatory_unavailable"}');
      assertTransportHeaders(response);
      assert.deepEqual(Object.getOwnPropertyDescriptors(raw.runtime), descriptors);
   }
   assert.deepEqual(f.build(), good);
   assertNoWork();
});

test('all availability states, nulls, numeric values and complete readiness variants are preserved', async t => {
   const f = fixture(t);
   const baseline = f.build();
   for (const availability of ['unavailable', 'not_yet_sampled', 'instrumentation_disabled', 'collection_failed'] as const) {
      const snapshot = structuredClone(baseline);
      snapshot.readiness = { availability, observedAt: null, data: null,
         lastCollectionFailureAt: availability === 'collection_failed' ? FAILURE_TIME : null };
      snapshot.capacity = { ...snapshot.readiness, data: null };
      snapshot.resources = { ...snapshot.readiness, data: null };
      const response = await f.compose({ runtimeSnapshot: () => snapshot })(request());
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), snapshot);
   }
   const snapshot = structuredClone(baseline);
   snapshot.runtime.processEpoch = 'opaque:epoch unchanged';
   assert.deepEqual(await (await f.compose({ runtimeSnapshot: () => snapshot })(request())).json(), snapshot);
   snapshot.readiness = { availability: 'available', observedAt: SAMPLE_TIME, lastCollectionFailureAt: FAILURE_TIME,
      data: { ready: false, checks: { readinessCheck: false } } };
   snapshot.resources.data!.cpu = null;
   snapshot.capacity.data!.scanLagRounds = null;
   snapshot.runtime.processEpoch = null;
   snapshot.runtime.processMonotonicMs = null;
   assert.deepEqual(await (await f.compose({ runtimeSnapshot: () => snapshot })(request())).json(), snapshot);
});

test('mixed and contradictory readiness variants fail without rewriting or operational work', async t => {
   const f = fixture(t);
   const good = f.build();
   const candidates = [];
   for (const ready of [true, false]) {
      candidates.push({ ready, checks: { ...completeReadiness().checks, readinessCheck: false } });
      // Every own normal key is forbidden, including non-enumerable accessors.
      for (const key of Object.keys(completeReadiness().checks)) {
         const checks = { readinessCheck: false };
         Object.defineProperty(checks, key, { get: forbidden });
         candidates.push({ ready, checks });
      }
   }
   candidates.push({ ready: true, checks: { readinessCheck: false } });
   candidates.push({ ready: false, checks: { readinessCheck: true } });
   const accessorChecks = {};
   Object.defineProperty(accessorChecks, 'readinessCheck', { get: forbidden });
   candidates.push({ ready: false, checks: accessorChecks });
   const assertNoWork = guardOperationalWork(t, f);
   for (const data of candidates) {
      const raw = structuredClone(good);
      raw.readiness.data = data as ObservatoryRuntimeV01['readiness']['data'];
      const descriptors = Object.getOwnPropertyDescriptors(data.checks);
      const observation = Object.getOwnPropertyDescriptors(raw.readiness);
      const snapshot = t.mock.fn(() => raw);
      const response = await f.compose({ runtimeSnapshot: snapshot })(request());
      assert.equal(response.status, 500);
      assert.equal(await response.text(), '{"error":"observatory_unavailable"}');
      assertTransportHeaders(response);
      assert.equal(snapshot.mock.callCount(), 1, 'no fallback snapshot acquisition');
      assert.deepEqual(Object.getOwnPropertyDescriptors(data.checks), descriptors);
      assert.deepEqual(Object.getOwnPropertyDescriptors(raw.readiness), observation);
   }
   assert.deepEqual(f.build(), good);
   assertNoWork();
});

test('positive, negative and exception readiness preserve approved fields and ignore private hooks', async t => {
   const f = fixture(t);
   const good = f.build();
   const assertNoWork = guardOperationalWork(t, f);
   for (const data of [
      { ready: true, checks: { storage: true, poller: true, reconciler: true, backgroundWorkers: true, diskHeadroom: true } },
      completeReadiness(), { ready: false, checks: { readinessCheck: false } },
   ]) {
      const expected = structuredClone(good);
      expected.readiness.data = data as ObservatoryRuntimeV01['readiness']['data'];
      const raw = structuredClone(expected);
      Object.assign(raw.readiness.data!, { privateError: TOKEN, toJSON: forbidden });
      Object.assign(raw.readiness.data!.checks, { privateError: TOKEN, toJSON: forbidden });
      Object.defineProperty(raw.readiness.data!, 'privateQueue', { get: forbidden });
      Object.defineProperty(raw.readiness.data!.checks, 'privateQueue', { get: forbidden });
      const beforeData = Object.getOwnPropertyDescriptors(raw.readiness.data!);
      const beforeChecks = Object.getOwnPropertyDescriptors(raw.readiness.data!.checks);
      const response = await f.compose({ runtimeSnapshot: () => raw })(request());
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), expected);
      assertTransportHeaders(response);
      assert.deepEqual(Object.getOwnPropertyDescriptors(raw.readiness.data!), beforeData);
      assert.deepEqual(Object.getOwnPropertyDescriptors(raw.readiness.data!.checks), beforeChecks);
   }
   assert.deepEqual(f.build(), good);
   assertNoWork();
});

test('optional transport construction failure preserves operational startup and keeps the namespace disabled', async t => {
   const f = fixture(t);
   const events: string[] = [];
   const initialize = t.mock.fn(() => { throw new Error(`private initialization ${TOKEN}`); });
   let fetch!: ReturnType<typeof f.compose>;
   const server = Object.assign(new EventEmitter(), { listen(port: number) { events.push(`listen:${port}`); } });
   await startProductionRuntime({
      application: f.lifetime,
      coordinator: { isStopping: () => false, shutdown: async () => { assert.fail('Observatory fault shut down the server'); } },
      initializePayments: async () => { events.push('payments'); },
      createServer: () => { fetch = f.compose({}, initialize); events.push('server'); return server; },
      port: 4021, startWorkers: () => { events.push('workers'); }, onListening: () => { events.push('listening'); },
      setExitCode: forbidden,
   });
   server.emit('listening');
   assert.deepEqual(events, ['payments', 'server', 'listen:4021', 'workers', 'listening']);
   assert.equal(initialize.mock.callCount(), 1);
   assert.equal((await fetch(new Request('http://offline/health'))).status, 200);
   // Reset the expected normal-route effects before testing internal isolation.
   for (const mock of [f.hono, f.telemetry.requestId, f.telemetry.now, f.telemetry.monotonicNow, f.telemetry.log]) mock.mock.resetCalls();
   const assertNoWork = guardOperationalWork(t, f);
   const response = await fetch(request());
   assert.equal(response.status, 404);
   assertTransportHeaders(response);
   assert.equal(f.snapshot.mock.callCount(), 0);
   assertNoWork();
});

test('stopped lifetime rejects all new Observatory requests before routing, authentication or assembly', async t => {
   const f = fixture(t);
   const fetch = f.compose();
   f.lifetime.stopAdmission();
   const assertNoWork = guardOperationalWork(t, f);
   for (const path of [OBSERVATORY_RUNTIME_PATH, '/internal/observatory/unknown']) {
      for (const authorization of [null, `Bearer ${TOKEN}`]) {
         const response = await fetch(request(path, authorization));
         assert.equal(response.status, 503);
         assertTransportHeaders(response);
         assert.equal(await response.text(), 'Service is shutting down');
      }
   }
   await f.lifetime.drain();
   assert.equal(f.snapshot.mock.callCount(), 0);
   assertNoWork();
});

function deferred<T>() {
   let resolve!: (value: T) => void;
   const promise = new Promise<T>(accept => { resolve = accept; });
   return { promise, resolve };
}

for (const reject of [false, true]) {
   test(`in-flight Observatory ${reject ? 'failure' : 'success'} remains owned through socket abort and coordinator draining`, async t => {
      const f = fixture(t);
      const snapshot = f.build();
      const held = deferred<ObservatoryRuntimeV01>();
      const entered = deferred<void>();
      const getSnapshot = t.mock.fn(() => { entered.resolve(); return held.promise.then(value => {
         if (reject) throw new Error(`private held error ${TOKEN}`);
         return value;
      }); });
      const fetch = f.compose({ runtimeSnapshot: getSnapshot });
      let storageClosed = false;
      let listenerClosed = false;
      const coordinator = createShutdownCoordinator({
         application: f.lifetime, facilitator: f.facilitator, dispatcher: f.dispatcher,
         poller: f.poller, reconciler: f.reconciler, healthProbe: f.probe,
         runtimeSampler: f.sampler,
         closeServer: async () => { listenerClosed = true; }, closeStore: () => { storageClosed = true; },
         timers: { setTimeout: () => 'test-deadline', clearTimeout() {} }, terminate: forbidden, report: forbidden,
      });
      const abort = new AbortController();
      const pending = fetch(request(undefined, undefined, 'GET', { signal: abort.signal }));
      await entered.promise;
      abort.abort();
      const shutdown = coordinator.shutdown('test stop');
      let drained = false;
      const draining = f.lifetime.drain().then(() => { drained = true; });
      await Promise.resolve();
      assert.equal(listenerClosed, true);
      assert.equal(storageClosed, false);
      assert.equal(drained, false);
      assert.equal((await fetch(request())).status, 503);
      assert.equal(getSnapshot.mock.callCount(), 1);
      held.resolve(snapshot);
      const response = await pending;
      assert.equal(response.status, reject ? 500 : 200);
      assertTransportHeaders(response);
      assert.equal((await shutdown).status, 'drained');
      await draining;
      assert.equal(storageClosed, true);
      assert.equal(f.hono.mock.callCount(), 0);
      assert.equal(f.providerFetch.mock.callCount(), 0);
   });
}

for (const network of [TESTNET_NETWORK_CONFIG, MAINNET_NETWORK_CONFIG]) {
   test(`existing ${network.name} health, ready, watch, MCP, recovery and discovery routing matches ordinary Hono`, async t => {
      const f = fixture(t, network);
      const fetch = f.compose();
      const watchPath = network.name === 'mainnet' ? '/v1/watch' : '/spike/watch';
      const routes = [
         ['GET', '/health', undefined], ['GET', '/ready', undefined],
         ['GET', `${watchPath}/unknown`, undefined], ['POST', watchPath, '{}'],
         ['POST', `${watchPath}/recover`, '{}'], ['POST', '/mcp', '{"jsonrpc":"2.0","id":1,"method":"ping"}'],
         ['GET', '/openapi.json', undefined], ['GET', '/llms.txt', undefined],
         ['GET', '/internal/observatory-other', undefined],
      ] as const;
      for (const [method, path, body] of routes) {
         const init = { method, headers: { 'content-type': 'application/json', origin: 'https://browser.example.test' }, body };
         const baseline = await f.runtime.app.fetch(new Request(`http://offline.example.test${path}`, init));
         const response = await fetch(new Request(`http://offline.example.test${path}`, init));
         assert.equal(response.status, baseline.status, `${method} ${path}`);
         assert.deepEqual([...response.headers], [...baseline.headers], path);
         assert.equal(await response.text(), await baseline.text(), path);
         assert.equal(response.headers.get('access-control-allow-origin'), '*');
      }
      assert.equal(f.hono.mock.callCount(), routes.length);
      assert.equal(f.snapshot.mock.callCount(), 0);
      assert.ok(f.telemetry.requestId.mock.callCount() > 0, 'actual ordinary telemetry must be enabled');
      assert.ok(f.telemetry.log.mock.callCount() > 0);
      assert.equal(f.providerFetch.mock.callCount(), 0);
   });
}

test('Observatory cannot refresh strict paid evidence or consume tokens; normal paid admission still fails closed', async t => {
   const f = fixture(t);
   const storage = t.mock.fn(() => false);
   const disk = t.mock.fn(() => true);
   const strict = createPaidAdmissionReadinessCheck({
      storageReady: storage, diskHeadroom: disk, poller: f.poller, reconciler: f.reconciler,
      healthProbe: f.probe, maximumEvidenceAgeMilliseconds: 30_000,
   });
   const app = createAppRuntime({
      avmAddress: RECEIVER, facilitatorClient: f.facilitator, store: f.store, indexer: f.indexer,
      syncFacilitatorOnStart: false, paidAdmissionReadinessCheck: strict,
   });
   const fetch = createRoundWatchHttpFetch(f.lifetime, app.app.fetch, { token: TOKEN, runtimeSnapshot: f.snapshot });
   const acquisition = t.mock.method(f.probe, 'runIfDue', forbidden);
   const tokens = t.mock.method(SignedPaymentGate.prototype, 'tryAcquire', forbidden);
   for (let i = 0; i < 50; i += 1) assert.equal((await fetch(request())).status, 200);
   assert.equal(storage.mock.callCount(), 0);
   assert.equal(disk.mock.callCount(), 0);
   assert.equal(acquisition.mock.callCount(), 0);
   assert.equal(tokens.mock.callCount(), 0);
   const response = await fetch(new Request('http://offline.example.test/spike/watch', { method: 'POST' }));
   assert.equal(response.status, 503);
   assert.equal((await response.json() as { code: string }).code, 'service_not_ready');
   assert.equal(storage.mock.callCount(), 1);
   assert.equal(f.providerFetch.mock.callCount(), 0);
   assert.equal(acquisition.mock.callCount(), 0);
   assert.equal(tokens.mock.callCount(), 0);
});

test('dispatch preserves every adapter argument and normal-route lifetime ownership', async () => {
   const lifetime = new ApplicationLifetime();
   const held = deferred<Response>();
   const incoming = new Request('http://offline/health');
   const env = { incoming: {}, outgoing: {} };
   const execution = {};
   const fetch = createRoundWatchHttpFetch(lifetime, (received, bindings: typeof env, context: typeof execution) => {
      assert.equal(received, incoming); assert.equal(bindings, env); assert.equal(context, execution);
      return held.promise;
   }, { token: undefined, runtimeSnapshot: undefined });
   const pending = fetch(incoming, env, execution);
   let drained = false;
   const draining = lifetime.drain().then(() => { drained = true; });
   await Promise.resolve();
   assert.equal(drained, false);
   held.resolve(new Response('operational'));
   assert.equal(await (await pending).text(), 'operational');
   await draining;
});
