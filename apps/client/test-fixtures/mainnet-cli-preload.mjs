// Isolated-process stubs for the production CLI. Never loads real secrets or
// contacts a service; package exports are patched in memory, not on disk.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const config = JSON.parse(fs.readFileSync(process.env.RW_TEST_CONFIGURATION, 'utf8'));
const require = createRequire(config.clientPackage);
const sdkDirectory = dirname(require.resolve('algosdk'));
const trace = {
   account: 0, signingKey: 0, algod: 0, params: 0, construction: 0,
   signing: 0, submission: 0, confirmation: 0, paymentClient: 0,
   paymentPayload: 0, outbound: 0, envLoads: 0, checkpointReads: 0,
   checkpointWrites: 0, jsonReads: 0, requests: [], order: [],
};
const writeFile = fs.writeFileSync;
const readFile = fs.readFileSync;
process.on('exit', () => writeFile(config.tracePath, JSON.stringify(trace)));

process.loadEnvFile = filename => {
   assert.ok([
      resolve('../server/.env'), resolve('.env'),
   ].includes(filename), 'Unexpected environment-file path');
   trace.envLoads += 1;
};
process.env.AVM_MNEMONIC = 'synthetic-only-account-factory-stub';
process.env.ROUNDWATCH_SERVER_URL = config.serverUrl;
process.env.ALGORAND_ALGOD_URL = config.algodUrl;
process.env.AVM_ADDRESS = config.receiver;

fs.readFileSync = (filename, ...args) => {
   if (String(filename) === config.statePath) trace.checkpointReads += 1;
   return readFile(filename, ...args);
};
fs.writeFileSync = (filename, ...args) => {
   if (String(filename) === config.statePath) trace.checkpointWrites += 1;
   return writeFile(filename, ...args);
};
net.Socket.prototype.connect = () => {
   trace.outbound += 1;
   throw new Error('Real network access forbidden in offline CLI tests');
};
syncBuiltinESMExports();

const { default: realSdk } = await import(pathToFileURL(join(sdkDirectory, '../esm/index.js')).href);
const sdk = { ...realSdk };
sdk.mnemonicToSecretKey = mnemonic => {
   assert.equal(mnemonic, 'synthetic-only-account-factory-stub');
   trace.account += 1;
   trace.order.push('account');
   return {
      addr: { toString: () => { trace.order.push('payer'); return config.payer; } },
      get sk() { trace.signingKey += 1; return new Uint8Array([1, 2, 3]); },
   };
};
sdk.Algodv2 = class {
   constructor() { trace.algod += 1; trace.order.push('algod'); }
   getTransactionParams() {
      trace.params += 1;
      trace.order.push('params');
      return { do: async () => ({ synthetic: true }) };
   }
   sendRawTransaction(signed) {
      assert.deepEqual(Array.from(signed), [4, 5, 6]);
      trace.submission += 1;
      trace.order.push('submission');
      return { do: async () => ({}) };
   }
};
sdk.makeAssetTransferTxnWithSuggestedParamsFromObject = args => {
   trace.construction += 1;
   trace.order.push('construction');
   trace.transfer = {
      sender: args.sender, receiver: args.receiver, amount: args.amount,
      assetIndex: args.assetIndex, note: Array.from(args.note),
   };
   return {
      txID: () => 'SYNTHETIC-INVOICE-TRANSACTION',
      signTxn: key => {
         assert.deepEqual(Array.from(key), [1, 2, 3]);
         trace.signing += 1;
         trace.order.push('signing');
         return new Uint8Array([4, 5, 6]);
      },
   };
};
sdk.waitForConfirmation = async () => {
   trace.confirmation += 1;
   trace.order.push('confirmation');
   return { confirmedRound: 123 };
};

// ESM SDK exports are immutable. Redirect only the CLI's SDK import to a
// synthetic default export; all production CLI control flow remains real.
globalThis.__roundwatchCliSdk = sdk;
registerHooks({
   resolve(specifier, context, nextResolve) {
      if (specifier === 'algosdk' && context.parentURL === pathToFileURL(config.cliPath).href) {
         return {
            url: 'data:text/javascript,export default globalThis.__roundwatchCliSdk;',
            shortCircuit: true,
         };
      }
      return nextResolve(specifier, context);
   },
});

// Cover the SDK's require and import builds, whichever the CLI loader uses.
const paymentModules = [
   require('@x402/fetch'),
   await import(pathToFileURL(join(dirname(require.resolve('@x402/fetch')), '../esm/index.mjs')).href),
];
for (const { x402Client } of paymentModules) {
   x402Client.prototype.register = () => {
      trace.paymentClient += 1;
      throw new Error('Recovery must not initialize a payment client');
   };
   x402Client.prototype.createPaymentPayload = async () => {
      trace.paymentPayload += 1;
      throw new Error('Recovery must not create a payment payload');
   };
}

globalThis.fetch = async (input, init) => {
   const url = String(input);
   const method = init?.method ?? 'GET';
   const headers = new Headers(init?.headers);
   assert.equal(headers.has('payment-signature'), false);
   const expectedUrl = config.checkpoint.watchId
      ? `${config.serverUrl}/v1/watch/${config.checkpoint.watchId}`
      : `${config.serverUrl}/v1/watch/recover`;
   assert.equal(url, expectedUrl, 'Unexpected request or paid watch fallback');
   assert.equal(method, config.checkpoint.watchId ? 'GET' : 'POST');
   if (method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), {
         idempotencyKey: config.checkpoint.idempotencyKey,
         expectedSender: config.checkpoint.expectedSender,
         expectedReceiver: config.checkpoint.expectedReceiver,
         atomicAmount: config.checkpoint.atomicAmount,
         invoiceNote: config.checkpoint.invoiceNote,
         servicePayer: config.checkpoint.expectedSender,
      });
   }
   trace.requests.push({ url, method, paymentSignature: false });
   trace.order.push('request');
   const body = config.rawBody ?? JSON.stringify(trace.requests.length > 1
      ? { watch: { ...config.watch, state: 'matched', matchedTransaction: 'synthetic-match', matchedRound: 123 } }
      : { watch: config.watch });
   const response = new Response(config.status === 204 ? null : body, { status: config.status });
   const readJson = response.json.bind(response);
   response.json = async () => {
      trace.jsonReads += 1;
      const result = await readJson();
      if (result?.watch && typeof result.watch === 'object') {
         const state = result.watch.state;
         const sender = result.watch.expectedSender;
         Object.defineProperty(result.watch, 'state', {
            get() { trace.order.push(`state:${state}`); return state; },
            enumerable: true,
         });
         Object.defineProperty(result.watch, 'expectedSender', {
            get() { trace.order.push('identity'); return sender; },
            enumerable: true,
         });
      }
      return result;
   };
   return response;
};
trace.ready = true;
