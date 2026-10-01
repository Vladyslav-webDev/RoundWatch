import { performance } from 'node:perf_hooks';

export const DEFAULT_INDEXER_HEALTH_PROBE_INTERVAL_MS = 15_000;
export const DEFAULT_INDEXER_IDLE_HEALTH_PROBE_INTERVAL_MS = 120_000;
export const DEFAULT_PAID_ADMISSION_INDEXER_EVIDENCE_MAX_AGE_MS = 30_000;

export interface IndexerCapabilityEvidence {
   polling: boolean;
   reconciliation: boolean;
}

export interface IndexerCapabilitySource {
   probeReadinessCapabilities(assetId: number): Promise<IndexerCapabilityEvidence>;
}

export interface IndexerProbeSample {
   revision: number;
   attemptedAtMs: number;
   evidence: IndexerCapabilityEvidence;
}

// Both workers and paid admission share one probe and one in-flight promise.
// The source uses the production Indexer client, so every request passes
// through its dispatcher. Idle callers may request a much longer cache age;
// unhealthy evidence is always rechecked at the short active interval.
export class IndexerHealthProbe {
   private lastAttemptAtMs?: number;
   private pending?: Promise<IndexerProbeSample>;
   private latest?: IndexerProbeSample;
   private revision = 0;

   constructor(
      private readonly source: IndexerCapabilitySource,
      private readonly assetId: number,
      private readonly now: () => number = () => performance.now(),
      private readonly minimumIntervalMs =
         DEFAULT_INDEXER_HEALTH_PROBE_INTERVAL_MS,
      private readonly idleIntervalMs = minimumIntervalMs,
   ) {
      if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 1_000) {
         throw new Error('health probe interval must be at least one second');
      }
      if (
         !Number.isSafeInteger(idleIntervalMs) ||
         idleIntervalMs < minimumIntervalMs
      ) {
         throw new Error(
            'idle health probe interval must be a safe integer at least as large as the active interval',
         );
      }
   }

   currentRevision(): number { return this.revision; }

   activeIntervalMilliseconds(): number {
      return this.minimumIntervalMs;
   }

   idleIntervalMilliseconds(): number {
      return this.idleIntervalMs;
   }

   readinessFreshnessMilliseconds(): number {
      return Math.max(
         45_000,
         Math.ceil(this.idleIntervalMs * 1.5),
      );
   }

   runIfDue(
      maximumEvidenceAgeMs = this.minimumIntervalMs,
   ): Promise<IndexerProbeSample> {
      if (
         !Number.isSafeInteger(maximumEvidenceAgeMs) ||
         maximumEvidenceAgeMs < this.minimumIntervalMs
      ) {
         throw new Error(
            'health probe maximum evidence age must be at least the active probe interval',
         );
      }

      if (this.pending) return this.pending;

      const at = this.now();
      const latestHealthy =
         this.latest?.evidence.polling === true &&
         this.latest.evidence.reconciliation === true;
      const effectiveMaximumAgeMs = latestHealthy
         ? maximumEvidenceAgeMs
         : Math.min(maximumEvidenceAgeMs, this.minimumIntervalMs);

      if (
         this.lastAttemptAtMs !== undefined &&
         at - this.lastAttemptAtMs < effectiveMaximumAgeMs
      ) {
         return Promise.resolve(this.latest!);
      }

      this.lastAttemptAtMs = at;
      const revision = ++this.revision;
      const pending = this.source.probeReadinessCapabilities(this.assetId)
         .catch(() => ({ polling: false, reconciliation: false }))
         .then(evidence => {
            const sample = { revision, attemptedAtMs: at, evidence };
            this.latest = sample;
            return sample;
         })
         .finally(() => { this.pending = undefined; });
      this.pending = pending;
      return pending;
   }
}
