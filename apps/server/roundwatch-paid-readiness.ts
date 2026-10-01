import type { IndexerHealthProbe } from './roundwatch-health-probe.js';
import type { WorkerHealthSnapshot } from './roundwatch-worker-health.js';

export interface PaidReadinessSnapshot {
   ready: boolean;
   checks: Record<string, boolean>;
}

export interface PaidReadinessWorker {
   healthSnapshot(): WorkerHealthSnapshot;
}

export interface PaidAdmissionReadinessDependencies {
   storageReady: () => boolean;
   diskHeadroom: () => boolean;
   poller: PaidReadinessWorker;
   reconciler: PaidReadinessWorker;
   healthProbe: IndexerHealthProbe;
   maximumEvidenceAgeMilliseconds: number;
}

interface LocalReadiness {
   storage: boolean;
   diskHeadroom: boolean;
   poller: WorkerHealthSnapshot;
   reconciler: WorkerHealthSnapshot;
   workersOperational: boolean;
}

export function createPaidAdmissionReadinessCheck(
   dependencies: PaidAdmissionReadinessDependencies,
): () => Promise<PaidReadinessSnapshot> {
   return async () => {
      const before = readLocalReadiness(dependencies);

      if (!before.storage || !before.diskHeadroom || !before.workersOperational) {
         return localFailureSnapshot(before);
      }

      const sample = await dependencies.healthProbe.runIfDue(
         dependencies.maximumEvidenceAgeMilliseconds,
      );

      // An asynchronous capability probe is a scheduling boundary. Local
      // storage/disk/worker state and worker generation must be re-read after
      // it completes instead of authorizing from the pre-await snapshot.
      const after = readLocalReadiness(dependencies);

      if (
         !after.storage ||
         !after.diskHeadroom ||
         !after.workersOperational ||
         workerGenerationChanged(before.poller, after.poller) ||
         workerGenerationChanged(before.reconciler, after.reconciler)
      ) {
         return localFailureSnapshot(after);
      }

      // A sample is admissible only when it belongs to the current provider
      // failure epoch and was still fresh when the paid decision consumed it.
      // This prevents both stale in-flight results and cached success that
      // predates a newer systemic worker failure.
      const sampleFresh = dependencies.healthProbe.isSampleFreshForAdmission(
         sample,
         dependencies.maximumEvidenceAgeMilliseconds,
      );
      const pollerReady = sampleFresh && sample.evidence.polling;
      const reconcilerReady = sampleFresh && sample.evidence.reconciliation;
      const backgroundWorkers = pollerReady && reconcilerReady;

      return {
         ready:
            after.storage &&
            after.diskHeadroom &&
            after.workersOperational &&
            backgroundWorkers,
         checks: {
            storage: after.storage,
            poller: pollerReady,
            reconciler: reconcilerReady,
            backgroundWorkers,
            diskHeadroom: after.diskHeadroom,
            capabilityEvidenceFresh: sampleFresh,
         },
      };
   };
}

function readLocalReadiness(
   dependencies: PaidAdmissionReadinessDependencies,
): LocalReadiness {
   const storage = dependencies.storageReady();
   const diskHeadroom = dependencies.diskHeadroom();
   const poller = dependencies.poller.healthSnapshot();
   const reconciler = dependencies.reconciler.healthSnapshot();
   const workersOperational =
      poller.started &&
      poller.cycleNotStalled &&
      poller.providerHealth !== 'unhealthy' &&
      reconciler.started &&
      reconciler.cycleNotStalled &&
      reconciler.providerHealth !== 'unhealthy';

   return {
      storage,
      diskHeadroom,
      poller,
      reconciler,
      workersOperational,
   };
}

function localFailureSnapshot(local: LocalReadiness): PaidReadinessSnapshot {
   const poller =
      local.poller.started &&
      local.poller.cycleNotStalled &&
      local.poller.providerHealth !== 'unhealthy';
   const reconciler =
      local.reconciler.started &&
      local.reconciler.cycleNotStalled &&
      local.reconciler.providerHealth !== 'unhealthy';

   return {
      ready: false,
      checks: {
         storage: local.storage,
         poller,
         reconciler,
         backgroundWorkers: poller && reconciler,
         diskHeadroom: local.diskHeadroom,
      },
   };
}

function workerGenerationChanged(
   before: WorkerHealthSnapshot,
   after: WorkerHealthSnapshot,
): boolean {
   return (
      before.generation !== undefined &&
      after.generation !== undefined &&
      before.generation !== after.generation
   );
}
