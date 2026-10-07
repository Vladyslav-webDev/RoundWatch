import { performance } from 'node:perf_hooks';

import {
   IndexerHttpError,
   matchesWatch,
   type RoundWatchIndexer,
   type TransactionPage,
} from './roundwatch-indexer.js';
import {
   captureWatchEconomicsTurn,
   finishWatchEconomicsTurn,
   warnWatchMetricFailure,
   type RoundWatchEconomicsMetrics,
   type WatchEconomicsRecorder,
   type WatchEconomicsTurn,
} from './roundwatch-metrics.js';
import type { IndexerHealthProbe } from './roundwatch-health-probe.js';
import { ShutdownInterrupted, isShutdownInterrupted } from './roundwatch-shutdown.js';
import type {
   PollingFailureDisposition,
   RoundWatchStore,
   WatchRecord,
} from './roundwatch-store.js';
import {
   IndexerRequestTurnBudget,
   MAX_INDEXER_REQUESTS_PER_ACTIVE_WORK_TURN,
} from './roundwatch-work-budget.js';
import {
   WorkerHealthTracker,
   type CustomerTurnOutcome,
   type WorkerCycleOutcome,
   type WorkerHealthSnapshot,
} from './roundwatch-worker-health.js';

export const DEFAULT_SCAN_ROUND_WINDOW = 100;
export const DEFAULT_SCAN_PAGE_CACHE_ENTRIES = 16;
export const DEFAULT_SCAN_PAGE_CACHE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_POLL_FAILURE_BASE_BACKOFF_MILLISECONDS = 5_000;
export const MAX_POLL_FAILURE_BACKOFF_MILLISECONDS = 5 * 60_000;
export const MAX_POLL_RETRY_AFTER_MILLISECONDS = 60 * 60_000;

export interface PollerCapacitySnapshot {
   lastCycleCompletedAt?: string;
   lastCycleDurationMs?: number;
   watchesAttemptedLastCycle: number;
   watchesSucceededLastCycle: number;
   watchesFailedLastCycle: number;
   currentIndexerRound?: number;
   currentIndexerRoundObservedAt?: string;
}

interface CompletedPollCycle {
   readonly lastCycleCompletedAt: string;
   readonly lastCycleDurationMs: number;
   readonly watchesAttemptedLastCycle: number;
   readonly watchesSucceededLastCycle: number;
   readonly watchesFailedLastCycle: number;
}

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
   private schedulingStopped = false;
   private ownedLifecycles = 0;
   private drainPromise?: Promise<void>;
   private resolveDrain?: () => void;
   private generation = 0;
   private nextWatchIndex = 0;
   private readonly sessions = new Map<string, ScanSession>();
   private readonly historicalPageCache = new Map<string, CachedHistoricalPage>();
   private historicalPageCacheBytes = 0;
   private readonly workerHealth = new WorkerHealthTracker();
   private lastObservedProbeRevision = 0;
   private latestCompletedCycle?: CompletedPollCycle;
   private lastObservedIndexerRound?: number;
   private lastObservedIndexerRoundAt?: string;

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
      private readonly healthProbe?: IndexerHealthProbe,
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
      if (this.schedulingStopped || this.started) return;
      this.started = true;
      this.generation += 1;
      this.lastObservedProbeRevision = this.healthProbe?.currentRevision() ?? 0;
      this.workerHealth.markStarted();
      void this.tick();
   }

   /** Operational pause; start() can resume scheduling. Does not join active work. */
   stop(): void {
      this.started = false;
      this.generation += 1;
      this.workerHealth.markStopped();
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
   }

   /** Terminal scheduling fence. Keep the store open until drain() settles. */
   stopScheduling(): void {
      if (this.schedulingStopped) return;
      this.schedulingStopped = true;
      this.stop();
   }

   /** Establish terminal shutdown and join every direct call and scheduled wrapper. */
   drain(): Promise<void> {
      this.stopScheduling();
      this.drainPromise ??= new Promise<void>(resolve => {
         this.resolveDrain = resolve;
      });
      this.resolveDrainIfIdle();
      return this.drainPromise;
   }

   private resolveDrainIfIdle(): void {
      if (this.ownedLifecycles === 0) this.resolveDrain?.();
   }

   private assertAcquisitionOpen(): void {
      if (this.schedulingStopped) throw new ShutdownInterrupted();
   }

   healthSnapshot(): WorkerHealthSnapshot {
      return {
         ...this.workerHealth.snapshot(
            Math.max(
               this.intervalMilliseconds * 3,
               this.healthProbe?.readinessFreshnessMilliseconds() ?? 45_000,
            ),
         ),
         generation: this.generation,
      };
   }

   readinessCheck(): boolean {
      return this.healthSnapshot().ready;
   }

   capacitySnapshot(): PollerCapacitySnapshot {
      const cycle = this.latestCompletedCycle;
      return {
         ...(cycle === undefined
            ? {}
            : {
                 lastCycleCompletedAt: cycle.lastCycleCompletedAt,
                 lastCycleDurationMs: cycle.lastCycleDurationMs,
              }),
         watchesAttemptedLastCycle: cycle?.watchesAttemptedLastCycle ?? 0,
         watchesSucceededLastCycle: cycle?.watchesSucceededLastCycle ?? 0,
         watchesFailedLastCycle: cycle?.watchesFailedLastCycle ?? 0,
         ...(this.lastObservedIndexerRound === undefined
            ? {}
            : { currentIndexerRound: this.lastObservedIndexerRound }),
         ...(this.lastObservedIndexerRoundAt === undefined
            ? {}
            : {
                 currentIndexerRoundObservedAt:
                    this.lastObservedIndexerRoundAt,
              }),
      };
   }

   async runOnce(
      onProgress?: () => void,
   ): Promise<WorkerCycleOutcome> {
      this.assertAcquisitionOpen();
      this.ownedLifecycles += 1;
      try {
         const generation = this.generation;
         const cycleStartedAt = performance.now();
         let outcome: WorkerCycleOutcome;
         try {
            this.pruneScanSessions();
            outcome = await this.runPollingSweep(generation, onProgress);
         } finally {
            // Ordinary stop/start invalidates session pruning. Terminal drain
            // still owns this continuation, and requires the store to stay open.
            if (generation === this.generation) this.pruneScanSessions();
         }
         return this.schedulingStopped
            ? outcome
            : this.finishCapacityCycle(outcome, cycleStartedAt);
      } finally {
         this.ownedLifecycles -= 1;
         this.resolveDrainIfIdle();
      }
   }

   private pruneScanSessions(): void {
      // Check only retained IDs through the primary-key lookup. Scheduling
      // backoff is not loss of durable eligibility to own a continuation.
      for (const [id, session] of this.sessions) {
         const watch = this.store.getWatch(id);
         if (
            watch?.state !== 'active' ||
            watch.evidenceVersion !== 1 ||
            watch.scanAfterRound === undefined ||
            watch.expiresAt === undefined ||
            session.minRound !== watch.scanAfterRound + 1
         ) {
            this.sessions.delete(id);
         }
      }
   }

   private async runPollingSweep(
      generation: number,
      onProgress?: () => void,
   ): Promise<WorkerCycleOutcome> {
      const outcome: WorkerCycleOutcome = {
         attempted: 0,
         succeeded: 0,
         failed: 0,
      };
      const watches = this.store.listPollingCandidates();

      if (watches.length === 0) {
         this.nextWatchIndex = 0;
         return outcome;
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
         if (!sharedTipPromise) {
            this.assertAcquisitionOpen();
            sharedTipPromise = this.indexer.getCurrentRound('health').then(
               round => {
                  this.lastObservedIndexerRound = round;
                  this.lastObservedIndexerRoundAt = this.now().toISOString();
                  return round;
               },
            );
         }
         return sharedTipPromise;
      };

      const getSweepPage = (
         watch: WatchRecord,
         minRound: number,
         maxRound: number,
         nextToken?: string,
         watchMetrics?: WatchEconomicsRecorder,
      ) => {
         const queryKey = this.indexer.watchPageQueryKey?.(
            watch,
            minRound,
            maxRound,
            nextToken,
         );

         if (!queryKey) {
            this.assertAcquisitionOpen();
            return this.indexer.searchWatchPage(
               watch,
               minRound,
               maxRound,
               nextToken,
               watchMetrics,
            ).then(page => ({ page, fresh: true }));
         }

         const cached = this.getCachedHistoricalPage(queryKey);
         if (cached) {
            return Promise.resolve({ page: cached, fresh: false });
         }

         let pending = sharedPages.get(queryKey);
         if (!pending) {
            this.assertAcquisitionOpen();
            pending = this.indexer.searchWatchPage(
               watch,
               minRound,
               maxRound,
               nextToken,
               watchMetrics,
            ).then(page => {
               if (page.currentRound >= maxRound) {
                  this.cacheHistoricalPage(queryKey, page);
               }
               return page;
            });
            sharedPages.set(queryKey, pending);
         }
         return pending.then(page => ({ page, fresh: true }));
      };

      for (const watch of ordered) {
         this.assertAcquisitionOpen();
         outcome.attempted += 1;
         // Lexical to this turn, never shared with another watch or sweep.
         const context: { metrics?: WatchEconomicsTurn } = {};
         try {
            const turn = await this.serviceWatch(watch, getSweepTip, getSweepPage, context);
            if (turn.kind !== 'noOp') this.store.clearPollingFailure(watch.id);
            if (turn.kind === 'progressed') outcome.succeeded += 1;
            else if (turn.kind === 'providerEvidenceOnly') outcome.providerEvidenceOnly =
               (outcome.providerEvidenceOnly ?? 0) + 1;
            else outcome.noOp = (outcome.noOp ?? 0) + 1;
            if (turn.providerEvidence) outcome.providerEvidence =
               (outcome.providerEvidence ?? 0) + 1;
            onProgress?.();
         } catch (error) {
            if (isShutdownInterrupted(error)) throw error;
            outcome.failed += 1;
            const failure = classifyPollingFailure(error);
            if (
               failure.disposition !== 'permanent' &&
               generation === this.generation
            ) {
               // Publish at recognition, before another watch can await the
               // provider. Completion records statistics, not another epoch.
               this.healthProbe?.invalidateForProviderFailure();
               this.lastObservedProbeRevision = this.healthProbe?.currentRevision() ?? 0;
               this.workerHealth.markProviderFailure();
            }
            this.sessions.delete(watch.id);
            // A cached page may contain a provider continuation token that
            // later became invalid. Clear the bounded cache on any scan-path
            // failure so the next admitted attempt restarts from durable
            // coverage rather than replaying stale provider state.
            this.clearHistoricalPageCache();
            const persisted = this.persistPollingFailure(watch, failure);
            if (persisted?.state === 'indeterminate') {
               outcome.isolatedFailures =
                  (outcome.isolatedFailures ?? 0) + 1;
               this.finishMetric(persisted, context.metrics);
            }
            this.recordMetric(() => console.error(
               `RoundWatch poll failed for watch ${watch.id}:`,
               safeErrorMessage(error),
            ));
         }
      }

      return outcome;
   }

   private finishCapacityCycle(
      outcome: WorkerCycleOutcome,
      cycleStartedAt: number,
   ): WorkerCycleOutcome {
      try {
         const cycleFinishedAt = performance.now();
         if (!Number.isFinite(cycleStartedAt) || !Number.isFinite(cycleFinishedAt)) return outcome;
         const durationMs = Math.max(0, cycleFinishedAt - cycleStartedAt);
         // Native conversion validates the Date range and produces ISO UTC.
         // Capture only here, before tick's subsequent capability-probe work.
         const completedAt = Date.prototype.toISOString.call(this.now());
         if (
            !Number.isFinite(durationMs) ||
            ![outcome.attempted, outcome.succeeded, outcome.failed].every(
               value => Number.isSafeInteger(value) && value >= 0,
            )
         ) return outcome;

         this.latestCompletedCycle = Object.freeze({
            lastCycleCompletedAt: completedAt,
            lastCycleDurationMs: durationMs,
            watchesAttemptedLastCycle: outcome.attempted,
            watchesSucceededLastCycle: outcome.succeeded,
            watchesFailedLastCycle: outcome.failed,
         });
      } catch {
         // Passive telemetry failure must not enter operational failure handling.
         // Keep the preceding complete record; no logging, callbacks, or retries.
      }
      return outcome;
   }

   private persistPollingFailure(
      watch: WatchRecord,
      failure: ClassifiedPollingFailure,
   ): WatchRecord | undefined {
      if (failure.disposition === 'permanent') {
         const updated = this.store.recordPollingFailure(watch.id, {
            code: failure.code,
            ...(failure.status === undefined ? {} : { status: failure.status }),
            disposition: 'permanent',
         });
         if (updated) {
            this.recordMetric(() => console.warn(
               `RoundWatch polling permanently blocked watch=${watch.id} code=${failure.code} work=${updated.workUnitsUsed}/${updated.workUnitBudget ?? 'unknown'}; terminal state=indeterminate`,
            ));
         }
         return updated;
      }

      const failureNumber = Math.max(1, (watch.pollingFailureCount ?? 0) + 1);
      const retryDelay = pollingRetryDelayMilliseconds(
         watch.id,
         failureNumber,
         failure.retryAfterMilliseconds,
      );
      const retryAt = new Date(this.now().getTime() + retryDelay);
      const updated = this.store.recordPollingFailure(watch.id, {
         code: failure.code,
         ...(failure.status === undefined ? {} : { status: failure.status }),
         disposition: failure.disposition,
         retryAt,
      });
      if (updated) {
         this.recordMetric(() => console.warn(
            `RoundWatch polling deferred watch=${watch.id} code=${failure.code} disposition=${failure.disposition} retryAt=${retryAt.toISOString()} failures=${updated.pollingFailureCount}`,
         ));
      }
      return updated;
   }

   private async serviceWatch(
      initial: WatchRecord,
      getSweepTip: () => Promise<number>,
      getSweepPage: (
         watch: WatchRecord,
         minRound: number,
         maxRound: number,
         nextToken?: string,
         watchMetrics?: WatchEconomicsRecorder,
      ) => Promise<{ page: TransactionPage; fresh: boolean }>,
      context: { metrics?: WatchEconomicsTurn },
   ): Promise<CustomerTurnOutcome> {
      if (initial.evidenceVersion !== 1 || initial.scanAfterRound === undefined || initial.expiresAt === undefined) {
         this.recordMetric(() => console.warn(`RoundWatch watch ${initial.id} lacks proof-compatible baseline metadata; left unresolved`));
         return { kind: 'noOp', providerEvidence: false };
      }

      const workClaim = this.store.claimWorkUnit(initial.id, 'polling');
      if (workClaim === 'exhausted') {
         this.sessions.delete(initial.id);
         context.metrics = captureWatchEconomicsTurn(this.economicsMetrics, initial.id);
         this.finishMetric(initial, context.metrics);
         this.recordMetric(() => console.warn(
            `RoundWatch work budget exhausted watch=${initial.id}; terminal state=indeterminate`,
         ));
         return { kind: 'noOp', providerEvidence: false };
      }
      if (workClaim !== 'claimed') return { kind: 'noOp', providerEvidence: false };

      context.metrics = captureWatchEconomicsTurn(this.economicsMetrics, initial.id);
      const watchMetrics = context.metrics?.recorder;
      this.recordMetric(() => watchMetrics?.recordWorkUnit());

      const requestBudget = new IndexerRequestTurnBudget(
         MAX_INDEXER_REQUESTS_PER_ACTIVE_WORK_TURN,
         'active polling turn',
      );

      let watch = initial as WatchRecord & { scanAfterRound: number; expiresAt: string };
      if (watch.closingRound === undefined && this.now().getTime() >= Date.parse(watch.expiresAt)) {
         this.recordMetric(() => watchMetrics?.recordClosingRequest());
         const tip = await requestBudget.run(() => {
            this.assertAcquisitionOpen();
            return this.indexer.getCurrentRound('checkpoint', watch.id, watchMetrics);
         });
         const block = await requestBudget.run(() => {
            this.assertAcquisitionOpen();
            return this.indexer.getBlock(tip, watch.id, watchMetrics);
         });
         if (block.timestamp * 1_000 >= Date.parse(watch.expiresAt)) {
            this.store.setClosingRound(watch.id, block.round);
            watch = this.store.getWatch(watch.id)! as WatchRecord & { scanAfterRound: number; expiresAt: string };
            this.recordMetric(() => console.log(`RoundWatch finalization checkpoint fixed for watch ${watch.id} at round ${block.round}`));
         }
      }

      if (watch.closingRound !== undefined && watch.scanAfterRound >= watch.closingRound) {
         this.store.markExpired(watch.id, watch.scanAfterRound, watch.closingRound);
         this.finishMetric(watch, context.metrics);
         return { kind: 'noOp', providerEvidence: false };
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
         if (maxRound <= watch.scanAfterRound) return { kind: 'noOp', providerEvidence: false };
         session = {
            minRound: watch.scanAfterRound + 1,
            maxRound,
            seenTokens: new Set<string>(),
         };
         this.sessions.set(watch.id, session);
      }

      const { page, fresh } = await requestBudget.run(() =>
         getSweepPage(
            watch,
            session.minRound,
            session.maxRound,
            session.nextToken,
            watchMetrics,
         ),
      );
      let transactionsExamined = 0;
      const match = page.transactions.find(transaction => {
         transactionsExamined += 1;
         return matchesWatch(transaction, watch);
      });
      this.recordMetric(() => watchMetrics?.recordScanPage({
         transactionsReturned: page.transactions.length,
         transactionsExamined,
      }));

      if (page.currentRound < session.maxRound) {
         throw new Error(`Indexer coverage ${page.currentRound} is below requested round ${session.maxRound}`);
      }
      if (match) {
         this.store.markMatched(watch.id, match.transaction, match.round);
         this.sessions.delete(watch.id);
         this.finishMetric(watch, context.metrics);
         this.recordMetric(() => console.log(`RoundWatch matched watch ${watch.id} in round ${match.round}`));
         return { kind: 'progressed', providerEvidence: fresh };
      }
      if (page.nextToken) {
         if (page.nextToken === session.nextToken || session.seenTokens.has(page.nextToken)) {
            throw new Error('Indexer pagination continuation repeated or stalled');
         }
         session.seenTokens.add(page.nextToken);
         session.nextToken = page.nextToken;
         return fresh
            ? { kind: 'providerEvidenceOnly', providerEvidence: true }
            : { kind: 'noOp', providerEvidence: false };
      }

      const advanced = this.store.advanceScanRound(watch.id, watch.scanAfterRound, session.maxRound);
      this.sessions.delete(watch.id);
      if (!advanced) return fresh
         ? { kind: 'providerEvidenceOnly', providerEvidence: true }
         : { kind: 'noOp', providerEvidence: false };
      this.recordMetric(() => watchMetrics?.recordCoverage(
         session.maxRound - watch.scanAfterRound,
      ));
      this.recordMetric(() => console.log(`RoundWatch scan progress watch=${watch.id} coveredThrough=${session.maxRound}`));
      const updated = this.store.getWatch(watch.id);
      if (updated?.closingRound !== undefined && updated.scanAfterRound !== undefined && updated.scanAfterRound === updated.closingRound) {
         this.store.markExpired(updated.id, updated.scanAfterRound, updated.closingRound);
         this.finishMetric(updated, context.metrics);
         this.recordMetric(() => console.log(`RoundWatch finalization complete watch=${updated.id} closingRound=${updated.closingRound}`));
      }
      return { kind: 'progressed', providerEvidence: fresh };
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

   private finishMetric(
      watch: WatchRecord,
      metricTurn: WatchEconomicsTurn | undefined,
   ): void {
      if (!metricTurn) return;
      const persisted = this.recordMetric(() => this.store.getWatch(watch.id));
      finishWatchEconomicsTurn(metricTurn, persisted, () => this.now().getTime());
   }

   private recordMetric<T>(operation: () => T): T | undefined {
      try {
         return operation();
      } catch (error) {
         warnWatchMetricFailure(
            'RoundWatch economics poll metric failed:',
            error,
         );
      }
   }

   private async tick(): Promise<void> {
      if (this.schedulingStopped || !this.started || this.running) return;
      this.running = true;
      this.ownedLifecycles += 1;
      const generation = this.generation;
      this.workerHealth.markCycleStarted();
      try {
         const outcome = await this.runOnce(() =>
            { if (generation === this.generation) this.workerHealth.markCycleProgress(); },
         );
         if (generation !== this.generation) return;
         if (this.healthProbe && outcome.failed === (outcome.isolatedFailures ?? 0)) {
            const probeAge =
               outcome.attempted === 0
                  ? this.healthProbe.idleIntervalMilliseconds()
                  : this.healthProbe.activeIntervalMilliseconds();
            const sample = await this.healthProbe.runIfDue(probeAge);
            if (generation !== this.generation) return;
            if (
               sample.revision > this.lastObservedProbeRevision &&
               this.healthProbe.isSampleCurrent(sample) &&
               // Current negative evidence counts even when the probe was slow.
               (!sample.evidence.polling ||
                  this.healthProbe.isSampleFreshForAdmission(sample, probeAge))
            ) {
               this.lastObservedProbeRevision = sample.revision;
               this.workerHealth.markProbeResult(sample.evidence.polling);
            }
         }
         this.workerHealth.markCycleCompleted(outcome);
      } catch (error) {
         if (isShutdownInterrupted(error)) return;
         if (generation === this.generation) {
            this.healthProbe?.invalidateForProviderFailure();
            this.workerHealth.markCycleFailed();
         }
         console.error('RoundWatch poll failed:', safeErrorMessage(error));
      } finally {
         this.running = false;
         if (this.started && !this.schedulingStopped) {
            this.timer = setTimeout(
               () => void this.tick(),
               this.intervalMilliseconds,
            );
            this.timer.unref();
         }
         this.ownedLifecycles -= 1;
         this.resolveDrainIfIdle();
      }
   }
}

interface ClassifiedPollingFailure {
   code: string;
   status?: number;
   disposition: PollingFailureDisposition;
   retryAfterMilliseconds?: number;
}

function classifyPollingFailure(error: unknown): ClassifiedPollingFailure {
   if (error instanceof IndexerHttpError) {
      // "Permanent" at the HTTP/provider layer does not automatically mean a
      // single paid watch is permanently invalid. Authentication, forbidden,
      // missing-route and similar failures are service/provider conditions and
      // must keep global readiness unhealthy rather than terminalizing one
      // customer obligation at a time.
      const disposition =
         error.retryDisposition === 'permanent' &&
         !isWatchScopedPermanentIndexerFailure(error)
            ? 'unknown'
            : error.retryDisposition;

      return {
         code: error.code,
         status: error.status,
         disposition,
         ...(error.retryAfterMilliseconds === undefined
            ? {}
            : { retryAfterMilliseconds: error.retryAfterMilliseconds }),
      };
   }

   if (isTimeoutError(error)) {
      return {
         code: 'indexer_timeout',
         disposition: 'transient',
      };
   }

   if (error instanceof TypeError) {
      return {
         code: 'indexer_network_failure',
         disposition: 'transient',
      };
   }

   return {
      code: 'indexer_protocol_failure',
      disposition: 'unknown',
   };
}

function isWatchScopedPermanentIndexerFailure(
   error: IndexerHttpError,
): boolean {
   return (
      error.purpose === 'scan-page' &&
      error.code === 'zero_address_sender_unsupported'
   );
}

function pollingRetryDelayMilliseconds(
   watchId: string,
   failureNumber: number,
   retryAfterMilliseconds: number | undefined,
): number {
   const exponent = Math.min(Math.max(0, failureNumber - 1), 12);
   const base = Math.min(
      DEFAULT_POLL_FAILURE_BASE_BACKOFF_MILLISECONDS * 2 ** exponent,
      MAX_POLL_FAILURE_BACKOFF_MILLISECONDS,
   );
   const jittered = Math.floor(
      base * deterministicJitterFactor(watchId, failureNumber),
   );
   const boundedBackoff = Math.min(
      MAX_POLL_FAILURE_BACKOFF_MILLISECONDS,
      Math.max(DEFAULT_POLL_FAILURE_BASE_BACKOFF_MILLISECONDS, jittered),
   );
   const boundedRetryAfter =
      retryAfterMilliseconds === undefined
         ? 0
         : Math.min(
              Math.max(0, retryAfterMilliseconds),
              MAX_POLL_RETRY_AFTER_MILLISECONDS,
           );
   return Math.max(boundedBackoff, boundedRetryAfter);
}

function deterministicJitterFactor(
   watchId: string,
   failureNumber: number,
): number {
   let hash = 2_166_136_261;
   for (const char of `${watchId}:${failureNumber}`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16_777_619) >>> 0;
   }
   return 0.8 + (hash % 401) / 1_000;
}

function isTimeoutError(error: unknown): boolean {
   return (
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
   );
}

function safeErrorMessage(error: unknown): string {
   return error instanceof Error ? error.message : 'Unknown poll error';
}
