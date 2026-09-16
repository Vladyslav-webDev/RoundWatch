import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import algosdk from 'algosdk';
import {
   x402Client,
   wrapFetchWithPayment,
   x402HTTPClient,
} from '@x402/fetch';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { ExactAvmScheme, toClientAvmSigner } from '@x402/avm';
import {
   ALGORAND_MAINNET,
   assertMainnetRuntimeSafety,
   CHALLENGE_TAG,
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

process.loadEnvFile(resolve('../server/.env'));
process.loadEnvFile(resolve('.env'));

const CONFIRM_FLAG = '--confirm-mainnet';

const serverUrl = (process.env.ROUNDWATCH_SERVER_URL ?? DEFAULT_SERVER_URL).replace(
   /\/+$/,
   '',
);
const algodUrl = process.env.ALGORAND_ALGOD_URL ?? DEFAULT_ALGOD_URL;
const mnemonic = process.env.AVM_MNEMONIC;
const configuredReceiver = process.env.AVM_ADDRESS;
const statePath = resolve('data/roundwatch-mainnet-live.json');

interface ReadyMainnetState extends MainnetCheckpoint {
   watchId: string;
}

async function main(): Promise<void> {
   const mode = process.argv[2];

   if (!['start', 'recover', 'status', 'pay'].includes(mode ?? '')) {
      printUsage();
      process.exit(2);
   }

   assertStaticSafety();

   if (mode === 'status') {
      const state = validateMainnetCheckpoint(readState(), {
         runtimeServerUrl: serverUrl,
      });
      if (!state.watchId) {
         console.log('MainNet checkpoint exists but has no watchId yet.');
         return;
      }

      const watch = await readWatch(state.watchId);
      validateMainnetCheckpoint(state, {
         runtimeServerUrl: serverUrl,
         requireWatchId: true,
         watch,
      });
      console.log(JSON.stringify({ checkpoint: state, watch }, null, 2));
      return;
   }

   requireExplicitConfirmation();
   const account = getPayerAccount();
   const sender = account.addr.toString();

   if (mode === 'start') {
      if (existsSync(statePath)) {
         throw new Error(
            `MainNet checkpoint already exists at ${statePath}. Refusing to create a second paid watch. Use status/recover/pay, or remove the checkpoint only after deliberate review.`,
         );
      }

      const state = await startWatch(account, sender);
      writeState(state);
      console.log(`MainNet checkpoint written to ${statePath}.`);
      return;
   }

   const state = validateMainnetCheckpoint(readState(), {
      runtimeServerUrl: serverUrl,
      payerAddress: sender,
      requireWatchId: mode === 'pay',
   });

   if (mode === 'recover') {
      const recovered = await recoverWatch(account, state);
      writeState(recovered);
      console.log(`Recovered MainNet checkpoint written to ${statePath}.`);
      return;
   }

   if (!state.watchId) {
      throw new Error('Checkpoint has no watchId. Run recover first.');
   }

   await payInvoice(account, state as ReadyMainnetState);
}

function assertStaticSafety(): void {
   assertMainnetRuntimeSafety(serverUrl, algodUrl);

   if (configuredReceiver && configuredReceiver !== EXPECTED_RECEIVER) {
      throw new Error(
         `AVM_ADDRESS does not match the approved MainNet receiver. Expected ${EXPECTED_RECEIVER}, received ${configuredReceiver}.`,
      );
   }
}

function requireExplicitConfirmation(): void {
   if (!process.argv.includes(CONFIRM_FLAG)) {
      throw new Error(
         `This command can spend real MainNet funds. Re-run with ${CONFIRM_FLAG} only after reviewing the preflight.`,
      );
   }
}

function getPayerAccount(): algosdk.Account {
   if (!mnemonic) {
      throw new Error('Missing AVM_MNEMONIC in apps/client/.env');
   }

   return algosdk.mnemonicToSecretKey(mnemonic);
}

async function startWatch(
   account: algosdk.Account,
   sender: string,
): Promise<ReadyMainnetState> {
   const health = await fetch(`${serverUrl}/health`);
   const healthBody = await health.json() as { status?: string; network?: string };

   if (!health.ok || healthBody.status !== 'ok' || healthBody.network !== 'mainnet') {
      throw new Error(
         `Production health preflight failed: HTTP ${health.status}; network=${healthBody.network ?? 'unknown'}`,
      );
   }

   const nonce = randomUUID();
   const requestBody: MainnetCheckpoint = {
      network: ALGORAND_MAINNET,
      assetId: USDC_MAINNET_ASA_ID,
      serverUrl: DEFAULT_SERVER_URL,
      idempotencyKey: `mainnet-${nonce}`,
      expectedSender: sender,
      expectedReceiver: EXPECTED_RECEIVER,
      atomicAmount: INVOICE_ATOMIC_AMOUNT,
      invoiceNote: `roundwatch:mainnet:${nonce}`,
   };

   // Persist before any paid retry so a client-side interruption can be recovered
   // without inventing a new idempotency key and risking a duplicate purchase.
   writeState(requestBody);

   const watchUrl = `${serverUrl}/v1/watch`;
   const unpaid = await fetch(watchUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(watchRequestBody(requestBody)),
   });

   if (unpaid.status !== 402) {
      throw new Error(`Expected unpaid HTTP 402, received ${unpaid.status}`);
   }

   const paymentRequiredHeader = unpaid.headers.get('payment-required');
   if (!paymentRequiredHeader) {
      throw new Error('HTTP 402 did not contain PAYMENT-REQUIRED');
   }

   assertPaymentRequirements(paymentRequiredHeader, watchUrl);
   console.log('MainNet unpaid preflight passed. No payment has been sent yet.');

   const client = createPaymentClient(account);
   const fetchWithPayment = wrapFetchWithPayment(fetch, client);
   const paid = await fetchWithPayment(watchUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(watchRequestBody(requestBody)),
   });
   const settlement = new x402HTTPClient(client).getPaymentSettleResponse(
      name => paid.headers.get(name),
   );

   if (!paid.ok || !settlement?.success) {
      throw new Error(
         `MainNet watch purchase failed: HTTP ${paid.status}; settled=${settlement?.success ?? false}`,
      );
   }

   if (settlement.network !== ALGORAND_MAINNET) {
      throw new Error(
         `Settlement returned unexpected network ${settlement.network}`,
      );
   }

   const created = await paid.json() as { watchId?: string };
   if (!created.watchId) {
      throw new Error('Paid MainNet response did not include a watchId');
   }

   const active = await readWatch(created.watchId);
   if (active.state !== 'active') {
      throw new Error(`Expected active MainNet watch, received ${active.state}`);
   }

   const completedCheckpoint = {
      ...requestBody,
      watchId: created.watchId,
      serviceSettlementTransaction: settlement.transaction,
   };
   validateMainnetCheckpoint(completedCheckpoint, {
      runtimeServerUrl: serverUrl,
      payerAddress: sender,
      requireWatchId: true,
      watch: active,
   });

   console.log(`MAINNET SERVICE SETTLEMENT: ${settlement.transaction}`);
   console.log(`MAINNET WATCH ACTIVE: ${created.watchId}`);

   return completedCheckpoint;
}

function assertPaymentRequirements(header: string, watchUrl: string): void {
   const decoded = decodePaymentRequiredHeader(header) as unknown as {
      resource?: { url?: string };
      accepts?: Array<{
         scheme?: string;
         network?: string;
         amount?: string;
         asset?: string;
         payTo?: string;
         extra?: Record<string, unknown>;
      }>;
   };

   if (decoded.resource?.url !== watchUrl) {
      throw new Error(
         `SAFETY STOP: x402 resource URL mismatch. Expected ${watchUrl}, received ${decoded.resource?.url ?? 'missing'}`,
      );
   }

   const option = decoded.accepts?.find(
      candidate =>
         candidate.scheme === 'exact' &&
         candidate.network === ALGORAND_MAINNET,
   );

   if (!option) {
      throw new Error('SAFETY STOP: no exact Algorand MainNet payment option');
   }

   const checks: Array<[string, unknown, string]> = [
      ['amount', option.amount, SERVICE_ATOMIC_AMOUNT],
      ['asset', option.asset, String(USDC_MAINNET_ASA_ID)],
      ['payTo', option.payTo, EXPECTED_RECEIVER],
      ['tag', option.extra?.tag, CHALLENGE_TAG],
   ];

   for (const [name, actual, expected] of checks) {
      if (actual !== expected) {
         throw new Error(
            `SAFETY STOP: x402 ${name} mismatch. Expected ${expected}, received ${String(actual)}`,
         );
      }
   }
}

async function recoverWatch(
   account: algosdk.Account,
   state: MainnetCheckpoint,
): Promise<ReadyMainnetState> {
   if (state.watchId) {
      const existing = await readWatch(state.watchId);
      validateMainnetCheckpoint(state, {
         runtimeServerUrl: serverUrl,
         payerAddress: account.addr.toString(),
         requireWatchId: true,
         watch: existing,
      });
      if (existing.state !== 'active' && existing.state !== 'matched') {
         throw new Error(`Existing MainNet watch is ${existing.state}, not recovered`);
      }

      console.log(`Existing MainNet watch ${state.watchId} is ${existing.state}.`);
      return state as ReadyMainnetState;
   }

   const client = createPaymentClient(account);
   const fetchWithPayment = wrapFetchWithPayment(fetch, client);
   const response = await fetchWithPayment(`${serverUrl}/v1/watch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
         idempotencyKey: state.idempotencyKey,
         expectedSender: state.expectedSender,
         expectedReceiver: state.expectedReceiver,
         atomicAmount: state.atomicAmount,
         invoiceNote: state.invoiceNote,
      }),
   });

   const unexpectedSettlement = new x402HTTPClient(client).getPaymentSettleResponse(
      name => response.headers.get(name),
   );

   if (unexpectedSettlement?.success) {
      throw new Error(
         `SAFETY STOP: recovery unexpectedly settled another payment: ${unexpectedSettlement.transaction}`,
      );
   }

   if (response.status !== 409) {
      throw new Error(
         `Expected duplicate recovery HTTP 409 without a second settlement; received ${response.status}`,
      );
   }

   const body = await response.json() as { watch?: MainnetWatchSnapshot };
   if (!body.watch?.id) {
      throw new Error('Recovery response did not expose the existing watchId');
   }

   if (body.watch.state !== 'active' && body.watch.state !== 'matched') {
      throw new Error(`Recovered MainNet watch is ${body.watch.state}`);
   }

   console.log(
      `MAINNET WATCH RECOVERED: ${body.watch.id}; duplicate request did not settle again.`,
   );

   const recovered = {
      ...state,
      watchId: body.watch.id,
   };

   validateMainnetCheckpoint(recovered, {
      runtimeServerUrl: serverUrl,
      payerAddress: account.addr.toString(),
      requireWatchId: true,
      watch: body.watch,
   });

   return recovered as ReadyMainnetState;
}

async function payInvoice(
   account: algosdk.Account,
   state: ReadyMainnetState,
): Promise<void> {
   const active = await readWatch(state.watchId);
   validateMainnetCheckpoint(state, {
      runtimeServerUrl: serverUrl,
      payerAddress: account.addr.toString(),
      requireWatchId: true,
      watch: active,
   });
   if (active.state === 'matched') {
      console.log(
         `MainNet watch is already matched by ${active.matchedTransaction ?? 'unknown transaction'} at round ${active.matchedRound ?? 'unknown'}.`,
      );
      return;
   }

   if (active.state !== 'active') {
      throw new Error(`Expected active MainNet watch, received ${active.state}`);
   }

   const algod = new algosdk.Algodv2('', algodUrl, '');
   const suggestedParams = await algod.getTransactionParams().do();
   const transaction = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: state.expectedSender,
      receiver: state.expectedReceiver,
      amount: Number(state.atomicAmount),
      assetIndex: USDC_MAINNET_ASA_ID,
      note: new TextEncoder().encode(state.invoiceNote),
      suggestedParams,
   });
   const transactionId = transaction.txID();
   const signedTransaction = transaction.signTxn(account.sk);

   await algod.sendRawTransaction(signedTransaction).do();
   const confirmation = await algosdk.waitForConfirmation(
      algod,
      transactionId,
      8,
   );

   console.log(
      `MAINNET INVOICE PAYMENT: ${transactionId} at round ${confirmation.confirmedRound}`,
   );

   const matched = await waitForMatched(state.watchId, 60_000);
   console.log(
      `MAINNET MATCHED: ${matched.matchedTransaction} at round ${matched.matchedRound}`,
   );
}

function createPaymentClient(account: algosdk.Account): x402Client {
   const signer = toClientAvmSigner(Buffer.from(account.sk).toString('base64'));
   const client = new x402Client();
   client.register(ALGORAND_MAINNET, new ExactAvmScheme(signer));
   return client;
}

function writeState(state: MainnetCheckpoint): void {
   mkdirSync(dirname(statePath), { recursive: true });
   writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
   });
}

function readState(): unknown {
   if (!existsSync(statePath)) {
      throw new Error(`MainNet checkpoint does not exist: ${statePath}`);
   }

   return JSON.parse(readFileSync(statePath, 'utf8')) as unknown;
}

async function readWatch(watchId: string): Promise<MainnetWatchSnapshot> {
   const response = await fetch(`${serverUrl}/v1/watch/${watchId}`);
   if (!response.ok) {
      throw new Error(`MainNet watch status failed with HTTP ${response.status}`);
   }

   const body = await response.json() as { watch: MainnetWatchSnapshot };
   return body.watch;
}

async function waitForMatched(
   watchId: string,
   timeoutMilliseconds: number,
): Promise<MainnetWatchSnapshot> {
   const deadline = Date.now() + timeoutMilliseconds;

   while (Date.now() < deadline) {
      const watch = await readWatch(watchId);
      if (watch.state === 'matched') {
         return watch;
      }

      await new Promise(resolveTimeout => setTimeout(resolveTimeout, 2_000));
   }

   throw new Error('MainNet watch did not transition to matched before timeout');
}

function watchRequestBody(state: MainnetCheckpoint): Record<string, string> {
   return {
      idempotencyKey: state.idempotencyKey,
      expectedSender: state.expectedSender,
      expectedReceiver: state.expectedReceiver,
      atomicAmount: state.atomicAmount,
      invoiceNote: state.invoiceNote,
   };
}

function printUsage(): void {
   console.log('Usage:');
   console.log('  tsx mainnet-e2e.ts start --confirm-mainnet   # spends 0.001 USDC service payment');
   console.log('  tsx mainnet-e2e.ts recover --confirm-mainnet # recovery only; must not settle again');
   console.log('  tsx mainnet-e2e.ts status                    # read-only');
   console.log('  tsx mainnet-e2e.ts pay --confirm-mainnet     # spends 0.000001 USDC invoice payment + network fee');
}

main().catch(error => {
   console.error('ROUNDWATCH MAINNET E2E ERROR');
   console.error(error instanceof Error ? error.message : error);
   process.exit(1);
});
