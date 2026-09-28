import { performance } from 'node:perf_hooks';

export interface IndexerCapabilityEvidence {
   scan: boolean;
   reconciliation: boolean;
}

export interface IndexerCapabilitySource {
   probeReadinessCapabilities(assetId: number): Promise<IndexerCapabilityEvidence>;
}

export interface IndexerProbeSample {
   revision: number;
   evidence: IndexerCapabilityEvidence;
}

// Both workers share one probe and one frequency limit. The source uses the
// production Indexer client, so every request passes through its dispatcher.
export class IndexerHealthProbe {
   private lastAttemptAtMs?: number;
   private pending?: Promise<IndexerProbeSample>;
   private latest?: IndexerProbeSample;
   private revision = 0;

   constructor(
      private readonly source: IndexerCapabilitySource,
      private readonly assetId: number,
      private readonly now: () => number = () => performance.now(),
      private readonly minimumIntervalMs = 15_000,
   ) {
      if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 1_000) {
         throw new Error('health probe interval must be at least one second');
      }
   }

   currentRevision(): number { return this.revision; }

   runIfDue(): Promise<IndexerProbeSample> {
      if (this.pending) return this.pending;
      const at = this.now();
      if (this.lastAttemptAtMs !== undefined && at - this.lastAttemptAtMs < this.minimumIntervalMs) {
         return Promise.resolve(this.latest!);
      }
      this.lastAttemptAtMs = at;
      const revision = ++this.revision;
      const pending = this.source.probeReadinessCapabilities(this.assetId)
         .catch(() => ({ scan: false, reconciliation: false }))
         .then(evidence => {
            const sample = { revision, evidence };
            this.latest = sample;
            return sample;
         })
         .finally(() => { this.pending = undefined; });
      this.pending = pending;
      return pending;
   }
}
