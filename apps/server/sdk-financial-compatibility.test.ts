import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
   ALGORAND_MAINNET_GENESIS_HASH, ALGORAND_TESTNET_GENESIS_HASH,
   decodeSignedTransaction, getTransactionId,
} from '@x402/avm';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { PaymentRequiredSchema } from '@x402/core/schemas';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';

import { LEGACY_ALGORAND_MAINNET, LEGACY_ALGORAND_TESTNET } from '../algorand-networks.js';
import { createAppRuntime, ROUNDWATCH_SERVICE_ATOMIC_AMOUNT } from './app.js';
import {
   MAINNET_NETWORK_CONFIG, TESTNET_NETWORK_CONFIG, type RoundWatchNetworkConfig,
} from './network-config.js';
import { RoundWatchFacilitatorClient } from './roundwatch-facilitator.js';
import type { RoundWatchIndexer } from './roundwatch-indexer.js';
import { SettlementReconciler } from './roundwatch-reconciler.js';
import { RoundWatchStore } from './roundwatch-store.js';

const PAYER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const WATCH_SENDER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBAKQ4C4';
const SERVICE_RECEIVER = WATCH_SENDER;
const INVOICE_RECEIVER = 'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';
// Existing zero-signature fixture from roundwatch.test.ts. These are not valid
// signed transactions and must only reach injected mock HTTP transports.
const TESTNET_PAYMENT =
   'gqNzaWfEQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACjdHhuiqRhYW10zgABhqCkYXJjdsQgCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCEKjZmVlAKJmdmSjZ2VurHRlc3RuZXQtdjEuMKJnaMQgSGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiKibHbMyKNzbmTEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApHR5cGWlYXhmZXKkeGFpZM4An5c9';
// Same fixture, re-encoded offline with only genesis ID/hash and ASA changed.
// The signature remains 64 zero bytes; no key/signing API created this fixture.
const MAINNET_PAYMENT =
   'gqNzaWfEQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACjdHhuiqRhYW10zgABhqCkYXJjdsQgCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCEKjZmVlAKJmdmSjZ2VurG1haW5uZXQtdjEuMKJnaMQgwGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit+ibHbMyKNzbmTEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApHR5cGWlYXhmZXKkeGFpZM4B4atw';

type Fault = 'none' | 'network' | 'transaction' | 'activation-lookup';

function fixture(t: TestContext, config: RoundWatchNetworkConfig, fault: Fault = 'none') {
   let forbiddenOutbound = 0;
   t.mock.method(globalThis, 'fetch', async () => {
      forbiddenOutbound++;
      throw new Error('Real fetch forbidden in offline SDK financial qualification');
   });
   t.mock.method(net.Socket.prototype, 'connect', () => {
      forbiddenOutbound++;
      throw new Error('Real socket forbidden in offline SDK financial qualification');
   });
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-sdk-financial-'));
   assert.equal(join(directory, '..'), tmpdir());
   const databasePath = join(directory, 'watch.sqlite');
   let store = new RoundWatchStore(databasePath);
   const path = config.name === 'mainnet' ? '/v1/watch' : '/spike/watch';
   const legacy = config.name === 'mainnet' ? LEGACY_ALGORAND_MAINNET : LEGACY_ALGORAND_TESTNET;
   const payment = config.name === 'mainnet' ? MAINNET_PAYMENT : TESTNET_PAYMENT;
   const decoded = decodeSignedTransaction(payment);
   assert.deepEqual(decoded.sig, new Uint8Array(64), 'Fixture contains no cryptographic signature');
   assert.equal(decoded.txn.sender.toString(), PAYER);
   assert.equal(decoded.txn.assetTransfer?.receiver.toString(), SERVICE_RECEIVER);
   assert.equal(String(decoded.txn.assetTransfer?.assetId), config.usdcAssetId);
   assert.equal(String(decoded.txn.assetTransfer?.amount), ROUNDWATCH_SERVICE_ATOMIC_AMOUNT);
   assert.equal(Buffer.from(decoded.txn.genesisHash!).toString('base64'),
      config.name === 'mainnet' ? ALGORAND_MAINNET_GENESIS_HASH : ALGORAND_TESTNET_GENESIS_HASH);
   const transaction = getTransactionId(Buffer.from(payment, 'base64'));
   const idempotencyKey = `sdk-financial-${config.name}-${fault}`;
   const body = JSON.stringify({
      idempotencyKey, expectedSender: WATCH_SENDER, expectedReceiver: INVOICE_RECEIVER,
      atomicAmount: '2500000', invoiceNote: `invoice:${idempotencyKey}`,
   });
   const calls = { supported: 0, verify: 0, settle: 0, lookup: 0 };
   const wire: Array<{ operation: string; payload: PaymentPayload; requirements: PaymentRequirements }> = [];
   let declaredExtensions: Record<string, unknown> | undefined;
   const facilitator = new RoundWatchFacilitatorClient({
      url: 'https://facilitator.offline.invalid',
      fetch: async (input, init) => {
         const url = new URL(String(input));
         assert.equal(url.origin, 'https://facilitator.offline.invalid');
         assert.equal(init?.redirect, 'manual');
         if (url.pathname === '/supported') {
            calls.supported++;
            assert.equal(init?.method, 'GET');
            return Response.json({
               kinds: [config.network, legacy].map(network => ({ x402Version: 2, scheme: 'exact', network })),
               extensions: ['bazaar'], signers: {},
            });
         }
         assert.equal(init?.method, 'POST');
         const data = JSON.parse(String(init?.body)) as {
            x402Version: number; paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements;
         };
         assert.equal(data.x402Version, 2);
         assert.equal(data.paymentRequirements.network, config.network);
         assert.equal(data.paymentRequirements.asset, config.usdcAssetId);
         assert.equal(data.paymentRequirements.amount, ROUNDWATCH_SERVICE_ATOMIC_AMOUNT);
         assert.equal(data.paymentRequirements.payTo, SERVICE_RECEIVER);
         assert.equal(data.paymentPayload.accepted.network, config.network);
         assert.deepEqual(data.paymentPayload.payload, { paymentGroup: [payment], paymentIndex: 0 });
         assert.ok(declaredExtensions?.bazaar);
         assert.deepEqual(data.paymentPayload.extensions, declaredExtensions,
            'Official client Bazaar declaration must reach facilitator HTTP unchanged');
         wire.push({ operation: url.pathname, payload: data.paymentPayload, requirements: data.paymentRequirements });
         if (url.pathname === '/verify') {
            calls.verify++;
            return Response.json({ isValid: true, payer: PAYER });
         }
         assert.equal(url.pathname, '/settle');
         calls.settle++;
         const prepared = store.getByPayerAndIdempotencyKey(PAYER, idempotencyKey);
         assert.equal(prepared?.state, 'settlement_pending', 'Durable intent precedes SDK settlement');
         assert.equal(prepared.expectedServiceNetwork, config.network);
         assert.equal(prepared.expectedServiceTransaction, transaction);
         return Response.json({
            success: true, payer: PAYER,
            transaction: fault === 'transaction' ? '7'.repeat(51) + 'A' : transaction,
            network: fault === 'network'
               ? (config.name === 'mainnet' ? LEGACY_ALGORAND_TESTNET : LEGACY_ALGORAND_MAINNET)
               : legacy,
         }, {
            headers: { 'EXTENSION-RESPONSES': Buffer.from(JSON.stringify({ bazaar: { status: 'accepted' } })).toString('base64') },
         });
      },
   });
   let activationFailed = false;
   const indexer: RoundWatchIndexer = {
      getCurrentRound: async () => 201,
      lookupAssetTransfer: async requested => {
         calls.lookup++;
         assert.equal(requested, transaction);
         if (fault === 'activation-lookup' && !activationFailed) {
            activationFailed = true;
            throw new Error('Injected offline activation lookup failure');
         }
         return {
            transaction, sender: PAYER, receiver: SERVICE_RECEIVER,
            assetId: config.usdcAssetIdNumber, atomicAmount: ROUNDWATCH_SERVICE_ATOMIC_AMOUNT, round: 150,
         };
      },
      getBlock: async round => ({ round, timestamp: 1_800_000_000 }),
      searchWatchPage: async () => ({ transactions: [], currentRound: 201 }),
      searchTransactionPage: async () => ({ transactions: [], currentRound: 201 }),
   };
   const runtime = createAppRuntime({
      avmAddress: SERVICE_RECEIVER, publicBaseUrl: 'https://roundwatch.offline.invalid',
      networkConfig: config, facilitatorClient: facilitator, store, indexer,
      requireSettlementIntent: true,
   });
   t.after(async () => {
      await facilitator.drain();
      store.close();
      rmSync(directory, { recursive: true, force: true });
      assert.equal(forbiddenOutbound, 0);
   });
   return {
      runtime, calls, wire, transaction, config, legacy, path, idempotencyKey, indexer,
      get store() { return store; },
      reopen() { store.close(); store = new RoundWatchStore(databasePath); return store; },
      async request() {
         await runtime.initializePayments();
         const unpaid = await runtime.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
         assert.equal(unpaid.status, 402);
         const header = unpaid.headers.get('payment-required');
         assert.ok(header);
         const offer = decodePaymentRequiredHeader(header);
         PaymentRequiredSchema.parse(offer);
         assert.equal(offer.accepts.length, 1);
         assert.equal(offer.accepts[0]!.network, config.network);
         assert.equal(offer.accepts[0]!.amount, ROUNDWATCH_SERVICE_ATOMIC_AMOUNT);
         assert.ok(offer.extensions?.bazaar, 'Official Bazaar declaration remains in canonical challenge');
         assert.deepEqual(calls, { supported: 1, verify: 0, settle: 0, lookup: 0 });
         declaredExtensions = offer.extensions;
         let mockCreations = 0;
         const client = new x402Client().register(config.network, {
            scheme: 'exact',
            findDefaultAsset: asset => ({ asset, decimals: 6, symbol: 'USDC' }),
            createPaymentPayload: async (version, selected, context) => {
               mockCreations++;
               assert.equal(version, 2);
               assert.deepEqual(selected, offer.accepts[0]);
               assert.deepEqual(context?.extensions, declaredExtensions);
               assert.equal(context?.maxAmountPerPayment, ROUNDWATCH_SERVICE_ATOMIC_AMOUNT);
               // Only the scheme payload is mocked. The real SDK selects the
               // requirement and copies resource/extension declarations.
               return { x402Version: version, payload: { paymentGroup: [payment], paymentIndex: 0 } };
            },
         }).setSpendControls({ maxAmountPerPayment: '$0.10' });
         const payload = await client.createPaymentPayload(offer);
         assert.equal(mockCreations, 1);
         assert.deepEqual(payload.accepted, offer.accepts[0]);
         assert.deepEqual(payload.resource, offer.resource);
         assert.deepEqual(payload.extensions, offer.extensions,
            'Real SDK client must echo the official Bazaar challenge declaration');
         const init = {
            method: 'POST', body,
            headers: { 'content-type': 'application/json', 'payment-signature': encodePaymentSignatureHeader(payload) },
         };
         return { initial: await runtime.app.request(path, init), replay: () => runtime.app.request(path, init) };
      },
   };
}

for (const config of [MAINNET_NETWORK_CONFIG, TESTNET_NETWORK_CONFIG]) {
   test(`SDK 2.29 ${config.name}: canonical challenge and legacy settlement activate durably exactly once`, async t => {
      const f = fixture(t, config);
      const { initial, replay } = await f.request();
      assert.equal(initial.status, 200);
      const watch = f.store.getByPayerAndIdempotencyKey(PAYER, f.idempotencyKey)!;
      assert.equal(watch.state, 'active');
      assert.equal(watch.expectedServiceNetwork, config.network);
      assert.equal(watch.serviceNetwork, f.legacy);
      assert.equal(watch.expectedServiceTransaction, f.transaction);
      assert.equal(watch.serviceTransaction, f.transaction);
      assert.equal(watch.activationRound, 150);
      assert.equal(watch.scanAfterRound, 150);
      assert.equal(watch.serviceAssetId, config.usdcAssetIdNumber);
      assert.equal(watch.serviceAtomicAmount, ROUNDWATCH_SERVICE_ATOMIC_AMOUNT);
      assert.equal((await replay()).status, 409);
      assert.equal(f.calls.settle, 1);
      assert.deepEqual(f.wire.slice(0, 2).map(entry => entry.operation), ['/verify', '/settle']);
      assert.ok(f.wire.slice(2).every(entry => entry.operation === '/verify'));
      assert.deepEqual(f.reopen().getWatch(watch.id), watch);
   });

   for (const fault of ['network', 'transaction'] as const) {
      test(`SDK 2.29 ${config.name}: wrong settlement ${fault} fails closed and replay never settles again`, async t => {
         const f = fixture(t, config, fault);
         const { initial, replay } = await f.request();
         assert.ok(initial.status >= 400, `Rejected settlement returned HTTP ${initial.status}`);
         const watch = f.store.getByPayerAndIdempotencyKey(PAYER, f.idempotencyKey)!;
         assert.notEqual(watch.state, 'active');
         assert.equal(watch.expectedServiceNetwork, config.network);
         assert.equal(watch.expectedServiceTransaction, f.transaction);
         assert.equal(watch.serviceTransaction, undefined);
         assert.equal(watch.activationRound, undefined);
         assert.equal(f.calls.lookup, 0, 'Untrusted settlement evidence cannot reach activation lookup');
         assert.equal((await replay()).status, 409);
         assert.equal(f.calls.settle, 1);
         assert.deepEqual(f.store.getWatch(watch.id), watch);
      });
   }

   test(`SDK 2.29 ${config.name}: failed post-settlement lookup recovers after restart without another settlement`, async t => {
      const f = fixture(t, config, 'activation-lookup');
      const { initial, replay } = await f.request();
      assert.equal(initial.status, 500);
      const pending = f.store.getByPayerAndIdempotencyKey(PAYER, f.idempotencyKey)!;
      assert.equal(pending.state, 'settlement_pending');
      assert.equal(pending.expectedServiceTransaction, f.transaction);
      assert.equal(pending.expectedServiceNetwork, config.network);
      assert.equal(pending.serviceTransaction, undefined);
      assert.equal((await replay()).status, 409);
      const restarted = f.reopen();
      assert.deepEqual(restarted.getWatch(pending.id), pending);
      await new SettlementReconciler(restarted, f.indexer, {
         network: config.network, intervalMilliseconds: 5_000,
      }).reconcileOnce();
      const active = restarted.getWatch(pending.id)!;
      assert.equal(active.state, 'active');
      assert.equal(active.serviceTransaction, f.transaction);
      assert.equal(active.serviceNetwork, config.network);
      assert.equal(active.activationRound, 150);
      assert.equal(f.calls.settle, 1);
   });
}
