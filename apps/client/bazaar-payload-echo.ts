import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import algosdk from 'algosdk';
import { x402Client } from '@x402/fetch';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { ExactAvmScheme, toClientAvmSigner } from '@x402/avm';

import {
   ALGORAND_MAINNET,
   assertApprovedRoundWatchPayment,
   assertMainnetRuntimeSafety,
   DEFAULT_ALGOD_URL,
   DEFAULT_SERVER_URL,
   EXPECTED_RECEIVER,
   installRoundWatchPaymentSafety,
} from './mainnet-safety.js';

type JsonRecord = Record<string, unknown>;

export interface BazaarPayloadEchoInspection {
   serverDeclared: boolean;
   payloadEchoed: boolean;
   sameJsonShape: boolean;
   serverExtensionKeys: string[];
   payloadExtensionKeys: string[];
   bazaarInputType?: string;
   bazaarMethod?: string;
   bazaarBodyType?: string;
   bazaarOutputType?: string;
}

function asRecord(value: unknown): JsonRecord | undefined {
   return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonRecord
      : undefined;
}

function sortedKeys(value: unknown): string[] {
   const record = asRecord(value);
   return record ? Object.keys(record).sort() : [];
}

export function inspectBazaarPayloadEcho(
   paymentRequired: unknown,
   paymentPayload: unknown,
): BazaarPayloadEchoInspection {
   const requiredRoot = asRecord(paymentRequired);
   const payloadRoot = asRecord(paymentPayload);

   const requiredExtensions = requiredRoot
      ? asRecord(requiredRoot.extensions)
      : undefined;
   const payloadExtensions = payloadRoot
      ? asRecord(payloadRoot.extensions)
      : undefined;

   const requiredBazaar = requiredExtensions?.bazaar;
   const payloadBazaar = payloadExtensions?.bazaar;

   const bazaarRecord = asRecord(payloadBazaar);
   const info = bazaarRecord ? asRecord(bazaarRecord.info) : undefined;
   const input = info ? asRecord(info.input) : undefined;
   const output = info ? asRecord(info.output) : undefined;

   return {
      serverDeclared: requiredBazaar !== undefined,
      payloadEchoed: payloadBazaar !== undefined,
      sameJsonShape:
         requiredBazaar !== undefined &&
         payloadBazaar !== undefined &&
         JSON.stringify(requiredBazaar) === JSON.stringify(payloadBazaar),
      serverExtensionKeys: sortedKeys(requiredExtensions),
      payloadExtensionKeys: sortedKeys(payloadExtensions),
      ...(input && typeof input.type === 'string'
         ? { bazaarInputType: input.type }
         : {}),
      ...(input && typeof input.method === 'string'
         ? { bazaarMethod: input.method }
         : {}),
      ...(input && typeof input.bodyType === 'string'
         ? { bazaarBodyType: input.bodyType }
         : {}),
      ...(output && typeof output.type === 'string'
         ? { bazaarOutputType: output.type }
         : {}),
   };
}

function loadOptionalEnvFile(path: string): void {
   try {
      process.loadEnvFile(path);
   } catch (error) {
      if (
         error instanceof Error &&
         /ENOENT|no such file/i.test(error.message)
      ) {
         return;
      }
      throw error;
   }
}

async function main(): Promise<void> {
   loadOptionalEnvFile(resolve('../server/.env'));
   loadOptionalEnvFile(resolve('.env'));

   const serverUrl = (
      process.env.ROUNDWATCH_SERVER_URL ?? DEFAULT_SERVER_URL
   ).replace(/\/+$/, '');
   const algodUrl = process.env.ALGORAND_ALGOD_URL ?? DEFAULT_ALGOD_URL;
   const resourceUrl = `${serverUrl}/v1/watch`;

   assertMainnetRuntimeSafety(serverUrl, algodUrl);

   const configuredReceiver = process.env.AVM_ADDRESS;
   if (configuredReceiver && configuredReceiver !== EXPECTED_RECEIVER) {
      throw new Error(
         `AVM_ADDRESS does not match the approved MainNet receiver. Expected ${EXPECTED_RECEIVER}, received ${configuredReceiver}.`,
      );
   }

   const mnemonic = process.env.AVM_MNEMONIC;
   if (!mnemonic) {
      throw new Error(
         'Missing AVM_MNEMONIC in apps/client/.env. This probe signs a payment payload locally but never submits it.',
      );
   }

   const readiness = await fetch(`${serverUrl}/ready`);
   const readinessBody = await readiness.json() as {
      status?: string;
      network?: string;
   };

   if (
      !readiness.ok ||
      readinessBody.status !== 'ready' ||
      readinessBody.network !== 'mainnet'
   ) {
      throw new Error(
         `Production readiness preflight failed: HTTP ${readiness.status}; network=${readinessBody.network ?? 'unknown'}`,
      );
   }

   const account = algosdk.mnemonicToSecretKey(mnemonic);
   const nonce = randomUUID();
   const requestBody = {
      idempotencyKey: `bazaar-payload-probe-${nonce}`,
      expectedSender: account.addr.toString(),
      expectedReceiver: EXPECTED_RECEIVER,
      atomicAmount: '1',
      invoiceNote: `roundwatch:bazaar-payload-probe:${nonce}`,
   };

   const unpaid = await fetch(resourceUrl, {
      method: 'POST',
      headers: {
         accept: 'application/json',
         'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
   });

   if (unpaid.status !== 402) {
      throw new Error(
         `Expected unpaid HTTP 402, received ${unpaid.status}`,
      );
   }

   const paymentRequiredHeader = unpaid.headers.get('payment-required');
   if (!paymentRequiredHeader) {
      throw new Error('HTTP 402 did not contain PAYMENT-REQUIRED');
   }

   const paymentRequired = decodePaymentRequiredHeader(
      paymentRequiredHeader,
   );
   assertApprovedRoundWatchPayment(paymentRequired, resourceUrl);

   const signer = toClientAvmSigner(
      Buffer.from(account.sk).toString('base64'),
   );
   const client = new x402Client();
   client.register(ALGORAND_MAINNET, new ExactAvmScheme(signer));
   installRoundWatchPaymentSafety(client, resourceUrl);

   // Important: createPaymentPayload signs the x402 payment payload locally.
   // This script intentionally never serializes it into PAYMENT-SIGNATURE and
   // never performs the paid retry, so no settlement or broadcast can occur.
   const paymentPayload = await client.createPaymentPayload(paymentRequired);
   const inspection = inspectBazaarPayloadEcho(
      paymentRequired,
      paymentPayload,
   );

   const report = {
      generatedAt: new Date().toISOString(),
      resourceUrl,
      spendAuthorized: false,
      networkSubmissionPerformed: false,
      signedPayloadCreatedLocally: true,
      inspection,
   };

   console.log(JSON.stringify(report, null, 2));

   if (!inspection.serverDeclared) {
      throw new Error(
         'Live PaymentRequired did not declare the Bazaar extension',
      );
   }

   if (!inspection.payloadEchoed) {
      throw new Error(
         'The installed x402 client did not echo the Bazaar extension into PaymentPayload',
      );
   }

   if (!inspection.sameJsonShape) {
      throw new Error(
         'The installed x402 client changed the Bazaar declaration while creating PaymentPayload',
      );
   }

   console.log(
      'Bazaar payload echo verified locally. No paid retry was sent.',
   );
}

const invokedPath = process.argv[1];
if (
   invokedPath &&
   import.meta.url === pathToFileURL(invokedPath).href
) {
   void main().catch(error => {
      console.error('ROUNDWATCH BAZAAR PAYLOAD ECHO ERROR');
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
   });
}
