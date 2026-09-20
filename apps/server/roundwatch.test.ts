import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { FacilitatorClient } from '@x402/core/server';
import type {
   PaymentPayload,
   PaymentRequirements,
   SettleResponse,
   SupportedResponse,
   VerifyResponse,
} from '@x402/core/types';
import {
   decodePaymentRequiredHeader,
   encodePaymentSignatureHeader,
} from '@x402/core/http';
import { getTransactionId, isValidAlgorandAddress } from '@x402/avm';

import { ALGORAND_TESTNET, createApp, ROUNDWATCH_SERVICE_ATOMIC_AMOUNT, TESTNET_USDC_ASSET_ID } from './app.js';
import {
   MAINNET_NETWORK_CONFIG,
   resolveRoundWatchNetwork,
   resolveRoundWatchPublicBaseUrl,
} from './network-config.js';
import {
   AlgorandIndexerClient,
   matchesWatch,
   resolveScanQueryVariant,
   type IndexedBlock,
   type IndexedWatchTransaction,
   type RoundWatchIndexer,
   type ScanQueryVariant,
   type TransactionIdPage,
   type TransactionPage,
} from './roundwatch-indexer.js';
import { RoundWatchPoller } from './roundwatch-poller.js';
import { SettlementReconciler } from './roundwatch-reconciler.js';
import { IndexerRequestDispatcher } from './roundwatch-scheduler.js';
import {
   RoundWatchStore,
   WatchCapacityError,
   type SettlementIntent,
   type WatchRecord,
   type WatchSpec,
} from './roundwatch-store.js';

const PAYER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const RECEIVER = 'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';
const SPEC: WatchSpec = {
   idempotencyKey: 'invoice-0001', expectedSender: PAYER, expectedReceiver: RECEIVER,
   assetId: TESTNET_USDC_ASSET_ID, atomicAmount: '2500000', invoiceNote: 'invoice:1',
};
const intent = (tx = 'SERVICE_TX'): SettlementIntent => ({
   expectedTransaction: tx, network: ALGORAND_TESTNET, payer: PAYER,
   receiver: RECEIVER, assetId: TESTNET_USDC_ASSET_ID, atomicAmount: '1000',
   firstValid: 90, lastValid: 190,
});

const SERVICE_RECEIVER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBAKQ4C4';
const SIGNED_SERVICE_PAYMENT =
   'gqNzaWfEQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACjdHhuiqRhYW10zQPopGFyY3bEIAhCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCo2ZlZQCiZnZko2dlbqx0ZXN0bmV0LXYxLjCiZ2jEIEhjtRiks8hOyBDyLU8QgcsPcfBZp6wg3sYvf3DlCToiomx2zMijc25kxCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKR0eXBlpWF4ZmVypHhhaWTOAJ+XPQ==';
const SIGNED_SERVICE_TX_ID = getTransactionId(
   Buffer.from(SIGNED_SERVICE_PAYMENT, 'base64'),
);

test('TestNet remains the default and the x402 requirement preserves network, asset, amount, and receiver', async () => {
   assert.equal(resolveRoundWatchNetwork(undefined).name, 'testnet');
   assert.equal(resolveRoundWatchNetwork('mainnet'), MAINNET_NETWORK_CONFIG);
   const store = new RoundWatchStore(':memory:');
   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [{ x402Version: 2, scheme: 'exact', network: ALGORAND_TESTNET }],
               extensions: [], signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
      });
      const response = await app.request('/spike/watch', {
         method: 'POST', headers: { 'content-type': 'application/json' },
         body: JSON.stringify({ idempotencyKey: SPEC.idempotencyKey, expectedSender: PAYER,
            expectedReceiver: RECEIVER, atomicAmount: SPEC.atomicAmount, invoiceNote: SPEC.invoiceNote }),
      });
      assert.equal(response.status, 402);
      const encoded = response.headers.get('payment-required'); assert.ok(encoded);
      const required = decodePaymentRequiredHeader(encoded).accepts[0]!;
      assert.equal(required.network, ALGORAND_TESTNET);
      assert.equal(required.payTo, RECEIVER);
      assert.equal(required.amount, ROUNDWATCH_SERVICE_ATOMIC_AMOUNT);
      assert.equal(required.extra?.asset, String(TESTNET_USDC_ASSET_ID));
      assert.equal(store.getByIdempotencyKey(SPEC.idempotencyKey), undefined);
   } finally { store.close(); }
});

test('Bazaar discovery watch example uses checksum-valid Algorand addresses', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [{ x402Version: 2, scheme: 'exact', network: ALGORAND_TESTNET }],
               extensions: [], signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
      });
      const response = await app.request('/spike/watch', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
            idempotencyKey: 'bazaar-address-smoke',
            expectedSender: PAYER,
            expectedReceiver: RECEIVER,
            atomicAmount: '1',
         }),
      });
      assert.equal(response.status, 402);

      const encoded = response.headers.get('payment-required');
      assert.ok(encoded);
      const decoded = decodePaymentRequiredHeader(encoded) as unknown as {
         extensions?: {
            bazaar?: {
               info?: {
                  input?: {
                     body?: {
                        expectedSender?: unknown;
                        expectedReceiver?: unknown;
                     };
                  };
               };
            };
         };
      };
      const example = decoded.extensions?.bazaar?.info?.input?.body;
      assert.ok(example);
      const expectedSender = example.expectedSender;
      const expectedReceiver = example.expectedReceiver;
      if (typeof expectedSender !== 'string' || typeof expectedReceiver !== 'string') {
         assert.fail('Bazaar watch example must contain string Algorand addresses');
      }
      assert.equal(isValidAlgorandAddress(expectedSender), true);
      assert.equal(isValidAlgorandAddress(expectedReceiver), true);
      assert.equal(expectedSender, PAYER);
      assert.equal(expectedReceiver, RECEIVER);
   } finally {
      store.close();
   }
});

test('paid x402 middleware persists signed purchase terms and activates from the exact service round', async () => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new MiddlewareIndexer();
   const facilitator = new MiddlewareFacilitator(store, 'middleware-paid');
   const app = createApp({
      avmAddress: SERVICE_RECEIVER,
      facilitatorClient: facilitator,
      store,
      indexer,
      requireSettlementIntent: true,
   });

   try {
      const spec = { ...SPEC, idempotencyKey: 'middleware-paid' };
      const { paymentHeader, body } = await createSyntheticPaidRequest(app, spec);
      const paid = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': paymentHeader,
         },
         body,
      });

      assert.equal(paid.status, 200);
      assert.equal(facilitator.settleCalls, 1);
      assert.deepEqual(facilitator.statesObservedAtSettle, ['settlement_pending']);

      const active = store.getByIdempotencyKey(spec.idempotencyKey);
      assert.equal(active?.state, 'active');
      assert.equal(active?.expectedServiceTransaction, SIGNED_SERVICE_TX_ID);
      assert.equal(active?.expectedServicePayer, PAYER);
      assert.equal(active?.serviceReceiver, SERVICE_RECEIVER);
      assert.equal(active?.serviceAssetId, TESTNET_USDC_ASSET_ID);
      assert.equal(active?.serviceAtomicAmount, ROUNDWATCH_SERVICE_ATOMIC_AMOUNT);
      assert.equal(active?.serviceFirstValid, 100);
      assert.equal(active?.serviceLastValid, 200);
      assert.equal(active?.evidenceVersion, 1);
      assert.equal(active?.activationRound, 150);
      assert.equal(active?.scanAfterRound, 150);

      const duplicate = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': paymentHeader,
         },
         body,
      });

      assert.equal(duplicate.status, 409);
      assert.equal(facilitator.settleCalls, 1, 'duplicate must not settle again');
   } finally {
      store.close();
   }
});

test('settled payment survives activation lookup failure and reconciles without a second settlement', async () => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new MiddlewareIndexer();
   indexer.activationFailuresRemaining = 1;
   const facilitator = new MiddlewareFacilitator(store, 'middleware-recovery');
   const app = createApp({
      avmAddress: SERVICE_RECEIVER,
      facilitatorClient: facilitator,
      store,
      indexer,
      requireSettlementIntent: true,
   });

   try {
      const spec = { ...SPEC, idempotencyKey: 'middleware-recovery' };
      const { paymentHeader, body } = await createSyntheticPaidRequest(app, spec);
      const paid = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': paymentHeader,
         },
         body,
      });

      assert.equal(paid.status, 500);
      assert.equal(facilitator.settleCalls, 1);

      const pending = store.getByIdempotencyKey(spec.idempotencyKey);
      assert.equal(pending?.state, 'settlement_pending');
      assert.equal(pending?.expectedServiceTransaction, SIGNED_SERVICE_TX_ID);
      assert.equal(pending?.scanAfterRound, undefined);

      const reconciler = new SettlementReconciler(store, indexer, {
         network: ALGORAND_TESTNET,
         intervalMilliseconds: 5_000,
      });
      await reconciler.reconcileOnce();

      const recovered = store.getByIdempotencyKey(spec.idempotencyKey);
      assert.equal(recovered?.state, 'active');
      assert.equal(recovered?.activationRound, 150);
      assert.equal(recovered?.scanAfterRound, 150);
      assert.equal(facilitator.settleCalls, 1, 'recovery must not settle again');
   } finally {
      store.close();
   }
});

test('route-level global and payer admission rejection occur before x402 settlement', async () => {
   for (const scope of ['global', 'payer'] as const) {
      const store = new RoundWatchStore(':memory:', {
         maxOpenWatches: scope === 'global' ? 1 : 10,
         maxOpenWatchesPerPayer: 1,
      });

      try {
         store.prepareWatch(
            { ...SPEC, idempotencyKey: `${scope}-existing` },
            intent(`${scope.toUpperCase()}_EXISTING_TX`),
         );

         const rejectedKey = `${scope}-route-rejected`;
         const facilitator = new MiddlewareFacilitator(store, rejectedKey);
         const app = createApp({
            avmAddress: SERVICE_RECEIVER,
            facilitatorClient: facilitator,
            store,
            indexer: new MiddlewareIndexer(),
            requireSettlementIntent: true,
         });
         const spec = { ...SPEC, idempotencyKey: rejectedKey };
         const { paymentHeader, body } = await createSyntheticPaidRequest(app, spec);
         const response = await app.request('/spike/watch', {
            method: 'POST',
            headers: {
               'content-type': 'application/json',
               'payment-signature': paymentHeader,
            },
            body,
         });
         const responseBody = await response.json() as { code?: string };

         assert.equal(response.status, 429);
         assert.equal(
            responseBody.code,
            scope === 'global'
               ? 'global_watch_capacity_exhausted'
               : 'payer_watch_capacity_exhausted',
         );
         assert.equal(facilitator.settleCalls, 0);
         assert.equal(store.getByIdempotencyKey(rejectedKey), undefined);
      } finally {
         store.close();
      }
   }
});

test('MainNet public base URL remains required, HTTPS-only, loopback-safe, and normalized', () => {
   assert.throws(
      () => resolveRoundWatchPublicBaseUrl(undefined, 'mainnet'),
      /required on MainNet/,
   );
   assert.throws(
      () => resolveRoundWatchPublicBaseUrl('http://roundwatch.example', 'mainnet'),
      /must use HTTPS/,
   );
   assert.throws(
      () => resolveRoundWatchPublicBaseUrl('https://127.0.0.1', 'mainnet'),
      /loopback/,
   );
   assert.throws(
      () => resolveRoundWatchPublicBaseUrl('https://localhost.', 'mainnet'),
      /localhost/,
   );
   assert.equal(
      resolveRoundWatchPublicBaseUrl(
         'https://roundwatch-api.onrender.com///',
         'mainnet',
      ),
      'https://roundwatch-api.onrender.com',
   );
   assert.equal(resolveRoundWatchPublicBaseUrl(undefined, 'testnet'), undefined);
});

test('exact watch matching rejects every changed field and compares note bytes exactly', () => {
   const watch = watchRecord({
      activationRound: 100,
      expiresAt: '2030-01-01T00:00:00.000Z',
   });
   const matching = invoiceTx(101, 1_800_000_000);

   assert.equal(matchesWatch(matching, watch), true);
   assert.equal(matchesWatch({ ...matching, sender: RECEIVER }, watch), false);
   assert.equal(matchesWatch({ ...matching, receiver: PAYER }, watch), false);
   assert.equal(matchesWatch({ ...matching, assetId: TESTNET_USDC_ASSET_ID + 1 }, watch), false);
   assert.equal(matchesWatch({ ...matching, atomicAmount: '2500001' }, watch), false);
   assert.equal(
      matchesWatch({
         ...matching,
         note: Buffer.from('different-note', 'utf8').toString('base64'),
      }, watch),
      false,
   );

   const replacementWatch = watchRecord({
      invoiceNote: '\uFFFD',
      activationRound: 100,
      expiresAt: '2030-01-01T00:00:00.000Z',
   });
   assert.equal(
      matchesWatch({
         ...matching,
         note: Buffer.from([0xff]).toString('base64'),
      }, replacementWatch),
      false,
      'invalid UTF-8 bytes must not match U+FFFD through replacement decoding',
   );
});

test('evidence version 1 is never fabricated without immutable settlement intent', () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const withoutEvidence = store.prepareWatch({
         ...SPEC,
         idempotencyKey: 'evidence-version-zero',
      }).watch;
      const withEvidence = store.prepareWatch({
         ...SPEC,
         idempotencyKey: 'evidence-version-one',
      }, intent('EVIDENCE_VERSION_ONE_TX')).watch;

      assert.equal(withoutEvidence.evidenceVersion, 0);
      assert.equal(withEvidence.evidenceVersion, 1);
   } finally {
      store.close();
   }
});

test('proof-compatible active watch without a cursor remains unresolved and is not scanned', async () => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new FakeIndexer(101);
   try {
      const watch = store.prepareWatch({
         ...SPEC,
         idempotencyKey: 'cursorless-proof-watch',
      }, intent('CURSORLESS_PROOF_TX')).watch;
      store.activateWatch(
         watch.id,
         {
            transaction: 'CURSORLESS_PROOF_TX',
            network: ALGORAND_TESTNET,
            payer: PAYER,
         },
      );

      await new RoundWatchPoller(store, indexer).runOnce();

      assert.equal(store.getWatch(watch.id)?.state, 'active');
      assert.equal(store.getWatch(watch.id)?.scanAfterRound, undefined);
      assert.equal(indexer.pageCalls.length, 0);
   } finally {
      store.close();
   }
});

test('creation deadline is stable and wall-clock reads never terminalize a watch', () => {
   let now = new Date('2026-09-18T10:00:00.123Z');
   const store = new RoundWatchStore(':memory:', { watchTtlMilliseconds: 1_000, now: () => now });
   try {
      const prepared = store.prepareWatch(SPEC, intent());
      assert.equal(prepared.watch.expiresAt, '2026-09-18T10:00:01.123Z');
      store.activateWatch(prepared.watch.id, { transaction: 'SERVICE_TX', network: ALGORAND_TESTNET, payer: PAYER }, 100);
      now = new Date('2026-09-18T10:01:00.000Z');
      assert.equal(store.getWatch(prepared.watch.id)?.state, 'active');
      assert.equal(store.getByIdempotencyKey(SPEC.idempotencyKey)?.state, 'active');
   } finally { store.close(); }
});

test('chain time is exclusive at the deadline and fractional milliseconds are explicit', () => {
   const watch = watchRecord({ expiresAt: '2026-09-18T10:00:01.123Z', activationRound: 100 });
   assert.equal(matchesWatch(invoiceTx(101, 1_789_722_000), watch), true);
   // Indexer timestamps have second precision: 10:00:01.000 remains before .123.
   assert.equal(matchesWatch(invoiceTx(101, Date.parse('2026-09-18T10:00:01Z') / 1_000), watch), true);
   const exact = watchRecord({ expiresAt: '2026-09-18T10:00:01.000Z', activationRound: 100 });
   assert.equal(matchesWatch(invoiceTx(101, Date.parse(exact.expiresAt!) / 1_000), exact), false);
   assert.equal(matchesWatch(invoiceTx(101, Date.parse(exact.expiresAt!) / 1_000 + 1), exact), false);
   assert.equal(matchesWatch(invoiceTx(100, 1), watch), false, 'same settlement round is excluded');
});

test('an eligible invoice is found after local deadline and a scan spanning the deadline may match', async () => {
   let now = new Date('2026-09-18T10:00:00Z');
   const store = new RoundWatchStore(':memory:', { watchTtlMilliseconds: 2_000, now: () => now });
   const indexer = new FakeIndexer(105);
   try {
      const watch = store.prepareWatch(SPEC, intent()).watch;
      store.activateWatch(watch.id, { transaction: 'SERVICE_TX', network: ALGORAND_TESTNET, payer: PAYER }, 100);
      now = new Date('2026-09-18T10:00:10Z');
      indexer.block = { round: 105, timestamp: Date.parse('2026-09-18T10:00:03Z') / 1_000 };
      indexer.pages.push({ transactions: [invoiceTx(101, Date.parse('2026-09-18T10:00:01Z') / 1_000)], currentRound: 105 });
      await new RoundWatchPoller(store, indexer, 1, 100, () => now).runOnce();
      assert.equal(store.getWatch(watch.id)?.state, 'matched');
      assert.equal(store.getWatch(watch.id)?.closingRound, 105);
   } finally { store.close(); }
});

test('closing checkpoint is fixed and complete validated coverage alone expires', async () => {
   let now = new Date('2026-09-18T10:00:00Z');
   const store = new RoundWatchStore(':memory:', { watchTtlMilliseconds: 1_000, now: () => now });
   const indexer = new FakeIndexer(110);
   try {
      const watch = store.prepareWatch(SPEC, intent()).watch;
      store.activateWatch(watch.id, { transaction: 'SERVICE_TX', network: ALGORAND_TESTNET, payer: PAYER }, 100);
      now = new Date('2026-09-18T10:00:02Z');
      indexer.block = { round: 110, timestamp: Date.parse('2026-09-18T10:00:01Z') / 1_000 };
      indexer.pages.push({ transactions: [], currentRound: 110 });
      const poller = new RoundWatchPoller(store, indexer, 1, 100, () => now);
      await poller.runOnce();
      assert.equal(store.getWatch(watch.id)?.state, 'expired');
      assert.equal(store.getWatch(watch.id)?.closingRound, 110);
      indexer.round = 999;
      assert.equal(store.setClosingRound(watch.id, 999), 110);
   } finally { store.close(); }
});

test('closing checkpoint survives restart and provider advancement', () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-closing-'));
   const path = join(directory, 'watch.sqlite');
   try {
      const first = new RoundWatchStore(path);
      const watch = first.prepareWatch(SPEC, intent()).watch;
      first.activateWatch(watch.id, { transaction: 'SERVICE_TX', network: ALGORAND_TESTNET, payer: PAYER }, 100);
      assert.equal(first.setClosingRound(watch.id, 110), 110);
      first.close();
      const restarted = new RoundWatchStore(path);
      assert.equal(restarted.getWatch(watch.id)?.closingRound, 110);
      assert.equal(restarted.setClosingRound(watch.id, 999), 110);
      restarted.close();
   } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('low coverage, pagination failure, and repeated tokens cannot advance or expire', async () => {
   let now = new Date('2026-09-18T10:00:00Z');
   const store = new RoundWatchStore(':memory:', { watchTtlMilliseconds: 1_000, now: () => now });
   const indexer = new FakeIndexer(105);
   try {
      const watch = store.prepareWatch(SPEC, intent()).watch;
      store.activateWatch(watch.id, { transaction: 'SERVICE_TX', network: ALGORAND_TESTNET, payer: PAYER }, 100);
      now = new Date('2026-09-18T10:00:02Z');
      indexer.block = { round: 105, timestamp: Date.parse('2026-09-18T10:00:02Z') / 1_000 };
      indexer.pages.push({ transactions: [], currentRound: 104, nextToken: 'more' });
      const poller = new RoundWatchPoller(store, indexer, 1, 100, () => now);
      await poller.runOnce();
      assert.equal(store.getWatch(watch.id)?.scanAfterRound, 100);
      assert.equal(store.getWatch(watch.id)?.state, 'active');
      indexer.pages.push({ transactions: [], currentRound: 105, nextToken: 'same' });
      await poller.runOnce();
      indexer.pages.push({ transactions: [], currentRound: 105, nextToken: 'same' });
      await poller.runOnce();
      assert.equal(store.getWatch(watch.id)?.scanAfterRound, 100);
   } finally { store.close(); }
});

test('restart mid-pagination replays the bounded window from the durable cursor', async () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-page-'));
   const path = join(directory, 'watch.sqlite');
   try {
      const first = new RoundWatchStore(path);
      const watch = first.prepareWatch(SPEC, intent()).watch;
      first.activateWatch(watch.id, { transaction: 'SERVICE_TX', network: ALGORAND_TESTNET, payer: PAYER }, 100);
      const firstIndexer = new FakeIndexer(105);
      firstIndexer.pages.push({ transactions: [], currentRound: 105, nextToken: 'page-2' });
      await new RoundWatchPoller(first, firstIndexer).runOnce();
      assert.equal(first.getWatch(watch.id)?.scanAfterRound, 100);
      first.close();
      const restarted = new RoundWatchStore(path);
      const secondIndexer = new FakeIndexer(105);
      secondIndexer.pages.push({ transactions: [invoiceTx(102, 1)], currentRound: 105 });
      await new RoundWatchPoller(restarted, secondIndexer).runOnce();
      assert.equal(secondIndexer.pageCalls[0]?.nextToken, undefined);
      assert.equal(restarted.getWatch(watch.id)?.state, 'matched');
      restarted.close();
   } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('cursor updates are monotonic and stale competing work cannot overwrite progress', () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const watch = store.prepareWatch(SPEC, intent()).watch;
      store.activateWatch(watch.id, { transaction: 'SERVICE_TX', network: ALGORAND_TESTNET, payer: PAYER }, 100);
      assert.equal(store.advanceScanRound(watch.id, 100, 110), true);
      assert.equal(store.advanceScanRound(watch.id, 100, 105), false);
      assert.equal(store.advanceScanRound(watch.id, 110, 109), false);
      assert.equal(store.getWatch(watch.id)?.scanAfterRound, 110);
   } finally { store.close(); }
});

test('runtime scan query strategy defaults to C and validates explicit rollback variants', () => {
   assert.equal(resolveScanQueryVariant(undefined), 'C');
   assert.equal(resolveScanQueryVariant(''), 'C');
   assert.equal(resolveScanQueryVariant(' c '), 'C');
   assert.equal(resolveScanQueryVariant('A'), 'A');
   assert.equal(resolveScanQueryVariant('B'), 'B');
   assert.equal(resolveScanQueryVariant('D'), 'D');
   assert.throws(
      () => resolveScanQueryVariant('E'),
      /must be one of A, B, C, D/,
   );
});

test('scan query variants apply only declared server filters and keep exact matching local', async () => {
   const watch = watchRecord({});
   const variants: Array<{
      variant: ScanQueryVariant;
      expectedRole: 'sender' | 'receiver';
      expectedAddress: string;
      expectAmount: boolean;
      expectNote: boolean;
   }> = [
      {
         variant: 'A',
         expectedRole: 'sender',
         expectedAddress: PAYER,
         expectAmount: false,
         expectNote: false,
      },
      {
         variant: 'B',
         expectedRole: 'sender',
         expectedAddress: PAYER,
         expectAmount: true,
         expectNote: false,
      },
      {
         variant: 'C',
         expectedRole: 'sender',
         expectedAddress: PAYER,
         expectAmount: true,
         expectNote: true,
      },
      {
         variant: 'D',
         expectedRole: 'receiver',
         expectedAddress: RECEIVER,
         expectAmount: true,
         expectNote: true,
      },
   ];

   for (const expected of variants) {
      let requested: URL | undefined;
      const dispatcher = new IndexerRequestDispatcher({
         requestsPerSecond: 1_000,
         burst: 10,
         concurrency: 1,
      });
      const mockFetch: typeof fetch = async input => {
         requested = new URL(String(input));

         const sender =
            expected.variant === 'D' ? RECEIVER : PAYER;
         const note = Buffer.from(
            `${SPEC.invoiceNote}:suffix`,
            'utf8',
         ).toString('base64');

         return Response.json({
            transactions: [{
               id: `TX_${expected.variant}`,
               sender,
               note,
               'confirmed-round': 11,
               'round-time': 1,
               'asset-transfer-transaction': {
                  receiver: RECEIVER,
                  'asset-id': TESTNET_USDC_ASSET_ID,
                  amount: Number(SPEC.atomicAmount),
               },
            }],
            'current-round': 20,
         });
      };

      const indexer = new AlgorandIndexerClient(
         'https://indexer.invalid',
         dispatcher,
         mockFetch,
         1_000,
         undefined,
         expected.variant,
      );

      const page = await indexer.searchWatchPage(watch, 10, 20);
      assert.equal(page.transactions.length, 1);
      assert.ok(requested);

      assert.equal(
         requested.searchParams.get('address-role'),
         expected.expectedRole,
      );
      assert.equal(
         requested.searchParams.get('address'),
         expected.expectedAddress,
      );

      if (expected.expectAmount) {
         assert.equal(
            requested.searchParams.get('currency-greater-than'),
            String(BigInt(SPEC.atomicAmount) - 1n),
         );
         assert.equal(
            requested.searchParams.get('currency-less-than'),
            String(BigInt(SPEC.atomicAmount) + 1n),
         );
      } else {
         assert.equal(
            requested.searchParams.has('currency-greater-than'),
            false,
         );
         assert.equal(
            requested.searchParams.has('currency-less-than'),
            false,
         );
      }

      if (expected.expectNote) {
         assert.equal(
            requested.searchParams.get('note-prefix'),
            Buffer.from(SPEC.invoiceNote!, 'utf8').toString('base64'),
         );
      } else {
         assert.equal(requested.searchParams.has('note-prefix'), false);
      }

      // D is receiver-oriented. A different sender is allowed through
      // server-filter validation and is rejected later by matchesWatch().
      if (expected.variant === 'D') {
         assert.equal(page.transactions[0]?.sender, RECEIVER);
         assert.equal(matchesWatch(page.transactions[0]!, watch), false);
      }
   }

   const noNote = watchRecord({ invoiceNote: undefined });
   let cUrl: URL | undefined;
   const cIndexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      new IndexerRequestDispatcher({
         requestsPerSecond: 1_000,
         burst: 10,
         concurrency: 1,
      }),
      async input => {
         cUrl = new URL(String(input));
         return Response.json({
            transactions: [],
            'current-round': 20,
         });
      },
      1_000,
      undefined,
      'C',
   );
   await cIndexer.searchWatchPage(noNote, 10, 20);
   assert.ok(cUrl);
   assert.equal(cUrl.searchParams.has('note-prefix'), false);
});

test('Indexer page validation rejects malformed fields, bounds, JSON, and inadequate watermark', async () => {
   const bodies: Array<Response> = [
      Response.json({ 'current-round': 10 }),
      Response.json({ transactions: 'wrong', 'current-round': 10 }),
      Response.json({ transactions: [{ ...rawTx(11), 'confirmed-round': 99 }], 'current-round': 99 }),
      Response.json({ transactions: [rawTx(11)], 'current-round': 20, 'next-token': 7 }),
      Response.json({ transactions: [{ ...rawTx(11), 'round-time': 'bad' }], 'current-round': 20 }),
      new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
   ];
   const dispatcher = new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 2 });
   const indexer = new AlgorandIndexerClient('https://indexer.invalid', dispatcher, async () => bodies.shift()!);
   const watch = watchRecord({});
   await assert.rejects(indexer.searchWatchPage(watch, 10, 20), /missing transactions/);
   await assert.rejects(indexer.searchWatchPage(watch, 10, 20), /not an array/);
   await assert.rejects(indexer.searchWatchPage(watch, 10, 20), /outside/);
   await assert.rejects(indexer.searchWatchPage(watch, 10, 20), /next-token/);
   await assert.rejects(indexer.searchWatchPage(watch, 10, 20), /round-time/);
   await assert.rejects(indexer.searchWatchPage(watch, 10, 20), /valid JSON/);
});

test('Indexer rejects responses that violate requested filters and disables redirects', async () => {
   const wrongSender = {
      ...rawTx(11),
      sender: RECEIVER,
   };
   const wrongAsset = {
      ...rawTx(11),
      'asset-transfer-transaction': {
         receiver: RECEIVER,
         'asset-id': TESTNET_USDC_ASSET_ID + 1,
         amount: 1,
      },
   };
   const wrongTransactionId = {
      ...rawTx(11),
      id: 'OTHER_TRANSACTION',
   };
   const bodies = [
      Response.json({ transactions: [wrongSender], 'current-round': 20 }),
      Response.json({ transactions: [wrongAsset], 'current-round': 20 }),
      Response.json({ transactions: [wrongTransactionId], 'current-round': 20 }),
   ];
   const dispatcher = new IndexerRequestDispatcher({
      requestsPerSecond: 1_000,
      burst: 10,
      concurrency: 2,
   });
   const mockFetch: typeof fetch = async (_input, init) => {
      assert.equal(init?.redirect, 'error');
      return bodies.shift()!;
   };
   const indexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      dispatcher,
      mockFetch,
   );

   await assert.rejects(
      indexer.searchWatchPage(watchRecord({}), 10, 20),
      /requested sender filter/,
   );
   await assert.rejects(
      indexer.searchWatchPage(watchRecord({}), 10, 20),
      /requested asset filter/,
   );
   await assert.rejects(
      indexer.searchTransactionPage('SERVICE'),
      /requested transaction ID/,
   );
});

test('dispatcher does not mint tokens when its clock moves backwards', async () => {
   let clock = 1_000;
   let starts = 0;
   const dispatcher = new IndexerRequestDispatcher({
      requestsPerSecond: 100,
      burst: 1,
      concurrency: 1,
      now: () => clock,
   });

   await dispatcher.dispatch('health', async () => {
      starts += 1;
   });
   assert.equal(starts, 1);

   clock = 900;
   const pending = dispatcher.dispatch('health', async () => {
      starts += 1;
   });

   await new Promise(resolve => setTimeout(resolve, 20));
   assert.equal(starts, 1);

   clock = 1_000;
   await new Promise(resolve => setTimeout(resolve, 20));
   assert.equal(starts, 1);

   clock = 1_010;
   await new Promise(resolve => setTimeout(resolve, 20));
   assert.equal(starts, 2);
   await pending;
});

test('shared dispatcher caps aggregate concurrency and finite restart burst', async () => {
   const dispatcher = new IndexerRequestDispatcher({ requestsPerSecond: 20, burst: 2, concurrency: 2 });
   let active = 0; let peak = 0; const starts: number[] = []; const began = Date.now();
   const work = Array.from({ length: 6 }, (_, i) => dispatcher.dispatch(i % 2 ? 'scan-page' : 'reconciliation', async () => {
      starts.push(Date.now() - began); active += 1; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 15)); active -= 1;
   }));
   await Promise.all(work);
   assert.ok(peak <= 2);
   assert.equal(starts.filter(value => value < 20).length, 2);
   assert.equal(dispatcher.snapshot().requests['scan-page'], 3);
   assert.equal(dispatcher.snapshot().requests.reconciliation, 3);
});

test('health, activation, checkpoint, scan pages, and absence pages all consume shared capacity', async () => {
   const dispatcher = new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 2 });
   const client = new AlgorandIndexerClient('https://indexer.invalid', dispatcher, async input => {
      const url = new URL(String(input));
      if (url.pathname === '/health') return Response.json({ round: 20 });
      if (url.pathname === '/v2/blocks/20') return Response.json({ round: 20, timestamp: 1 });
      if (url.pathname === '/v2/transactions/SERVICE') return Response.json({ transaction: { ...rawTx(10), id: 'SERVICE' } });
      return Response.json({ transactions: [], 'current-round': 20 });
   });
   await client.getCurrentRound('health');
   await client.lookupAssetTransfer('SERVICE', 'activation');
   await client.getBlock(20);
   await client.searchWatchPage(watchRecord({}), 10, 20);
   await client.searchTransactionPage('SERVICE');
   assert.deepEqual(dispatcher.snapshot().requests, {
      health: 1, activation: 1, checkpoint: 1, 'scan-page': 1, 'absence-proof': 1,
   });
});

test('each pagination page consumes a separate dispatcher credit', async () => {
   const dispatcher = new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 1 });
   let calls = 0;
   const client = new AlgorandIndexerClient('https://indexer.invalid', dispatcher, async () => {
      calls += 1;
      return Response.json({ transactions: [], 'current-round': 20, ...(calls === 1 ? { 'next-token': 'p2' } : {}) });
   });
   const first = await client.searchWatchPage(watchRecord({}), 10, 20);
   assert.equal(first.nextToken, 'p2');
   await client.searchWatchPage(watchRecord({}), 10, 20, first.nextToken);
   assert.equal(dispatcher.snapshot().requests['scan-page'], 2);
});

test('identical scan pages are fetched once and reused within a poll sweep', async () => {
   const store = new RoundWatchStore(':memory:', {
      maxOpenWatches: 2,
      maxOpenWatchesPerPayer: 2,
   });
   const indexer = new SharedPageFakeIndexer(101);

   try {
      for (let i = 0; i < 2; i += 1) {
         const tx = `SHARED_PAGE_SERVICE_${i}`;
         const watch = store.prepareWatch(
            { ...SPEC, idempotencyKey: `shared-page-${i}` },
            intent(tx),
         ).watch;
         store.activateWatch(
            watch.id,
            { transaction: tx, network: ALGORAND_TESTNET, payer: PAYER },
            100,
         );
      }

      indexer.pages.push({
         transactions: [],
         currentRound: 101,
         nextToken: 'page-2',
      });

      const poller = new RoundWatchPoller(store, indexer);
      await poller.runOnce();

      assert.equal(indexer.currentRoundCalls, 1);
      assert.equal(indexer.pageCalls.length, 1);
      assert.equal(
         store.listActiveWatches().every(watch => watch.scanAfterRound === 100),
         true,
      );

      indexer.pages.push({
         transactions: [],
         currentRound: 101,
      });
      await poller.runOnce();

      assert.equal(indexer.currentRoundCalls, 1);
      assert.equal(indexer.pageCalls.length, 2);
      assert.equal(indexer.pageCalls.at(-1)?.nextToken, 'page-2');
      assert.equal(
         store.listActiveWatches().every(watch => watch.scanAfterRound === 101),
         true,
      );
   } finally {
      store.close();
   }
});

test('validated historical pages are reused across staggered poll sweeps', async () => {
   const store = new RoundWatchStore(':memory:', {
      maxOpenWatches: 2,
      maxOpenWatchesPerPayer: 2,
   });
   const indexer = new SharedPageFakeIndexer(101);

   const createActiveWatch = (index: number): void => {
      const tx = `CROSS_SWEEP_SERVICE_${index}`;
      const watch = store.prepareWatch(
         { ...SPEC, idempotencyKey: `cross-sweep-${index}` },
         intent(tx),
      ).watch;
      store.activateWatch(
         watch.id,
         { transaction: tx, network: ALGORAND_TESTNET, payer: PAYER },
         100,
      );
   };

   try {
      createActiveWatch(0);
      indexer.pages.push({
         transactions: [],
         currentRound: 101,
         nextToken: 'page-2',
      });

      const poller = new RoundWatchPoller(store, indexer);
      await poller.runOnce();
      assert.equal(indexer.pageCalls.length, 1);

      createActiveWatch(1);
      indexer.pages.push({
         transactions: [],
         currentRound: 101,
      });

      await poller.runOnce();

      // Watch 0 physically fetches page 2. The newly admitted watch 1 reuses
      // page 1 from the bounded cross-sweep cache.
      assert.equal(indexer.pageCalls.length, 2);

      await poller.runOnce();

      // Watch 1 now reuses the previously fetched page 2 as well.
      assert.equal(indexer.pageCalls.length, 2);
      assert.equal(
         store.listActiveWatches().every(
            watch => watch.scanAfterRound === 101,
         ),
         true,
      );
   } finally {
      store.close();
   }
});

test('scan failure clears historical pages so stale provider tokens cannot loop forever', async () => {
   const store = new RoundWatchStore(':memory:', {
      maxOpenWatches: 1,
      maxOpenWatchesPerPayer: 1,
   });
   const indexer = new SharedPageFakeIndexer(101);

   try {
      const tx = 'STALE_TOKEN_SERVICE';
      const watch = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'stale-token-cache' },
         intent(tx),
      ).watch;
      store.activateWatch(
         watch.id,
         { transaction: tx, network: ALGORAND_TESTNET, payer: PAYER },
         100,
      );

      indexer.pages.push({
         transactions: [],
         currentRound: 101,
         nextToken: 'provider-token',
      });

      const poller = new RoundWatchPoller(store, indexer);
      await poller.runOnce();
      assert.equal(indexer.pageCalls.length, 1);

      indexer.failPageCalls.add(1);
      await poller.runOnce();
      assert.equal(indexer.pageCalls.length, 2);

      indexer.pages.push({
         transactions: [],
         currentRound: 101,
      });
      await poller.runOnce();

      // The first page must be fetched again after the failed continuation.
      assert.equal(indexer.pageCalls.length, 3);
      assert.equal(store.getWatch(watch.id)?.scanAfterRound, 101);
   } finally {
      store.close();
   }
});

test('historical page cache can be disabled without disabling within-sweep reuse', async () => {
   const store = new RoundWatchStore(':memory:', {
      maxOpenWatches: 1,
      maxOpenWatchesPerPayer: 1,
   });
   const indexer = new SharedPageFakeIndexer(101);

   try {
      const tx = 'CACHE_DISABLED_SERVICE';
      const watch = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'cache-disabled' },
         intent(tx),
      ).watch;
      store.activateWatch(
         watch.id,
         { transaction: tx, network: ALGORAND_TESTNET, payer: PAYER },
         100,
      );

      indexer.pages.push({
         transactions: [],
         currentRound: 101,
         nextToken: 'page-2',
      });
      indexer.pages.push({
         transactions: [],
         currentRound: 101,
      });

      const poller = new RoundWatchPoller(
         store,
         indexer,
         5_000,
         100,
         () => new Date(),
         undefined,
         0,
      );
      await poller.runOnce();
      await poller.runOnce();

      assert.equal(indexer.pageCalls.length, 2);
      assert.equal(store.getWatch(watch.id)?.scanAfterRound, 101);
   } finally {
      store.close();
   }
});

test('active polling stops before extra work after durable budget exhaustion', async () => {
   const store = new RoundWatchStore(':memory:', {
      maxOpenWatches: 1,
      maxOpenWatchesPerPayer: 1,
      workUnitBudget: 1,
   });
   const indexer = new FakeIndexer(101);

   try {
      const tx = 'WORK_BUDGET_SERVICE';
      const watch = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'work-budget-active' },
         intent(tx),
      ).watch;
      store.activateWatch(
         watch.id,
         { transaction: tx, network: ALGORAND_TESTNET, payer: PAYER },
         100,
      );

      indexer.pages.push({
         transactions: [],
         currentRound: 101,
         nextToken: 'page-2',
      });

      const poller = new RoundWatchPoller(store, indexer);
      await poller.runOnce();

      const afterFirst = store.getWatch(watch.id);
      assert.equal(afterFirst?.state, 'active');
      assert.equal(afterFirst?.workUnitsUsed, 1);
      assert.equal(indexer.pageCalls.length, 1);

      await poller.runOnce();

      const exhausted = store.getWatch(watch.id);
      assert.equal(exhausted?.state, 'indeterminate');
      assert.equal(exhausted?.terminalReason, 'work_budget_exhausted');
      assert.equal(exhausted?.workUnitsUsed, 1);
      assert.equal(indexer.pageCalls.length, 1);
   } finally {
      store.close();
   }
});

test('watch-page query identity follows the actual server-side filters', () => {
   const dispatcher = new IndexerRequestDispatcher({
      requestsPerSecond: 1_000,
      burst: 10,
      concurrency: 1,
   });
   const cIndexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      dispatcher,
      async () => Response.json({ transactions: [], 'current-round': 20 }),
      1_000,
      undefined,
      'C',
   );
   const dIndexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      dispatcher,
      async () => Response.json({ transactions: [], 'current-round': 20 }),
      1_000,
      undefined,
      'D',
   );

   const base = watchRecord({});
   const otherReceiver = watchRecord({
      id: 'other-receiver',
      expectedReceiver:
         'AEBAGBAFAYDQQCIKBMGA2DQPCAIREEYUCULBOGAZDINRYHI6D4QCC5T6YA',
   });
   const otherNote = watchRecord({
      id: 'other-note',
      invoiceNote: 'different-note',
   });

   assert.equal(
      cIndexer.watchPageQueryKey(base, 101, 200),
      cIndexer.watchPageQueryKey(otherReceiver, 101, 200),
   );
   assert.notEqual(
      cIndexer.watchPageQueryKey(base, 101, 200),
      cIndexer.watchPageQueryKey(otherNote, 101, 200),
   );
   assert.notEqual(
      dIndexer.watchPageQueryKey(base, 101, 200),
      dIndexer.watchPageQueryKey(otherReceiver, 101, 200),
   );
});

test('50 watches each receive at most one page turn in one fair sweep', async () => {
   const store = new RoundWatchStore(':memory:', { maxOpenWatches: 50, maxOpenWatchesPerPayer: 50 });
   const indexer = new FakeIndexer(101);
   try {
      for (let i = 0; i < 50; i += 1) {
         const tx = `SERVICE_${i}`;
         const watch = store.prepareWatch({ ...SPEC, idempotencyKey: `load-watch-${i}` }, intent(tx)).watch;
         store.activateWatch(watch.id, { transaction: tx, network: ALGORAND_TESTNET, payer: PAYER }, 100);
      }

      // The first watch has another page. It must yield after that first page
      // while every later watch still receives its own turn in the same sweep.
      indexer.pages.push({ transactions: [], currentRound: 101, nextToken: 'busy-page-2' });
      for (let i = 1; i < 50; i += 1) {
         indexer.pages.push({ transactions: [], currentRound: 101 });
      }

      const poller = new RoundWatchPoller(store, indexer);
      await poller.runOnce();

      assert.equal(indexer.pageCalls.length, 50);
      assert.equal(
         indexer.currentRoundCalls,
         1,
         'one sweep must share one health tip across all watches',
      );
      assert.equal(
         store.listActiveWatches().filter(watch => watch.scanAfterRound === 101).length,
         49,
      );
      assert.equal(
         store.listActiveWatches().filter(watch => watch.scanAfterRound === 100).length,
         1,
      );

      // Only the unfinished continuation needs another transaction page.
      indexer.pages.push({ transactions: [], currentRound: 101 });
      await poller.runOnce();

      assert.equal(indexer.pageCalls.length, 51);
      assert.equal(
         indexer.currentRoundCalls,
         2,
         'the next sweep may fetch one fresh shared tip',
      );
      assert.equal(indexer.pageCalls.at(-1)?.nextToken, 'busy-page-2');
      assert.equal(
         store.listActiveWatches().every(watch => watch.scanAfterRound === 101),
         true,
      );
   } finally { store.close(); }
});

test('one watch page failure does not block later watches in the same fair sweep', async () => {
   const store = new RoundWatchStore(':memory:', { maxOpenWatches: 2, maxOpenWatchesPerPayer: 2 });
   const indexer = new FakeIndexer(101);
   try {
      for (let i = 0; i < 2; i += 1) {
         const tx = `FAILURE_ISOLATION_SERVICE_${i}`;
         const watch = store.prepareWatch(
            { ...SPEC, idempotencyKey: `failure-isolation-${i}` },
            intent(tx),
         ).watch;
         store.activateWatch(
            watch.id,
            { transaction: tx, network: ALGORAND_TESTNET, payer: PAYER },
            100,
         );
      }

      indexer.failPageCalls.add(0);
      indexer.pages.push({ transactions: [], currentRound: 101 });

      await new RoundWatchPoller(store, indexer).runOnce();

      assert.equal(indexer.pageCalls.length, 2);
      assert.equal(
         store.listActiveWatches().filter(watch => watch.scanAfterRound === 100).length,
         1,
      );
      assert.equal(
         store.listActiveWatches().filter(watch => watch.scanAfterRound === 101).length,
         1,
      );
   } finally { store.close(); }
});

test('capacity and transaction uniqueness reject before creating another obligation', () => {
   const store = new RoundWatchStore(':memory:', { maxOpenWatches: 1, maxOpenWatchesPerPayer: 1 });
   try {
      const first = store.prepareWatch(SPEC, intent());
      assert.throws(() => store.prepareWatch({ ...SPEC, idempotencyKey: 'invoice-0002' }, intent('OTHER')), WatchCapacityError);
      assert.equal(store.prepareWatch(SPEC, intent()).watch.id, first.watch.id);
   } finally { store.close(); }
});

test('one signed service transaction cannot reserve watches under different idempotency keys', () => {
   const store = new RoundWatchStore(':memory:', { maxOpenWatches: 10, maxOpenWatchesPerPayer: 10 });
   try {
      store.prepareWatch(SPEC, intent('UNIQUE_SERVICE'));
      assert.throws(
         () => store.prepareWatch({ ...SPEC, idempotencyKey: 'different-key' }, intent('UNIQUE_SERVICE')),
         /UNIQUE constraint failed/,
      );
      assert.equal(store.listSettlementReconciliationCandidates().length, 1);
   } finally { store.close(); }
});

test('concurrent admission attempts cannot exceed the transactional global limit', async () => {
   const store = new RoundWatchStore(':memory:', { maxOpenWatches: 3, maxOpenWatchesPerPayer: 10 });
   try {
      const attempts = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
         Promise.resolve().then(() => store.prepareWatch(
            { ...SPEC, idempotencyKey: `concurrent-${i}` }, intent(`CONCURRENT_${i}`),
         )),
      ));
      assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 3);
      assert.equal(store.listSettlementReconciliationCandidates().length, 3);
   } finally { store.close(); }
});

test('legacy migration is idempotent and does not fabricate proof or alter matched state', () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-legacy-'));
   const path = join(directory, 'legacy.sqlite');
   try {
      const db = new DatabaseSync(path);
      db.exec(`CREATE TABLE roundwatch_watches (
         id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
         expected_sender TEXT NOT NULL, expected_receiver TEXT NOT NULL, asset_id INTEGER NOT NULL,
         atomic_amount TEXT NOT NULL, invoice_note TEXT, service_transaction TEXT UNIQUE,
         service_network TEXT, service_payer TEXT, activation_round INTEGER, activated_at TEXT,
         scan_after_round INTEGER, created_at TEXT NOT NULL, matched_transaction TEXT, matched_round INTEGER
      );`);
      db.prepare(`INSERT INTO roundwatch_watches VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
         'legacy-match', 'legacy-key', 'matched', PAYER, RECEIVER, TESTNET_USDC_ASSET_ID, '1', null,
         'service', ALGORAND_TESTNET, PAYER, 10, '2026-01-01T00:00:00Z', 10,
         '2026-01-01T00:00:00Z', 'invoice', 11,
      );
      db.close();
      for (let i = 0; i < 2; i += 1) {
         const store = new RoundWatchStore(path);
         const legacy = store.getWatch('legacy-match');
         assert.equal(legacy?.state, 'matched');
         assert.equal(legacy?.evidenceVersion, 0);
         assert.equal(legacy?.expiresAt, undefined);
         assert.equal(legacy?.closingRound, undefined);
         store.close();
      }
   } finally { rmSync(directory, { recursive: true, force: true }); }
});

async function createSyntheticPaidRequest(
   app: ReturnType<typeof createApp>,
   spec: WatchSpec,
): Promise<{ paymentHeader: string; body: string }> {
   const body = JSON.stringify({
      idempotencyKey: spec.idempotencyKey,
      expectedSender: spec.expectedSender,
      expectedReceiver: spec.expectedReceiver,
      atomicAmount: spec.atomicAmount,
      invoiceNote: spec.invoiceNote,
   });
   const unpaid = await app.request('/spike/watch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
   });

   assert.equal(unpaid.status, 402);
   const encoded = unpaid.headers.get('payment-required');
   assert.ok(encoded);
   const required = decodePaymentRequiredHeader(encoded).accepts[0]!;
   const payload: PaymentPayload = {
      x402Version: 2,
      accepted: required,
      payload: {
         paymentGroup: [SIGNED_SERVICE_PAYMENT],
         paymentIndex: 0,
      },
   };

   return {
      paymentHeader: encodePaymentSignatureHeader(payload),
      body,
   };
}

function paymentTransactionId(payload: PaymentPayload): string {
   const exact = payload.payload as unknown as {
      paymentGroup?: unknown;
      paymentIndex?: unknown;
   };
   if (
      !Array.isArray(exact.paymentGroup) ||
      !exact.paymentGroup.every(item => typeof item === 'string') ||
      !Number.isSafeInteger(exact.paymentIndex) ||
      (exact.paymentIndex as number) < 0 ||
      (exact.paymentIndex as number) >= exact.paymentGroup.length
   ) {
      throw new Error('synthetic facilitator received malformed payment payload');
   }

   return getTransactionId(
      Buffer.from(exact.paymentGroup[exact.paymentIndex as number] as string, 'base64'),
   );
}

class MiddlewareFacilitator implements FacilitatorClient {
   settleCalls = 0;
   readonly statesObservedAtSettle: Array<WatchRecord['state'] | undefined> = [];

   constructor(
      private readonly store: RoundWatchStore,
      private readonly idempotencyKey: string,
   ) {}

   async verify(
      _paymentPayload: PaymentPayload,
      _paymentRequirements: PaymentRequirements,
   ): Promise<VerifyResponse> {
      return { isValid: true, payer: PAYER };
   }

   async settle(
      paymentPayload: PaymentPayload,
      _paymentRequirements: PaymentRequirements,
   ): Promise<SettleResponse> {
      this.settleCalls += 1;
      this.statesObservedAtSettle.push(
         this.store.getByIdempotencyKey(this.idempotencyKey)?.state,
      );

      return {
         success: true,
         payer: PAYER,
         transaction: paymentTransactionId(paymentPayload),
         network: ALGORAND_TESTNET,
      };
   }

   async getSupported(): Promise<SupportedResponse> {
      return {
         kinds: [
            {
               x402Version: 2,
               scheme: 'exact',
               network: ALGORAND_TESTNET,
            },
         ],
         extensions: [],
         signers: {},
      };
   }
}

class MiddlewareIndexer implements RoundWatchIndexer {
   activationFailuresRemaining = 0;
   readonly lookupPurposes: string[] = [];

   async getCurrentRound(): Promise<number> {
      return 201;
   }

   async lookupAssetTransfer(
      transactionId: string,
      purpose = 'reconciliation',
   ) {
      this.lookupPurposes.push(purpose);
      if (purpose === 'activation' && this.activationFailuresRemaining > 0) {
         this.activationFailuresRemaining -= 1;
         throw new Error('synthetic activation lookup failure');
      }

      return {
         transaction: transactionId,
         sender: PAYER,
         receiver: SERVICE_RECEIVER,
         assetId: TESTNET_USDC_ASSET_ID,
         atomicAmount: ROUNDWATCH_SERVICE_ATOMIC_AMOUNT,
         round: 150,
      };
   }

   async getBlock(round: number): Promise<IndexedBlock> {
      return { round, timestamp: 1_800_000_000 };
   }

   async searchWatchPage(): Promise<TransactionPage> {
      return { transactions: [], currentRound: 201 };
   }

   async searchTransactionPage(): Promise<TransactionIdPage> {
      return { transactions: [], currentRound: 201 };
   }
}

class FakeIndexer implements RoundWatchIndexer {
   pages: TransactionPage[] = [];
   pageCalls: Array<{ min: number; max: number; nextToken?: string }> = [];
   failPageCalls = new Set<number>();
   currentRoundCalls = 0;
   block: IndexedBlock;
   constructor(public round: number) { this.block = { round, timestamp: 0 }; }
   async getCurrentRound(): Promise<number> {
      this.currentRoundCalls += 1;
      return this.round;
   }
   async lookupAssetTransfer(): Promise<undefined> { return undefined; }
   async getBlock(): Promise<IndexedBlock> { return this.block; }
   async searchWatchPage(_watch: WatchRecord, min: number, max: number, nextToken?: string): Promise<TransactionPage> {
      const callIndex = this.pageCalls.length;
      this.pageCalls.push({ min, max, ...(nextToken ? { nextToken } : {}) });
      if (this.failPageCalls.has(callIndex)) throw new Error('synthetic page failure');
      const page = this.pages.shift(); if (!page) throw new Error('no fake page'); return page;
   }
   async searchTransactionPage(): Promise<TransactionIdPage> { return { transactions: [], currentRound: this.round }; }
}

class SharedPageFakeIndexer extends FakeIndexer {
   watchPageQueryKey(
      _watch: WatchRecord,
      min: number,
      max: number,
      nextToken?: string,
   ): string {
      return `${min}:${max}:${nextToken ?? ''}`;
   }
}

function watchRecord(overrides: Partial<WatchRecord>): WatchRecord {
   return {
      ...SPEC, id: 'watch', state: 'active', activationRound: 100, scanAfterRound: 100,
      createdAt: '2026-09-18T09:30:00Z', expiresAt: '2026-09-18T10:00:00Z',
      evidenceVersion: 1, reconciliationAttempts: 0,
      workUnitBudget: 100, workUnitsUsed: 0, ...overrides,
   };
}
function invoiceTx(round: number, roundTime: number): IndexedWatchTransaction {
   return { transaction: `INVOICE_${round}`, sender: PAYER, receiver: RECEIVER,
      assetId: TESTNET_USDC_ASSET_ID, atomicAmount: SPEC.atomicAmount, round, roundTime,
      note: Buffer.from(SPEC.invoiceNote!, 'utf8').toString('base64') };
}
function rawTx(round: number): Record<string, unknown> {
   return { id: 'TX', sender: PAYER, 'confirmed-round': round, 'round-time': 1,
      'asset-transfer-transaction': { receiver: RECEIVER, 'asset-id': TESTNET_USDC_ASSET_ID, amount: 1 } };
}
