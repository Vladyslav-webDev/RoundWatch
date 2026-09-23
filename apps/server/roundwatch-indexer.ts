import type { IndexedAssetTransfer } from './roundwatch-reconciler.js';
import type { WatchRecord } from './roundwatch-store.js';
import type { RoundWatchEconomicsMetrics } from './roundwatch-metrics.js';
import {
   IndexerRequestDispatcher,
   type IndexerDispatchObservation,
   type IndexerRequestPurpose,
} from './roundwatch-scheduler.js';

export type ScanQueryVariant = 'A' | 'B' | 'C' | 'D';

export const DEFAULT_SCAN_QUERY_VARIANT: ScanQueryVariant = 'C';
export const MAX_INDEXER_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_INDEXER_NEXT_TOKEN_BYTES = 4 * 1024;

export function resolveScanQueryVariant(
   value: string | undefined,
): ScanQueryVariant {
   const normalized = value?.trim().toUpperCase();

   if (!normalized) return DEFAULT_SCAN_QUERY_VARIANT;

   if (
      normalized === 'A' ||
      normalized === 'B' ||
      normalized === 'C' ||
      normalized === 'D'
   ) {
      return normalized;
   }

   throw new Error(
      'ROUNDWATCH_SCAN_QUERY_VARIANT must be one of A, B, C, D',
   );
}

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
   watchPageQueryKey?(
      watch: WatchRecord,
      minRound: number,
      maxRound: number,
      nextToken?: string,
   ): string;
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
   'tx-type'?: unknown;
   'inner-txns'?: unknown;
   'asset-transfer-transaction'?: unknown;
}

export class AlgorandIndexerClient implements RoundWatchIndexer {
   constructor(
      private readonly baseUrl: string,
      private readonly dispatcher: IndexerRequestDispatcher,
      private readonly fetchImplementation: typeof fetch = fetch,
      private readonly timeoutMilliseconds = 10_000,
      private readonly economicsMetrics?: RoundWatchEconomicsMetrics,
      private readonly scanQueryVariant: ScanQueryVariant = 'A',
      private readonly maxResponseBodyBytes =
         MAX_INDEXER_RESPONSE_BODY_BYTES,
   ) {
      if (
         !Number.isSafeInteger(maxResponseBodyBytes) ||
         maxResponseBodyBytes <= 0
      ) {
         throw new Error(
            'maxResponseBodyBytes must be a positive safe integer',
         );
      }
   }

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
            const parsed = parseDirectAssetTransfer(
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

   watchPageQueryKey(
      watch: WatchRecord,
      minRound: number,
      maxRound: number,
      nextToken?: string,
   ): string {
      return this.buildWatchSearchUrl(
         watch,
         minRound,
         maxRound,
         nextToken,
      ).toString();
   }

   async searchWatchPage(
      watch: WatchRecord,
      minRound: number,
      maxRound: number,
      nextToken?: string,
   ): Promise<TransactionPage> {
      const plan = buildScanQueryPlan(watch, this.scanQueryVariant);
      const url = this.buildWatchSearchUrl(
         watch,
         minRound,
         maxRound,
         nextToken,
      );

      return (await this.requestUrl(
         'scan-page',
         url,
         body => ({
            transactions: requiredBoundedArray(
               body,
               'transactions',
               1_000,
            )
               .map((item, i) =>
                  parseWatchTransaction(
                     item,
                     i,
                     minRound,
                     maxRound,
                     watch,
                     plan,
                  ),
               )
               .filter(
                  (item): item is IndexedWatchTransaction =>
                     item !== undefined,
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

   private buildWatchSearchUrl(
      watch: WatchRecord,
      minRound: number,
      maxRound: number,
      nextToken?: string,
   ): URL {
      safeRange(minRound, maxRound);
      const plan = buildScanQueryPlan(watch, this.scanQueryVariant);
      const url = new URL(
         `/v2/assets/${watch.assetId}/transactions`,
         this.baseUrl,
      );
      url.searchParams.set('tx-type', 'axfer');
      url.searchParams.set('address', plan.address);
      url.searchParams.set('address-role', plan.addressRole);
      url.searchParams.set('min-round', String(minRound));
      url.searchParams.set('max-round', String(maxRound));
      url.searchParams.set('limit', '1000');
      url.searchParams.set('exclude-close-to', 'true');

      if (plan.exactAmount) {
         const amount = BigInt(watch.atomicAmount);
         url.searchParams.set(
            'currency-greater-than',
            String(amount - 1n),
         );
         url.searchParams.set(
            'currency-less-than',
            String(amount + 1n),
         );
      }

      if (plan.notePrefix) {
         url.searchParams.set(
            'note-prefix',
            Buffer.from(watch.invoiceNote!, 'utf8').toString('base64'),
         );
      }

      if (nextToken) url.searchParams.set('next', nextToken);
      return url;
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
            transactions: requiredBoundedArray(
               body,
               'transactions',
               1_000,
            ).map((item, i) =>
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

               const declaredBytes = headerContentLength(response);
               if (declaredBytes > this.maxResponseBodyBytes) {
                  responseBytes = declaredBytes;
                  throw new Error(
                     `Indexer ${purpose} response exceeded ${this.maxResponseBodyBytes} byte limit`,
                  );
               }

               const boundedBody = await readBoundedResponseText(
                  response,
                  this.maxResponseBodyBytes,
               );
               const rawBody = boundedBody.text;
               responseBytes = boundedBody.bytes;

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
            dispatchObservation ?? {
               outcome: 'success',
               queueWaitMs: 0,
               wallTimeMs: 0,
            },
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

interface ParsedTransactionCommon {
   transaction?: string;
   sender: string;
   round: number;
   roundTime: number;
   txType: string;
   note?: string;
   record: IndexerTransaction;
}

interface ParsedAssetTransferEnvelope extends ParsedTransactionCommon {
   receiver: string;
   assetId: number;
   atomicAmount: string;
   assetSender?: string;
   closeTo?: string;
   closeAmount: string;
}

const MAX_INDEXER_INNER_TRANSACTIONS = 1_000;
const MAX_INDEXER_INNER_DEPTH = 16;

function parseTransactionCommon(
   value: unknown,
   label: string,
   requireTransactionId: boolean,
): ParsedTransactionCommon {
   const transaction = record(value, label) as IndexerTransaction;
   let transactionId: string | undefined;

   if (requireTransactionId) {
      transactionId = nonEmptyString(transaction.id, `${label} id`);
   } else if (transaction.id !== undefined) {
      transactionId = nonEmptyString(transaction.id, `${label} id`);
   }

   const note = parseOptionalNote(transaction.note, label);

   return {
      ...(transactionId === undefined
         ? {}
         : { transaction: transactionId }),
      sender: nonEmptyString(transaction.sender, `${label} sender`),
      round: safeRound(
         transaction['confirmed-round'],
         `${label} confirmed-round`,
      ),
      roundTime: safeRound(
         transaction['round-time'],
         `${label} round-time`,
      ),
      txType: nonEmptyString(
         transaction['tx-type'],
         `${label} tx-type`,
      ),
      ...(note === undefined ? {} : { note }),
      record: transaction,
   };
}

function parseAssetTransferEnvelope(
   value: unknown,
   label: string,
   requireTransactionId: boolean,
): ParsedAssetTransferEnvelope {
   const common = parseTransactionCommon(
      value,
      label,
      requireTransactionId,
   );

   if (common.txType !== 'axfer') {
      throw new Error(`${label} is not an axfer transaction`);
   }

   const transfer = record(
      common.record['asset-transfer-transaction'],
      `${label} asset transfer`,
   );
   const assetSender =
      transfer.sender === undefined
         ? undefined
         : nonEmptyString(transfer.sender, `${label} asset sender`);
   const closeTo =
      transfer['close-to'] === undefined
         ? undefined
         : nonEmptyString(transfer['close-to'], `${label} close-to`);
   const closeAmount =
      transfer['close-amount'] === undefined
         ? '0'
         : safeAmount(
              transfer['close-amount'],
              `${label} close-amount`,
           );

   // Indexer emits close-amount: 0 for ordinary transfers. A positive close
   // amount without a close destination is contradictory evidence.
   if (closeTo === undefined && closeAmount !== '0') {
      throw new Error(
         `${label} has positive close-amount without close-to`,
      );
   }

   return {
      ...common,
      receiver: nonEmptyString(
         transfer.receiver,
         `${label} receiver`,
      ),
      assetId: safeRound(
         transfer['asset-id'],
         `${label} asset-id`,
      ),
      atomicAmount: safeAmount(
         transfer.amount,
         `${label} amount`,
      ),
      ...(assetSender === undefined ? {} : { assetSender }),
      ...(closeTo === undefined ? {} : { closeTo }),
      closeAmount,
   };
}

function parseDirectAssetTransfer(
   value: unknown,
   label: string,
): IndexedAssetTransfer {
   const parsed = parseAssetTransferEnvelope(value, label, true);

   if (parsed.assetSender !== undefined) {
      throw new Error(`${label} is a clawback asset transfer`);
   }
   if (parsed.closeTo !== undefined) {
      throw new Error(`${label} is an asset close-out transfer`);
   }

   return indexedAssetTransfer(parsed, label);
}

function indexedAssetTransfer(
   parsed: ParsedAssetTransferEnvelope,
   label: string,
): IndexedAssetTransfer {
   if (parsed.transaction === undefined) {
      throw new Error(`${label} has no top-level transaction ID`);
   }

   return {
      transaction: parsed.transaction,
      sender: parsed.sender,
      receiver: parsed.receiver,
      assetId: parsed.assetId,
      atomicAmount: parsed.atomicAmount,
      round: parsed.round,
   };
}

interface ScanQueryPlan {
   address: string;
   addressRole: 'sender' | 'receiver';
   exactAmount: boolean;
   notePrefix: boolean;
}

function buildScanQueryPlan(
   watch: Pick<
      WatchRecord,
      'expectedSender' | 'expectedReceiver' | 'atomicAmount' | 'invoiceNote'
   >,
   variant: ScanQueryVariant,
): ScanQueryPlan {
   const exactAmount = variant !== 'A';
   const notePrefix =
      (variant === 'C' || variant === 'D') &&
      watch.invoiceNote !== undefined;

   if (exactAmount) {
      const amount = BigInt(watch.atomicAmount);
      if (amount <= 0n) {
         throw new Error(
            'exact amount Indexer filtering requires a positive atomicAmount',
         );
      }
   }

   return {
      address: variant === 'D'
         ? watch.expectedReceiver
         : watch.expectedSender,
      addressRole: variant === 'D' ? 'receiver' : 'sender',
      exactAmount,
      notePrefix,
   };
}

function parseWatchTransaction(
   value: unknown,
   index: number,
   minRound: number,
   maxRound: number,
   watch: Pick<
      WatchRecord,
      | 'expectedSender'
      | 'expectedReceiver'
      | 'assetId'
      | 'atomicAmount'
      | 'invoiceNote'
   >,
   plan: ScanQueryPlan,
): IndexedWatchTransaction | undefined {
   const label = `transaction page item ${index}`;
   const common = parseTransactionCommon(value, label, true);

   if (common.round < minRound || common.round > maxRound) {
      throw new Error(`${label} lies outside the requested round range`);
   }

   if (common.txType !== 'axfer') {
      const innerTransactions = common.record['inner-txns'];
      if (
         !Array.isArray(innerTransactions) ||
         innerTransactions.length === 0
      ) {
         throw new Error(
            `${label} is not an axfer and has no inner transaction evidence`,
         );
      }
      if (innerTransactions.length > MAX_INDEXER_INNER_TRANSACTIONS) {
         throw new Error(
            `${label} inner transaction count exceeds ${MAX_INDEXER_INNER_TRANSACTIONS}`,
         );
      }

      const traversal = { visited: 0 };
      let queryMatch = false;
      for (let i = 0; i < innerTransactions.length; i += 1) {
         queryMatch =
            inspectInnerTransaction(
               innerTransactions[i],
               `${label} inner transaction ${i}`,
               minRound,
               maxRound,
               watch,
               plan,
               1,
               traversal,
            ) || queryMatch;
      }

      if (!queryMatch) {
         throw new Error(
            `${label} inner transaction tree does not satisfy the requested asset-transfer filters`,
         );
      }

      // The provider returned this parent because a validated inner asset
      // transfer satisfied the search. Inner transfers remain outside the
      // RoundWatch payment contract, but only validated evidence may
      // contribute to coverage.
      return undefined;
   }

   const parsed = parseAssetTransferEnvelope(value, label, true);
   assertTopLevelScanFilters(parsed, minRound, maxRound, watch, plan, label);

   if (
      parsed.assetSender !== undefined ||
      parsed.closeTo !== undefined
   ) {
      // Valid clawback/close-out transactions are explicitly outside the
      // direct-payment contract. They may be ignored only after the complete
      // envelope and server-side query filters have been validated.
      return undefined;
   }

   return {
      ...indexedAssetTransfer(parsed, label),
      roundTime: parsed.roundTime,
      ...(parsed.note === undefined ? {} : { note: parsed.note }),
   };
}

function inspectInnerTransaction(
   value: unknown,
   label: string,
   minRound: number,
   maxRound: number,
   watch: Pick<
      WatchRecord,
      | 'expectedSender'
      | 'expectedReceiver'
      | 'assetId'
      | 'atomicAmount'
      | 'invoiceNote'
   >,
   plan: ScanQueryPlan,
   depth: number,
   traversal: { visited: number },
): boolean {
   if (depth > MAX_INDEXER_INNER_DEPTH) {
      throw new Error(
         `${label} exceeds inner transaction depth ${MAX_INDEXER_INNER_DEPTH}`,
      );
   }
   traversal.visited += 1;
   if (traversal.visited > MAX_INDEXER_INNER_TRANSACTIONS) {
      throw new Error(
         `${label} inner transaction tree exceeds ${MAX_INDEXER_INNER_TRANSACTIONS} items`,
      );
   }

   const common = parseTransactionCommon(value, label, false);
   if (common.round < minRound || common.round > maxRound) {
      throw new Error(`${label} lies outside the requested round range`);
   }

   if (common.txType === 'axfer') {
      const parsed = parseAssetTransferEnvelope(value, label, false);
      return satisfiesScanFilters(parsed, watch, plan);
   }

   const children = common.record['inner-txns'];
   if (children === undefined) return false;
   if (!Array.isArray(children)) {
      throw new Error(`${label} inner-txns is not an array`);
   }

   let queryMatch = false;
   for (let i = 0; i < children.length; i += 1) {
      queryMatch =
         inspectInnerTransaction(
            children[i],
            `${label} child ${i}`,
            minRound,
            maxRound,
            watch,
            plan,
            depth + 1,
            traversal,
         ) || queryMatch;
   }
   return queryMatch;
}

function assertTopLevelScanFilters(
   parsed: ParsedAssetTransferEnvelope,
   minRound: number,
   maxRound: number,
   watch: Pick<
      WatchRecord,
      | 'expectedSender'
      | 'expectedReceiver'
      | 'assetId'
      | 'atomicAmount'
      | 'invoiceNote'
   >,
   plan: ScanQueryPlan,
   label: string,
): void {
   if (parsed.round < minRound || parsed.round > maxRound) {
      throw new Error(`${label} lies outside the requested round range`);
   }
   if (parsed.assetId !== watch.assetId) {
      throw new Error(
         `${label} does not satisfy the requested asset filter`,
      );
   }

   const addressMatches =
      plan.addressRole === 'sender'
         ? parsed.sender === plan.address ||
           parsed.assetSender === plan.address
         : parsed.receiver === plan.address;
   if (!addressMatches) {
      throw new Error(
         `${label} does not satisfy the requested ${plan.addressRole} filter`,
      );
   }

   if (
      plan.exactAmount &&
      parsed.atomicAmount !== watch.atomicAmount
   ) {
      throw new Error(
         `${label} does not satisfy the requested amount range`,
      );
   }

   if (!satisfiesNotePrefix(parsed.note, watch, plan)) {
      throw new Error(
         `${label} does not satisfy the requested note prefix`,
      );
   }
}

function satisfiesScanFilters(
   parsed: ParsedAssetTransferEnvelope,
   watch: Pick<
      WatchRecord,
      | 'expectedSender'
      | 'expectedReceiver'
      | 'assetId'
      | 'atomicAmount'
      | 'invoiceNote'
   >,
   plan: ScanQueryPlan,
): boolean {
   if (parsed.assetId !== watch.assetId) return false;

   if (
      plan.addressRole === 'sender' &&
      parsed.sender !== plan.address &&
      parsed.assetSender !== plan.address
   ) {
      return false;
   }
   if (
      plan.addressRole === 'receiver' &&
      parsed.receiver !== plan.address
   ) {
      return false;
   }
   if (
      plan.exactAmount &&
      parsed.atomicAmount !== watch.atomicAmount
   ) {
      return false;
   }

   return satisfiesNotePrefix(parsed.note, watch, plan);
}

function satisfiesNotePrefix(
   note: string | undefined,
   watch: Pick<WatchRecord, 'invoiceNote'>,
   plan: ScanQueryPlan,
): boolean {
   if (!plan.notePrefix) return true;
   if (note === undefined || watch.invoiceNote === undefined) return false;

   const actual = Buffer.from(note, 'base64');
   const prefix = Buffer.from(watch.invoiceNote, 'utf8');
   return (
      actual.length >= prefix.length &&
      actual.subarray(0, prefix.length).equals(prefix)
   );
}

function parseOptionalNote(
   value: unknown,
   label: string,
): string | undefined {
   if (value === undefined) return undefined;
   if (typeof value !== 'string' || !isCanonicalBase64(value)) {
      throw new Error(`${label} note is malformed`);
   }
   return value;
}

function parseTransactionSearchItem(
   value: unknown,
   index: number,
   transactionId: string,
): IndexedAssetTransfer {
   const label = `transaction search item ${index}`;
   const parsed = parseDirectAssetTransfer(value, label);
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

   const nextToken = nonEmptyString(value, 'next-token');
   if (Buffer.byteLength(nextToken, 'utf8') > MAX_INDEXER_NEXT_TOKEN_BYTES) {
      throw new Error(
         `Indexer next-token exceeds ${MAX_INDEXER_NEXT_TOKEN_BYTES} byte limit`,
      );
   }

   return { nextToken };
}
function requiredArray(body: unknown, name: string): unknown[] {
   const value = field(body, name); if (!Array.isArray(value)) throw new Error(`Indexer ${name} is not an array`); return value;
}
function requiredBoundedArray(
   body: unknown,
   name: string,
   maximumItems: number,
): unknown[] {
   const value = requiredArray(body, name);
   if (value.length > maximumItems) {
      throw new Error(
         `Indexer ${name} exceeded requested page limit ${maximumItems}`,
      );
   }
   return value;
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
   if (!raw || !/^\d+$/.test(raw)) return 0;
   const value = Number(raw);
   return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function readBoundedResponseText(
   response: Response,
   limitBytes: number,
): Promise<{ text: string; bytes: number }> {
   if (!response.body) {
      return { text: '', bytes: 0 };
   }

   const reader = response.body.getReader();
   const chunks: Uint8Array[] = [];
   let totalBytes = 0;

   try {
      while (true) {
         const { done, value } = await reader.read();
         if (done) break;

         totalBytes += value.byteLength;
         if (totalBytes > limitBytes) {
            await reader.cancel('indexer response body limit exceeded');
            throw new Error(
               `Indexer response exceeded ${limitBytes} byte limit`,
            );
         }

         chunks.push(value);
      }
   } finally {
      reader.releaseLock();
   }

   const body = new Uint8Array(totalBytes);
   let offset = 0;
   for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
   }

   let text: string;
   try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
   } catch (error) {
      throw new Error('Indexer response was not valid UTF-8', {
         cause: error,
      });
   }

   return { text, bytes: totalBytes };
}

function isTimeoutError(error: unknown): boolean {
   return error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');
}
