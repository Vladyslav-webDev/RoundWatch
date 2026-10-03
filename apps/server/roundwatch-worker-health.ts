export type CustomerTurnOutcome =
   | { kind: 'progressed'; providerEvidence: boolean }
   | { kind: 'providerEvidenceOnly'; providerEvidence: true }
   | { kind: 'noOp'; providerEvidence: false };

export interface WorkerCycleOutcome {
   attempted: number;
   succeeded: number;
   failed: number;
   isolatedFailures?: number;
   noOp?: number;
   providerEvidenceOnly?: number;
   providerEvidence?: number;
}

export interface WorkerHealthSnapshot {
   started: boolean;
   running: boolean;
   ready: boolean;
   cycleNotStalled: boolean;
   providerHealth: 'unknown' | 'healthy' | 'unhealthy';
   // Kept for telemetry compatibility. This now specifically counts
   // consecutive failures of the complete functional capability probe.
   consecutiveFailures: number;
   generation?: number;
   lastCycleStartedAtMs?: number;
   lastProgressAtMs?: number;
   lastProviderEvidenceAtMs?: number;
   lastErrorAtMs?: number;
}

export class WorkerHealthTracker {
   private started = false;
   private running = false;
   private consecutiveProbeFailures = 0;
   private consecutiveCycleFailures = 0;
   private lastCycleStartedAtMs?: number;
   private lastProgressAtMs?: number;
   private lastErrorAtMs?: number;
   private providerHealth: 'unknown' | 'healthy' | 'unhealthy' = 'unknown';
   private lastProviderEvidenceAtMs?: number;

   constructor(private readonly now: () => number = () => Date.now()) {}

   markStarted(): void {
      this.started = true;
      this.providerHealth = 'unknown';
      this.lastProviderEvidenceAtMs = undefined;
      this.lastProgressAtMs = undefined;
      this.consecutiveProbeFailures = 0;
      this.consecutiveCycleFailures = 0;
   }

   markStopped(): void {
      this.started = false;
      this.running = false;
      this.providerHealth = 'unknown';
      this.lastProviderEvidenceAtMs = undefined;
   }

   markCycleStarted(): void {
      this.running = true;
      this.lastCycleStartedAtMs = this.now();
   }

   markCycleProgress(): void {
      if (!this.running) return;
      this.lastProgressAtMs = this.now();
   }

   markProviderFailure(): void {
      // A failed customer turn must be visible even while the sweep is still
      // running. Cycle failure counters are recorded once at completion.
      this.providerHealth = 'unhealthy';
      this.lastErrorAtMs = this.now();
   }

   markCycleCompleted(outcome: WorkerCycleOutcome): void {
      validateOutcome(outcome);
      this.running = false;

      const isolatedFailures = outcome.isolatedFailures ?? 0;
      const readinessFailures = outcome.failed - isolatedFailures;
      const completedAt = this.now();

      if (outcome.failed > 0) {
         this.lastErrorAtMs = completedAt;
      }

      // A systemic customer-turn failure is immediately unhealthy. Recovery
      // still requires the independent complete functional probe.
      if (readinessFailures > 0) {
         this.consecutiveCycleFailures += 1;
         this.providerHealth = 'unhealthy';
         return;
      }

      // Successful customer work proves only the routes it exercised. It may
      // refresh freshness for a previously healthy worker, but it cannot erase
      // failures of the complete capability probe.
      if (
         this.providerHealth === 'healthy' &&
         (outcome.providerEvidence ?? 0) > 0
      ) {
         this.lastProviderEvidenceAtMs = completedAt;
      }
   }

   markProbeResult(healthy: boolean): void {
      if (!this.started) return;
      const at = this.now();

      if (healthy) {
         this.providerHealth = 'healthy';
         this.consecutiveProbeFailures = 0;
         this.consecutiveCycleFailures = 0;
         this.lastProviderEvidenceAtMs = at;
         return;
      }

      this.consecutiveProbeFailures += 1;
      this.lastErrorAtMs = at;

      // Public readiness uses one-sample hysteresis once health has been
      // established. Startup/unknown stays fail-closed. Only a successful full
      // probe resets this counter; partial customer success does not.
      if (
         this.providerHealth !== 'healthy' ||
         this.consecutiveProbeFailures >= 2
      ) {
         this.providerHealth = 'unhealthy';
      }
   }

   markCycleFailed(): void {
      this.running = false;
      this.consecutiveCycleFailures += 1;
      this.providerHealth = 'unhealthy';
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
         this.lastProviderEvidenceAtMs !== undefined &&
         now - this.lastProviderEvidenceAtMs <= maxSilenceMilliseconds;
      const providerHealth =
         this.providerHealth === 'healthy' && !successFresh
            ? 'unknown'
            : this.providerHealth;

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
         providerHealth === 'healthy';

      return {
         started: this.started,
         running: this.running,
         ready,
         cycleNotStalled,
         providerHealth,
         consecutiveFailures: Math.max(
            this.consecutiveProbeFailures,
            this.consecutiveCycleFailures,
         ),
         ...(this.lastCycleStartedAtMs === undefined
            ? {}
            : { lastCycleStartedAtMs: this.lastCycleStartedAtMs }),
         ...(this.lastProgressAtMs === undefined
            ? {}
            : { lastProgressAtMs: this.lastProgressAtMs }),
         ...(this.lastProviderEvidenceAtMs === undefined
            ? {}
            : { lastProviderEvidenceAtMs: this.lastProviderEvidenceAtMs }),
         ...(this.lastErrorAtMs === undefined
            ? {}
            : { lastErrorAtMs: this.lastErrorAtMs }),
      };
   }
}

function validateOutcome(outcome: WorkerCycleOutcome): void {
   for (const [label, value] of Object.entries(outcome)) {
      if (!Number.isSafeInteger(value) || value < 0) {
         throw new Error(
            `worker cycle ${label} must be a non-negative safe integer`,
         );
      }
   }
   if (
      outcome.succeeded +
         outcome.failed +
         (outcome.noOp ?? 0) +
         (outcome.providerEvidenceOnly ?? 0) !==
      outcome.attempted
   ) {
      throw new Error(
         'worker cycle attempted must equal progressed, evidence-only, no-op and failed turns',
      );
   }
   if (
      (outcome.providerEvidence ?? 0) >
      outcome.succeeded + (outcome.providerEvidenceOnly ?? 0)
   ) {
      throw new Error(
         'worker cycle providerEvidence exceeds successful provider turns',
      );
   }

   const isolatedFailures = outcome.isolatedFailures ?? 0;
   if (isolatedFailures > outcome.failed) {
      throw new Error(
         'worker cycle isolatedFailures cannot exceed failed',
      );
   }
}
