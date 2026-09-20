import assert from 'node:assert/strict';
import test from 'node:test';

import {
   ALGORAND_MAINNET,
   assertMainnetRuntimeSafety,
   DEFAULT_ALGOD_URL,
   DEFAULT_SERVER_URL,
   EXPECTED_RECEIVER,
   INVOICE_ATOMIC_AMOUNT,
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
