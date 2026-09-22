import assert from 'node:assert/strict';
import test from 'node:test';

import { x402Client } from '@x402/fetch';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';

import {
   ALGORAND_MAINNET,
   assertApprovedRoundWatchPayment,
   assertMainnetRuntimeSafety,
   DEFAULT_ALGOD_URL,
   DEFAULT_SERVER_URL,
   EXPECTED_RECEIVER,
   INVOICE_ATOMIC_AMOUNT,
   installRoundWatchPaymentSafety,
   recoverExistingMainnetWatch,
   SERVICE_ATOMIC_AMOUNT,
   USDC_MAINNET_ASA_ID,
   validateMainnetCheckpoint,
   type MainnetCheckpoint,
   type MainnetWatchSnapshot,
} from './mainnet-safety.js';

const PAYER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const NONCE = '123e4567-e89b-42d3-a456-426614174000';
const WATCH_ID = '223e4567-e89b-42d3-a456-426614174000';
const CHECKPOINT: MainnetCheckpoint = {
   network: ALGORAND_MAINNET,
   assetId: USDC_MAINNET_ASA_ID,
   serverUrl: DEFAULT_SERVER_URL,
   idempotencyKey: `mainnet-${NONCE}`,
   expectedSender: PAYER,
   expectedReceiver: EXPECTED_RECEIVER,
   atomicAmount: INVOICE_ATOMIC_AMOUNT,
   invoiceNote: `roundwatch:mainnet:${NONCE}`,
   watchId: WATCH_ID,
};
const WATCH: MainnetWatchSnapshot = {
   id: WATCH_ID,
   state: 'active',
   expectedSender: PAYER,
   expectedReceiver: EXPECTED_RECEIVER,
   assetId: USDC_MAINNET_ASA_ID,
   atomicAmount: INVOICE_ATOMIC_AMOUNT,
   invoiceNote: `roundwatch:mainnet:${NONCE}`,
};

test('MainNet runtime accepts only the approved production server and HTTPS Algod', () => {
   assert.doesNotThrow(() =>
      assertMainnetRuntimeSafety(DEFAULT_SERVER_URL, DEFAULT_ALGOD_URL),
   );
   assert.throws(
      () =>
         assertMainnetRuntimeSafety(
            'http://roundwatch-api.onrender.com',
            DEFAULT_ALGOD_URL,
         ),
      /must use HTTPS/,
   );
   assert.throws(
      () => assertMainnetRuntimeSafety('https://other.example', DEFAULT_ALGOD_URL),
      /not approved/,
   );
   assert.throws(
      () =>
         assertMainnetRuntimeSafety(
            DEFAULT_SERVER_URL,
            'http://mainnet-api.algonode.cloud',
         ),
      /Algod URL must use HTTPS/,
   );
});

test('MainNet service safety amount is the repriced 0.02 USDC contract', () => {
   assert.equal(SERVICE_ATOMIC_AMOUNT, '20000');
});

test('valid MainNet checkpoint and matching watch pass hard safety validation', () => {
   assert.deepEqual(
      validateMainnetCheckpoint(CHECKPOINT, {
         runtimeServerUrl: DEFAULT_SERVER_URL,
         payerAddress: PAYER,
         requireWatchId: true,
         watch: WATCH,
      }),
      CHECKPOINT,
   );
});

test('MainNet checkpoint validation fails closed on payment-critical mismatches', () => {
   const invalidCases: Array<[string, Record<string, unknown>]> = [
      ['network', { ...CHECKPOINT, network: 'algorand:testnet' }],
      ['asset', { ...CHECKPOINT, assetId: 10_458_941 }],
      ['server', { ...CHECKPOINT, serverUrl: 'https://other.example' }],
      ['receiver', { ...CHECKPOINT, expectedReceiver: PAYER }],
      ['amount', { ...CHECKPOINT, atomicAmount: '1000000' }],
      ['note', { ...CHECKPOINT, invoiceNote: 'roundwatch:mainnet:other' }],
      ['watchId', { ...CHECKPOINT, watchId: undefined }],
   ];

   for (const [name, checkpoint] of invalidCases) {
      assert.throws(
         () =>
            validateMainnetCheckpoint(checkpoint, {
               runtimeServerUrl: DEFAULT_SERVER_URL,
               payerAddress: PAYER,
               requireWatchId: true,
            }),
         name,
      );
   }

   assert.throws(
      () =>
         validateMainnetCheckpoint(CHECKPOINT, {
            runtimeServerUrl: DEFAULT_SERVER_URL,
            payerAddress: EXPECTED_RECEIVER,
            requireWatchId: true,
         }),
      /configured payer/,
   );
   assert.throws(
      () =>
         validateMainnetCheckpoint(CHECKPOINT, {
            runtimeServerUrl: DEFAULT_SERVER_URL,
            payerAddress: PAYER,
            requireWatchId: true,
            watch: { ...WATCH, atomicAmount: '2' },
         }),
      /watch amount/,
   );
});


test('fresh x402 challenge policy fails before payload creation on changed spend terms', async () => {
   let payloadCreations = 0;

   const fakeScheme = {
      scheme: 'exact',
      findDefaultAsset: () => ({
         symbol: 'USDC',
         asset: String(USDC_MAINNET_ASA_ID),
         decimals: 6,
      }),
      createPaymentPayload: async () => {
         payloadCreations += 1;
         return {
            x402Version: 2,
            payload: {},
         };
      },
   };

   const client = new x402Client();
   client.register(ALGORAND_MAINNET, fakeScheme as never);
   installRoundWatchPaymentSafety(
      client,
      `${DEFAULT_SERVER_URL}/v1/watch`,
   );

   const approvedRequirement: PaymentRequirements = {
      scheme: 'exact',
      network: ALGORAND_MAINNET,
      amount: SERVICE_ATOMIC_AMOUNT,
      asset: String(USDC_MAINNET_ASA_ID),
      payTo: EXPECTED_RECEIVER,
      maxTimeoutSeconds: 60,
      extra: {
         tag: 'x402-global-challenge',
      },
   };

   const approvedRequired: PaymentRequired = {
      x402Version: 2,
      resource: {
         url: `${DEFAULT_SERVER_URL}/v1/watch`,
         description: 'RoundWatch',
         mimeType: 'application/json',
      },
      accepts: [approvedRequirement],
   };

   await client.createPaymentPayload(approvedRequired);
   assert.equal(payloadCreations, 1);

   const changedCases: PaymentRequired[] = [
      {
         ...approvedRequired,
         accepts: [{ ...approvedRequirement, amount: '1000000' }],
      },
      {
         ...approvedRequired,
         accepts: [{ ...approvedRequirement, payTo: PAYER }],
      },
      {
         ...approvedRequired,
         accepts: [{
            ...approvedRequirement,
            asset: String(USDC_MAINNET_ASA_ID + 1),
         }],
      },
      {
         ...approvedRequired,
         accepts: [{
            ...approvedRequirement,
            extra: { tag: 'wrong-tag' },
         }],
      },
      {
         ...approvedRequired,
         accepts: [{
            ...approvedRequirement,
            extra: {
               tag: 'x402-global-challenge',
               paymentFlow: 'upfront',
            },
         }],
      },
      {
         ...approvedRequired,
         resource: {
            ...approvedRequired.resource!,
            url: 'https://attacker.example/v1/watch',
         },
      },
   ];

   for (const changed of changedCases) {
      await assert.rejects(
         client.createPaymentPayload(changed),
         /SAFETY STOP|filtered out|spendControls/,
      );
      assert.equal(
         payloadCreations,
         1,
         'changed fresh challenge must be rejected before scheme payload creation',
      );
   }
});

test('approved payment preflight validates the exact RoundWatch resource and terms', () => {
   const requirement = {
      scheme: 'exact',
      network: ALGORAND_MAINNET,
      amount: SERVICE_ATOMIC_AMOUNT,
      asset: String(USDC_MAINNET_ASA_ID),
      payTo: EXPECTED_RECEIVER,
      maxTimeoutSeconds: 60,
      extra: {
         tag: 'x402-global-challenge',
      },
   } as PaymentRequirements;

   const required = {
      x402Version: 2,
      resource: {
         url: `${DEFAULT_SERVER_URL}/v1/watch`,
         description: 'RoundWatch',
         mimeType: 'application/json',
      },
      accepts: [requirement],
   } as PaymentRequired;

   assert.doesNotThrow(() =>
      assertApprovedRoundWatchPayment(
         required,
         `${DEFAULT_SERVER_URL}/v1/watch`,
      ),
   );

   assert.throws(
      () =>
         assertApprovedRoundWatchPayment(
            {
               ...required,
               resource: {
                  ...required.resource!,
                  url: 'https://other.example/v1/watch',
               },
            },
            `${DEFAULT_SERVER_URL}/v1/watch`,
         ),
      /resource URL mismatch/,
   );
});

test('recovery lookup cannot sign or settle and refuses to create a missing watch', async () => {
   const checkpoint: MainnetCheckpoint = {
      ...CHECKPOINT,
      watchId: undefined,
   };

   let requests = 0;
   const missingFetch: typeof fetch = async (input, init) => {
      requests += 1;
      assert.equal(
         String(input),
         `${DEFAULT_SERVER_URL}/v1/watch/recover`,
      );
      assert.equal(init?.method, 'POST');

      const headers = new Headers(init?.headers);
      assert.equal(headers.has('payment-signature'), false);

      const body = JSON.parse(String(init?.body)) as {
         servicePayer?: string;
      };
      assert.equal(body.servicePayer, PAYER);

      return Response.json(
         { error: 'Recoverable watch not found' },
         { status: 404 },
      );
   };

   await assert.rejects(
      recoverExistingMainnetWatch(
         missingFetch,
         checkpoint,
         DEFAULT_SERVER_URL,
      ),
      /will not sign or purchase a new watch/,
   );
   assert.equal(requests, 1);

   const existingFetch: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.has('payment-signature'), false);
      return Response.json({ watch: WATCH });
   };

   const recovered = await recoverExistingMainnetWatch(
      existingFetch,
      checkpoint,
      DEFAULT_SERVER_URL,
   );
   assert.equal(recovered.watchId, WATCH_ID);
});
