import assert from 'node:assert/strict';
import test from 'node:test';

import algosdk from 'algosdk';
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
   validateRecoveredMainnetCheckpoint,
   type MainnetCheckpoint,
   type MainnetWatchSnapshot,
} from './mainnet-safety.js';
import { payInvoice, recoverWatch } from './mainnet-e2e.js';

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
   serviceTransaction: 'A'.repeat(52),
   servicePayer: PAYER,
   expectedServicePayer: PAYER,
};

// An accidental use of the real fetch must fail locally, including in CLI helpers.
test.before(() => {
   test.mock.method(globalThis, 'fetch', async () => {
      throw new Error('Unexpected outbound fetch in offline MainNet tests');
   });
});
test.after(() => test.mock.restoreAll());

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

test('MainNet service safety amount is the repriced 0.10 USDC contract', () => {
   assert.equal(SERVICE_ATOMIC_AMOUNT, '100000');
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

test('status inspection can validate an expired watch without making it payable', () => {
   const expired = { ...WATCH, state: 'expired' };

   assert.deepEqual(
      validateMainnetCheckpoint(CHECKPOINT, {
         runtimeServerUrl: DEFAULT_SERVER_URL,
         payerAddress: PAYER,
         requireWatchId: true,
         requirePayableWatch: false,
         watch: expired,
      }),
      CHECKPOINT,
   );

   assert.throws(
      () =>
         validateMainnetCheckpoint(CHECKPOINT, {
            runtimeServerUrl: DEFAULT_SERVER_URL,
            payerAddress: PAYER,
            requireWatchId: true,
            watch: expired,
         }),
      /state is not payable: expired/,
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
      /will not sign or purchase a new watch; no payment was attempted/,
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

const UNRECOVERED_CHECKPOINT: MainnetCheckpoint = {
   ...CHECKPOINT,
   watchId: undefined,
};

function recoveryResponse(body: unknown, status = 200) {
   let requests = 0;
   const fetchImpl: typeof fetch = async (input, init) => {
      requests += 1;
      assert.equal(String(input), `${DEFAULT_SERVER_URL}/v1/watch/recover`);
      assert.equal(init?.method, 'POST');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('content-type'), 'application/json');
      assert.equal(headers.has('payment-signature'), false);
      assert.deepEqual(JSON.parse(String(init?.body)), {
         idempotencyKey: CHECKPOINT.idempotencyKey,
         expectedSender: PAYER,
         expectedReceiver: EXPECTED_RECEIVER,
         atomicAmount: INVOICE_ATOMIC_AMOUNT,
         invoiceNote: CHECKPOINT.invoiceNote,
         servicePayer: PAYER,
      });
      return Response.json(body, { status });
   };
   return { fetchImpl, requestCount: () => requests };
}

for (const state of ['active', 'matched', 'expired', 'indeterminate']) {
   test(`free MainNet recovery restores the watchId for settled ${state}`, async () => {
      const response = recoveryResponse({ watch: { ...WATCH, state } });
      const recovered = await recoverExistingMainnetWatch(
         response.fetchImpl,
         UNRECOVERED_CHECKPOINT,
         DEFAULT_SERVER_URL,
      );
      assert.deepEqual(recovered, CHECKPOINT);
      assert.equal(UNRECOVERED_CHECKPOINT.watchId, undefined);
      assert.equal(response.requestCount(), 1);
   });

   test(`CLI recovery with an existing watchId accepts settled ${state}`, async () => {
      let statusReads = 0;
      const recovered = await recoverWatch(CHECKPOINT, async watchId => {
         statusReads += 1;
         assert.equal(watchId, WATCH_ID);
         return { ...WATCH, state };
      });
      assert.deepEqual(recovered, CHECKPOINT);
      assert.equal(statusReads, 1);
   });

   test(`MainNet recovery refuses ${state} without confirmed settlement`, async () => {
      for (const serviceTransaction of [undefined, '']) {
         const watch = { ...WATCH, state, serviceTransaction };
         const response = recoveryResponse({ watch });
         await assert.rejects(
            recoverExistingMainnetWatch(
               response.fetchImpl,
               UNRECOVERED_CHECKPOINT,
               DEFAULT_SERVER_URL,
            ),
            /settlement is not confirmed; not recovered/,
         );
         await assert.rejects(
            recoverWatch(CHECKPOINT, async () => watch),
            /settlement is not confirmed; not recovered/,
         );
         assert.equal(response.requestCount(), 1);
      }
   });
}

for (const state of ['settlement_pending', 'settlement_unknown', 'unknown_state']) {
   test(`MainNet recovery fails closed on HTTP 200 with ${state}`, async () => {
      const watch = { ...WATCH, state };
      const response = recoveryResponse({ watch });
      await assert.rejects(
         recoverExistingMainnetWatch(
            response.fetchImpl,
            UNRECOVERED_CHECKPOINT,
            DEFAULT_SERVER_URL,
         ),
         new RegExp(`state is not recoverable: ${state}`),
      );
      await assert.rejects(
         recoverWatch(CHECKPOINT, async () => watch),
         new RegExp(`state is not recoverable: ${state}`),
      );
      assert.equal(response.requestCount(), 1);

      assert.throws(() => validateMainnetCheckpoint(CHECKPOINT, {
         runtimeServerUrl: DEFAULT_SERVER_URL,
         requireWatchId: true,
         watch,
      }), /state is not payable/);
      assert.deepEqual(validateMainnetCheckpoint(CHECKPOINT, {
         runtimeServerUrl: DEFAULT_SERVER_URL,
         requireWatchId: true,
         requirePayableWatch: false,
         watch,
      }), CHECKPOINT, 'status inspection remains available');
   });
}

for (const status of [201, 202, 402, 409, 500]) {
   test(`MainNet recovery HTTP ${status} fails without a paid retry`, async () => {
      const response = recoveryResponse({ watch: WATCH }, status);
      await assert.rejects(
         recoverExistingMainnetWatch(
            response.fetchImpl,
            UNRECOVERED_CHECKPOINT,
            DEFAULT_SERVER_URL,
         ),
         new RegExp(`HTTP ${status}; no payment was attempted`),
      );
      assert.equal(response.requestCount(), 1);
   });
}

test('MainNet recovery rejects missing or invalid returned watchIds', async () => {
   for (const id of [undefined, '', 'invalid-watch-id', 42]) {
      const response = recoveryResponse({ watch: { ...WATCH, id } });
      await assert.rejects(
         recoverExistingMainnetWatch(
            response.fetchImpl,
            UNRECOVERED_CHECKPOINT,
            DEFAULT_SERVER_URL,
         ),
         /watchId/,
      );
      assert.equal(response.requestCount(), 1);
   }
});

const WATCH_MISMATCHES: Array<[string, Partial<MainnetWatchSnapshot>]> = [
   ['sender', { expectedSender: EXPECTED_RECEIVER }],
   ['receiver', { expectedReceiver: PAYER }],
   ['asset', { assetId: USDC_MAINNET_ASA_ID + 1 }],
   ['amount', { atomicAmount: '2' }],
   ['note', { invoiceNote: 'different-invoice' }],
   ['service payer', { servicePayer: EXPECTED_RECEIVER }],
   ['expected service payer', { expectedServicePayer: EXPECTED_RECEIVER }],
];

for (const state of ['expired', 'indeterminate']) {
   for (const [field, mismatch] of WATCH_MISMATCHES) {
      test(`terminal ${state} recovery rejects mismatched ${field}`, async () => {
         const watch = { ...WATCH, state, ...mismatch };
         const response = recoveryResponse({ watch });
         const message = /MainNet watch .* does not match the checkpoint/;
         await assert.rejects(
            recoverExistingMainnetWatch(
               response.fetchImpl,
               UNRECOVERED_CHECKPOINT,
               DEFAULT_SERVER_URL,
            ),
            message,
         );
         await assert.rejects(
            recoverWatch(CHECKPOINT, async () => watch),
            message,
         );
         assert.equal(response.requestCount(), 1);
      });
   }

   test(`terminal ${state} recovery rejects mismatched watchId or configured payer`, async () => {
      await assert.rejects(recoverWatch(CHECKPOINT, async () => ({
         ...WATCH,
         state,
         id: NONCE,
      })), /does not match the checkpoint watchId/);
      assert.throws(() => validateRecoveredMainnetCheckpoint(
         CHECKPOINT,
         { ...WATCH, state },
         DEFAULT_SERVER_URL,
         EXPECTED_RECEIVER,
      ), /does not match the configured payer/);
   });
}

test('CLI free recovery never signs or initializes an x402 payment action', async t => {
   const signer = t.mock.method(algosdk.Transaction.prototype, 'signTxn', () => {
      throw new Error('Recovery must not sign');
   });
   const registration = t.mock.method(x402Client.prototype, 'register', () => {
      throw new Error('Recovery must not initialize an x402 payment action');
   });
   const payment = t.mock.method(x402Client.prototype, 'createPaymentPayload', async () => {
      throw new Error('Recovery must not create an x402 payment');
   });
   for (const status of [200, 404, 402, 409, 500]) {
      const response = recoveryResponse({ watch: { ...WATCH, state: 'expired' } }, status);
      const recovery = recoverWatch(
         UNRECOVERED_CHECKPOINT,
         async () => { throw new Error('No watchId to inspect before recovery'); },
         response.fetchImpl,
      );
      if (status === 200) {
         assert.deepEqual(await recovery, CHECKPOINT);
      } else {
         await assert.rejects(recovery, /no payment was attempted/);
      }
      assert.equal(response.requestCount(), 1);
   }
   assert.equal(signer.mock.callCount(), 0);
   assert.equal(registration.mock.callCount(), 0);
   assert.equal(payment.mock.callCount(), 0);
});

for (const state of ['expired', 'indeterminate', 'matched']) {
   test(`pay after ${state} recovery performs no Algod fetch, signing, or submission`, async t => {
      const watch = { ...WATCH, state };
      const response = recoveryResponse({ watch });
      const recovered = await recoverExistingMainnetWatch(
         response.fetchImpl,
         UNRECOVERED_CHECKPOINT,
         DEFAULT_SERVER_URL,
      );
      const calls = { algod: 0, params: 0, signingKey: 0, signing: 0, submission: 0 };
      const payer = {
         addr: { toString: () => PAYER },
         get sk() {
            calls.signingKey += 1;
            throw new Error('Payment must not access a signing key');
         },
      } as unknown as algosdk.Account;
      t.mock.method(algosdk.Transaction.prototype, 'signTxn', () => {
         calls.signing += 1;
         throw new Error('Payment must not sign');
      });
      const createAlgod = () => {
         calls.algod += 1;
         return {
            getTransactionParams: () => {
               calls.params += 1;
               throw new Error('Payment must not fetch Algod parameters');
            },
            sendRawTransaction: () => {
               calls.submission += 1;
               throw new Error('Payment must not submit a raw transaction');
            },
         } as unknown as algosdk.Algodv2;
      };
      let reads = 0;
      const pay = payInvoice(() => payer, recovered, async watchId => {
         reads += 1;
         assert.equal(watchId, WATCH_ID);
         return watch;
      }, createAlgod);
      if (state === 'matched') {
         await pay;
      } else {
         await assert.rejects(pay, new RegExp(`state is not payable: ${state}`));
         assert.throws(() => validateMainnetCheckpoint(recovered, {
            runtimeServerUrl: DEFAULT_SERVER_URL,
            payerAddress: PAYER,
            requireWatchId: true,
            watch,
         }), new RegExp(`state is not payable: ${state}`));
      }
      assert.equal(reads, 1, 'pay must read the current watch state');
      assert.deepEqual(calls, {
         algod: 0, params: 0, signingKey: 0, signing: 0, submission: 0,
      });
   });
}
