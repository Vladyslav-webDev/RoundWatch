import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { AlgorandIndexerClient } from './roundwatch-indexer.js';
import { IndexerHealthProbe, type IndexerCapabilityEvidence } from './roundwatch-health-probe.js';
import { INERT_WATCH_ECONOMICS_RECORDER, type IndexerRequestObservation } from './roundwatch-metrics.js';
import { IndexerRequestDispatcher, type IndexerDispatchObservation } from './roundwatch-scheduler.js';
import { ShutdownInterrupted, isShutdownInterrupted } from './roundwatch-shutdown.js';

const ASSET = 10458941;

function gate<T>() {
   let resolve!: (value: T) => void;
   let reject!: (error: unknown) => void;
   const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
   return { promise, resolve, reject };
}

function observeUnhandledRejections(t: TestContext): unknown[] {
   const errors: unknown[] = [];
   const observe = (error: unknown) => { errors.push(error); };
   process.on('unhandledRejection', observe);
   t.after(() => { process.off('unhandledRejection', observe); });
   return errors;
}

test('S1 dispatcher rejects queued and future admission while drain owns an in-flight completion', async () => {
   const dispatcher = new IndexerRequestDispatcher({ burst: 3, concurrency: 1 });
   const held = gate<number>();
   const calls: string[] = [];
   const observations: IndexerDispatchObservation[] = [];
   const first = dispatcher.dispatch('scan-page', () => {
      calls.push('first');
      return held.promise;
   }, observation => observations.push(observation));
   const second = dispatcher.dispatch('checkpoint', async () => {
      calls.push('second');
      return 2;
   }, observation => observations.push(observation));
   const secondRejected = assert.rejects(second, isShutdownInterrupted);
   assert.deepEqual(dispatcher.snapshot(), {
      queued: 1, inFlight: 1, requests: { 'scan-page': 1 }, successes: 0, failures: 0, timeouts: 0,
   });

   dispatcher.stopScheduling();
   dispatcher.stopScheduling();
   const drained = dispatcher.drain();
   assert.equal(dispatcher.drain(), drained);
   let finished = false;
   void drained.then(() => { finished = true; });
   await secondRejected;
   await assert.rejects(dispatcher.dispatch('health', async () => {
      calls.push('future');
      return 3;
   }, observation => observations.push(observation)), isShutdownInterrupted);
   assert.equal(finished, false);
   assert.deepEqual(calls, ['first']);
   assert.equal(observations.length, 0);
   assert.equal(dispatcher.snapshot().queued, 0);

   held.resolve(1);
   assert.equal(await first, 1);
   await drained;
   assert.equal(finished, true);
   assert.deepEqual(calls, ['first']);
   assert.equal(observations.length, 1);
   assert.equal(observations[0]!.outcome, 'success');
   assert.deepEqual(dispatcher.snapshot(), {
      queued: 0, inFlight: 0, requests: { 'scan-page': 1 }, successes: 1, failures: 0, timeouts: 0,
   });
});

test('S1 dispatcher drain terminally fences admission and preserves an actual in-flight failure', async () => {
   const dispatcher = new IndexerRequestDispatcher();
   const held = gate<void>();
   const providerFailure = new Error('offline provider failure');
   const observations: IndexerDispatchObservation[] = [];
   const request = dispatcher.dispatch('health', () => held.promise, observation => observations.push(observation));
   const rejected = assert.rejects(request, error => error === providerFailure);
   const drained = dispatcher.drain();
   await assert.rejects(dispatcher.dispatch('health', async () => {}), isShutdownInterrupted);
   held.reject(providerFailure);
   await rejected;
   await drained;
   assert.equal(observations.length, 1);
   assert.equal(observations[0]!.outcome, 'failure');
   assert.equal(dispatcher.snapshot().failures, 1);
   assert.equal(dispatcher.snapshot().inFlight, 0);
});

for (const outcome of ['success', 'failure'] as const) {
   for (const diagnostic of ['debug', 'observer-warning'] as const) {
      test(`S1 dispatcher settles ${outcome} callers and drain when ${diagnostic} diagnostics throw`, async t => {
         const dispatcher = new IndexerRequestDispatcher();
         const held = gate<number>();
         const providerFailure = new Error('offline provider failure');
         const observations: IndexerDispatchObservation[] = [];
         const debug = t.mock.method(console, 'debug', () => {
            if (diagnostic === 'debug') throw new Error('debug sink failed');
         });
         const warn = t.mock.method(console, 'warn', () => { throw new Error('warning sink failed'); });
         const request = dispatcher.dispatch('health', () => held.promise, observation => {
            observations.push(observation);
            if (diagnostic === 'observer-warning') throw new Error('observer failed');
         });
         const callerSettled = outcome === 'success'
            ? request.then(value => { assert.equal(value, 101); })
            : assert.rejects(request, error => error === providerFailure);
         const drained = dispatcher.drain();
         let finished = false;
         void drained.then(() => { finished = true; });
         await Promise.resolve();
         assert.equal(finished, false);
         if (outcome === 'success') held.resolve(101);
         else held.reject(providerFailure);
         await callerSettled;
         await drained;
         assert.equal(finished, true);
         assert.equal(debug.mock.callCount(), 1);
         assert.equal(warn.mock.callCount(), diagnostic === 'observer-warning' ? 1 : 0);
         assert.equal(observations.length, 1);
         assert.equal(observations[0]!.outcome, outcome);
         assert.deepEqual(dispatcher.snapshot(), {
            queued: 0, inFlight: 0, requests: { health: 1 },
            successes: outcome === 'success' ? 1 : 0,
            failures: outcome === 'failure' ? 1 : 0,
            timeouts: 0,
         });
      });
   }
}

for (const outcome of ['success', 'failure'] as const) {
   for (const diagnosticsThrow of [false, true]) {
      test(`S1 F02 ${outcome} provider settlement wins over a throwing completion clock${diagnosticsThrow ? ' and observer/logging' : ''}`, async t => {
         const unhandled = observeUnhandledRejections(t);
         const held = gate<{ round: number }>();
         const providerValue = { round: 101 };
         const providerFailure = new Error('original offline provider error');
         const clockFailure = new Error('completion clock failed');
         let throwClock = false;
         let clockFailures = 0;
         let clock = 100;
         const dispatcher = new IndexerRequestDispatcher({ now() {
            if (throwClock) { clockFailures += 1; throw clockFailure; }
            return clock += 10;
         } });
         const debug = t.mock.method(console, 'debug', () => {
            if (diagnosticsThrow) throw new Error('debug sink failed');
         });
         const warn = t.mock.method(console, 'warn', () => { throw new Error('warning sink failed'); });
         const observations: IndexerDispatchObservation[] = [];
         const events: string[] = [];
         let drained = false;
         let providerStarted = false;
         const request = dispatcher.dispatch('health', () => {
            providerStarted = true;
            return held.promise;
         }, observation => {
            observations.push(observation);
            events.push('observer');
            assert.equal(dispatcher.snapshot().inFlight, 1);
            assert.equal(drained, false);
            if (diagnosticsThrow) throw new Error('observer failed');
         });
         assert.equal(providerStarted, true);
         // Clock acquisition succeeds until the actual provider operation is held.
         throwClock = true;
         const callerSettled = request.then(value => {
            assert.equal(outcome, 'success');
            assert.equal(value, providerValue);
            events.push('caller');
         }, error => {
            assert.equal(outcome, 'failure');
            assert.equal(error, providerFailure);
            events.push('caller');
         });
         const draining = dispatcher.drain();
         void draining.then(() => { drained = true; events.push('drain'); });
         await Promise.resolve();
         assert.equal(drained, false);
         assert.equal(dispatcher.snapshot().inFlight, 1);
         if (outcome === 'success') held.resolve(providerValue);
         else held.reject(providerFailure);
         await callerSettled;
         await draining;
         assert.deepEqual(events, ['observer', 'caller', 'drain']);
         assert.equal(clockFailures, 1);
         assert.equal(debug.mock.callCount(), 1);
         assert.equal(warn.mock.callCount(), diagnosticsThrow ? 1 : 0);
         assert.deepEqual(observations, [{ outcome, queueWaitMs: 20, wallTimeMs: 0 }]);
         assert.deepEqual(dispatcher.snapshot(), {
            queued: 0, inFlight: 0, requests: { health: 1 },
            successes: outcome === 'success' ? 1 : 0,
            failures: outcome === 'failure' ? 1 : 0,
            timeouts: 0,
         });
         // An event-loop turn observes any detached completion rejection, without a sleep.
         await new Promise<void>(resolve => setImmediate(resolve));
         assert.deepEqual(unhandled, []);
      });
   }
}

test('S1 F02 a throwing diagnostic clock cannot break normal completion queue pumping', async t => {
   const unhandled = observeUnhandledRejections(t);
   const held = gate<number>();
   let throwClock = false;
   let secondStarted = false;
   const dispatcher = new IndexerRequestDispatcher({ burst: 2, concurrency: 1, now() {
      if (throwClock) throw new Error('clock unavailable after dispatch');
      return 100;
   } });
   const first = dispatcher.dispatch('health', () => held.promise);
   const second = dispatcher.dispatch('checkpoint', async () => { secondStarted = true; return 102; });
   assert.equal(secondStarted, false);
   assert.equal(dispatcher.snapshot().queued, 1);
   throwClock = true;
   held.resolve(101);
   assert.equal(await first, 101);
   assert.equal(await second, 102);
   await dispatcher.drain();
   assert.equal(secondStarted, true);
   assert.deepEqual(dispatcher.snapshot(), {
      queued: 0, inFlight: 0, requests: { health: 1, checkpoint: 1 },
      successes: 2, failures: 0, timeouts: 0,
   });
   await new Promise<void>(resolve => setImmediate(resolve));
   assert.deepEqual(unhandled, []);
});

for (const [boundary, clockCall] of [['enqueue', 2], ['refill', 3], ['start', 4]] as const) {
   test(`S1 dispatcher clock-triggered shutdown at ${boundary} cannot leak admission or dispatch`, async () => {
      let clocks = 0;
      let dispatcher!: IndexerRequestDispatcher;
      dispatcher = new IndexerRequestDispatcher({ now() {
         clocks += 1;
         if (clocks === clockCall) dispatcher.stopScheduling();
         return 0;
      } });
      let calls = 0;
      const observations: IndexerDispatchObservation[] = [];
      await assert.rejects(dispatcher.dispatch('health', async () => { calls += 1; },
         observation => observations.push(observation)), isShutdownInterrupted);
      await dispatcher.drain();
      assert.equal(clocks, clockCall);
      assert.equal(calls, 0);
      assert.equal(observations.length, 0);
      assert.deepEqual(dispatcher.snapshot(), {
         queued: 0, inFlight: 0, requests: {}, successes: 0, failures: 0, timeouts: 0,
      });
   });
}

test('S1 dispatcher clears its token timer and neither late callback nor completion recreates it', async t => {
   const held = gate<void>();
   let timerCallback!: () => void;
   let timers = 0;
   let clears = 0;
   const timerHandle = { unref() {} } as NodeJS.Timeout;
   t.mock.method(globalThis, 'setTimeout', (callback: () => void) => {
      timers += 1;
      timerCallback = callback;
      return timerHandle;
   });
   t.mock.method(globalThis, 'clearTimeout', (handle: NodeJS.Timeout) => {
      assert.equal(handle, timerHandle);
      clears += 1;
   });
   const dispatcher = new IndexerRequestDispatcher({ burst: 1, concurrency: 2, now: () => 0 });
   const first = dispatcher.dispatch('health', () => held.promise);
   let queuedCalls = 0;
   const queued = dispatcher.dispatch('checkpoint', async () => { queuedCalls += 1; });
   const rejected = assert.rejects(queued, isShutdownInterrupted);
   assert.equal(timers, 1);
   assert.equal(clears, 0);
   dispatcher.stopScheduling();
   assert.equal(clears, 1);
   const drained = dispatcher.drain();
   timerCallback();
   held.resolve();
   await first;
   await rejected;
   await drained;
   assert.equal(timers, 1);
   assert.equal(clears, 1);
   assert.equal(queuedCalls, 0);
   assert.deepEqual(dispatcher.snapshot(), {
      queued: 0, inFlight: 0, requests: { health: 1 }, successes: 1, failures: 0, timeouts: 0,
   });
});

test('S1 undispatched client requests create no fallback request telemetry', async () => {
   const dispatcher = new IndexerRequestDispatcher({ burst: 5, concurrency: 1 });
   const held = gate<Response>();
   let fetches = 0;
   const observations: IndexerDispatchObservation['outcome'][] = [];
   const recorder = {
      ...INERT_WATCH_ECONOMICS_RECORDER,
      recordIndexerRequest(_purpose: unknown, observation: IndexerRequestObservation) {
         observations.push(observation.outcome);
      },
   };
   const client = new AlgorandIndexerClient('https://indexer.invalid', dispatcher, async () => {
      fetches += 1;
      return held.promise;
   });
   const first = client.getCurrentRound('health', undefined, recorder);
   const queued = client.getCurrentRound('health', undefined, recorder);
   const rejected = assert.rejects(queued, isShutdownInterrupted);
   dispatcher.stopScheduling();
   await rejected;
   await assert.rejects(client.getCurrentRound('health', undefined, recorder), isShutdownInterrupted);
   assert.equal(fetches, 1);
   assert.deepEqual(observations, []);
   held.resolve(Response.json({ round: 101 }));
   assert.equal(await first, 101);
   await dispatcher.drain();
   assert.deepEqual(observations, ['success']);
   assert.deepEqual(dispatcher.snapshot(), {
      queued: 0, inFlight: 0, requests: { health: 1 }, successes: 1, failures: 0, timeouts: 0,
   });
});

test('S1 health probe terminal stop and drain prohibit new acquisition', async () => {
   let acquisitions = 0;
   const probe = new IndexerHealthProbe({ async probeReadinessCapabilities() {
      acquisitions += 1;
      return { polling: true, reconciliation: true };
   } }, ASSET);
   probe.stopScheduling();
   probe.stopScheduling();
   await assert.rejects(probe.runIfDue(), isShutdownInterrupted);
   const drained = probe.drain();
   assert.equal(probe.drain(), drained);
   await drained;
   assert.equal(acquisitions, 0);
   assert.equal(probe.currentRevision(), 0);
   assert.equal(probe.currentFailureEpoch(), 0);
   assert.equal(probe.currentSample(), undefined);
});

test('S1 pending health probe stays owned until a successful result is retained', async () => {
   const held = gate<IndexerCapabilityEvidence>();
   const probe = new IndexerHealthProbe({ probeReadinessCapabilities: () => held.promise }, ASSET, () => 1_000);
   const pending = probe.runIfDue();
   const drained = probe.drain();
   assert.equal(probe.drain(), drained);
   let finished = false;
   void drained.then(() => { finished = true; });
   await Promise.resolve();
   assert.equal(finished, false);
   await assert.rejects(probe.runIfDue(), isShutdownInterrupted);
   held.resolve({ polling: true, reconciliation: true });
   const result = await pending;
   await drained;
   assert.equal(finished, true);
   assert.equal(probe.currentSample(), result);
   assert.deepEqual(result.evidence, { polling: true, reconciliation: true });
});

test('S1 a health probe clock-triggered shutdown rejects before source acquisition or evidence revision', async () => {
   let acquisitions = 0;
   let probe!: IndexerHealthProbe;
   probe = new IndexerHealthProbe({ async probeReadinessCapabilities() {
      acquisitions += 1;
      return { polling: true, reconciliation: true };
   } }, ASSET, () => {
      probe.stopScheduling();
      return 1_000;
   });
   await assert.rejects(probe.runIfDue(), isShutdownInterrupted);
   await probe.drain();
   assert.equal(acquisitions, 0);
   assert.equal(probe.currentRevision(), 0);
   assert.equal(probe.currentFailureEpoch(), 0);
   assert.equal(probe.currentSample(), undefined);
});

test('S1 administrative probe interruption retains prior evidence and does not advance failure evidence', async () => {
   let now = 1_000;
   let acquisitions = 0;
   const held = gate<IndexerCapabilityEvidence>();
   const probe = new IndexerHealthProbe({ probeReadinessCapabilities() {
      acquisitions += 1;
      return acquisitions === 1
         ? Promise.resolve({ polling: true, reconciliation: true })
         : held.promise;
   } }, ASSET, () => now);
   const retained = await probe.runIfDue();
   now += 15_000;
   const pending = probe.runIfDue();
   const rejected = assert.rejects(pending, isShutdownInterrupted);
   probe.stopScheduling();
   const drained = probe.drain();
   let finished = false;
   void drained.then(() => { finished = true; });
   await Promise.resolve();
   assert.equal(finished, false);
   held.reject(new ShutdownInterrupted());
   await rejected;
   await drained;
   assert.equal(finished, true);
   assert.equal(acquisitions, 2);
   assert.equal(probe.currentSample(), retained);
   assert.equal(probe.currentFailureEpoch(), 0);
   assert.equal(probe.isSampleCurrent(retained), true);
   assert.equal(retained.providerFailureRevision, 0);
});

test('S1 health probe owns acquisition before a synchronous source requests drain', async () => {
   const held = gate<IndexerCapabilityEvidence>();
   let drained!: Promise<void>;
   const probe = new IndexerHealthProbe({ probeReadinessCapabilities() {
      drained = probe.drain();
      return held.promise;
   } }, ASSET);
   const pending = probe.runIfDue();
   let finished = false;
   void drained.then(() => { finished = true; });
   await Promise.resolve();
   assert.equal(finished, false);
   held.resolve({ polling: true, reconciliation: true });
   await pending;
   await drained;
   assert.equal(finished, true);
});

test('S1 capability client propagates shutdown from the first health acquisition', async () => {
   const dispatcher = new IndexerRequestDispatcher();
   let fetches = 0;
   const client = new AlgorandIndexerClient('https://indexer.invalid', dispatcher, async () => {
      fetches += 1;
      return Response.json({ round: 101 });
   });
   dispatcher.stopScheduling();
   await assert.rejects(client.probeReadinessCapabilities(ASSET), isShutdownInterrupted);
   await dispatcher.drain();
   assert.equal(fetches, 0);
   assert.deepEqual(dispatcher.snapshot(), {
      queued: 0, inFlight: 0, requests: {}, successes: 0, failures: 0, timeouts: 0,
   });
});

for (const heldRoute of ['health', 'scan', 'block', 'lookup'] as const) {
   test(`S1 capability probe stopping after dispatched ${heldRoute} blocks its dependent request without negative evidence`, async () => {
      const dispatcher = new IndexerRequestDispatcher({ burst: 10, concurrency: 1 });
      const reached = gate<void>();
      const released = gate<void>();
      const calls: string[] = [];
      const client = new AlgorandIndexerClient('https://indexer.invalid', dispatcher, async input => {
         const path = new URL(String(input)).pathname;
         const route = path === '/health' ? 'health'
            : path.startsWith('/v2/assets/') ? 'scan'
               : path.startsWith('/v2/blocks/') ? 'block'
                  : path.startsWith('/v2/transactions/') ? 'lookup' : 'search';
         calls.push(route);
         if (route === heldRoute) {
            reached.resolve();
            await released.promise;
         }
         if (route === 'health') return Response.json({ round: 101 });
         if (route === 'block') return Response.json({ round: 101, timestamp: 1 });
         if (route === 'lookup') return new Response(null, { status: 404 });
         return Response.json({ transactions: [], 'current-round': 101 });
      });
      const probe = new IndexerHealthProbe(client, ASSET, () => 1_000);
      const pending = probe.runIfDue();
      const rejected = assert.rejects(pending, isShutdownInterrupted);
      await reached.promise;
      dispatcher.stopScheduling();
      probe.stopScheduling();
      const providerDrained = dispatcher.drain();
      const probeDrained = probe.drain();
      let finished = false;
      void probeDrained.then(() => { finished = true; });
      await Promise.resolve();
      assert.equal(finished, false);
      released.resolve();
      await rejected;
      await Promise.all([providerDrained, probeDrained]);
      const expectedCalls = ['health', 'scan', 'block', 'lookup'];
      assert.deepEqual(calls, expectedCalls.slice(0, expectedCalls.indexOf(heldRoute) + 1));
      assert.equal(dispatcher.snapshot().inFlight, 0);
      assert.equal(dispatcher.snapshot().queued, 0);
      assert.equal(dispatcher.snapshot().successes, calls.length);
      assert.equal(dispatcher.snapshot().failures, 0);
      assert.equal(dispatcher.snapshot().timeouts, 0);
      assert.equal(probe.currentFailureEpoch(), 0);
      assert.equal(probe.currentSample(), undefined);
   });
}
