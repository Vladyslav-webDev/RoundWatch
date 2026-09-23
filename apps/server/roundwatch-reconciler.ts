import type { TransactionIdPage } from './roundwatch-indexer.js';
import type { RoundWatchEconomicsMetrics } from './roundwatch-metrics.js';
import type { RoundWatchStore, WatchRecord } from './roundwatch-store.js';
import {
   IndexerRequestTurnBudget,
   MAX_INDEXER_REQUESTS_PER_RECONCILIATION_WORK_TURN,
} from './roundwatch-work-budget.js';
import {
   WorkerHealthTracker,
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
   ): Promise<IndexedAssetTransfer | undefined>;
   getCurrentRound(
      purpose?: 'reconciliation',
      watchId?: string,
   ): Promise<number>;
   searchTransactionPage(
      transactionId: string,
      nextToken?: string,
      watchId?: string,
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
   nextToken?: string;
   seenTokens: Set<string>;
   coverage?: number;
}

export class SettlementReconciler {
   private timer: NodeJS.Timeout | undefined;
   private running = false;
   private readonly absenceProofSessions = new Map<string, AbsenceProofSession>();
   private readonly now: () => Date;
   private readonly baseBackoffMilliseconds: number;
   private readonly maxBackoffMilliseconds: number;
   private readonly workerHealth = new WorkerHealthTracker();

   constructor(
      private readonly store: RoundWatchStore,
      private readonly indexer: SettlementLookupIndexer,
      private readonly config: SettlementReconcilerConfig,
      private readonly economicsMetrics?: RoundWatchEconomicsMetrics,
   ) {
      this.now = config.now ?? (() => new Date());
      this.baseBackoffMilliseconds = config.baseBackoffMilliseconds ?? 1_000;
      this.maxBackoffMilliseconds = config.maxBackoffMilliseconds ?? 60_000;
   }

   start(): void {
      if (this.timer) return;
      this.workerHealth.markStarted();
      const run = () => {
         if (this.running) return;

         this.workerHealth.markCycleStarted();
         void this.reconcileOnce()
            .then(() => {
               this.workerHealth.markCycleSucceeded();
            })
            .catch(error => {
               this.workerHealth.markCycleFailed();
               console.error(
                  'RoundWatch settlement reconciliation failed:',
                  safeErrorMessage(error),
               );
            });
      };
      run();
      this.timer = setInterval(run, this.config.intervalMilliseconds);
      this.timer.unref();
   }

   stop(): void {
      this.workerHealth.markStopped();
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
   }

   healthSnapshot(): WorkerHealthSnapshot {
      return this.workerHealth.snapshot(
         Math.max(this.config.intervalMilliseconds * 3, 15_000),
      );
   }

   readinessCheck(): boolean {
      return this.healthSnapshot().ready;
   }

   async reconcileOnce(): Promise<void> {
      if (this.running) return;
      this.running = true;
      try {
         for (const watch of this.store.listSettlementReconciliationCandidates()) {
            try {
               await this.reconcileWatch(watch);
            } catch (error) {
               this.absenceProofSessions.delete(watch.id);
               this.defer(watch);
               console.error(`RoundWatch settlement reconciliation failed for watch ${watch.id}:`, safeErrorMessage(error));
            }
         }
      } finally { this.running = false; }
   }

   private async reconcileWatch(watch: WatchRecord): Promise<void> {
      const workClaim = this.store.claimWorkUnit(watch.id);
      if (workClaim === 'exhausted') {
         this.absenceProofSessions.delete(watch.id);
         this.finishMetric(watch, 'indeterminate');
         console.warn(
            `RoundWatch work budget exhausted during settlement reconciliation watch=${watch.id}; terminal state=indeterminate`,
         );
         return;
      }
      if (workClaim !== 'claimed') return;

      this.recordMetric(() => {
         this.economicsMetrics?.recordWorkUnit(watch.id);
         this.economicsMetrics?.recordReconciliationAttempt(watch.id);
      });

      const requestBudget = new IndexerRequestTurnBudget(
         MAX_INDEXER_REQUESTS_PER_RECONCILIATION_WORK_TURN,
         'settlement reconciliation turn',
      );

      const expectedTransaction = watch.expectedServiceTransaction;
      if (!expectedTransaction) return;
      if (!hasImmutableTerms(watch)) {
         // Legacy rows cannot receive fabricated purchase terms or a terminal proof.
         this.defer(watch);
         return;
      }

      let session = this.absenceProofSessions.get(watch.id);

      if (!session) {
         const transfer = await requestBudget.run(() =>
            this.indexer.lookupAssetTransfer(
               expectedTransaction,
               'reconciliation',
               watch.id,
            ),
         );
         if (transfer) {
            this.absenceProofSessions.delete(watch.id);
            this.applyConfirmed(watch, transfer);
            return;
         }

         const currentRound = await requestBudget.run(() =>
            this.indexer.getCurrentRound(
               'reconciliation',
               watch.id,
            ),
         );
         if (currentRound <= watch.serviceLastValid) {
            this.defer(watch);
            return;
         }

         session = {
            seenTokens: new Set<string>(),
         };
         this.absenceProofSessions.set(watch.id, session);
      }

      const page = await requestBudget.run(() =>
         this.indexer.searchTransactionPage(
            expectedTransaction,
            session.nextToken,
            watch.id,
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
         this.applyConfirmed(watch, found);
         return;
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
         return;
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
      this.finishMetric(watch, 'settlement_unknown');
      console.error(
         `RoundWatch service transaction remained absent after LastValid for watch ${watch.id}`,
      );
   }

   private applyConfirmed(watch: WatchRecord, transfer: IndexedAssetTransfer): void {
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
         this.finishMetric(watch, 'settlement_unknown');
         console.error(`RoundWatch confirmed service transaction mismatched immutable terms for watch ${watch.id}`);
         return;
      }
      this.store.activateWatch(watch.id, {
         transaction: transfer.transaction,
         network: this.config.network,
         payer: transfer.sender,
      }, transfer.round);
      console.log(`RoundWatch reconciled watch ${watch.id} at service round ${transfer.round}`);
   }

   private defer(watch: WatchRecord): void {
      const exponent = Math.min(watch.reconciliationAttempts, 20);
      const delay = Math.min(this.maxBackoffMilliseconds, this.baseBackoffMilliseconds * 2 ** exponent);
      this.store.recordReconciliationFailure(watch.id, new Date(this.now().getTime() + delay));
   }

   private finishMetric(
      watch: WatchRecord,
      finalState: WatchRecord['state'],
   ): void {
      if (!this.economicsMetrics) return;

      const createdAt = Date.parse(watch.createdAt);
      this.recordMetric(() => this.economicsMetrics?.recordLifecycle(watch.id, {
         finalState,
         ...(Number.isFinite(createdAt)
            ? { timeToTerminalMs: Math.max(0, this.now().getTime() - createdAt) }
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
            'RoundWatch economics reconciliation metric failed:',
            error instanceof Error ? error.message : 'Unknown metrics error',
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
