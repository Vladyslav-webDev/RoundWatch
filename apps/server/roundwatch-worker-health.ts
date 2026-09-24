export interface WorkerCycleOutcome {
   attempted: number;
   succeeded: number;
   failed: number;
}

export interface WorkerHealthSnapshot {
   started: boolean;
   running: boolean;
   ready: boolean;
   consecutiveFailures: number;
   lastCycleStartedAtMs?: number;
   lastProgressAtMs?: number;
   lastSuccessAtMs?: number;
   lastErrorAtMs?: number;
}

export class WorkerHealthTracker {
   private started = false;
   private running = false;
   private consecutiveFailures = 0;
   private lastCycleStartedAtMs?: number;
   private lastProgressAtMs?: number;
   private lastSuccessAtMs?: number;
   private lastErrorAtMs?: number;

   constructor(private readonly now: () => number = () => Date.now()) {}

   markStarted(): void {
      this.started = true;
   }

   markStopped(): void {
      this.started = false;
      this.running = false;
   }

   markCycleStarted(): void {
      this.running = true;
      this.lastCycleStartedAtMs = this.now();
   }

   markCycleProgress(): void {
      if (!this.running) return;
      this.lastProgressAtMs = this.now();
   }

   markCycleCompleted(outcome: WorkerCycleOutcome): void {
      validateOutcome(outcome);
      this.running = false;

      if (outcome.failed > 0) {
         this.lastErrorAtMs = this.now();
      }

      if (
         outcome.attempted > 0 &&
         outcome.succeeded === 0 &&
         outcome.failed > 0
      ) {
         this.consecutiveFailures += 1;
         return;
      }

      this.consecutiveFailures = 0;
      this.lastSuccessAtMs = this.now();
   }

   markCycleSucceeded(): void {
      this.markCycleCompleted({ attempted: 0, succeeded: 0, failed: 0 });
   }

   markCycleFailed(): void {
      this.running = false;
      this.consecutiveFailures += 1;
      this.lastErrorAtMs = this.now();
   }

   snapshot(maxSilenceMilliseconds: number): WorkerHealthSnapshot {
      if (
         !Number.isSafeInteger(maxSilenceMilliseconds) ||
         maxSilenceMilliseconds <= 0
      ) {
         throw new Error(
            'maxSilenceMilliseconds must be a positive safe integer',
         );
      }

      const now = this.now();
      const freshestHealthyAt = Math.max(
         this.lastSuccessAtMs ?? Number.NEGATIVE_INFINITY,
         this.lastProgressAtMs ?? Number.NEGATIVE_INFINITY,
      );
      const successFresh =
         Number.isFinite(freshestHealthyAt) &&
         now - freshestHealthyAt <= maxSilenceMilliseconds;

      const currentCycleHeartbeat =
         this.running && this.lastCycleStartedAtMs !== undefined
            ? Math.max(
                 this.lastCycleStartedAtMs,
                 this.lastProgressAtMs !== undefined &&
                    this.lastProgressAtMs >= this.lastCycleStartedAtMs
                    ? this.lastProgressAtMs
                    : this.lastCycleStartedAtMs,
              )
            : undefined;
      const cycleNotStalled =
         !this.running ||
         (currentCycleHeartbeat !== undefined &&
            now - currentCycleHeartbeat <= maxSilenceMilliseconds);
      const ready =
         this.started &&
         successFresh &&
         cycleNotStalled &&
         this.consecutiveFailures === 0;

      return {
         started: this.started,
         running: this.running,
         ready,
         consecutiveFailures: this.consecutiveFailures,
         ...(this.lastCycleStartedAtMs === undefined
            ? {}
            : { lastCycleStartedAtMs: this.lastCycleStartedAtMs }),
         ...(this.lastProgressAtMs === undefined
            ? {}
            : { lastProgressAtMs: this.lastProgressAtMs }),
         ...(this.lastSuccessAtMs === undefined
            ? {}
            : { lastSuccessAtMs: this.lastSuccessAtMs }),
         ...(this.lastErrorAtMs === undefined
            ? {}
            : { lastErrorAtMs: this.lastErrorAtMs }),
      };
   }
}

function validateOutcome(outcome: WorkerCycleOutcome): void {
   for (const [label, value] of Object.entries(outcome)) {
      if (!Number.isSafeInteger(value) || value < 0) {
         throw new Error(`worker cycle ${label} must be a non-negative safe integer`);
      }
   }
   if (outcome.succeeded + outcome.failed !== outcome.attempted) {
      throw new Error(
         'worker cycle attempted must equal succeeded plus failed',
      );
   }
}
