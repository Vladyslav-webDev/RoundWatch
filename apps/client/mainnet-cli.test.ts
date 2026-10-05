import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
   ALGORAND_MAINNET, DEFAULT_ALGOD_URL, DEFAULT_SERVER_URL, EXPECTED_RECEIVER,
   INVOICE_ATOMIC_AMOUNT, USDC_MAINNET_ASA_ID,
   type MainnetCheckpoint, type MainnetWatchSnapshot,
} from './mainnet-safety.js';

const clientDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cliPath = join(clientDirectory, 'mainnet-e2e.ts');
const preloadPath = join(clientDirectory, 'test-fixtures/mainnet-cli-preload.mjs');
const PAYER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const WATCH_ID = '223e4567-e89b-42d3-a456-426614174000';
const NONCE = '123e4567-e89b-42d3-a456-426614174000';
const CHECKPOINT: MainnetCheckpoint = {
   network: ALGORAND_MAINNET, assetId: USDC_MAINNET_ASA_ID,
   serverUrl: DEFAULT_SERVER_URL, idempotencyKey: `mainnet-${NONCE}`,
   expectedSender: PAYER, expectedReceiver: EXPECTED_RECEIVER,
   atomicAmount: INVOICE_ATOMIC_AMOUNT, invoiceNote: `roundwatch:mainnet:${NONCE}`,
   watchId: WATCH_ID,
};
const WATCH: MainnetWatchSnapshot = {
   id: WATCH_ID, state: 'active', expectedSender: PAYER,
   expectedReceiver: EXPECTED_RECEIVER, assetId: USDC_MAINNET_ASA_ID,
   atomicAmount: INVOICE_ATOMIC_AMOUNT, invoiceNote: CHECKPOINT.invoiceNote,
   serviceTransaction: 'A'.repeat(52), servicePayer: PAYER, expectedServicePayer: PAYER,
};

interface Trace {
   ready: boolean;
   account: number; signingKey: number; algod: number; params: number;
   construction: number; signing: number; submission: number; confirmation: number;
   paymentClient: number; paymentPayload: number; outbound: number;
   envLoads: number; checkpointReads: number; checkpointWrites: number; jsonReads: number;
   requests: Array<{ url: string; method: string; paymentSignature: boolean }>;
   order: string[];
   transfer?: Record<string, unknown>;
}

function runCli(options: {
   mode?: string; checkpoint?: unknown; watch?: unknown; status?: number;
   rawBody?: string; payer?: string; confirm?: boolean; importOnly?: boolean;
   serverUrl?: string; receiver?: string;
} = {}) {
   const temporaryDirectory = mkdtempSync(join(tmpdir(), 'roundwatch-b2-cli-'));
   assert.equal(dirname(temporaryDirectory), tmpdir(), 'Cleanup stays within the temporary directory');
   try {
      const cwd = join(temporaryDirectory, 'client');
      mkdirSync(join(cwd, 'data'), { recursive: true });
      const statePath = join(cwd, 'data/roundwatch-mainnet-live.json');
      const tracePath = join(temporaryDirectory, 'trace.json');
      const configPath = join(temporaryDirectory, 'configuration.json');
      const checkpoint = options.checkpoint ?? CHECKPOINT;
      const originalCheckpoint = `${JSON.stringify(checkpoint)}\n`;
      writeFileSync(statePath, originalCheckpoint);
      writeFileSync(configPath, JSON.stringify({
         clientPackage: join(clientDirectory, 'package.json'), cliPath, statePath, tracePath,
         checkpoint, watch: options.watch ?? WATCH, status: options.status ?? 200,
         rawBody: options.rawBody, payer: options.payer ?? PAYER,
         serverUrl: options.serverUrl ?? DEFAULT_SERVER_URL,
         algodUrl: DEFAULT_ALGOD_URL, receiver: options.receiver ?? EXPECTED_RECEIVER,
      }));
      const entry = options.importOnly ? join(temporaryDirectory, 'import.mjs') : cliPath;
      if (options.importOnly) {
         writeFileSync(entry, `await import(${JSON.stringify(pathToFileURL(cliPath).href)});\n`);
      }
      // Inherit only OS/runtime paths, never the user's wallet or service settings.
      const env: NodeJS.ProcessEnv = { RW_TEST_CONFIGURATION: configPath };
      for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP']) {
         if (process.env[key]) env[key] = process.env[key];
      }
      const result = spawnSync(process.execPath, [
         '--import', pathToFileURL(require.resolve('tsx')).href,
         '--import', pathToFileURL(preloadPath).href,
         entry, options.mode ?? 'pay', ...(options.confirm === false ? [] : ['--confirm-mainnet']),
      ], { cwd, env, encoding: 'utf8', timeout: 15_000 });
      assert.equal(result.error, undefined, 'CLI subprocess must finish normally');
      assert.ok(existsSync(tracePath), `Missing instrumentation: ${result.stderr}`);
      const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as Trace;
      assert.equal(trace.ready, true, `Instrumentation must initialize: ${result.stderr}`);
      return {
         code: result.status, stdout: result.stdout, stderr: result.stderr,
         trace,
         checkpoint: JSON.parse(readFileSync(statePath, 'utf8')) as MainnetCheckpoint,
         unchanged: readFileSync(statePath, 'utf8') === originalCheckpoint,
      };
   } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
   }
}

function assertNoPayment(trace: Trace, expectedAccounts = 0) {
   assert.deepEqual({
      account: trace.account, signingKey: trace.signingKey, algod: trace.algod,
      params: trace.params, construction: trace.construction, signing: trace.signing,
      submission: trace.submission, confirmation: trace.confirmation,
      paymentClient: trace.paymentClient, paymentPayload: trace.paymentPayload,
      outbound: trace.outbound,
   }, {
      account: expectedAccounts, signingKey: 0, algod: 0, params: 0, construction: 0,
      signing: 0, submission: 0, confirmation: 0, paymentClient: 0,
      paymentPayload: 0, outbound: 0,
   });
}

for (const state of ['expired', 'indeterminate', 'matched']) {
   test(`B2-F1 production pay CLI after recovered ${state} never creates a signer`, () => {
      const watch = { ...WATCH, state };
      const recovery = runCli({ mode: 'recover', checkpoint: { ...CHECKPOINT, watchId: undefined }, watch });
      assert.equal(recovery.code, 0, recovery.stderr);
      assert.equal(recovery.checkpoint.watchId, WATCH_ID);
      assertNoPayment(recovery.trace);
      const result = runCli({ checkpoint: recovery.checkpoint, watch });
      assert.equal(result.code, state === 'matched' ? 0 : 1, result.stderr);
      if (state !== 'matched') assert.match(result.stderr, new RegExp(`state is not payable: ${state}`));
      assert.equal(result.trace.requests.length, 1);
      assert.equal(result.unchanged, true);
      assertNoPayment(result.trace);
   });
}

for (const status of [200, 201, 202, 203, 204, 206, 299, 402, 404, 409, 500]) {
   for (const hasWatchId of [false, true]) {
      test(`B2-F2 recovery HTTP ${status}, ${hasWatchId ? 'existing' : 'missing'} watchId`, () => {
         const result = runCli({
            mode: 'recover', status, watch: { ...WATCH, state: 'expired' },
            checkpoint: { ...CHECKPOINT, watchId: hasWatchId ? WATCH_ID : undefined },
         });
         assert.equal(result.code, status === 200 ? 0 : 1, result.stderr);
         assert.equal(result.trace.jsonReads, status === 200 ? 1 : 0, 'Reject unexpected HTTP status before reading JSON');
         assert.equal(result.trace.checkpointWrites, status === 200 ? 1 : 0);
         assert.equal(result.trace.requests.length, 1, 'No paid fallback or retry');
         assert.equal(result.trace.requests[0].method, hasWatchId ? 'GET' : 'POST');
         assert.equal(result.trace.requests[0].paymentSignature, false);
         if (status !== 200) assert.equal(result.unchanged, true);
         assertNoPayment(result.trace);
      });
   }
}

test('production pay CLI validates checkpoint and confirmation before any signer or request', () => {
   for (const options of [
      { checkpoint: { ...CHECKPOINT, watchId: undefined } },
      { checkpoint: { ...CHECKPOINT, atomicAmount: '2' } },
      { checkpoint: { ...CHECKPOINT, expectedReceiver: PAYER } },
      { confirm: false },
      { serverUrl: 'https://unapproved.example' },
   ]) {
      const result = runCli(options);
      assert.equal(result.code, 1);
      assert.equal(result.trace.requests.length, 0);
      assert.equal(result.unchanged, true);
      assertNoPayment(result.trace);
   }
});

test('production pay CLI rejects forbidden states and watch identity before creating a signer', () => {
   for (const watch of [
      { ...WATCH, state: 'settlement_pending' },
      { ...WATCH, state: 'settlement_unknown' },
      { ...WATCH, state: 'unknown-state' },
      { ...WATCH, id: NONCE },
      { ...WATCH, expectedSender: EXPECTED_RECEIVER },
      { ...WATCH, expectedReceiver: PAYER },
      { ...WATCH, assetId: USDC_MAINNET_ASA_ID + 1 },
      { ...WATCH, atomicAmount: '2' },
      { ...WATCH, invoiceNote: 'wrong-note' },
   ]) {
      const result = runCli({ watch });
      assert.equal(result.code, 1);
      assert.equal(result.trace.requests.length, 1);
      assert.equal(result.unchanged, true);
      assertNoPayment(result.trace);
   }
});

test('production active pay CLI creates account after public validation and rejects a derived payer mismatch', () => {
   const result = runCli({ payer: EXPECTED_RECEIVER });
   assert.equal(result.code, 1);
   assert.match(result.stderr, /does not match the configured payer/);
   assert.equal(result.trace.requests.length, 1);
   assert.ok(result.trace.order.indexOf('identity') < result.trace.order.indexOf('account'));
   assert.ok(result.trace.order.indexOf('state:active') < result.trace.order.indexOf('account'));
   assert.equal(result.unchanged, true);
   assertNoPayment(result.trace, 1);
});

test('production active pay CLI preserves the complete stubbed invoice payment flow', () => {
   const result = runCli();
   assert.equal(result.code, 0, result.stderr);
   assert.ok(result.trace.order.indexOf('identity') < result.trace.order.indexOf('account'));
   assert.ok(result.trace.order.indexOf('state:active') < result.trace.order.indexOf('account'));
   assert.ok(result.trace.order.indexOf('payer') < result.trace.order.indexOf('algod'));
   assert.deepEqual([
      result.trace.account, result.trace.algod, result.trace.params, result.trace.construction,
      result.trace.signingKey, result.trace.signing, result.trace.submission, result.trace.confirmation,
   ], Array(8).fill(1));
   assert.equal(result.trace.requests.length, 2, 'Initial gate then matched-result poll');
   assert.equal(result.trace.outbound, 0);
   assert.equal(result.unchanged, true);
   assert.deepEqual(result.trace.transfer, {
      sender: PAYER, receiver: EXPECTED_RECEIVER, amount: 1, assetIndex: USDC_MAINNET_ASA_ID,
      note: Array.from(new TextEncoder().encode(CHECKPOINT.invoiceNote)),
   });
});

test('CLI import performs no environment loading, checkpoint I/O, request, or signing', () => {
   const result = runCli({ importOnly: true });
   assert.equal(result.code, 0, result.stderr);
   assert.equal(result.stdout, '');
   assert.equal(result.stderr, '');
   assert.equal(result.trace.envLoads, 0);
   assert.equal(result.trace.checkpointReads, 0);
   assert.equal(result.trace.checkpointWrites, 0);
   assert.equal(result.trace.requests.length, 0);
   assert.equal(result.unchanged, true);
   assertNoPayment(result.trace);
});

test('direct CLI entry still runs main and status keeps its previous 2xx inspection policy', () => {
   for (const status of [200, 201, 202, 203, 206, 299]) {
      const result = runCli({ mode: 'status', status, watch: { ...WATCH, state: 'settlement_unknown' } });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).watch.state, 'settlement_unknown');
      assert.equal(result.trace.envLoads, 2);
      assert.equal(result.trace.checkpointReads, 1);
      assert.equal(result.trace.checkpointWrites, 0);
      assert.equal(result.trace.requests.length, 1);
      assert.equal(result.unchanged, true);
      assertNoPayment(result.trace);
   }
});

test('both recovery HTTP readers fail closed on malformed JSON, structure, state, or payer', () => {
   const rawBodies = ['invalid-json', 'null', '{}', '{"watch":null}', '{"watch":[]}'];
   const invalidWatches = [
      { ...WATCH, state: 'settlement_pending' },
      { ...WATCH, state: 'settlement_unknown' },
      { ...WATCH, state: 'unknown-state' },
      { ...WATCH, state: 'indeterminate', serviceTransaction: undefined },
      { ...WATCH, state: 'expired', servicePayer: EXPECTED_RECEIVER },
      { ...WATCH, state: 'expired', expectedServicePayer: EXPECTED_RECEIVER },
      { ...WATCH, state: 'expired', expectedSender: EXPECTED_RECEIVER },
   ];
   for (const hasWatchId of [false, true]) {
      for (const options of [
         ...rawBodies.map(rawBody => ({ rawBody })),
         ...invalidWatches.map(watch => ({ watch })),
      ]) {
         const result = runCli({
            mode: 'recover', ...options,
            checkpoint: { ...CHECKPOINT, watchId: hasWatchId ? WATCH_ID : undefined },
         });
         assert.equal(result.code, 1);
         assert.equal(result.trace.requests.length, 1);
         assert.equal(result.trace.checkpointWrites, 0);
         assert.equal(result.unchanged, true);
         assertNoPayment(result.trace);
      }
   }
});
