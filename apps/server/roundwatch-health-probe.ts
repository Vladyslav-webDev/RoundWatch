import { performance } from 'node:perf_hooks';

export interface IndexerCapabilityEvidence {
   polling: boolean;
   reconciliation: boolean;
}

export const DEFAULT_INDEXER_HEALTH_PROBE_INTERVAL_MS = 30_000;
export const DEFAULT_INDEXER_HEALTH_EVIDENCE_FRESHNESS_MS = 75_000;

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
      private readonly minimumIntervalMs = DEFAULT_INDEXER_HEALTH_PROBE_INTERVAL_MS,
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
         .catch(() => ({ polling: false, reconciliation: false }))
         .then(evidence => {
            const previous = this.latest?.evidence;
            const sample = { revision, evidence };
            this.latest = sample;

            if (!evidence.polling || !evidence.reconciliation) {
               console.warn(JSON.stringify({
                  event: 'roundwatch_indexer_capability_probe_degraded',
                  revision,
                  polling: evidence.polling,
                  reconciliation: evidence.reconciliation,
               }));
            } else if (
               previous &&
               (!previous.polling || !previous.reconciliation)
            ) {
               console.info(JSON.stringify({
                  event: 'roundwatch_indexer_capability_probe_recovered',
                  revision,
                  polling: true,
                  reconciliation: true,
               }));
            }

            return sample;
         })
         .finally(() => { this.pending = undefined; });
      this.pending = pending;
      return pending;
   }
}
