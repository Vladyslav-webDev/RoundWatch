import { isAbsolute, resolve } from 'node:path';

import { config } from 'dotenv';
import { serve } from '@hono/node-server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { isValidAlgorandAddress } from '@x402/avm';

import { createApp } from './app.js';
import {
   resolveRoundWatchNetwork,
   resolveRoundWatchPublicBaseUrl,
} from './network-config.js';
import {
   AlgorandIndexerClient,
   resolveScanQueryVariant,
} from './roundwatch-indexer.js';
import { RoundWatchEconomicsMetrics } from './roundwatch-metrics.js';
import {
   DEFAULT_ECONOMICS_SAMPLE_INTERVAL_MS,
   RoundWatchRuntimeSampler,
} from './roundwatch-runtime-metrics.js';
import { RoundWatchPoller } from './roundwatch-poller.js';
import { SettlementReconciler } from './roundwatch-reconciler.js';
import {
   DEFAULT_SIGNED_PAYMENT_BURST,
   DEFAULT_SIGNED_PAYMENT_CONCURRENCY,
   DEFAULT_SIGNED_PAYMENT_REQUESTS_PER_SECOND,
} from './free-payment-gate.js';
import {
   DEFAULT_INDEXER_BURST,
   DEFAULT_INDEXER_CONCURRENCY,
   DEFAULT_INDEXER_REQUESTS_PER_SECOND,
   IndexerRequestDispatcher,
} from './roundwatch-scheduler.js';
import {
   DEFAULT_SCAN_PAGE_CACHE_ENTRIES,
   DEFAULT_SCAN_ROUND_WINDOW,
} from './roundwatch-poller.js';
import {
   DEFAULT_MAX_OPEN_WATCHES,
   DEFAULT_MAX_OPEN_WATCHES_PER_PAYER,
   DEFAULT_WATCH_TTL_MILLISECONDS,
   DEFAULT_WORK_UNIT_BUDGET,
   RoundWatchStore,
   type SettlementEvidence,
   type WatchRecord,
} from './roundwatch-store.js';

config();

class TestnetExitAfterSettleStore extends RoundWatchStore {
   override activateWatch(
      _id: string,
      evidence: SettlementEvidence,
      _activationRound?: number,
   ): WatchRecord {
      console.error(
         `INTENTIONAL TESTNET FAULT: settlement ${evidence.transaction} succeeded; exiting before SQLite activation commit`,
      );
      process.exit(86);
   }
}

const avmAddress = process.env.AVM_ADDRESS?.trim();
const facilitatorUrl = process.env.FACILITATOR_URL?.trim();

if (!avmAddress || !facilitatorUrl) {
   console.error(
      'Missing environment variables: AVM_ADDRESS or FACILITATOR_URL',
   );
   process.exit(1);
}

if (!isValidAlgorandAddress(avmAddress)) {
   console.error('AVM_ADDRESS is not a valid Algorand address');
   process.exit(1);
}

let networkConfig;
let publicBaseUrl;
let watchTtlMilliseconds;
let maxOpenWatches;
let maxOpenWatchesPerPayer;
let workUnitBudget;
let indexerRequestsPerSecond;
let indexerBurst;
let indexerConcurrency;
let scanRoundWindow;
let scanPageCacheEntries;
let economicsSampleIntervalMilliseconds;
let scanQueryVariant;
let signedPaymentRequestsPerSecond;
let signedPaymentBurst;
let signedPaymentConcurrency;

try {
   networkConfig = resolveRoundWatchNetwork(process.env.ROUNDWATCH_NETWORK);
   publicBaseUrl = resolveRoundWatchPublicBaseUrl(
      process.env.ROUNDWATCH_PUBLIC_BASE_URL,
      networkConfig.name,
   );
   watchTtlMilliseconds = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_WATCH_TTL_MS,
      DEFAULT_WATCH_TTL_MILLISECONDS,
      'ROUNDWATCH_WATCH_TTL_MS',
   );
   maxOpenWatches = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_MAX_OPEN_WATCHES,
      DEFAULT_MAX_OPEN_WATCHES,
      'ROUNDWATCH_MAX_OPEN_WATCHES',
   );
   maxOpenWatchesPerPayer = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_MAX_OPEN_WATCHES_PER_PAYER,
      DEFAULT_MAX_OPEN_WATCHES_PER_PAYER,
      'ROUNDWATCH_MAX_OPEN_WATCHES_PER_PAYER',
   );
   workUnitBudget = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_WORK_UNIT_BUDGET,
      DEFAULT_WORK_UNIT_BUDGET,
      'ROUNDWATCH_WORK_UNIT_BUDGET',
   );
   indexerRequestsPerSecond = parseRequiredPositiveNumber(
      process.env.ROUNDWATCH_INDEXER_REQUESTS_PER_SECOND,
      DEFAULT_INDEXER_REQUESTS_PER_SECOND,
      'ROUNDWATCH_INDEXER_REQUESTS_PER_SECOND',
   );
   indexerBurst = parseRequiredPositiveInteger(process.env.ROUNDWATCH_INDEXER_BURST, DEFAULT_INDEXER_BURST, 'ROUNDWATCH_INDEXER_BURST');
   indexerConcurrency = parseRequiredPositiveInteger(process.env.ROUNDWATCH_INDEXER_CONCURRENCY, DEFAULT_INDEXER_CONCURRENCY, 'ROUNDWATCH_INDEXER_CONCURRENCY');
   scanRoundWindow = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_SCAN_ROUND_WINDOW,
      DEFAULT_SCAN_ROUND_WINDOW,
      'ROUNDWATCH_SCAN_ROUND_WINDOW',
   );
   scanPageCacheEntries = parseRequiredNonNegativeInteger(
      process.env.ROUNDWATCH_SCAN_PAGE_CACHE_ENTRIES,
      DEFAULT_SCAN_PAGE_CACHE_ENTRIES,
      'ROUNDWATCH_SCAN_PAGE_CACHE_ENTRIES',
   );
   economicsSampleIntervalMilliseconds = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_ECONOMICS_SAMPLE_INTERVAL_MS,
      DEFAULT_ECONOMICS_SAMPLE_INTERVAL_MS,
      'ROUNDWATCH_ECONOMICS_SAMPLE_INTERVAL_MS',
   );
   scanQueryVariant = resolveScanQueryVariant(
      process.env.ROUNDWATCH_SCAN_QUERY_VARIANT,
   );
   signedPaymentRequestsPerSecond = parseRequiredPositiveNumber(
      process.env.ROUNDWATCH_SIGNED_PAYMENT_REQUESTS_PER_SECOND,
      DEFAULT_SIGNED_PAYMENT_REQUESTS_PER_SECOND,
      'ROUNDWATCH_SIGNED_PAYMENT_REQUESTS_PER_SECOND',
   );
   signedPaymentBurst = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_SIGNED_PAYMENT_BURST,
      DEFAULT_SIGNED_PAYMENT_BURST,
      'ROUNDWATCH_SIGNED_PAYMENT_BURST',
   );
   signedPaymentConcurrency = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_SIGNED_PAYMENT_CONCURRENCY,
      DEFAULT_SIGNED_PAYMENT_CONCURRENCY,
      'ROUNDWATCH_SIGNED_PAYMENT_CONCURRENCY',
   );
} catch (error) {
   console.error(error instanceof Error ? error.message : error);
   process.exit(1);
}

const faultExitAfterSettle =
   process.env.ROUNDWATCH_TESTNET_EXIT_AFTER_SETTLE?.trim() === '1';
const economicsInstrumentationEnabled =
   process.env.ROUNDWATCH_ECONOMICS_METRICS?.trim() === '1';

if (faultExitAfterSettle && networkConfig.name !== 'testnet') {
   console.error(
      'ROUNDWATCH_TESTNET_EXIT_AFTER_SETTLE is a TestNet-only fault-injection switch and is forbidden on MainNet',
   );
   process.exit(1);
}

const configuredDatabasePath = process.env.ROUNDWATCH_DB_PATH?.trim();

if (networkConfig.name === 'mainnet' && !configuredDatabasePath) {
   console.error(
      'ROUNDWATCH_DB_PATH must be explicitly configured for MainNet so durable state is not written to an accidental ephemeral path',
   );
   process.exit(1);
}

if (
   networkConfig.name === 'mainnet' &&
   configuredDatabasePath &&
   !isAbsolute(configuredDatabasePath)
) {
   console.error(
      'ROUNDWATCH_DB_PATH must be an absolute path on MainNet and should point at a mounted persistent volume',
   );
   process.exit(1);
}

const databasePath = resolve(
   configuredDatabasePath || 'data/roundwatch.sqlite',
);
const indexerUrl =
   process.env.ALGORAND_INDEXER_URL?.trim() || networkConfig.indexerUrl;
const pollIntervalMilliseconds = parsePositiveInteger(
   process.env.ROUNDWATCH_POLL_INTERVAL_MS,
   5_000,
);
const reconciliationIntervalMilliseconds = parsePositiveInteger(
   process.env.ROUNDWATCH_RECONCILE_INTERVAL_MS,
   5_000,
);

try {
   assertUrlSafety(facilitatorUrl, 'FACILITATOR_URL', networkConfig.name);
   assertUrlSafety(indexerUrl, 'ALGORAND_INDEXER_URL', networkConfig.name);

   if (networkConfig.name === 'mainnet' && /testnet/i.test(indexerUrl)) {
      throw new Error(
         'ALGORAND_INDEXER_URL looks like a TestNet endpoint while ROUNDWATCH_NETWORK=mainnet',
      );
   }
} catch (error) {
   console.error(error instanceof Error ? error.message : error);
   process.exit(1);
}

const facilitatorClient = new HTTPFacilitatorClient({
   url: facilitatorUrl,
});
const storeOptions = {
   watchTtlMilliseconds,
   maxOpenWatches,
   maxOpenWatchesPerPayer,
   workUnitBudget,
};
const store = faultExitAfterSettle
   ? new TestnetExitAfterSettleStore(databasePath, storeOptions)
   : new RoundWatchStore(databasePath, storeOptions);
const dispatcher = new IndexerRequestDispatcher({
   requestsPerSecond: indexerRequestsPerSecond,
   burst: indexerBurst,
   concurrency: indexerConcurrency,
});
const economicsMetrics = economicsInstrumentationEnabled
   ? new RoundWatchEconomicsMetrics()
   : undefined;
const indexer = new AlgorandIndexerClient(
   indexerUrl,
   dispatcher,
   fetch,
   10_000,
   economicsMetrics,
   scanQueryVariant,
);
const poller = new RoundWatchPoller(
   store,
   indexer,
   pollIntervalMilliseconds,
   scanRoundWindow,
   undefined,
   economicsMetrics,
   scanPageCacheEntries,
);
const reconciler = new SettlementReconciler(
   store,
   indexer,
   {
      network: networkConfig.network,
      intervalMilliseconds: reconciliationIntervalMilliseconds,
   },
   economicsMetrics,
);
const app = createApp({
   avmAddress,
   facilitatorClient,
   store,
   indexer,
   networkConfig,
   publicBaseUrl,
   economicsMetrics,
   signedPaymentGateOptions: {
      requestsPerSecond: signedPaymentRequestsPerSecond,
      burst: signedPaymentBurst,
      concurrency: signedPaymentConcurrency,
   },
});
const runtimeSampler = economicsMetrics
   ? new RoundWatchRuntimeSampler(
      economicsMetrics,
      dispatcher,
      databasePath,
      { intervalMilliseconds: economicsSampleIntervalMilliseconds },
   )
   : undefined;

const port = parsePositiveInteger(process.env.PORT, 4021);

const server = serve({
   fetch: app.fetch,
   port,
});

server.on('listening', () => {
   reconciler.start();
   poller.start();
   runtimeSampler?.start();
   console.log(
      `RoundWatch x402 Resource Server listening at http://localhost:${port}`,
   );
   console.log(`Network: ${networkConfig.name}`);
   console.log(`USDC ASA: ${networkConfig.usdcAssetId}`);
   console.log(`Indexer: ${indexerUrl}`);
   console.log(`SQLite: ${databasePath}`);
   console.log(`Watch TTL: ${watchTtlMilliseconds} ms`);
   console.log(
      `Open-watch capacity: ${maxOpenWatches} global / ${maxOpenWatchesPerPayer} per payer`,
   );
   console.log(
      `Durable work budget: ${workUnitBudget} bounded background turns / watch`,
   );
   console.log(
      `Signed-payment gate: ${signedPaymentRequestsPerSecond}/s burst=${signedPaymentBurst} concurrency=${signedPaymentConcurrency}`,
   );
   console.log(`Indexer dispatcher: ${indexerRequestsPerSecond}/s burst=${indexerBurst} concurrency=${indexerConcurrency}; scan window=${scanRoundWindow} rounds`);
   console.log(`Indexer scan query variant: ${scanQueryVariant}`);
   console.log(
      `Historical scan-page cache: ${scanPageCacheEntries} entries`,
   );
   console.log(
      `Economics instrumentation: ${economicsInstrumentationEnabled ? 'enabled' : 'disabled'}`,
   );
   if (economicsInstrumentationEnabled) {
      console.log(
         `Economics sample interval: ${economicsSampleIntervalMilliseconds} ms`,
      );
   }

   if (faultExitAfterSettle) {
      console.warn(
         'TESTNET FAULT INJECTION ARMED: the process will exit after confirmed settlement and before SQLite activation',
      );
   }
});

server.on('close', () => {
   reconciler.stop();
   poller.stop();
   runtimeSampler?.stop();
   store.close();
   console.log('x402 Resource Server CLOSED');
});

server.on('error', error => {
   console.error('x402 Resource Server ERROR:', error);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
   process.once(signal, () => {
      server.close();
   });
}

function assertUrlSafety(
   value: string,
   variableName: string,
   networkName: 'testnet' | 'mainnet',
): void {
   let url: URL;

   try {
      url = new URL(value);
   } catch {
      throw new Error(`${variableName} must be a valid absolute URL`);
   }

   if (networkName === 'mainnet' && url.protocol !== 'https:') {
      throw new Error(`${variableName} must use HTTPS on MainNet`);
   }
}

function parsePositiveInteger(
   value: string | undefined,
   fallback: number,
): number {
   if (!value) {
      return fallback;
   }

   const parsed = Number(value);

   return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseRequiredPositiveInteger(
   value: string | undefined,
   fallback: number,
   variableName: string,
): number {
   const parsed = value === undefined || value.trim() === ''
      ? fallback
      : Number(value);

   if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${variableName} must be a finite positive integer`);
   }

   return parsed;
}

function parseRequiredNonNegativeInteger(
   value: string | undefined,
   fallback: number,
   variableName: string,
): number {
   const parsed = value === undefined || value.trim() === ''
      ? fallback
      : Number(value);

   if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(
         `${variableName} must be a non-negative safe integer`,
      );
   }

   return parsed;
}

function parseRequiredPositiveNumber(value: string | undefined, fallback: number, variableName: string): number {
   const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
   if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${variableName} must be a finite positive number`);
   return parsed;
}
