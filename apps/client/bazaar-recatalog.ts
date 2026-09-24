import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import algosdk from 'algosdk';
import {
   x402Client,
   wrapFetchWithPayment,
   x402HTTPClient,
} from '@x402/fetch';
import { ExactAvmScheme, toClientAvmSigner } from '@x402/avm';
import { decodePaymentRequiredHeader } from '@x402/core/http';

import {
   DEFAULT_ROUNDWATCH_RESOURCE_URL,
   inspectRoundWatchChallenge,
} from './discovery-qualification.js';
import {
   ALGORAND_MAINNET,
   assertApprovedRoundWatchPayment,
   assertMainnetRuntimeSafety,
   DEFAULT_ALGOD_URL,
   DEFAULT_SERVER_URL,
   EXPECTED_RECEIVER,
   installRoundWatchPaymentSafety,
   SERVICE_ATOMIC_AMOUNT,
} from './mainnet-safety.js';

const CONFIRM_FLAG = '--confirm-mainnet';
const EVIDENCE_PATH = resolve('data/bazaar-recatalog-mainnet.json');

type JsonRecord = Record<string, unknown>;

export interface BuyerExtensionSidechannelObservation {
   present: boolean;
   expectedPresent: false;
}

export function observeBuyerExtensionSidechannel(
   header: string | null,
): BuyerExtensionSidechannelObservation {
   return {
      present: header !== null,
      expectedPresent: false,
   };
}

function asRecord(value: unknown): JsonRecord | undefined {
   return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonRecord
      : undefined;
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

   const mode = process.argv[2];
   if (!['preflight', 'settle'].includes(mode ?? '')) {
      printUsage();
      process.exitCode = 2;
      return;
   }

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

   if (mode === 'preflight') {
      const request = makeWatchRequest(
         'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
      );
      const result = await inspectUnpaidChallenge(resourceUrl, request);
      console.log(JSON.stringify({
         mode: 'preflight',
         spendAuthorized: false,
         servicePriceAtomicAmount: SERVICE_ATOMIC_AMOUNT,
         challenge: result,
      }, null, 2));
      return;
   }

   if (!process.argv.includes(CONFIRM_FLAG)) {
      throw new Error(
         `This command settles one real MainNet RoundWatch service payment of 0.02 USDC plus the Algorand network fee. Re-run with ${CONFIRM_FLAG} only after explicit human authorization for this exact spend.`,
      );
   }

   const mnemonic = process.env.AVM_MNEMONIC;
   if (!mnemonic) {
      throw new Error('Missing AVM_MNEMONIC in apps/client/.env');
   }

   const account = algosdk.mnemonicToSecretKey(mnemonic);
   const payerAddress = account.addr.toString();
   const request = makeWatchRequest(payerAddress);

   const unpaid = await inspectUnpaidChallenge(resourceUrl, request);
   if (!unpaid.valid) {
      throw new Error(
         `Live Bazaar/x402 preflight failed: ${unpaid.errors.join('; ')}`,
      );
   }

   const signer = toClientAvmSigner(
      Buffer.from(account.sk).toString('base64'),
   );
   const client = new x402Client();
   client.register(ALGORAND_MAINNET, new ExactAvmScheme(signer));
   installRoundWatchPaymentSafety(client, resourceUrl);

   const fetchWithPayment = wrapFetchWithPayment(fetch, client);
   const paid = await fetchWithPayment(resourceUrl, {
      method: 'POST',
      headers: {
         accept: 'application/json',
         'content-type': 'application/json',
      },
      body: JSON.stringify(request),
   });

   const settlement = new x402HTTPClient(client).getPaymentSettleResponse(
      name => paid.headers.get(name),
   );
   const buyerExtensionSidechannel = observeBuyerExtensionSidechannel(
      paid.headers.get('extension-responses'),
   );

   let responseBody: unknown;
   try {
      responseBody = await paid.json();
   } catch {
      responseBody = undefined;
   }

   const responseRecord = asRecord(responseBody);
   const watchId =
      responseRecord && typeof responseRecord.watchId === 'string'
         ? responseRecord.watchId
         : undefined;

   const evidence = {
      generatedAt: new Date().toISOString(),
      mode: 'settle',
      resourceUrl,
      servicePriceAtomicAmount: SERVICE_ATOMIC_AMOUNT,
      paidHttpStatus: paid.status,
      paymentSettled: settlement?.success === true,
      settlementTransaction: settlement?.transaction,
      settlementNetwork: settlement?.network,
      watchId,
      buyerExtensionSidechannel,
   };

   mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
   writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
   });

   console.log(JSON.stringify(evidence, null, 2));
   console.log(`Evidence written to ${EVIDENCE_PATH}`);

   if (!paid.ok || !settlement?.success) {
      throw new Error(
         `MainNet Bazaar recatalog settlement failed: HTTP ${paid.status}; settled=${settlement?.success ?? false}`,
      );
   }

   if (!watchId) {
      throw new Error(
         'MainNet settlement succeeded but the RoundWatch response did not include a watchId',
      );
   }

   if (buyerExtensionSidechannel.present) {
      throw new Error(
         'Protocol violation: EXTENSION-RESPONSES is server-internal and must not be forwarded to the buyer',
      );
   }

   console.log(
      'Paid catalog-refresh evidence collected. Run probe:discovery again to verify catalog visibility.',
   );
}

function makeWatchRequest(expectedSender: string): Record<string, string> {
   const nonce = randomUUID();
   return {
      idempotencyKey: `bazaar-refresh-${nonce}`,
      expectedSender,
      expectedReceiver: EXPECTED_RECEIVER,
      atomicAmount: '1',
      invoiceNote: `roundwatch:bazaar-refresh:${nonce}`,
   };
}

async function inspectUnpaidChallenge(
   resourceUrl: string,
   body: Record<string, string>,
): Promise<ReturnType<typeof inspectRoundWatchChallenge>> {
   const unpaid = await fetch(resourceUrl, {
      method: 'POST',
      headers: {
         accept: 'application/json',
         'content-type': 'application/json',
      },
      body: JSON.stringify(body),
   });

   if (unpaid.status !== 402) {
      return {
         valid: false,
         errors: [`expected HTTP 402, received ${unpaid.status}`],
         tags: [],
      };
   }

   const header = unpaid.headers.get('payment-required');
   if (!header) {
      return {
         valid: false,
         errors: ['HTTP 402 did not contain PAYMENT-REQUIRED'],
         tags: [],
      };
   }

   const paymentRequired = decodePaymentRequiredHeader(header);
   assertApprovedRoundWatchPayment(paymentRequired, resourceUrl);
   return inspectRoundWatchChallenge(
      paymentRequired,
      DEFAULT_ROUNDWATCH_RESOURCE_URL,
   );
}

function printUsage(): void {
   console.log('Usage:');
   console.log(
      '  tsx bazaar-recatalog.ts preflight              # free/read-only; never signs or pays',
   );
   console.log(
      '  tsx bazaar-recatalog.ts settle --confirm-mainnet # spends exactly one 0.02 USDC service payment + network fee',
   );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
   void main().catch(error => {
      console.error('ROUNDWATCH BAZAAR RECATALOG ERROR');
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
   });
}
