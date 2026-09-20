import {
   AlgorandIndexerClient,
   matchesWatch,
   type IndexedWatchTransaction,
   type ScanQueryVariant,
} from './roundwatch-indexer.js';
import {
   MAINNET_NETWORK_CONFIG,
   TESTNET_NETWORK_CONFIG,
   type RoundWatchNetworkConfig,
} from './network-config.js';
import { IndexerRequestDispatcher } from './roundwatch-scheduler.js';
import type { WatchRecord } from './roundwatch-store.js';

const network = resolveNetwork(
   process.env.ROUNDWATCH_SEMANTIC_NETWORK?.trim().toLowerCase(),
);
const indexerUrl =
   process.env.ALGORAND_INDEXER_URL?.trim() || network.indexerUrl;
const expectedTransaction = requiredEnv('ROUNDWATCH_SEMANTIC_TX_ID');
const expectedSender = requiredEnv('ROUNDWATCH_SEMANTIC_SENDER');
const expectedReceiver = requiredEnv('ROUNDWATCH_SEMANTIC_RECEIVER');
const atomicAmount = requiredPositiveIntegerString(
   'ROUNDWATCH_SEMANTIC_AMOUNT',
);
const round = requiredPositiveInteger('ROUNDWATCH_SEMANTIC_ROUND');
const invoiceNote =
   process.env.ROUNDWATCH_SEMANTIC_NOTE?.trim() || undefined;

const watch: WatchRecord = {
   id: 'semantic-probe',
   idempotencyKey: 'semantic-probe',
   state: 'active',
   expectedSender,
   expectedReceiver,
   assetId: network.usdcAssetIdNumber,
   atomicAmount,
   ...(invoiceNote ? { invoiceNote } : {}),
   activationRound: round - 1,
   scanAfterRound: round - 1,
   createdAt: '2026-01-01T00:00:00.000Z',
   expiresAt: '2100-01-01T00:00:00.000Z',
   evidenceVersion: 1,
   reconciliationAttempts: 0,
   workUnitBudget: 500,
   workUnitsUsed: 0,
};

console.log(
   `RoundWatch historical semantic probe network=${network.name} endpoint=${indexerUrl} round=${round}`,
);
console.log(
   `Expected tx=${expectedTransaction} note=${invoiceNote ? 'present' : 'absent'}`,
);

interface SemanticProbeResult {
   variant: ScanQueryVariant;
   returned: number;
   foundExpected: boolean;
   exactLocalMatch: boolean;
   currentRound: number;
   nextToken: boolean;
   senderMatch?: boolean;
   receiverMatch?: boolean;
   assetMatch?: boolean;
   amountMatch?: boolean;
   roundAfterActivation?: boolean;
   beforeExpiry?: boolean;
   notePresent?: boolean;
   noteExact?: boolean;
   notePrefix?: boolean;
   actualSender?: string;
   actualReceiver?: string;
   actualAmount?: string;
   actualNoteUtf8?: string;
}

const results: SemanticProbeResult[] = [];

for (const variant of ['A', 'B', 'C', 'D'] as const) {
   const dispatcher = new IndexerRequestDispatcher({
      requestsPerSecond: 10,
      burst: 10,
      concurrency: 1,
   });
   const client = new AlgorandIndexerClient(
      indexerUrl,
      dispatcher,
      fetch,
      10_000,
      undefined,
      variant,
   );

   const page = await client.searchWatchPage(
      watch,
      round,
      round,
   );
   const exact = page.transactions.find(
      transaction => transaction.transaction === expectedTransaction,
   );

   results.push({
      variant,
      returned: page.transactions.length,
      foundExpected: exact !== undefined,
      exactLocalMatch: exact ? matchesWatch(exact, watch) : false,
      ...(exact ? diagnoseExactTransaction(exact, watch) : {}),
      currentRound: page.currentRound,
      nextToken: page.nextToken !== undefined,
   });
}

console.table(results);

const firstExact = results.find(
   result => result.foundExpected && result.actualSender !== undefined,
);
if (firstExact) {
   console.log('Exact transaction diagnostics:');
   console.log(
      JSON.stringify(
         {
            actualSender: firstExact.actualSender,
            actualReceiver: firstExact.actualReceiver,
            actualAmount: firstExact.actualAmount,
            actualNoteUtf8: firstExact.actualNoteUtf8,
            expectedSender,
            expectedReceiver,
            expectedAmount: atomicAmount,
            expectedNoteUtf8: invoiceNote,
         },
         null,
         2,
      ),
   );
}

console.log(
   'SEMANTIC_PROBE_SUMMARY ' +
      JSON.stringify({
         network: network.name,
         endpoint: indexerUrl,
         round,
         expectedTransaction,
         notePresent: invoiceNote !== undefined,
         results,
      }),
);

if (
   results.some(
      result => !result.foundExpected || !result.exactLocalMatch,
   )
) {
   process.exitCode = 2;
}

function diagnoseExactTransaction(
   transaction: IndexedWatchTransaction,
   expected: WatchRecord,
): Partial<SemanticProbeResult> {
   const actualNoteBytes = transaction.note === undefined
      ? undefined
      : Buffer.from(transaction.note, 'base64');
   const expectedNoteBytes = expected.invoiceNote === undefined
      ? undefined
      : Buffer.from(expected.invoiceNote, 'utf8');

   const noteExact =
      actualNoteBytes === undefined && expectedNoteBytes === undefined
         ? true
         : actualNoteBytes !== undefined &&
           expectedNoteBytes !== undefined &&
           actualNoteBytes.equals(expectedNoteBytes);

   const notePrefix =
      actualNoteBytes === undefined || expectedNoteBytes === undefined
         ? false
         : actualNoteBytes.length >= expectedNoteBytes.length &&
           actualNoteBytes
              .subarray(0, expectedNoteBytes.length)
              .equals(expectedNoteBytes);

   return {
      senderMatch: transaction.sender === expected.expectedSender,
      receiverMatch: transaction.receiver === expected.expectedReceiver,
      assetMatch: transaction.assetId === expected.assetId,
      amountMatch: transaction.atomicAmount === expected.atomicAmount,
      roundAfterActivation:
         expected.activationRound !== undefined &&
         transaction.round > expected.activationRound,
      beforeExpiry:
         expected.expiresAt !== undefined &&
         transaction.roundTime * 1_000 < Date.parse(expected.expiresAt),
      notePresent: transaction.note !== undefined,
      noteExact,
      notePrefix,
      actualSender: transaction.sender,
      actualReceiver: transaction.receiver,
      actualAmount: transaction.atomicAmount,
      actualNoteUtf8:
         actualNoteBytes === undefined
            ? undefined
            : actualNoteBytes.toString('utf8'),
   };
}

function resolveNetwork(
   value: string | undefined,
): RoundWatchNetworkConfig {
   if (!value || value === 'mainnet') return MAINNET_NETWORK_CONFIG;
   if (value === 'testnet') return TESTNET_NETWORK_CONFIG;
   throw new Error(
      'ROUNDWATCH_SEMANTIC_NETWORK must be mainnet or testnet',
   );
}

function requiredEnv(name: string): string {
   const value = process.env[name]?.trim();
   if (!value) throw new Error(`${name} is required`);
   return value;
}

function requiredPositiveIntegerString(name: string): string {
   const value = requiredEnv(name);
   if (!/^[1-9]\d*$/.test(value)) {
      throw new Error(`${name} must be a positive integer string`);
   }
   return value;
}

function requiredPositiveInteger(name: string): number {
   const value = Number(requiredEnv(name));
   if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
   }
   return value;
}
