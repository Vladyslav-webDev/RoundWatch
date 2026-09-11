import { config } from 'dotenv';

import {
   x402Client,
   wrapFetchWithPayment,
   x402HTTPClient,
} from '@x402/fetch';

import {
   toClientAvmSigner,
   ExactAvmScheme,
} from '@x402/avm';

import algosdk from 'algosdk';

config();

const avmMnemonic = process.env.AVM_MNEMONIC;

if (!avmMnemonic) {
   throw new Error('Missing AVM_MNEMONIC in apps/client/.env');
}

const payerMnemonic: string = avmMnemonic;


const url = 'http://localhost:4021/demo';

// Do NOT use ALGORAND_TESTNET_CAIP2 from @x402/avm@2.25.0 here.
// That installed version currently exposes a truncated TestNet identifier.
const ALGORAND_TESTNET =
   'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=' as const;

async function main(): Promise<void> {
   console.log('1. Plain request');

   const plainResponse = await fetch(url, {
      method: 'GET',
   });

   console.log(
      `Plain response: ${plainResponse.status} ${plainResponse.statusText}`,
   );

   if (plainResponse.status !== 402) {
      throw new Error(
         `Expected HTTP 402 before payment, received ${plainResponse.status}`,
      );
   }

   console.log('\n2. Preparing payer');

   const secretKey = getSecretKeyFromMnemonic(payerMnemonic);
   const avmSigner = toClientAvmSigner(secretKey);

   console.log(`Payer address: ${avmSigner.address}`);

   const client = new x402Client();

   client.register(
      ALGORAND_TESTNET,
      new ExactAvmScheme(avmSigner),
   );

   const fetchWithPayment = wrapFetchWithPayment(fetch, client);

   console.log('\n3. Sending x402 paid request');

   const response = await fetchWithPayment(url, {
      method: 'GET',
   });

   console.log(
      `Paid response: ${response.status} ${response.statusText}`,
   );

   if (!response.ok) {
      const body = await response.text();
      throw new Error(
         `Paid request failed with ${response.status}: ${body}`,
      );
   }

   const paymentResponse = new x402HTTPClient(
      client,
   ).getPaymentSettleResponse(name => response.headers.get(name));

   console.log('\n4. Settlement');
   console.log(JSON.stringify(paymentResponse, null, 2));

   const data = await response.json();

   console.log('\n5. Resource response');
   console.log(JSON.stringify(data, null, 2));
}

function getSecretKeyFromMnemonic(
   mnemonic: string,
): string {
   const account = algosdk.mnemonicToSecretKey(mnemonic);

   return Buffer.from(account.sk).toString('base64');
}

main().catch(error => {
   console.error('\nCLIENT ERROR');
   console.error(error?.response?.data?.error ?? error);
   process.exit(1);
});