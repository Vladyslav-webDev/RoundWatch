import {
   matchesWatch,
   type RoundWatchIndexer,
   type TransactionPage,
} from './roundwatch-indexer.js';
import type { RoundWatchEconomicsMetrics } from './roundwatch-metrics.js';
import type { RoundWatchStore, WatchRecord, WatchState } from './roundwatch-store.js';
import {
   IndexerRequestTurnBudget,
   MAX_INDEXER_REQUESTS_PER_ACTIVE_WORK_TURN,
} from './roundwatch-work-budget.js';
import {
   WorkerHealthTracker,
   type WorkerHealthSnapshot,
} from './roundwatch-worker-health.js';

export const DEFAULT_SCAN_ROUND_WINDOW = 100;
export const DEFAULT_SCAN_PAGE_CACHE_ENTRIES = 16;
export const DEFAULT_SCAN_PAGE_CACHE_BYTES = 8 * 1024 * 1024;

interface ScanSession {
   minRound: number;
   maxRound: number;
   nextToken?: string;
   seenTokens: Set<string>;
}

interface CachedHistoricalPage {
   encoded: Buffer;
   bytes: number;
}

export class RoundWatchPoller {
   private timer?: NodeJS.Timeout;
   private running = false;
   private started = false;
   private nextWatchIndex = 0;
   private readonly sessions = new Map<string, ScanSession>();
   private readonly historicalPageCache = new Map<string, CachedHistoricalPage>();
   private historicalPageCacheBytes = 0;
   private readonly workerHealth = new WorkerHealthTracker();

   constructor(
      private readonly store: RoundWatchStore,
      private readonly indexer: RoundWatchIndexer,
      private readonly intervalMilliseconds = 5_000,
      private readonly roundWindow = DEFAULT_SCAN_ROUND_WINDOW,
      private readonly now: () => Date = () => new Date(),
      private readonly economicsMetrics?: RoundWatchEconomicsMetrics,
      private readonly historicalPageCacheEntries =
         DEFAULT_SCAN_PAGE_CACHE_ENTRIES,
      private readonly historicalPageCacheByteBudget =
         DEFAULT_SCAN_PAGE_CACHE_BYTES,
   ) {
      if (!Number.isSafeInteger(roundWindow) || roundWindow <= 0) {
         throw new Error('roundWindow must be a finite positive integer');
      }
      if (
         !Number.isSafeInteger(historicalPageCacheEntries) ||
         historicalPageCacheEntries < 0
      ) {
         throw new Error(
            'historicalPageCacheEntries must be a non-negative safe integer',
         );
      }
      if (
         !Number.isSafeInteger(historicalPageCacheByteBudget) ||
         historicalPageCacheByteBudget < 0
      ) {
         throw new Error(
            'historicalPageCacheByteBudget must be a non-negative safe integer',
         );
      }
   }

   start(): void {
      if (this.started) return;
      this.started = true;
      this.workerHealth.markStarted();
      void this.tick();
   }

   stop(): void {
      this.started = false;
      this.workerHealth.markStopped();
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
   }

   healthSnapshot(): WorkerHealthSnapshot {
      return this.workerHealth.snapshot(
         Math.max(this.intervalMilliseconds * 3, 15_000),
      );
   }

   readinessCheck(): boolean {
      return this.healthSnapshot().ready;
   }

   async runOnce(): Promise<void> {
      const watches = this.store.listActiveWatches();

      if (watches.length === 0) {
         this.nextWatchIndex = 0;
         return;
      }

      const startIndex = this.nextWatchIndex % watches.length;
      const ordered = [
         ...watches.slice(startIndex),
         ...watches.slice(0, startIndex),
      ];

      // Rotate which watch receives the first turn on the next sweep. Every
      // watch still receives at most one service turn in this sweep.
      this.nextWatchIndex = (startIndex + 1) % watches.length;

      let sharedTipPromise: Promise<number> | undefined;
      const sharedPages = new Map<string, Promise<TransactionPage>>();

      const getSweepTip = (): Promise<number> => {
         sharedTipPromise ??= this.indexer.getCurrentRound('health');
         return sharedTipPromise;
      };

      const getSweepPage = (
         watch: WatchRecord,
         minRound: number,
         maxRound: number,
         nextToken?: string,
      ) => {
         const queryKey = this.indexer.watchPageQueryKey?.(
            watch,
            minRound,
            maxRound,
            nextToken,
         );

         if (!queryKey) {
            return this.indexer.searchWatchPage(
               watch,
               minRound,
               maxRound,
               nextToken,
            );
         }

         const cached = this.getCachedHistoricalPage(queryKey);
         if (cached) {
            return Promise.resolve(cached);
         }

         let pending = sharedPages.get(queryKey);
         if (!pending) {
            pending = this.indexer.searchWatchPage(
               watch,
               minRound,
               maxRound,
               nextToken,
            ).then(page => {
               if (page.currentRound >= maxRound) {
                  this.cacheHistoricalPage(queryKey, page);
               }
               return page;
            });
            sharedPages.set(queryKey, pending);
         }
         return pending;
      };

      for (const watch of ordered) {
         try {
            await this.serviceWatch(watch, getSweepTip, getSweepPage);
         } catch (error) {
            this.sessions.delete(watch.id);
            // A cached page may contain a provider continuation token that
            // later became invalid. Clear the bounded cache on any scan-path
            // failure so the next sweep restarts from fresh provider state
            // instead of replaying a stale token forever.
            this.clearHistoricalPageCache();
            console.error(
               `RoundWatch poll failed for watch ${watch.id}:`,
               safeErrorMessage(error),
            );
         }
      }
   }

   private async serviceWatch(
      initial: WatchRecord,
      getSweepTip: () => Promise<number>,
      getSweepPage: (
         watch: WatchRecord,
         minRound: number,
         maxRound: number,
         nextToken?: string,
      ) => Promise<TransactionPage>,
   ): Promise<void> {
      if (initial.evidenceVersion !== 1 || initial.scanAfterRound === undefined || initial.expiresAt === undefined) {
         console.warn(`RoundWatch watch ${initial.id} lacks proof-compatible baseline metadata; left unresolved`);
         return;
      }

      const workClaim = this.store.claimWorkUnit(initial.id);
      if (workClaim === 'exhausted') {
         this.sessions.delete(initial.id);
         this.finishMetric(initial, 'indeterminate');
         console.warn(
            `RoundWatch work budget exhausted watch=${initial.id}; terminal state=indeterminate`,
         );
         return;
      }
      if (workClaim !== 'claimed') return;

      this.recordMetric(() =>
         this.economicsMetrics?.recordWorkUnit(initial.id),
      );

      const requestBudget = new IndexerRequestTurnBudget(
         MAX_INDEXER_REQUESTS_PER_ACTIVE_WORK_TURN,
         'active polling turn',
      );

      let watch = initial as WatchRecord & { scanAfterRound: number; expiresAt: string };
      if (watch.closingRound === undefined && this.now().getTime() >= Date.parse(watch.expiresAt)) {
         this.recordMetric(() => this.economicsMetrics?.recordClosingRequest(watch.id));
         const tip = await requestBudget.run(() =>
            this.indexer.getCurrentRound('checkpoint', watch.id),
         );
         const block = await requestBudget.run(() =>
            this.indexer.getBlock(tip, watch.id),
         );
         if (block.timestamp * 1_000 >= Date.parse(watch.expiresAt)) {
            this.store.setClosingRound(watch.id, block.round);
            watch = this.store.getWatch(watch.id)! as WatchRecord & { scanAfterRound: number; expiresAt: string };
            console.log(`RoundWatch finalization checkpoint fixed for watch ${watch.id} at round ${block.round}`);
         }
      }

      if (watch.closingRound !== undefined && watch.scanAfterRound >= watch.closingRound) {
         this.store.markExpired(watch.id, watch.scanAfterRound, watch.closingRound);
         this.finishMetric(watch, 'expired');
         return;
      }

      let session = this.sessions.get(watch.id);
      if (session && session.minRound !== watch.scanAfterRound + 1) {
         this.sessions.delete(watch.id);
         session = undefined;
      }
      if (!session) {
         const tip = await requestBudget.run(getSweepTip);
         const maxRound = Math.min(
            watch.scanAfterRound + this.roundWindow,
            tip,
            watch.closingRound ?? Number.MAX_SAFE_INTEGER,
         );
         if (maxRound <= watch.scanAfterRound) return;
         session = {
            minRound: watch.scanAfterRound + 1,
            maxRound,
            seenTokens: new Set<string>(),
         };
         this.sessions.set(watch.id, session);
      }

      const page = await requestBudget.run(() =>
         getSweepPage(
            watch,
            session.minRound,
            session.maxRound,
            session.nextToken,
         ),
      );
      let transactionsExamined = 0;
      const match = page.transactions.find(transaction => {
         transactionsExamined += 1;
         return matchesWatch(transaction, watch);
      });
      this.recordMetric(() => this.economicsMetrics?.recordScanPage(watch.id, {
         transactionsReturned: page.transactions.length,
         transactionsExamined,
      }));

      if (page.currentRound < session.maxRound) {
         throw new Error(`Indexer coverage ${page.currentRound} is below requested round ${session.maxRound}`);
      }
      if (match) {
         this.store.markMatched(watch.id, match.transaction, match.round);
         this.sessions.delete(watch.id);
         this.finishMetric(watch, 'matched');
         console.log(`RoundWatch matched watch ${watch.id} in round ${match.round}`);
         return;
      }
      if (page.nextToken) {
         if (page.nextToken === session.nextToken || session.seenTokens.has(page.nextToken)) {
            throw new Error('Indexer pagination continuation repeated or stalled');
         }
         session.seenTokens.add(page.nextToken);
         session.nextToken = page.nextToken;
         return;
      }

      const advanced = this.store.advanceScanRound(watch.id, watch.scanAfterRound, session.maxRound);
      this.sessions.delete(watch.id);
      if (!advanced) return;
      this.recordMetric(() => this.economicsMetrics?.recordCoverage(
         watch.id,
         session.maxRound - watch.scanAfterRound,
      ));
      console.log(`RoundWatch scan progress watch=${watch.id} coveredThrough=${session.maxRound}`);
      const updated = this.store.getWatch(watch.id);
      if (updated?.closingRound !== undefined && updated.scanAfterRound !== undefined && updated.scanAfterRound === updated.closingRound) {
         this.store.markExpired(updated.id, updated.scanAfterRound, updated.closingRound);
         this.finishMetric(updated, 'expired');
         console.log(`RoundWatch finalization complete watch=${updated.id} closingRound=${updated.closingRound}`);
      }
   }

   private getCachedHistoricalPage(
      queryKey: string,
   ): TransactionPage | undefined {
      const cached = this.historicalPageCache.get(queryKey);
      if (!cached) return undefined;

      // Refresh insertion order to maintain an LRU eviction policy.
      this.historicalPageCache.delete(queryKey);
      this.historicalPageCache.set(queryKey, cached);

      return JSON.parse(cached.encoded.toString('utf8')) as TransactionPage;
   }

   private cacheHistoricalPage(
      queryKey: string,
      page: TransactionPage,
   ): void {
      if (
         this.historicalPageCacheEntries === 0 ||
         this.historicalPageCacheByteBudget === 0
      ) {
         return;
      }

      const encoded = Buffer.from(JSON.stringify(page), 'utf8');
      const bytes = encoded.byteLength;

      // Never let one oversized response evict the whole useful cache only to
      // remain resident itself. It simply remains eligible for within-sweep
      // promise sharing and is fetched again on a later sweep.
      if (bytes > this.historicalPageCacheByteBudget) return;

      const existing = this.historicalPageCache.get(queryKey);
      if (existing) {
         this.historicalPageCacheBytes -= existing.bytes;
         this.historicalPageCache.delete(queryKey);
      }

      this.historicalPageCache.set(queryKey, { encoded, bytes });
      this.historicalPageCacheBytes += bytes;

      while (
         this.historicalPageCache.size > this.historicalPageCacheEntries ||
         this.historicalPageCacheBytes >
            this.historicalPageCacheByteBudget
      ) {
         const oldestKey = this.historicalPageCache.keys().next().value as
            | string
            | undefined;
         if (oldestKey === undefined) break;

         const oldest = this.historicalPageCache.get(oldestKey);
         if (oldest) {
            this.historicalPageCacheBytes -= oldest.bytes;
         }
         this.historicalPageCache.delete(oldestKey);
      }
   }

   private clearHistoricalPageCache(): void {
      this.historicalPageCache.clear();
      this.historicalPageCacheBytes = 0;
   }

   private finishMetric(watch: WatchRecord, finalState: WatchState): void {
      if (!this.economicsMetrics) return;

      const now = this.now().getTime();
      const createdAt = Date.parse(watch.createdAt);
      const activatedAt = watch.activatedAt ? Date.parse(watch.activatedAt) : NaN;

      this.recordMetric(() => this.economicsMetrics?.recordLifecycle(watch.id, {
         finalState,
         ...(Number.isFinite(activatedAt)
            ? { activeDurationMs: Math.max(0, now - activatedAt) }
            : {}),
         ...(Number.isFinite(createdAt)
            ? { timeToTerminalMs: Math.max(0, now - createdAt) }
            : {}),
      }));

      const snapshot = this.economicsMetrics.finishWatch(watch.id);
      if (snapshot) {
         console.info(`RoundWatch economics watch-terminal ${JSON.stringify(snapshot)}`);
      }
   }

   private recordMetric(operation: () => void): void {
      try {
         operation();
      } catch (error) {
         console.warn(
            'RoundWatch economics poll metric failed:',
            error instanceof Error ? error.message : 'Unknown metrics error',
         );
      }
   }

   private async tick(): Promise<void> {
      if (this.running) return;
      this.running = true;
      this.workerHealth.markCycleStarted();
      try {
         await this.runOnce();
         this.workerHealth.markCycleSucceeded();
      } catch (error) {
         this.workerHealth.markCycleFailed();
         console.error('RoundWatch poll failed:', safeErrorMessage(error));
      } finally {
         this.running = false;
         if (this.started) {
            this.timer = setTimeout(
               () => void this.tick(),
               this.intervalMilliseconds,
            );
            this.timer.unref();
         }
      }
   }
}

function safeErrorMessage(error: unknown): string {
   return error instanceof Error ? error.message : 'Unknown poll error';
}
