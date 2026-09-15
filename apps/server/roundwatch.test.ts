import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

import {
   ALGORAND_TESTNET,
   createApp,
   TESTNET_USDC_ASSET_ID,
} from './app.js';
import {
   AlgorandIndexerClient,
   type RoundWatchIndexer,
   type WatchMatch,
} from './roundwatch-indexer.js';
import { RoundWatchPoller } from './roundwatch-poller.js';
import {
   RoundWatchStore,
   type WatchRecord,
   type WatchSpec,
} from './roundwatch-store.js';

const SENDER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const RECEIVER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const WRONG_RECEIVER = 'NOT_THE_EXPECTED_RECEIVER';
const SPEC: WatchSpec = {
   idempotencyKey: 'invoice-0001',
   expectedSender: SENDER,
   expectedReceiver: RECEIVER,
   assetId: TESTNET_USDC_ASSET_ID,
   atomicAmount: '2500000',
   invoiceNote: 'roundwatch:invoice-0001',
};

test('a watch activates only after settlement and duplicate creation is rejected', async () => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new FakeIndexer(500);
   const facilitator = new FakeFacilitator(store, SPEC.idempotencyKey);
   const app = createApp({
      avmAddress: RECEIVER,
      facilitatorClient: facilitator,
      store,
      indexer,
   });

   try {
      const requestBody = JSON.stringify({
         idempotencyKey: SPEC.idempotencyKey,
         expectedSender: SPEC.expectedSender,
         expectedReceiver: SPEC.expectedReceiver,
         atomicAmount: SPEC.atomicAmount,
         invoiceNote: SPEC.invoiceNote,
      });
      const unpaid = await app.request('/spike/watch', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: requestBody,
      });

      assert.equal(unpaid.status, 402);
      assert.equal(store.getByIdempotencyKey(SPEC.idempotencyKey), undefined);

      const paymentRequiredHeader = unpaid.headers.get('payment-required');
      assert.ok(paymentRequiredHeader);
      const required = decodePaymentRequiredHeader(paymentRequiredHeader);
      assert.equal(required.accepts[0]?.network, ALGORAND_TESTNET);

      const payload: PaymentPayload = {
         x402Version: 2,
         accepted: required.accepts[0]!,
         payload: { testAuthorization: true },
      };
      const paymentHeader = encodePaymentSignatureHeader(payload);
      const paid = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': paymentHeader,
         },
         body: requestBody,
      });

      assert.equal(paid.status, 200);
      assert.equal(facilitator.settleCalls, 1);
      assert.deepEqual(facilitator.statesObservedAtSettle, [
         'settlement_pending',
      ]);

      const active = store.getByIdempotencyKey(SPEC.idempotencyKey);
      assert.equal(active?.state, 'active');
      assert.equal(active?.serviceTransaction, 'SERVICE_SETTLEMENT_TX');
      assert.equal(active?.activationRound, 500);

      const duplicate = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': paymentHeader,
         },
         body: requestBody,
      });

      assert.equal(duplicate.status, 409);
      assert.equal(facilitator.settleCalls, 1);
      assert.equal(store.listActiveWatches().length, 1);

      const unpaidDemo = await app.request('/demo');
      assert.equal(unpaidDemo.status, 402);
   } finally {
      store.close();
   }
});

test('SQLite restart recovers an active watch and the poller matches only a later transfer', async () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-spike-'));
   const databasePath = join(directory, 'roundwatch.sqlite');
   let watchId: string;

   try {
      const firstProcess = new RoundWatchStore(databasePath);
      const prepared = firstProcess.prepareWatch(SPEC);
      watchId = prepared.watch.id;

      assert.equal(prepared.watch.state, 'settlement_pending');
      assert.equal(firstProcess.listActiveWatches().length, 0);

      firstProcess.activateWatch(
         watchId,
         {
            transaction: 'SERVICE_SETTLEMENT_TX',
            network: ALGORAND_TESTNET,
            payer: SENDER,
         },
         700,
      );
      firstProcess.close();

      const restartedProcess = new RoundWatchStore(databasePath);

      try {
         assert.equal(restartedProcess.getWatch(watchId)?.state, 'active');
         assert.equal(restartedProcess.listActiveWatches().length, 1);

         const indexer = new FakeIndexer(702);
         const poller = new RoundWatchPoller(restartedProcess, indexer);

         await poller.runOnce();
         assert.equal(restartedProcess.getWatch(watchId)?.state, 'active');
         assert.equal(restartedProcess.getWatch(watchId)?.scanAfterRound, 702);

         indexer.round = 705;
         indexer.match = {
            transaction: 'FUTURE_INVOICE_TX',
            round: 704,
         };
         await poller.runOnce();

         const matched = restartedProcess.getWatch(watchId);
         assert.equal(matched?.state, 'matched');
         assert.equal(matched?.matchedTransaction, 'FUTURE_INVOICE_TX');
         assert.equal(matched?.matchedRound, 704);
      } finally {
         restartedProcess.close();
      }
   } finally {
      rmSync(directory, { recursive: true, force: true });
   }
});

test('Algorand Indexer matching checks sender, receiver, ASA, amount, and note', async () => {
   const correctNote = Buffer.from(SPEC.invoiceNote!, 'utf8').toString('base64');
   const mockFetch: typeof fetch = async input => {
      const url = new URL(String(input));
      assert.equal(url.pathname, `/v2/assets/${TESTNET_USDC_ASSET_ID}/transactions`);
      assert.equal(url.searchParams.get('address'), SENDER);
      assert.equal(url.searchParams.get('address-role'), 'sender');
      assert.equal(url.searchParams.get('min-round'), '801');
      assert.equal(url.searchParams.get('max-round'), '810');

      return Response.json({
         transactions: [
            assetTransferTransaction({
               id: 'WRONG_RECEIVER',
               receiver: WRONG_RECEIVER,
               note: correctNote,
            }),
            assetTransferTransaction({
               id: 'WRONG_AMOUNT',
               amount: 1,
               note: correctNote,
            }),
            assetTransferTransaction({
               id: 'MATCHING_TX',
               note: correctNote,
            }),
         ],
      });
   };
   const indexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      mockFetch,
   );

   const match = await indexer.findMatch(
      {
         id: 'watch-id',
         state: 'active',
         ...SPEC,
         activationRound: 800,
         scanAfterRound: 800,
         createdAt: new Date().toISOString(),
      },
      801,
      810,
   );

   assert.deepEqual(match, { transaction: 'MATCHING_TX', round: 805 });
});

class FakeFacilitator implements FacilitatorClient {
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
      return { isValid: true, payer: SENDER };
   }

   async settle(
      _paymentPayload: PaymentPayload,
      _paymentRequirements: PaymentRequirements,
   ): Promise<SettleResponse> {
      this.settleCalls += 1;
      this.statesObservedAtSettle.push(
         this.store.getByIdempotencyKey(this.idempotencyKey)?.state,
      );

      return {
         success: true,
         payer: SENDER,
         transaction: 'SERVICE_SETTLEMENT_TX',
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

class FakeIndexer implements RoundWatchIndexer {
   match?: WatchMatch;

   constructor(public round: number) {}

   async getCurrentRound(): Promise<number> {
      return this.round;
   }

   async findMatch(
      _watch: WatchRecord,
      _minRound: number,
      _maxRound: number,
   ): Promise<WatchMatch | undefined> {
      return this.match;
   }
}

function assetTransferTransaction(options: {
   id: string;
   receiver?: string;
   amount?: number;
   note: string;
}): Record<string, unknown> {
   return {
      id: options.id,
      sender: SENDER,
      note: options.note,
      'confirmed-round': 805,
      'asset-transfer-transaction': {
         amount: options.amount ?? Number(SPEC.atomicAmount),
         receiver: options.receiver ?? RECEIVER,
         'asset-id': TESTNET_USDC_ASSET_ID,
      },
   };
}
