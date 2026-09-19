import type { IndexedAssetTransfer } from './roundwatch-reconciler.js';
import type { WatchRecord } from './roundwatch-store.js';
import type { RoundWatchEconomicsMetrics } from './roundwatch-metrics.js';
import {
   IndexerRequestDispatcher,
   type IndexerDispatchObservation,
   type IndexerRequestPurpose,
} from './roundwatch-scheduler.js';

export interface IndexedWatchTransaction extends IndexedAssetTransfer {
   roundTime: number;
   note?: string;
}
export interface TransactionPage { transactions: IndexedWatchTransaction[]; currentRound: number; nextToken?: string; }
export interface TransactionIdPage { transactions: IndexedAssetTransfer[]; currentRound: number; nextToken?: string; }
export interface IndexedBlock { round: number; timestamp: number; }

export interface RoundWatchIndexer {
   getCurrentRound(
      purpose?: IndexerRequestPurpose,
      watchId?: string,
   ): Promise<number>;
   lookupAssetTransfer(
      transactionId: string,
      purpose?: IndexerRequestPurpose,
      watchId?: string,
   ): Promise<IndexedAssetTransfer | undefined>;
   getBlock(round: number, watchId?: string): Promise<IndexedBlock>;
   searchWatchPage(
      watch: WatchRecord,
      minRound: number,
      maxRound: number,
      nextToken?: string,
   ): Promise<TransactionPage>;
   searchTransactionPage(
      transactionId: string,
      nextToken?: string,
      watchId?: string,
   ): Promise<TransactionIdPage>;
}

interface IndexerTransaction {
   id?: unknown; sender?: unknown; note?: unknown;
   'confirmed-round'?: unknown; 'round-time'?: unknown;
   'asset-transfer-transaction'?: unknown;
}

export class AlgorandIndexerClient implements RoundWatchIndexer {
   constructor(
      private readonly baseUrl: string,
      private readonly dispatcher: IndexerRequestDispatcher,
      private readonly fetchImplementation: typeof fetch = fetch,
      private readonly timeoutMilliseconds = 10_000,
      private readonly economicsMetrics?: RoundWatchEconomicsMetrics,
   ) {}

   async getCurrentRound(
      purpose: IndexerRequestPurpose = 'health',
      watchId?: string,
   ): Promise<number> {
      return (await this.request(
         purpose,
         '/health',
         body => safeRound(field(body, 'round'), 'health round'),
         false,
         watchId,
      ))!;
   }

   async lookupAssetTransfer(
      transactionId: string,
      purpose: IndexerRequestPurpose = 'reconciliation',
      watchId?: string,
   ): Promise<IndexedAssetTransfer | undefined> {
      return this.request(
         purpose,
         `/v2/transactions/${encodeURIComponent(transactionId)}`,
         body => {
            const parsed = parseAssetTransfer(
               field(body, 'transaction'),
               'lookup transaction',
            );
            if (parsed.transaction !== transactionId) {
               throw new Error('Indexer lookup returned a different transaction ID');
            }
            return parsed;
         },
         true,
         watchId,
      );
   }

   async getBlock(round: number, watchId?: string): Promise<IndexedBlock> {
      const expected = safeRound(round, 'requested block round');
      return (await this.request(
         'checkpoint',
         `/v2/blocks/${expected}?header-only=true`,
         body => {
            const returned = safeRound(field(body, 'round'), 'block round');
            const timestamp = safeRound(field(body, 'timestamp'), 'block timestamp');
            if (returned !== expected) {
               throw new Error(
                  'Indexer returned a different block round than requested',
               );
            }
            return { round: returned, timestamp };
         },
         false,
         watchId,
      ))!;
   }

   async searchWatchPage(watch: WatchRecord, minRound: number, maxRound: number, nextToken?: string): Promise<TransactionPage> {
      safeRange(minRound, maxRound);
      const url = new URL(`/v2/assets/${watch.assetId}/transactions`, this.baseUrl);
      url.searchParams.set('tx-type', 'axfer');
      url.searchParams.set('address', watch.expectedSender);
      url.searchParams.set('address-role', 'sender');
      url.searchParams.set('min-round', String(minRound));
      url.searchParams.set('max-round', String(maxRound));
      url.searchParams.set('limit', '1000');
      if (nextToken) url.searchParams.set('next', nextToken);
      return (await this.requestUrl(
         'scan-page',
         url,
         body => ({
            transactions: requiredArray(body, 'transactions').map((item, i) =>
               parseWatchTransaction(item, i, minRound, maxRound, watch),
            ),
            currentRound: safeRound(
               field(body, 'current-round'),
               'transaction page current-round',
            ),
            ...optionalToken(body),
         }),
         false,
         watch.id,
      ))!;
   }

   async searchTransactionPage(
      transactionId: string,
      nextToken?: string,
      watchId?: string,
   ): Promise<TransactionIdPage> {
      const url = new URL('/v2/transactions', this.baseUrl);
      url.searchParams.set('txid', transactionId);
      url.searchParams.set('limit', '1000');
      if (nextToken) url.searchParams.set('next', nextToken);
      return (await this.requestUrl(
         'absence-proof',
         url,
         body => ({
            transactions: requiredArray(body, 'transactions').map((item, i) =>
               parseTransactionSearchItem(item, i, transactionId),
            ),
            currentRound: safeRound(
               field(body, 'current-round'),
               'transaction search current-round',
            ),
            ...optionalToken(body),
         }),
         false,
         watchId,
      ))!;
   }

   private request<T>(
      purpose: IndexerRequestPurpose,
      path: string,
      parse: (body: unknown) => T,
      allowNotFound = false,
      watchId?: string,
   ): Promise<T | undefined> {
      return this.requestUrl(
         purpose,
         new URL(path, this.baseUrl),
         parse,
         allowNotFound,
         watchId,
      );
   }

   private async requestUrl<T>(
      purpose: IndexerRequestPurpose,
      url: URL,
      parse: (body: unknown) => T,
      allowNotFound = false,
      watchId?: string,
   ): Promise<T | undefined> {
      let dispatchObservation: IndexerDispatchObservation | undefined;
      let responseBytes = 0;

      try {
         const result = await this.dispatcher.dispatch(
            purpose,
            async () => {
               const response = await this.fetchImplementation(url, {
                  signal: AbortSignal.timeout(this.timeoutMilliseconds),
                  redirect: 'error',
               });

               if (allowNotFound && response.status === 404) {
                  responseBytes = headerContentLength(response);
                  return undefined;
               }

               if (!response.ok) {
                  responseBytes = headerContentLength(response);
                  throw new Error(
                     `Indexer ${purpose} request failed with HTTP ${response.status}`,
                  );
               }

               const rawBody = await response.text();
               responseBytes = Buffer.byteLength(rawBody, 'utf8');

               let body: unknown;
               try {
                  body = JSON.parse(rawBody);
               } catch (error) {
                  throw new Error(
                     `Indexer ${purpose} response was not valid JSON`,
                     { cause: error },
                  );
               }

               return parse(body);
            },
            observation => {
               dispatchObservation = observation;
            },
         );

         this.recordRequestMetric(
            watchId,
            purpose,
            dispatchObservation,
            responseBytes,
         );
         return result;
      } catch (error) {
         this.recordRequestMetric(
            watchId,
            purpose,
            dispatchObservation ?? {
               outcome: isTimeoutError(error) ? 'timeout' : 'failure',
               queueWaitMs: 0,
               wallTimeMs: 0,
            },
            responseBytes,
         );
         throw error;
      }
   }

   private recordRequestMetric(
      watchId: string | undefined,
      purpose: IndexerRequestPurpose,
      observation: IndexerDispatchObservation,
      responseBytes: number,
   ): void {
      if (!watchId || !this.economicsMetrics) return;

      try {
         this.economicsMetrics.recordIndexerRequest(watchId, purpose, {
            outcome: observation.outcome,
            responseBytes,
            queueWaitMs: observation.queueWaitMs,
            wallTimeMs: observation.wallTimeMs,
         });
      } catch (error) {
         console.warn(
            'RoundWatch economics Indexer metric failed:',
            error instanceof Error ? error.message : 'Unknown metrics error',
         );
      }
   }
}

function parseAssetTransfer(value: unknown, label: string): IndexedAssetTransfer {
   const transaction = record(value, label) as IndexerTransaction;
   const transfer = record(transaction['asset-transfer-transaction'], `${label} asset transfer`);
   return {
      transaction: nonEmptyString(transaction.id, `${label} id`),
      sender: nonEmptyString(transaction.sender, `${label} sender`),
      receiver: nonEmptyString(transfer.receiver, `${label} receiver`),
      assetId: safeRound(transfer['asset-id'], `${label} asset-id`),
      atomicAmount: safeAmount(transfer.amount, `${label} amount`),
      round: safeRound(transaction['confirmed-round'], `${label} confirmed-round`),
   };
}

function parseWatchTransaction(
   value: unknown,
   index: number,
   minRound: number,
   maxRound: number,
   watch: Pick<WatchRecord, 'expectedSender' | 'assetId'>,
): IndexedWatchTransaction {
   const label = `transaction page item ${index}`;
   const parsed = parseAssetTransfer(value, label);
   const transaction = value as IndexerTransaction;
   if (parsed.round < minRound || parsed.round > maxRound) {
      throw new Error(`${label} lies outside the requested round range`);
   }
   if (parsed.sender !== watch.expectedSender || parsed.assetId !== watch.assetId) {
      throw new Error(`${label} does not satisfy the requested sender and asset filters`);
   }
   const roundTime = safeRound(transaction['round-time'], `${label} round-time`);
   if (transaction.note !== undefined) {
      if (typeof transaction.note !== 'string' || !isCanonicalBase64(transaction.note)) {
         throw new Error(`${label} note is malformed`);
      }
   }
   return { ...parsed, roundTime, ...(transaction.note === undefined ? {} : { note: transaction.note }) };
}

function parseTransactionSearchItem(
   value: unknown,
   index: number,
   transactionId: string,
): IndexedAssetTransfer {
   const label = `transaction search item ${index}`;
   const parsed = parseAssetTransfer(value, label);
   if (parsed.transaction !== transactionId) {
      throw new Error(`${label} does not match the requested transaction ID`);
   }
   return parsed;
}

export function matchesWatch(transaction: IndexedWatchTransaction, watch: WatchRecord): boolean {
   if (watch.activationRound === undefined || transaction.round <= watch.activationRound ||
      transaction.sender !== watch.expectedSender || transaction.receiver !== watch.expectedReceiver ||
      transaction.assetId !== watch.assetId || transaction.atomicAmount !== watch.atomicAmount ||
      watch.expiresAt === undefined || transaction.roundTime * 1_000 >= Date.parse(watch.expiresAt)) return false;
   if (watch.invoiceNote !== undefined) {
      if (transaction.note === undefined) return false;
      const actualNote = Buffer.from(transaction.note, 'base64');
      const expectedNote = Buffer.from(watch.invoiceNote, 'utf8');
      if (!actualNote.equals(expectedNote)) return false;
   }
   return true;
}

function safeRange(minRound: number, maxRound: number): void {
   safeRound(minRound, 'minimum round'); safeRound(maxRound, 'maximum round');
   if (minRound > maxRound) throw new Error('minimum round exceeds maximum round');
}
function optionalToken(body: unknown): { nextToken?: string } {
   const value = field(body, 'next-token', false);
   if (value === undefined || value === null || value === '') return {};
   return { nextToken: nonEmptyString(value, 'next-token') };
}
function requiredArray(body: unknown, name: string): unknown[] {
   const value = field(body, name); if (!Array.isArray(value)) throw new Error(`Indexer ${name} is not an array`); return value;
}
function field(value: unknown, name: string, required = true): unknown {
   const object = record(value, 'response');
   if (!(name in object)) { if (!required) return undefined; throw new Error(`Indexer response is missing ${name}`); }
   return object[name];
}
function record(value: unknown, label: string): Record<string, unknown> {
   if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Indexer ${label} is not an object`);
   return value as Record<string, unknown>;
}
function safeRound(value: unknown, label: string): number {
   if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is not a non-negative safe integer`);
   return value as number;
}
function safeAmount(value: unknown, label: string): string {
   if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is not a non-negative safe integer`);
   return String(value);
}
function nonEmptyString(value: unknown, label: string): string {
   if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is not a non-empty string`);
   return value;
}

function isCanonicalBase64(value: string): boolean {
   if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
   return Buffer.from(value, 'base64').toString('base64') === value;
}

function headerContentLength(response: Response): number {
   const raw = response.headers.get('content-length');
   if (!raw) return 0;
   const value = Number(raw);
   return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isTimeoutError(error: unknown): boolean {
   return error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');
}
