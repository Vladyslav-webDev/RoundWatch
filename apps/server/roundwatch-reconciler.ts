import type { TransactionIdPage } from './roundwatch-indexer.js';
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
import type { RoundWatchStore, WatchRecord } from './roundwatch-store.js';
import {
   IndexerRequestTurnBudget,
   MAX_INDEXER_REQUESTS_PER_RECONCILIATION_WORK_TURN,
} from './roundwatch-work-budget.js';
import {
   WorkerHealthTracker,
   type CustomerTurnOutcome,
   type WorkerCycleOutcome,
   type WorkerHealthSnapshot,
} from './roundwatch-worker-health.js';

export interface IndexedAssetTransfer {
   transaction: string;
   sender: string;
   receiver: string;
   assetId: number;
   atomicAmount: string;
   round: number;
}

export interface SettlementLookupIndexer {
   lookupAssetTransfer(
      transactionId: string,
      purpose?: 'activation' | 'reconciliation',
      watchId?: string,
      watchMetrics?: WatchEconomicsRecorder,
   ): Promise<IndexedAssetTransfer | undefined>;
   getCurrentRound(
      purpose?: 'reconciliation',
      watchId?: string,
      watchMetrics?: WatchEconomicsRecorder,
   ): Promise<number>;
   searchTransactionPage(
      transactionId: string,
      nextToken?: string,
      watchId?: string,
      watchMetrics?: WatchEconomicsRecorder,
   ): Promise<TransactionIdPage>;
}

export interface SettlementReconcilerConfig {
   network: string;
   intervalMilliseconds: number;
   baseBackoffMilliseconds?: number;
   maxBackoffMilliseconds?: number;
   now?: () => Date;
}

interface AbsenceProofSession {
   expectedTransaction: string;
   nextToken?: string;
   seenTokens: Set<string>;
   coverage?: number;
}

export class SettlementReconciler {
   private timer: NodeJS.Timeout | undefined;
   private running = false;
   private scheduledRunning = false;
   private shutdownStarted = false;
   private ownedWork = 0;
   private drainPromise?: Promise<void>;
   private resolveDrain?: () => void;
   private generation = 0;
   private readonly absenceProofSessions = new Map<string, AbsenceProofSession>();
   private readonly now: () => Date;
   private readonly baseBackoffMilliseconds: number;
   private readonly maxBackoffMilliseconds: number;
   private readonly workerHealth = new WorkerHealthTracker();
   private lastObservedProbeRevision = 0;

   constructor(
      private readonly store: RoundWatchStore,
      private readonly indexer: SettlementLookupIndexer,
      private readonly config: SettlementReconcilerConfig,
      private readonly economicsMetrics?: RoundWatchEconomicsMetrics,
      private readonly healthProbe?: IndexerHealthProbe,
   ) {
      this.now = config.now ?? (() => new Date());
      this.baseBackoffMilliseconds = config.baseBackoffMilliseconds ?? 1_000;
      this.maxBackoffMilliseconds = config.maxBackoffMilliseconds ?? 60_000;
   }

   start(): void {
      if (this.shutdownStarted || this.timer) return;
      this.generation += 1;
      this.lastObservedProbeRevision = this.healthProbe?.currentRevision() ?? 0;
      this.workerHealth.markStarted();
      const run = () => {
         if (this.shutdownStarted || this.scheduledRunning) return;
         this.scheduledRunning = true;
         const generation = this.generation;

         this.workerHealth.markCycleStarted();
         // The wrapper owns the post-sweep probe as well as reconciliation.
         void this.ownWork(() => this.reconcileOnce(() =>
            { if (generation === this.generation) this.workerHealth.markCycleProgress(); },
         )
            .then(async outcome => {
               if (generation !== this.generation) return;
               if (this.healthProbe && outcome.failed === 0) {
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
                     (!sample.evidence.reconciliation ||
                        this.healthProbe.isSampleFreshForAdmission(sample, probeAge))
                  ) {
                     this.lastObservedProbeRevision = sample.revision;
                     this.workerHealth.markProbeResult(sample.evidence.reconciliation);
                  }
               }
               this.workerHealth.markCycleCompleted(outcome);
            })
            .catch(error => {
               if (isShutdownInterrupted(error)) return;
               if (generation === this.generation) {
                  this.healthProbe?.invalidateForProviderFailure();
                  this.workerHealth.markCycleFailed();
               }
               console.error(
                  'RoundWatch settlement reconciliation failed:',
                  safeErrorMessage(error),
               );
            })
            .finally(() => { this.scheduledRunning = false; }));
      };
      run();
      if (this.shutdownStarted) return;
      this.timer = setInterval(run, this.config.intervalMilliseconds);
      this.timer.unref();
   }

   stop(): void {
      this.generation += 1;
      this.workerHealth.markStopped();
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
   }

   // Unlike operational stop(), this boundary permanently prevents restart.
   stopScheduling(): void {
      if (this.shutdownStarted) return;
      this.shutdownStarted = true;
      this.stop();
   }

   // Establish the terminal boundary, then join direct sweeps and wrappers.
   drain(): Promise<void> {
      this.stopScheduling();
      if (!this.drainPromise) {
         this.drainPromise = this.ownedWork === 0
            ? Promise.resolve()
            : new Promise(resolve => { this.resolveDrain = resolve; });
      }
      return this.drainPromise;
   }

   healthSnapshot(): WorkerHealthSnapshot {
      return {
         ...this.workerHealth.snapshot(
            Math.max(
               this.config.intervalMilliseconds * 3,
               this.healthProbe?.readinessFreshnessMilliseconds() ?? 45_000,
            ),
         ),
         generation: this.generation,
      };
   }

   readinessCheck(): boolean {
      return this.healthSnapshot().ready;
   }

   reconcileOnce(
      onProgress?: () => void,
   ): Promise<WorkerCycleOutcome> {
      if (this.shutdownStarted) return Promise.reject(new ShutdownInterrupted());
      return this.ownWork(() => this.reconcileSweep(onProgress));
   }

   private async ownWork<T>(operation: () => Promise<T>): Promise<T> {
      this.ownedWork += 1;
      try {
         return await operation();
      } finally {
         this.ownedWork -= 1;
         if (this.ownedWork === 0) this.resolveDrain?.();
      }
   }

   private assertSchedulingOpen(): void {
      if (this.shutdownStarted) throw new ShutdownInterrupted();
   }

   private async reconcileSweep(
      onProgress?: () => void,
   ): Promise<WorkerCycleOutcome> {
      const outcome: WorkerCycleOutcome = {
         attempted: 0,
         succeeded: 0,
         failed: 0,
      };
      if (this.running) return outcome;
      const generation = this.generation;
      this.running = true;
      try {
         this.pruneAbsenceProofSessions();
         for (const watch of this.store.listSettlementReconciliationCandidates()) {
            this.assertSchedulingOpen();
            outcome.attempted += 1;
            try {
               const turn = await this.reconcileWatch(watch);
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
               if (generation === this.generation) {
                  // Invalidate before the next customer turn; the sweep's
                  // completion must not republish this provider failure.
                  this.healthProbe?.invalidateForProviderFailure();
                  this.lastObservedProbeRevision = this.healthProbe?.currentRevision() ?? 0;
                  this.workerHealth.markProviderFailure();
               }
               this.absenceProofSessions.delete(watch.id);
               this.defer(watch);
               this.recordMetric(() => console.error(`RoundWatch settlement reconciliation failed for watch ${watch.id}:`, safeErrorMessage(error)));
            }
         }
      } finally {
         this.running = false;
         // Preserve operational stop/start generation fencing: an invalidated
         // sweep leaves pruning to the next sweep.
         if (generation === this.generation) this.pruneAbsenceProofSessions();
      }
      return outcome;
   }

   private pruneAbsenceProofSessions(): void {
      for (const [watchId, session] of this.absenceProofSessions) {
         const watch = this.store.getWatch(watchId);
         // Due-candidate selection excludes backoff rows. Their pagination
         // state still belongs to a live reconciliation obligation.
         if (!this.isSessionCompatible(session, watch)) {
            this.absenceProofSessions.delete(watchId);
         }
      }
   }

   private isSessionCompatible(
      session: AbsenceProofSession,
      watch: WatchRecord | undefined,
   ): boolean {
      return !!watch &&
         (watch.state === 'settlement_pending' || watch.state === 'settlement_unknown') &&
         !watch.settlementReconciliationTerminal &&
         watch.expectedServiceTransaction === session.expectedTransaction;
   }

   private async reconcileWatch(watch: WatchRecord): Promise<CustomerTurnOutcome> {
      const expectedTransaction = watch.expectedServiceTransaction;
      if (!expectedTransaction) return { kind: 'noOp', providerEvidence: false };
      // A candidate selected before another turn awaited may already have
      // been terminally rejected. Check before claiming work, which can itself
      // terminalize a watch through budget exhaustion.
      const metricWasTerminal = this.economicsMetrics
         ? this.store.getWatch(watch.id)?.settlementReconciliationTerminal
         : false;
      const captureMetrics = () => captureWatchEconomicsTurn(
         this.economicsMetrics, watch.id, !!metricWasTerminal,
      );
      this.assertSchedulingOpen();
      const workClaim = this.store.claimWorkUnit(watch.id, {
         purpose: 'reconciliation',
         expectedServiceTransaction: expectedTransaction,
         expectedReconciliationAttempts: watch.reconciliationAttempts,
      });
      if (workClaim === 'exhausted') {
         this.absenceProofSessions.delete(watch.id);
         this.finishMetric(watch, captureMetrics());
         this.recordMetric(() => console.warn(
            `RoundWatch work budget exhausted during settlement reconciliation watch=${watch.id}; terminal state=indeterminate`,
         ));
         return { kind: 'noOp', providerEvidence: false };
      }
      if (workClaim !== 'claimed') {
         const session = this.absenceProofSessions.get(watch.id);
         // Freshness rejection can be temporary scheduling/attempt staleness.
         // Keep pagination unless the durable obligation identity changed.
         if (session && !this.isSessionCompatible(session, this.store.getWatch(watch.id))) {
            this.absenceProofSessions.delete(watch.id);
         }
         return { kind: 'noOp', providerEvidence: false };
      }

      const metricTurn = captureMetrics();
      const watchMetrics = metricTurn?.recorder;
      // An inert recorder explicitly suppresses ID fallback after capture
      // failure; every continuation retains this turn's original binding.
      this.recordMetric(() => {
         watchMetrics?.recordWorkUnit();
         watchMetrics?.recordReconciliationAttempt();
      });

      const requestBudget = new IndexerRequestTurnBudget(
         MAX_INDEXER_REQUESTS_PER_RECONCILIATION_WORK_TURN,
         'settlement reconciliation turn',
      );

      if (!hasImmutableTerms(watch)) {
         // Legacy rows cannot receive fabricated purchase terms or a terminal proof.
         this.defer(watch);
         return { kind: 'noOp', providerEvidence: false };
      }

      let session = this.absenceProofSessions.get(watch.id);
      if (session && !this.isSessionCompatible(session, watch)) {
         this.absenceProofSessions.delete(watch.id);
         session = undefined;
      }

      if (!session) {
         this.assertSchedulingOpen();
         const transfer = await requestBudget.run(() =>
            this.indexer.lookupAssetTransfer(
               expectedTransaction,
               'reconciliation',
               watch.id,
               watchMetrics,
            ),
         );
         if (transfer) {
            this.absenceProofSessions.delete(watch.id);
            this.applyConfirmed(watch, transfer, metricTurn);
            return { kind: 'progressed', providerEvidence: true };
         }

         this.assertSchedulingOpen();
         const currentRound = await requestBudget.run(() =>
            this.indexer.getCurrentRound(
               'reconciliation',
               watch.id,
               watchMetrics,
            ),
         );
         if (currentRound <= watch.serviceLastValid) {
            this.defer(watch);
            return { kind: 'providerEvidenceOnly', providerEvidence: true };
         }

         session = {
            expectedTransaction,
            seenTokens: new Set<string>(),
         };
         this.absenceProofSessions.set(watch.id, session);
      }

      this.assertSchedulingOpen();
      const page = await requestBudget.run(() =>
         this.indexer.searchTransactionPage(
            expectedTransaction,
            session.nextToken,
            watch.id,
            watchMetrics,
         ),
      );
      session.coverage =
         session.coverage === undefined
            ? page.currentRound
            : Math.min(session.coverage, page.currentRound);

      const found = page.transactions.find(
         item => item.transaction === expectedTransaction,
      );
      if (found) {
         this.absenceProofSessions.delete(watch.id);
         this.applyConfirmed(watch, found, metricTurn);
         return { kind: 'progressed', providerEvidence: true };
      }

      if (page.nextToken) {
         if (
            page.nextToken === session.nextToken ||
            session.seenTokens.has(page.nextToken)
         ) {
            throw new Error(
               'Indexer absence-proof pagination repeated or stalled',
            );
         }

         session.seenTokens.add(page.nextToken);
         session.nextToken = page.nextToken;
         this.defer(watch);
         return { kind: 'providerEvidenceOnly', providerEvidence: true };
      }

      this.absenceProofSessions.delete(watch.id);
      if (
         session.coverage === undefined ||
         session.coverage <= watch.serviceLastValid
      ) {
         throw new Error(
            'Indexer absence proof lacks post-LastValid coverage',
         );
      }

      this.store.markSettlementInvalid(watch.id);
      this.finishMetric(watch, metricTurn);
      this.recordMetric(() => console.error(
         `RoundWatch service transaction remained absent after LastValid for watch ${watch.id}`,
      ));
      return { kind: 'progressed', providerEvidence: true };
   }

   private applyConfirmed(
      watch: WatchRecord,
      transfer: IndexedAssetTransfer,
      metricTurn: WatchEconomicsTurn | undefined,
   ): void {
      this.absenceProofSessions.delete(watch.id);
      const matches =
         transfer.transaction === watch.expectedServiceTransaction &&
         watch.expectedServiceNetwork === this.config.network &&
         transfer.sender === watch.expectedServicePayer &&
         transfer.receiver === watch.serviceReceiver &&
         transfer.assetId === watch.serviceAssetId &&
         transfer.atomicAmount === watch.serviceAtomicAmount &&
         transfer.round >= watch.serviceFirstValid! &&
         transfer.round <= watch.serviceLastValid!;
      if (!matches) {
         this.store.markSettlementInvalid(watch.id);
         this.finishMetric(watch, metricTurn);
         this.recordMetric(() => console.error(`RoundWatch confirmed service transaction mismatched immutable terms for watch ${watch.id}`));
         return;
      }
      this.store.activateWatch(watch.id, {
         transaction: transfer.transaction,
         network: this.config.network,
         payer: transfer.sender,
      }, transfer.round);
      this.recordMetric(() => console.log(`RoundWatch reconciled watch ${watch.id} at service round ${transfer.round}`));
   }

   private defer(watch: WatchRecord): void {
      const exponent = Math.min(watch.reconciliationAttempts, 20);
      const delay = Math.min(this.maxBackoffMilliseconds, this.baseBackoffMilliseconds * 2 ** exponent);
      this.store.recordReconciliationFailure(watch.id, new Date(this.now().getTime() + delay));
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
            'RoundWatch economics reconciliation metric failed:',
            error,
         );
      }
   }
}

function hasImmutableTerms(watch: WatchRecord): watch is WatchRecord & {
   expectedServiceTransaction: string;
   expectedServiceNetwork: string;
   expectedServicePayer: string;
   serviceReceiver: string;
   serviceAssetId: number;
   serviceAtomicAmount: string;
   serviceFirstValid: number;
   serviceLastValid: number;
} {
   return watch.evidenceVersion === 1 &&
      typeof watch.expectedServiceTransaction === 'string' &&
      typeof watch.expectedServiceNetwork === 'string' &&
      typeof watch.expectedServicePayer === 'string' &&
      typeof watch.serviceReceiver === 'string' &&
      Number.isSafeInteger(watch.serviceAssetId) &&
      typeof watch.serviceAtomicAmount === 'string' &&
      Number.isSafeInteger(watch.serviceFirstValid) &&
      Number.isSafeInteger(watch.serviceLastValid);
}

function safeErrorMessage(error: unknown): string {
   return error instanceof Error ? error.message : 'Unknown reconciliation error';
}
