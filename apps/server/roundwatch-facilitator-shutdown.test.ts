import assert from 'node:assert/strict';
import test from 'node:test';
import { x402ResourceServer } from '@x402/core/server';
import {
   FacilitatorResponseError,
   FacilitatorTimeoutError,
   SettleError,
   VerifyError,
   type PaymentPayload,
   type PaymentRequirements,
} from '@x402/core/types';
import { ExactAvmScheme } from '@x402/avm/exact/server';
import { createAppRuntime, ALGORAND_TESTNET } from './app.js';
import { ApplicationLifetime } from './roundwatch-application-lifetime.js';
import { RoundWatchFacilitatorClient } from './roundwatch-facilitator.js';
import { ShutdownInterrupted } from './roundwatch-shutdown.js';
import { RoundWatchStore } from './roundwatch-store.js';
import type { RoundWatchIndexer } from './roundwatch-indexer.js';

function gate<T>() {
   let resolve!: (value: T | PromiseLike<T>) => void;
   let reject!: (error: unknown) => void;
   const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
   return { promise, resolve, reject };
}
const requirements: PaymentRequirements = {
   scheme: 'exact', network: ALGORAND_TESTNET, asset: '10458941', amount: '100000',
   payTo: 'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI',
   maxTimeoutSeconds: 60, extra: {},
};
const payload: PaymentPayload = { x402Version: 2, accepted: requirements, payload: {} };
const supported = {
   kinds: [{ x402Version: 2, scheme: 'exact', network: ALGORAND_TESTNET }],
   extensions: [], signers: {},
};
const settled = { success: true, transaction: 'SETTLED_TX', network: ALGORAND_TESTNET };
function json(value: unknown, status = 200, headers?: HeadersInit): Response {
   return new Response(JSON.stringify(value), { status, headers });
}
function client(transport: typeof fetch) {
   return new RoundWatchFacilitatorClient({ url: 'https://offline.invalid/facilitator/', fetch: transport });
}

test('S2 facilitator idle drain is terminal and shares one completion promise', async () => {
   let attempts = 0;
   const facilitator = client(async () => { attempts++; return json(supported); });
   const first = facilitator.drain();
   assert.strictEqual(first, facilitator.drain());
   await first;
   await assert.rejects(facilitator.getSupported(), ShutdownInterrupted);
   await assert.rejects(facilitator.verify(payload, requirements), ShutdownInterrupted);
   await assert.rejects(facilitator.settle(payload, requirements), ShutdownInterrupted);
   assert.equal(attempts, 0);
});

for (const operation of ['supported', 'verify', 'settle'] as const) {
   test(`S2 facilitator ${operation} keeps dispatched body consumption owned during drain`, async () => {
      const entered = gate<void>();
      const body = gate<string>();
      let attempts = 0;
      const facilitator = client(async () => {
         attempts++;
         const response = json({});
         response.text = () => { entered.resolve(); return body.promise; };
         return response;
      });
      const running = operation === 'supported' ? facilitator.getSupported() : facilitator[operation](payload, requirements);
      await entered.promise;
      let drained = false;
      const drain = facilitator.drain().then(() => { drained = true; });
      await assert.rejects(facilitator.getSupported(), ShutdownInterrupted);
      assert.equal(drained, false);
      body.resolve(JSON.stringify(operation === 'supported' ? supported : operation === 'verify' ? { isValid: true } : settled));
      await running;
      await drain;
      assert.equal(attempts, 1);
   });
}

test('S2 429 returned after stop cannot schedule a capability retry or transport', async () => {
   const started = gate<void>();
   const response = gate<Response>();
   let attempts = 0;
   let timers = 0;
   const facilitator = new RoundWatchFacilitatorClient({
      fetch: async () => { attempts++; started.resolve(); return response.promise; },
      setTimer: () => { timers++; throw new Error('no retry timer may start'); },
   });
   const running = facilitator.getSupported();
   const rejected = assert.rejects(running, ShutdownInterrupted);
   await started.promise;
   facilitator.stopAdmission();
   response.resolve(json({ error: 'retry' }, 429));
   await rejected;
   await facilitator.drain();
   assert.equal(attempts, 1);
   assert.equal(timers, 0);
});

test('S2 shutdown cancels an admitted capability backoff and cannot begin its retry', async () => {
   const scheduled = gate<void>();
   let retry!: () => void;
   let attempts = 0;
   let clears = 0;
   const facilitator = new RoundWatchFacilitatorClient({
      fetch: async () => { attempts++; return json({}, 429); },
      setTimer: callback => { retry = callback; scheduled.resolve(); return 123 as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => { clears++; },
   });
   const running = facilitator.getSupported();
   const rejected = assert.rejects(running, ShutdownInterrupted);
   await scheduled.promise;
   facilitator.stopAdmission();
   retry(); // A queued timer callback delivered after clear cannot recreate work.
   await rejected;
   await facilitator.drain();
   assert.equal(attempts, 1);
   assert.equal(clears, 1);
});

test('S2 capability retries preserve installed 429 max-attempt and delay behavior', async () => {
   const delays: number[] = [];
   let attempts = 0;
   const facilitator = new RoundWatchFacilitatorClient({
      fetch: async () => { attempts++; return json({}, 429, { 'retry-after': attempts === 1 ? '120' : '0' }); },
      setTimer: (callback, delay) => { delays.push(delay); callback(); return 123 as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => {},
   });
   await assert.rejects(facilitator.getSupported(), /getSupported failed \(429\)/);
   await facilitator.drain();
   assert.equal(attempts, 3);
   assert.deepEqual(delays, [30_000, 2_000]);
});

test('S2 reentrant retry scheduling fence prevents actual second transport invocation', async () => {
   let attempts = 0;
   let cleared = 0;
   let facilitator!: RoundWatchFacilitatorClient;
   facilitator = new RoundWatchFacilitatorClient({
      fetch: async () => { attempts++; return json({}, 429); },
      setTimer: () => { facilitator.stopAdmission(); return 123 as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => { cleared++; },
   });
   await assert.rejects(facilitator.getSupported(), ShutdownInterrupted);
   await facilitator.drain();
   assert.equal(attempts, 1);
   assert.equal(cleared, 1);
});

test('S2 auth completion cannot start a transport after the facilitator fence', async () => {
   const entered = gate<void>();
   const auth = gate<{ supported: Record<string, string> }>();
   let attempts = 0;
   const facilitator = new RoundWatchFacilitatorClient({
      createAuthHeaders: () => { entered.resolve(); return auth.promise; },
      fetch: async () => { attempts++; return json(supported); },
   });
   const running = facilitator.getSupported();
   const rejected = assert.rejects(running, ShutdownInterrupted);
   await entered.promise;
   const drain = facilitator.drain();
   auth.resolve({ supported: {} });
   await rejected;
   await drain;
   assert.equal(attempts, 0);
});

test('S2 signal factory reentry cannot begin facilitator transport', async () => {
   let attempts = 0;
   let facilitator!: RoundWatchFacilitatorClient;
   facilitator = new RoundWatchFacilitatorClient({
      timeoutSignal: () => { facilitator.stopAdmission(); return new AbortController().signal; },
      fetch: async () => { attempts++; return json(supported); },
   });
   await assert.rejects(facilitator.getSupported(), ShutdownInterrupted);
   await facilitator.drain();
   assert.equal(attempts, 0);
});

test('S2 redirect returned after fence cannot start its second transport', async () => {
   const entered = gate<void>();
   const response = gate<Response>();
   let attempts = 0;
   const facilitator = client(async (_url, init) => {
      assert.equal(init?.redirect, 'manual');
      attempts++;
      entered.resolve();
      return response.promise;
   });
   const running = facilitator.getSupported();
   const rejected = assert.rejects(running, ShutdownInterrupted);
   await entered.promise;
   facilitator.stopAdmission();
   response.resolve(new Response('', { status: 307, headers: { location: '/next-supported' } }));
   await rejected;
   await facilitator.drain();
   assert.equal(attempts, 1);
});

test('S2 resource-server settlement_pending secondary attempt is fenced at actual transport', async () => {
   const started = gate<void>();
   const held = gate<Response>();
   const calls: string[] = [];
   const facilitator = client(async url => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path.endsWith('/supported')) return json(supported);
      started.resolve();
      return held.promise;
   });
   const resource = new x402ResourceServer(facilitator).register(ALGORAND_TESTNET, new ExactAvmScheme());
   await resource.initialize();
   const settling = resource.settlePayment(payload, requirements);
   const rejected = assert.rejects(settling, ShutdownInterrupted);
   await started.promise;
   facilitator.stopAdmission();
   held.resolve(json({ success: false, errorReason: 'settlement_pending', transaction: 'BROADCAST_TX', network: ALGORAND_TESTNET }));
   await rejected;
   await facilitator.drain();
   assert.deepEqual(calls, ['/facilitator/supported', '/facilitator/settle']);
});

test('S2 owned initialization cannot retry a 429 after application and facilitator stop', async () => {
   const store = new RoundWatchStore(':memory:');
   const started = gate<void>();
   const held = gate<Response>();
   const lifetime = new ApplicationLifetime();
   let attempts = 0;
   let timers = 0;
   const facilitator = new RoundWatchFacilitatorClient({
      fetch: async () => { attempts++; started.resolve(); return held.promise; },
      setTimer: () => { timers++; throw new Error('no retry timer'); },
   });
   try {
      const runtime = createAppRuntime({ avmAddress: requirements.payTo, store, indexer: {} as RoundWatchIndexer, facilitatorClient: facilitator });
      const initialization = lifetime.track(runtime.initializePayments);
      const rejected = assert.rejects(initialization, error => error instanceof Error && error.cause instanceof ShutdownInterrupted);
      await started.promise;
      lifetime.stopAdmission();
      facilitator.stopAdmission();
      held.resolve(json({}, 429));
      await rejected;
      await Promise.all([lifetime.drain(), facilitator.drain()]);
      assert.equal(attempts, 1);
      assert.equal(timers, 0);
   } finally { store.close(); }
});

test('S2 explicit payment initialization has no eager transport and is owned until completion', async () => {
   const store = new RoundWatchStore(':memory:');
   const started = gate<void>();
   const response = gate<Response>();
   let attempts = 0;
   const facilitator = client(async () => { attempts++; started.resolve(); return response.promise; });
   const lifetime = new ApplicationLifetime();
   try {
      const runtime = createAppRuntime({ avmAddress: requirements.payTo, store, indexer: {} as RoundWatchIndexer, facilitatorClient: facilitator });
      assert.equal(attempts, 0);
      const initialized = lifetime.track(runtime.initializePayments);
      await started.promise;
      assert.strictEqual(runtime.initializePayments(), runtime.initializePayments());
      let drained = false;
      const drain = lifetime.drain().then(() => { drained = true; });
      facilitator.stopAdmission();
      assert.equal(drained, false);
      response.resolve(json(supported));
      await initialized;
      await drain;
      await facilitator.drain();
      assert.equal(attempts, 1);
      const challenge = await runtime.app.request('/demo');
      assert.equal(challenge.status, 402);
      assert.equal(attempts, 1);
   } finally { store.close(); }
});

test('S2 explicit HTTP initialization preserves route capability validation and controlled rejection', async () => {
   const store = new RoundWatchStore(':memory:');
   let attempts = 0;
   const facilitator = client(async () => { attempts++; return json({ ...supported, kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:1' }] }); });
   try {
      const runtime = createAppRuntime({ avmAddress: requirements.payTo, store, indexer: {} as RoundWatchIndexer, facilitatorClient: facilitator });
      const initial = runtime.initializePayments();
      await assert.rejects(initial, /configuration/i);
      assert.strictEqual(runtime.initializePayments(), initial);
      await assert.rejects(runtime.initializePayments(), /configuration/i);
      await facilitator.drain();
      assert.equal(attempts, 1);
   } finally { store.close(); }
});

test('S2 HTTP facade preserves request body, path auth, BigInt conversion and Bazaar sidechannel', async () => {
   const calls: Array<{ url: string; init: RequestInit }> = [];
   const facilitator = new RoundWatchFacilitatorClient({
      url: 'https://offline.invalid/facilitator///',
      createAuthHeaders: async () => ({ verify: { authorization: 'offline-verify' }, settle: { authorization: 'offline-settle' } }),
      fetch: async (url, init) => {
         calls.push({ url: String(url), init: init! });
         return String(url).endsWith('/verify') ? json({ isValid: true, payer: null, discarded: true }) : json(settled, 200, {
            'EXTENSION-RESPONSES': Buffer.from(JSON.stringify({ bazaar: { status: 'accepted' } })).toString('base64'),
         });
      },
   });
   const bigintPayload = { ...payload, payload: { amount: 12n } };
   const verify = await facilitator.verify(bigintPayload, requirements);
   assert.equal(verify.payer, undefined);
   assert.equal('discarded' in verify, false);
   const settle = await facilitator.settle(payload, requirements);
   assert.deepEqual((settle as unknown as { extensionResponses: unknown }).extensionResponses, { bazaar: { status: 'accepted' } });
   assert.equal(calls[0]!.url, 'https://offline.invalid/facilitator/verify');
   assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), 'offline-verify');
   assert.equal(new Headers(calls[1]!.init.headers).get('authorization'), 'offline-settle');
   assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { x402Version: 2, paymentPayload: { ...payload, payload: { amount: '12' } }, paymentRequirements: requirements });
   await facilitator.drain();
});

test('S2 manual redirects preserve follow behavior and strip cross-origin credentials', async () => {
   const calls: Array<{ url: string; init: RequestInit }> = [];
   const facilitator = new RoundWatchFacilitatorClient({
      url: 'https://offline.invalid/facilitator',
      createAuthHeaders: async () => ({ settle: { authorization: 'offline-secret', cookie: 'offline-cookie' } }),
      fetch: async (url, init) => {
         calls.push({ url: String(url), init: init! });
         return calls.length === 1 ? new Response('', { status: 302, headers: { location: 'https://other.offline.invalid/result' } }) : json(settled);
      },
   });
   await facilitator.settle(payload, requirements);
   assert.equal(calls.length, 2);
   assert.equal(calls[0]!.init.method, 'POST');
   assert.equal(calls[1]!.init.method, 'GET');
   assert.equal(calls[1]!.init.body, undefined);
   const headers = new Headers(calls[1]!.init.headers);
   assert.equal(headers.get('authorization'), null);
   assert.equal(headers.get('cookie'), null);
   assert.equal(headers.get('content-type'), null);
   await facilitator.drain();
});

test('S2 malformed JSON and invalid timeout configuration preserve facilitator boundary failures', async () => {
   for (const timeoutMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => new RoundWatchFacilitatorClient({ timeoutMs }), RangeError);
   }
   const facilitator = client(async () => new Response('invalid-json'));
   await assert.rejects(facilitator.verify(payload, requirements), FacilitatorResponseError);
   await facilitator.drain();
});

test('S2 facade matches installed schema record __proto__ normalization and preserves nested unknowns', async () => {
   const record = JSON.parse('{"__proto__":{"discarded":true},"kept":1,"nested":{"__proto__":{"retained":true}}}') as Record<string, unknown>;
   const expected = JSON.parse('{"kept":1,"nested":{"__proto__":{"retained":true}}}') as Record<string, unknown>;
   const signers = JSON.parse('{"__proto__":["discarded"],"offline":["retained"]}') as Record<string, string[]>;
   const extensionHeader = Buffer.from(JSON.stringify(record)).toString('base64');
   const facilitator = client(async url => {
      if (String(url).endsWith('/supported')) {
         return json({ ...supported, kinds: supported.kinds.map(kind => ({ ...kind, extra: record })), signers });
      }
      return json({ ...(String(url).endsWith('/verify') ? { isValid: true } : settled), extra: record, extensions: record }, 200, {
         'EXTENSION-RESPONSES': extensionHeader,
      });
   });
   const verify = await facilitator.verify(payload, requirements);
   const settle = await facilitator.settle(payload, requirements);
   const capabilities = await facilitator.getSupported();
   for (const response of [verify, settle]) {
      for (const field of [response.extra, response.extensions]) {
         assert.deepEqual(field, expected);
         assert.equal(Object.hasOwn(field!, '__proto__'), false);
         assert.equal(Object.hasOwn(field!.nested as object, '__proto__'), true);
      }
      // The optional sidechannel is not parsed by a schema in the installed client.
      assert.deepEqual((response as unknown as { extensionResponses: unknown }).extensionResponses, record);
   }
   assert.deepEqual(capabilities.kinds[0]!.extra, expected);
   assert.equal(Object.hasOwn(capabilities.kinds[0]!.extra!, '__proto__'), false);
   assert.deepEqual(capabilities.signers, { offline: ['retained'] });
   await facilitator.drain();
});

for (const [operation, value] of [
   ['verify', { isValid: 'yes' }],
   ['settle', { ...settled, network: 1 }],
   ['supported', { ...supported, kinds: [{ x402Version: '2', scheme: 'exact', network: ALGORAND_TESTNET }] }],
   ['supported', { ...supported, signers: { [ALGORAND_TESTNET]: [1] } }],
] as const) {
   test(`S2 facade rejects malformed ${operation} response ${JSON.stringify(value)}`, async () => {
      const facilitator = client(async () => json(value));
      await assert.rejects(operation === 'supported' ? facilitator.getSupported() : facilitator[operation](payload, requirements), FacilitatorResponseError);
      await facilitator.drain();
   });
}

test('S2 facade retains public failed verification and settlement error classes', async () => {
   const facilitator = client(async url => String(url).endsWith('/verify') ? json({ isValid: false, invalidReason: 'invalid' }, 400) : json({ ...settled, success: false, errorReason: 'declined' }, 400));
   await assert.rejects(facilitator.verify(payload, requirements), error => error instanceof VerifyError && error.statusCode === 400 && error.invalidReason === 'invalid');
   await assert.rejects(facilitator.settle(payload, requirements), error => error instanceof SettleError && error.statusCode === 400 && error.errorReason === 'declined');
   await facilitator.drain();
});

test('S2 facade retains timeout classification without shutdown aborting dispatched requests', async () => {
   const controller = new AbortController();
   const started = gate<void>();
   const failure = gate<Response>();
   const facilitator = new RoundWatchFacilitatorClient({
      timeoutSignal: () => controller.signal,
      fetch: async (_url, init) => { assert.strictEqual(init?.signal, controller.signal); started.resolve(); return failure.promise; },
   });
   const pending = facilitator.settle(payload, requirements);
   const rejected = assert.rejects(pending, FacilitatorTimeoutError);
   await started.promise;
   facilitator.stopAdmission();
   assert.equal(controller.signal.aborted, false);
   controller.abort();
   failure.reject(new DOMException('offline timeout', 'TimeoutError'));
   await rejected;
   await facilitator.drain();
});

test('S2 facade one rejected method does not release another dispatched owner', async () => {
   const started = gate<void>();
   const held = gate<Response>();
   const facilitator = client(async url => {
      if (String(url).endsWith('/verify')) throw new Error('offline verify rejection');
      started.resolve();
      return held.promise;
   });
   const settling = facilitator.settle(payload, requirements);
   const failing = assert.rejects(facilitator.verify(payload, requirements), /offline verify rejection/);
   await started.promise;
   let drained = false;
   const drain = facilitator.drain().then(() => { drained = true; });
   await failing;
   assert.equal(drained, false);
   held.resolve(json(settled));
   await settling;
   await drain;
});
