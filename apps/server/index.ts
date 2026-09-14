import { resolve } from 'node:path';

import { config } from 'dotenv';
import { serve } from '@hono/node-server';
import { HTTPFacilitatorClient } from '@x402/core/server';

import { createApp } from './app.js';
import { AlgorandIndexerClient } from './roundwatch-indexer.js';
import { RoundWatchPoller } from './roundwatch-poller.js';
import { RoundWatchStore } from './roundwatch-store.js';

config();

const avmAddress = process.env.AVM_ADDRESS;
const facilitatorUrl = process.env.FACILITATOR_URL;

if (!avmAddress || !facilitatorUrl) {
   console.error(
      'Missing environment variables: AVM_ADDRESS or FACILITATOR_URL',
   );
   process.exit(1);
}

const databasePath = resolve(
   process.env.ROUNDWATCH_DB_PATH ?? 'data/roundwatch.sqlite',
);
const indexerUrl =
   process.env.ALGORAND_INDEXER_URL ?? 'https://testnet-idx.algonode.cloud';
const pollIntervalMilliseconds = parsePositiveInteger(
   process.env.ROUNDWATCH_POLL_INTERVAL_MS,
   5_000,
);

const facilitatorClient = new HTTPFacilitatorClient({
   url: facilitatorUrl,
});
const store = new RoundWatchStore(databasePath);
const indexer = new AlgorandIndexerClient(indexerUrl);
const poller = new RoundWatchPoller(
   store,
   indexer,
   pollIntervalMilliseconds,
);
const app = createApp({
   avmAddress,
   facilitatorClient,
   store,
   indexer,
});

const port = 4021;

const server = serve({
   fetch: app.fetch,
   port,
});

server.on('listening', () => {
   poller.start();
   console.log(
      `x402 Resource Server listening at http://localhost:${port}`,
   );
});

server.on('close', () => {
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
