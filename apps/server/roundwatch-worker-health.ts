export interface WorkerHealthSnapshot {
   started: boolean;
   running: boolean;
   ready: boolean;
   consecutiveFailures: number;
   lastCycleStartedAtMs?: number;
   lastSuccessAtMs?: number;
   lastErrorAtMs?: number;
}

export class WorkerHealthTracker {
   private started = false;
   private running = false;
   private consecutiveFailures = 0;
   private lastCycleStartedAtMs?: number;
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

   markCycleSucceeded(): void {
      this.running = false;
      this.consecutiveFailures = 0;
      this.lastSuccessAtMs = this.now();
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
      const successFresh =
         this.lastSuccessAtMs !== undefined &&
         now - this.lastSuccessAtMs <= maxSilenceMilliseconds;
      const cycleNotStalled =
         !this.running ||
         (this.lastCycleStartedAtMs !== undefined &&
            now - this.lastCycleStartedAtMs <= maxSilenceMilliseconds);
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
         ...(this.lastSuccessAtMs === undefined
            ? {}
            : { lastSuccessAtMs: this.lastSuccessAtMs }),
         ...(this.lastErrorAtMs === undefined
            ? {}
            : { lastErrorAtMs: this.lastErrorAtMs }),
      };
   }
}
