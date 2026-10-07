import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { getTransactionId } from '@x402/avm';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload } from '@x402/core/types';

import {
   ALGORAND_TESTNET,
   createAppRuntime,
   ROUNDWATCH_SERVICE_ATOMIC_AMOUNT,
   TESTNET_USDC_ASSET_ID,
} from './app.js';
import { ApplicationLifetime, ownApplicationFetch } from './roundwatch-application-lifetime.js';
import { RoundWatchFacilitatorClient } from './roundwatch-facilitator.js';
import { AlgorandIndexerClient } from './roundwatch-indexer.js';
import type { PaidAdmissionReadinessCheck } from './roundwatch-paid-readiness.js';
import { IndexerRequestDispatcher } from './roundwatch-scheduler.js';
import { createShutdownCoordinator } from './roundwatch-shutdown-coordinator.js';
import { RoundWatchStore, type WatchRecord, type WatchSpec } from './roundwatch-store.js';

const PAYER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const WATCH_SENDER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBAKQ4C4';
const RECEIVER = 'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';
const SERVICE_RECEIVER = WATCH_SENDER;
// Synthetic, offline signed-payment fixture from the existing x402 regressions.
const SIGNED_SERVICE_PAYMENT =
   'gqNzaWfEQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACjdHhuiqRhYW10zgABhqCkYXJjdsQgCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCEKjZmVlAKJmdmSjZ2VurHRlc3RuZXQtdjEuMKJnaMQgSGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiKibHbMyKNzbmTEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApHR5cGWlYXhmZXKkeGFpZM4An5c9';
const SERVICE_TRANSACTION = getTransactionId(Buffer.from(SIGNED_SERVICE_PAYMENT, 'base64'));

function gate<T>() {
   let resolve!: (value: T | PromiseLike<T>) => void;
   const promise = new Promise<T>(res => { resolve = res; });
   return { promise, resolve };
}

function serviceTransferResponse(): Response {
   return Response.json({ transaction: {
      id: SERVICE_TRANSACTION,
      sender: PAYER,
      'tx-type': 'axfer',
      'confirmed-round': 150,
      'round-time': 1_800_000_000,
      'asset-transfer-transaction': {
         'asset-id': TESTNET_USDC_ASSET_ID,
         amount: Number(ROUNDWATCH_SERVICE_ATOMIC_AMOUNT),
         receiver: SERVICE_RECEIVER,
      },
   } });
}

function createFixture(t: TestContext, idempotencyKey: string, hold: 'settlement' | 'activation') {
   const store = new RoundWatchStore(':memory:');
   const lifetime = new ApplicationLifetime();
   const settlementEntered = gate<void>();
   const releaseSettlement = gate<void>();
   const activationEntered = gate<void>();
   const releaseActivation = gate<Response>();
   const serverClosed = gate<void>();
   const events: string[] = [];
   const providerCalls = { supported: 0, verify: 0, settle: 0, indexer: 0 };
   let closed = false;
   let closedWatch: WatchRecord | undefined;
   let closeCalls = 0;
   let serverCloseCalls = 0;
   let deadlineClears = 0;
   const terminateCalls: number[] = [];
   const facilitator = new RoundWatchFacilitatorClient({
      url: 'https://facilitator.example.test',
      timeoutSignal: () => new AbortController().signal,
      fetch: async input => {
         const path = new URL(String(input)).pathname;
         if (path === '/supported') {
            providerCalls.supported += 1;
            return Response.json({
               kinds: [{ x402Version: 2, scheme: 'exact', network: ALGORAND_TESTNET }],
               extensions: [], signers: {},
            });
         }
         if (path === '/verify') {
            providerCalls.verify += 1;
            return Response.json({ isValid: true, payer: PAYER });
         }
         assert.equal(path, '/settle');
         providerCalls.settle += 1;
         assert.equal(store.getByIdempotencyKey(idempotencyKey)?.state, 'settlement_pending');
         events.push('settlement-dispatched');
         settlementEntered.resolve();
         if (hold === 'settlement') await releaseSettlement.promise;
         return Response.json({
            success: true, payer: PAYER, transaction: SERVICE_TRANSACTION, network: ALGORAND_TESTNET,
         });
      },
   });
   const dispatcher = new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 1 });
   const indexer = new AlgorandIndexerClient('https://indexer.example.test', dispatcher, async input => {
      providerCalls.indexer += 1;
      assert.equal(new URL(String(input)).pathname, `/v2/transactions/${SERVICE_TRANSACTION}`);
      events.push('activation-dispatched');
      activationEntered.resolve();
      return releaseActivation.promise;
   });
   const recordCandidate = store.recordSettlementCandidate.bind(store);
   t.mock.method(store, 'recordSettlementCandidate', (...args: Parameters<typeof recordCandidate>) => {
      assert.equal(closed, false, 'settlement persistence must precede SQLite closure');
      events.push('settlement-persisted');
      return recordCandidate(...args);
   });
   const activateWatch = store.activateWatch.bind(store);
   t.mock.method(store, 'activateWatch', (...args: Parameters<typeof activateWatch>) => {
      assert.equal(closed, false, 'activation persistence must precede SQLite closure');
      events.push('activation-persisted');
      return activateWatch(...args);
   });
   const runtime = createAppRuntime({
      avmAddress: SERVICE_RECEIVER, facilitatorClient: facilitator,
      store, indexer, requireSettlementIntent: true,
   });
   const fetch = ownApplicationFetch(lifetime, runtime.app.fetch);
   const idleWorker = () => ({ stopScheduling() {}, drain: async () => {} });
   const coordinator = createShutdownCoordinator({
      application: lifetime,
      facilitator,
      poller: idleWorker(), reconciler: idleWorker(), healthProbe: idleWorker(), dispatcher,
      runtimeSampler: { stop() { events.push('sampler-stopped'); } },
      closeServer: () => {
         serverCloseCalls += 1;
         events.push('socket-closed');
         serverClosed.resolve();
         return serverClosed.promise;
      },
      closeStore: () => {
         closeCalls += 1;
         closedWatch = store.getByIdempotencyKey(idempotencyKey);
         events.push('store-closed');
         store.close();
         closed = true;
      },
      timers: {
         setTimeout: () => 'injected-deadline',
         clearTimeout: () => { deadlineClears += 1; },
      },
      terminate: code => { terminateCalls.push(code); },
      report() {},
   });
   const spec: WatchSpec = {
      idempotencyKey, expectedSender: WATCH_SENDER, expectedReceiver: RECEIVER,
      assetId: TESTNET_USDC_ASSET_ID, atomicAmount: '2500000', invoiceNote: 'invoice:s2',
   };
   return {
      store, lifetime, facilitator, dispatcher, runtime, fetch, coordinator, spec,
      settlementEntered, releaseSettlement, activationEntered, releaseActivation, serverClosed,
      providerCalls, events, terminateCalls,
      snapshot: () => ({ closed, closedWatch, closeCalls, serverCloseCalls, deadlineClears }),
   };
}

async function paidRequest(
   fixture: ReturnType<typeof createFixture>,
   signal: AbortSignal,
): Promise<Request> {
   await fixture.lifetime.track(() => fixture.runtime.initializePayments());
   const body = JSON.stringify({
      idempotencyKey: fixture.spec.idempotencyKey,
      expectedSender: fixture.spec.expectedSender, expectedReceiver: fixture.spec.expectedReceiver,
      atomicAmount: fixture.spec.atomicAmount, invoiceNote: fixture.spec.invoiceNote,
   });
   const unpaid = await fixture.fetch(new Request('http://roundwatch.example.test/spike/watch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
   }));
   assert.equal(unpaid.status, 402);
   const paymentRequired = unpaid.headers.get('payment-required');
   assert.ok(paymentRequired);
   const payload: PaymentPayload = {
      x402Version: 2,
      accepted: decodePaymentRequiredHeader(paymentRequired).accepts[0]!,
      payload: { paymentGroup: [SIGNED_SERVICE_PAYMENT], paymentIndex: 0 },
   };
   return new Request('http://roundwatch.example.test/spike/watch', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'payment-signature': encodePaymentSignatureHeader(payload) },
      body,
   });
}

for (const disconnect of [false, true]) {
   test(`S2 HTTP held settlement survives ${disconnect ? 'request disconnect' : 'server close'} and persists before SQLite closes`, async t => {
      const fixture = createFixture(t, `shutdown-held-settlement-${disconnect}`, 'settlement');
      const abort = new AbortController();
      let requestPromise: Promise<Response> | undefined;
      let requestFinished = false;
      try {
         const request = await paidRequest(fixture, abort.signal);
         requestPromise = Promise.resolve(fixture.fetch(request));
         void requestPromise.then(
            () => { requestFinished = true; },
            () => { requestFinished = true; },
         );
         await fixture.settlementEntered.promise;
         if (disconnect) abort.abort(new Error('synthetic socket disconnect'));
         const shutdown = fixture.coordinator.shutdown('SIGTERM');
         assert.equal(fixture.coordinator.shutdown('SIGINT'), shutdown);
         await fixture.serverClosed.promise;
         assert.equal(request.signal.aborted, disconnect);
         assert.equal(requestFinished, false, 'socket close/abort must not settle application ownership');
         assert.equal(fixture.snapshot().closed, false);
         assert.equal(fixture.store.getByIdempotencyKey(fixture.spec.idempotencyKey)?.state, 'settlement_pending');
         assert.equal(fixture.providerCalls.indexer, 0);
         let applicationDrained = false;
         void fixture.lifetime.drain().then(() => { applicationDrained = true; });
         await Promise.resolve();
         assert.equal(applicationDrained, false);
         assert.equal(fixture.snapshot().closeCalls, 0);

         fixture.releaseSettlement.resolve();
         const response = await requestPromise;
         assert.equal(response.status, 500, 'fenced activation must retain the paid obligation for reconciliation');
         assert.equal((await shutdown).status, 'drained');
         const final = fixture.snapshot();
         assert.equal(final.closeCalls, 1);
         assert.equal(final.serverCloseCalls, 1);
         assert.equal(final.deadlineClears, 1);
         assert.equal(final.closedWatch?.state, 'settlement_pending');
         assert.equal(final.closedWatch?.expectedServiceTransaction, SERVICE_TRANSACTION);
         assert.equal(final.closedWatch?.expectedServicePayer, PAYER);
         assert.equal(final.closedWatch?.activationRound, undefined);
         assert.equal(final.closedWatch?.workUnitsUsed, 0, 'shutdown must not refund or add work claims');
         assert.deepEqual(fixture.providerCalls, { supported: 1, verify: 1, settle: 1, indexer: 0 });
         assert.ok(fixture.events.indexOf('settlement-persisted') < fixture.events.indexOf('store-closed'));
         assert.deepEqual(fixture.terminateCalls, []);
      } finally {
         fixture.releaseSettlement.resolve();
         fixture.releaseActivation.resolve(serviceTransferResponse());
         await Promise.allSettled(requestPromise ? [requestPromise] : []);
         await fixture.coordinator.shutdown('test cleanup');
      }
   });

   test(`S2 HTTP dispatched activation survives ${disconnect ? 'request disconnect' : 'server close'} and writes before SQLite closes`, async t => {
      const fixture = createFixture(t, `shutdown-held-activation-${disconnect}`, 'activation');
      const abort = new AbortController();
      let requestPromise: Promise<Response> | undefined;
      let requestFinished = false;
      try {
         const request = await paidRequest(fixture, abort.signal);
         requestPromise = Promise.resolve(fixture.fetch(request));
         void requestPromise.then(
            () => { requestFinished = true; },
            () => { requestFinished = true; },
         );
         await fixture.activationEntered.promise;
         const persisted = fixture.store.getByIdempotencyKey(fixture.spec.idempotencyKey)!;
         assert.equal(persisted.expectedServiceTransaction, SERVICE_TRANSACTION);
         assert.equal(persisted.state, 'settlement_pending');
         if (disconnect) abort.abort(new Error('synthetic socket disconnect'));
         const shutdown = fixture.coordinator.shutdown('SIGINT');
         await fixture.serverClosed.promise;
         assert.equal(request.signal.aborted, disconnect);
         assert.equal(requestFinished, false);
         assert.equal(fixture.snapshot().closed, false);
         assert.equal(fixture.dispatcher.snapshot().inFlight, 1);
         let applicationDrained = false;
         void fixture.lifetime.drain().then(() => { applicationDrained = true; });
         await Promise.resolve();
         assert.equal(applicationDrained, false);

         fixture.releaseActivation.resolve(serviceTransferResponse());
         assert.equal((await requestPromise).status, 200);
         assert.equal((await shutdown).status, 'drained');
         const final = fixture.snapshot();
         assert.equal(final.closeCalls, 1);
         assert.equal(final.closedWatch?.state, 'active');
         assert.equal(final.closedWatch?.activationRound, 150);
         assert.equal(final.closedWatch?.scanAfterRound, 150);
         assert.equal(final.closedWatch?.serviceTransaction, SERVICE_TRANSACTION);
         assert.equal(fixture.dispatcher.snapshot().inFlight, 0);
         assert.deepEqual(fixture.providerCalls, { supported: 1, verify: 1, settle: 1, indexer: 1 });
         assert.ok(fixture.events.indexOf('activation-persisted') < fixture.events.indexOf('store-closed'));
         assert.equal(final.deadlineClears, 1);
         assert.deepEqual(fixture.terminateCalls, []);
      } finally {
         fixture.releaseSettlement.resolve();
         fixture.releaseActivation.resolve(serviceTransferResponse());
         await Promise.allSettled(requestPromise ? [requestPromise] : []);
         await fixture.coordinator.shutdown('test cleanup');
      }
   });
}

test('S2 HTTP terminal outer admission bypasses readiness, paid admission, facilitator, Indexer, MCP and recovery store access', async t => {
   const store = new RoundWatchStore(':memory:');
   const lifetime = new ApplicationLifetime();
   const calls = { hono: 0, storageReadiness: 0, readiness: 0, paidReadiness: 0, storeLookup: 0, provider: 0 };
   const facilitator = new RoundWatchFacilitatorClient({
      url: 'https://facilitator.example.test',
      fetch: async () => { calls.provider += 1; throw new Error('facilitator must not be reached'); },
   });
   const dispatcher = new IndexerRequestDispatcher();
   const indexer = new AlgorandIndexerClient('https://indexer.example.test', dispatcher, async () => {
      calls.provider += 1;
      throw new Error('Indexer must not be reached');
   });
   const paidReadiness = Object.assign(async () => {
      calls.paidReadiness += 1;
      return { ready: true, checks: { storage: true } };
   }, {
      validateCurrent: () => { calls.paidReadiness += 1; return { ready: true, checks: { storage: true } }; },
   }) satisfies PaidAdmissionReadinessCheck;
   const runtime = createAppRuntime({
      avmAddress: SERVICE_RECEIVER, facilitatorClient: facilitator, store, indexer,
      readinessCheck: () => { calls.readiness += 1; return { ready: true, checks: { storage: true } }; },
      paidAdmissionReadinessCheck: paidReadiness,
   });
   t.mock.method(store, 'readinessCheck', () => { calls.storageReadiness += 1; return true; });
   for (const method of ['getWatch', 'getByIdempotencyKey', 'getByPayerAndIdempotencyKey'] as const) {
      t.mock.method(store, method, () => { calls.storeLookup += 1; throw new Error('store must not be reached'); });
   }
   const fetch = ownApplicationFetch(lifetime, (...args: Parameters<typeof runtime.app.fetch>) => {
      calls.hono += 1;
      return runtime.app.fetch(...args);
   });
   try {
      lifetime.stopAdmission();
      lifetime.stopAdmission();
      const routes = [
         ['GET', '/ready'], ['GET', '/health'], ['GET', '/demo'],
         ['POST', '/spike/watch'], ['POST', '/spike/watch/recover'],
         ['GET', '/spike/watch/unknown'], ['POST', '/mcp'], ['GET', '/'],
      ] as const;
      for (const [method, path] of routes) {
         const response = await fetch(new Request(`http://roundwatch.example.test${path}`, {
            method,
            ...(method === 'POST' ? {
               headers: { 'content-type': 'application/json', 'payment-signature': 'synthetic-signed-header' },
               body: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}',
            } : {}),
         }));
         assert.equal(response.status, 503, `${method} ${path}`);
         assert.equal(response.headers.get('cache-control'), 'no-store');
         assert.ok((await response.text()).length < 1_024, 'shutdown response must be bounded');
      }
      assert.deepEqual(calls, {
         hono: 0, storageReadiness: 0, readiness: 0, paidReadiness: 0, storeLookup: 0, provider: 0,
      });
      assert.deepEqual(dispatcher.snapshot().requests, {});
      await lifetime.drain();
   } finally {
      await Promise.allSettled([lifetime.drain(), facilitator.drain(), dispatcher.drain()]);
      store.close();
   }
});
