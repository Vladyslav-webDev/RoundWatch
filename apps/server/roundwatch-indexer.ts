import type { WatchRecord } from './roundwatch-store.js';

export interface WatchMatch {
   transaction: string;
   round: number;
}

export interface RoundWatchIndexer {
   getCurrentRound(): Promise<number>;
   findMatch(
      watch: WatchRecord,
      minRound: number,
      maxRound: number,
   ): Promise<WatchMatch | undefined>;
}

interface IndexerHealth {
   round?: number;
}

interface IndexerAssetTransfer {
   amount?: number;
   receiver?: string;
   'asset-id'?: number;
}

interface IndexerTransaction {
   id?: string;
   sender?: string;
   note?: string;
   'confirmed-round'?: number;
   'asset-transfer-transaction'?: IndexerAssetTransfer;
}

interface IndexerTransactionsResponse {
   transactions?: IndexerTransaction[];
   'next-token'?: string;
}

export class AlgorandIndexerClient implements RoundWatchIndexer {
   constructor(
      private readonly baseUrl: string,
      private readonly fetchImplementation: typeof fetch = fetch,
      private readonly timeoutMilliseconds = 10_000,
   ) {}

   async getCurrentRound(): Promise<number> {
      const response = await this.fetchImplementation(
         new URL('/health', this.baseUrl),
         { signal: AbortSignal.timeout(this.timeoutMilliseconds) },
      );

      if (!response.ok) {
         throw new Error(`Indexer health failed with HTTP ${response.status}`);
      }

      const health = await response.json() as IndexerHealth;

      if (!Number.isSafeInteger(health.round) || health.round! < 0) {
         throw new Error('Indexer health did not return a valid round');
      }

      return health.round!;
   }

   async findMatch(
      watch: WatchRecord,
      minRound: number,
      maxRound: number,
   ): Promise<WatchMatch | undefined> {
      if (minRound > maxRound) {
         return undefined;
      }

      let nextToken: string | undefined;

      do {
         const url = new URL(
            `/v2/assets/${watch.assetId}/transactions`,
            this.baseUrl,
         );
         url.searchParams.set('tx-type', 'axfer');
         url.searchParams.set('address', watch.expectedSender);
         url.searchParams.set('address-role', 'sender');
         url.searchParams.set('min-round', String(minRound));
         url.searchParams.set('max-round', String(maxRound));
         url.searchParams.set('limit', '1000');

         if (nextToken) {
            url.searchParams.set('next', nextToken);
         }

         const response = await this.fetchImplementation(url, {
            signal: AbortSignal.timeout(this.timeoutMilliseconds),
         });

         if (!response.ok) {
            throw new Error(`Indexer transaction search failed with HTTP ${response.status}`);
         }

         const page = await response.json() as IndexerTransactionsResponse;

         for (const transaction of page.transactions ?? []) {
            if (matchesWatch(transaction, watch)) {
               return {
                  transaction: transaction.id!,
                  round: transaction['confirmed-round']!,
               };
            }
         }

         nextToken = page['next-token'];
      } while (nextToken);

      return undefined;
   }
}

function matchesWatch(
   transaction: IndexerTransaction,
   watch: WatchRecord,
): boolean {
   const transfer = transaction['asset-transfer-transaction'];

   if (
      !transaction.id ||
      !Number.isSafeInteger(transaction['confirmed-round']) ||
      transaction.sender !== watch.expectedSender ||
      transfer?.receiver !== watch.expectedReceiver ||
      transfer['asset-id'] !== watch.assetId ||
      !Number.isSafeInteger(transfer.amount) ||
      String(transfer.amount) !== watch.atomicAmount
   ) {
      return false;
   }

   if (watch.invoiceNote !== undefined) {
      if (!transaction.note) {
         return false;
      }

      const note = Buffer.from(transaction.note, 'base64').toString('utf8');

      if (note !== watch.invoiceNote) {
         return false;
      }
   }

   return true;
}
