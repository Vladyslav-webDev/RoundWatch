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
   failureEpoch: number;
   providerFailureRevision: number;
   attemptedAtMs: number;
   completedAtMs: number;
   evidence: IndexerCapabilityEvidence;
}

// Both workers and paid admission share one probe and one in-flight promise.
// Every provider failure invalidates earlier probes by observation revision.
// The public epoch coalesces failures until complete, current, fresh recovery.
export class IndexerHealthProbe {
   private lastAttemptAtMs?: number;
   private pending?: Promise<IndexerProbeSample>;
   private latest?: IndexerProbeSample;
   private revision = 0;
   private failureEpoch = 0;
   private providerFailureRevision = 0;
   private providerEvidenceInvalidated = false;

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

   currentFailureEpoch(): number { return this.failureEpoch; }

   currentSample(): IndexerProbeSample | undefined { return this.latest; }

   invalidateForProviderFailure(): number {
      // Even a coalesced observation makes an earlier in-flight probe obsolete.
      this.providerFailureRevision += 1;
      // Epochs invalidate evidence generations, not each watch observing a
      // failed shared request. Only fresh complete recovery rearms publication.
      if (!this.providerEvidenceInvalidated) {
         this.providerEvidenceInvalidated = true;
         this.failureEpoch += 1;
      }
      return this.failureEpoch;
   }

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

   isSampleFreshForAdmission(
      sample: IndexerProbeSample,
      maximumEvidenceAgeMs: number,
   ): boolean {
      this.assertMaximumEvidenceAge(maximumEvidenceAgeMs);
      const at = this.now();
      return (
         this.isSampleCurrent(sample) &&
         sample.completedAtMs >= sample.attemptedAtMs &&
         sample.completedAtMs - sample.attemptedAtMs <= maximumEvidenceAgeMs &&
         at >= sample.attemptedAtMs &&
         at - sample.attemptedAtMs <= maximumEvidenceAgeMs
      );
   }

   runIfDue(
      maximumEvidenceAgeMs = this.minimumIntervalMs,
   ): Promise<IndexerProbeSample> {
      this.assertMaximumEvidenceAge(maximumEvidenceAgeMs);

      if (this.pending) return this.pending;

      const at = this.now();
      const latestHealthy =
         this.latest?.evidence.polling === true &&
         this.latest.evidence.reconciliation === true;
      const latestCurrent = this.latest !== undefined &&
         this.isSampleCurrent(this.latest);
      const effectiveMaximumAgeMs = latestHealthy && latestCurrent
         ? maximumEvidenceAgeMs
         : Math.min(maximumEvidenceAgeMs, this.minimumIntervalMs);

      if (
         latestCurrent &&
         this.lastAttemptAtMs !== undefined &&
         at - this.lastAttemptAtMs < effectiveMaximumAgeMs
      ) {
         return Promise.resolve(this.latest!);
      }

      this.lastAttemptAtMs = at;
      const revision = ++this.revision;
      const failureEpoch = this.failureEpoch;
      const providerFailureRevision = this.providerFailureRevision;
      const pending = this.source.probeReadinessCapabilities(this.assetId)
         .catch(() => ({ polling: false, reconciliation: false }))
         .then(evidence => {
            const sample = {
               revision,
               failureEpoch,
               providerFailureRevision,
               attemptedAtMs: at,
               completedAtMs: this.now(),
               evidence,
            };
            this.latest = sample;
            if (
               evidence.polling && evidence.reconciliation &&
               this.isSampleFreshForAdmission(sample, maximumEvidenceAgeMs)
            ) {
               this.providerEvidenceInvalidated = false;
            }
            return sample;
         })
         .finally(() => { this.pending = undefined; });
      this.pending = pending;
      return pending;
   }

   // Causal currentness is independent of age; positive evidence also needs freshness.
   isSampleCurrent(sample: IndexerProbeSample): boolean {
      return sample.failureEpoch === this.failureEpoch &&
         sample.providerFailureRevision === this.providerFailureRevision;
   }

   private assertMaximumEvidenceAge(maximumEvidenceAgeMs: number): void {
      if (
         !Number.isSafeInteger(maximumEvidenceAgeMs) ||
         maximumEvidenceAgeMs < this.minimumIntervalMs
      ) {
         throw new Error(
            'health probe maximum evidence age must be at least the active probe interval',
         );
      }
   }
}
