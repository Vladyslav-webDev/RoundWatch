import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import algosdk from 'algosdk';
import {
   x402Client,
   wrapFetchWithPayment,
   x402HTTPClient,
} from '@x402/fetch';
import { ExactAvmScheme, toClientAvmSigner } from '@x402/avm';

process.loadEnvFile(resolve('../server/.env'));
process.loadEnvFile(resolve('.env'));

const ALGORAND_TESTNET =
   'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=' as const;
const USDC_TESTNET_ASA_ID = 10_458_941;
const serverUrl = process.env.ROUNDWATCH_SERVER_URL ?? 'http://localhost:4021';
const algodUrl =
   process.env.ALGORAND_ALGOD_URL ?? 'https://testnet-api.algonode.cloud';
const mnemonic = process.env.AVM_MNEMONIC;
const receiver = process.env.AVM_ADDRESS;
const statePath = resolve('data/roundwatch-live.json');

if (!mnemonic || !receiver) {
   throw new Error('AVM_MNEMONIC or AVM_ADDRESS is missing');
}

async function main(): Promise<void> {
   const account = algosdk.mnemonicToSecretKey(mnemonic!);
   const sender = account.addr.toString();

   if (process.argv[2] === 'prepare') {
      const state = await prepareWatch(account, sender);
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
         encoding: 'utf8',
         mode: 0o600,
      });
      console.log(`Restart checkpoint written to ${statePath}.`);
      return;
   }

   if (process.argv[2] === 'pay') {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as LiveState;
      await payInvoice(account, state);
      return;
   }

   const state = await prepareWatch(account, sender);
   await payInvoice(account, state);
}

async function prepareWatch(
   account: algosdk.Account,
   sender: string,
): Promise<LiveState> {
   const nonce = randomUUID();
   const requestBody = {
      idempotencyKey: `roundwatch-${nonce}`,
      expectedSender: sender,
      expectedReceiver: receiver!,
      atomicAmount: '1',
      invoiceNote: `roundwatch:${nonce}`,
   };
   const watchUrl = `${serverUrl}/spike/watch`;

   const unpaid = await fetch(watchUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
   });

   if (unpaid.status !== 402) {
      throw new Error(`Expected unpaid HTTP 402, received ${unpaid.status}`);
   }

   console.log('Unpaid spike request returned HTTP 402.');

   const signer = toClientAvmSigner(Buffer.from(account.sk).toString('base64'));
   const client = new x402Client();
   client.register(ALGORAND_TESTNET, new ExactAvmScheme(signer));
   const fetchWithPayment = wrapFetchWithPayment(fetch, client);

   const paid = await fetchWithPayment(watchUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
   });
   const settlement = new x402HTTPClient(client).getPaymentSettleResponse(
      name => paid.headers.get(name),
   );

   if (!paid.ok || !settlement?.success) {
      throw new Error(
         `Watch service payment failed: HTTP ${paid.status}; settled=${settlement?.success ?? false}`,
      );
   }

   const created = await paid.json() as { watchId?: string };

   if (!created.watchId) {
      throw new Error('Paid response did not include a watch ID');
   }

   console.log(`Service settlement confirmed: ${settlement.transaction}`);
   console.log(`Durable watch created: ${created.watchId}`);

   const active = await readWatch(created.watchId);

   if (active.state !== 'active') {
      throw new Error(`Expected active watch, received ${active.state}`);
   }

   return {
      ...requestBody,
      watchId: created.watchId,
   };
}

async function payInvoice(
   account: algosdk.Account,
   state: LiveState,
): Promise<void> {
   const active = await readWatch(state.watchId);

   if (active.state !== 'active') {
      throw new Error(`Expected recovered active watch, received ${active.state}`);
   }

   const algod = new algosdk.Algodv2('', algodUrl, '');
   const suggestedParams = await algod.getTransactionParams().do();
   const transaction = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: state.expectedSender,
      receiver: state.expectedReceiver,
      amount: Number(state.atomicAmount),
      assetIndex: USDC_TESTNET_ASA_ID,
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
      `Separate invoice payment confirmed: ${transactionId} at round ${confirmation.confirmedRound}`,
   );

   const matched = await waitForMatched(state.watchId, 60_000);
   console.log(
      `Recovered watcher matched ${matched.matchedTransaction} at round ${matched.matchedRound}.`,
   );
}

interface PublicWatch {
   state: string;
   matchedTransaction?: string;
   matchedRound?: number;
}

interface LiveState {
   idempotencyKey: string;
   expectedSender: string;
   expectedReceiver: string;
   atomicAmount: string;
   invoiceNote: string;
   watchId: string;
}

async function readWatch(watchId: string): Promise<PublicWatch> {
   const response = await fetch(`${serverUrl}/spike/watch/${watchId}`);

   if (!response.ok) {
      throw new Error(`Watch status failed with HTTP ${response.status}`);
   }

   const body = await response.json() as { watch: PublicWatch };
   return body.watch;
}

async function waitForMatched(
   watchId: string,
   timeoutMilliseconds: number,
): Promise<PublicWatch> {
   const deadline = Date.now() + timeoutMilliseconds;

   while (Date.now() < deadline) {
      const watch = await readWatch(watchId);

      if (watch.state === 'matched') {
         return watch;
      }

      await new Promise(resolveTimeout => setTimeout(resolveTimeout, 2_000));
   }

   throw new Error('Watch did not transition to matched before timeout');
}

main().catch(error => {
   console.error('ROUNDWATCH SPIKE ERROR');
   console.error(error instanceof Error ? error.message : error);
   process.exit(1);
});
