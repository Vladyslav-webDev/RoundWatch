import { isAbsolute, resolve } from 'node:path';

import { config } from 'dotenv';
import { serve } from '@hono/node-server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { isValidAlgorandAddress } from '@x402/avm';

import {
   createApp,
   ROUNDWATCH_SERVICE_ATOMIC_AMOUNT,
} from './app.js';
import {
   resolveRoundWatchNetwork,
   resolveRoundWatchPublicBaseUrl,
} from './network-config.js';
import { AlgorandIndexerClient } from './roundwatch-indexer.js';
import { RoundWatchPoller } from './roundwatch-poller.js';
import { SettlementReconciler } from './roundwatch-reconciler.js';
import {
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

try {
   networkConfig = resolveRoundWatchNetwork(process.env.ROUNDWATCH_NETWORK);
   publicBaseUrl = resolveRoundWatchPublicBaseUrl(
      process.env.ROUNDWATCH_PUBLIC_BASE_URL,
      networkConfig.name,
   );
} catch (error) {
   console.error(error instanceof Error ? error.message : error);
   process.exit(1);
}

const faultExitAfterSettle =
   process.env.ROUNDWATCH_TESTNET_EXIT_AFTER_SETTLE?.trim() === '1';

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
const store = faultExitAfterSettle
   ? new TestnetExitAfterSettleStore(databasePath)
   : new RoundWatchStore(databasePath);
const indexer = new AlgorandIndexerClient(indexerUrl);
const poller = new RoundWatchPoller(
   store,
   indexer,
   pollIntervalMilliseconds,
);
const reconciler = new SettlementReconciler(store, indexer, {
   network: networkConfig.network,
   receiver: avmAddress,
   assetId: networkConfig.usdcAssetIdNumber,
   atomicAmount: ROUNDWATCH_SERVICE_ATOMIC_AMOUNT,
   intervalMilliseconds: reconciliationIntervalMilliseconds,
});
const app = createApp({
   avmAddress,
   facilitatorClient,
   store,
   indexer,
   networkConfig,
   publicBaseUrl,
});

const port = parsePositiveInteger(process.env.PORT, 4021);

const server = serve({
   fetch: app.fetch,
   port,
});

server.on('listening', () => {
   reconciler.start();
   poller.start();
   console.log(
      `RoundWatch x402 Resource Server listening at http://localhost:${port}`,
   );
   console.log(`Network: ${networkConfig.name}`);
   console.log(`USDC ASA: ${networkConfig.usdcAssetId}`);
   console.log(`Indexer: ${indexerUrl}`);
   console.log(`SQLite: ${databasePath}`);

   if (faultExitAfterSettle) {
      console.warn(
         'TESTNET FAULT INJECTION ARMED: the process will exit after confirmed settlement and before SQLite activation',
      );
   }
});

server.on('close', () => {
   reconciler.stop();
   poller.stop();
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
