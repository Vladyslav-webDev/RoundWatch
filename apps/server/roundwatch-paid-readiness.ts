import type { IndexerHealthProbe } from './roundwatch-health-probe.js';
import type { WorkerHealthSnapshot } from './roundwatch-worker-health.js';

export interface PaidReadinessSnapshot {
   ready: boolean;
   checks: Record<string, boolean>;
   workerGenerations?: { poller?: number; reconciler?: number };
}

export interface PaidAdmissionReadinessCheck {
   (): Promise<PaidReadinessSnapshot>;
   validateCurrent(refreshed: PaidReadinessSnapshot): PaidReadinessSnapshot;
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
): PaidAdmissionReadinessCheck {
   // This consumer is entirely synchronous: re-read current local state and
   // current shared evidence in the handler's commitment turn, without probing.
   const currentSnapshot = (generations: PaidReadinessSnapshot['workerGenerations']) => {
      const after = readLocalReadiness(dependencies);

      if (
         !after.storage ||
         !after.diskHeadroom ||
         !after.workersOperational ||
         generations?.poller !== after.poller.generation ||
         generations?.reconciler !== after.reconciler.generation
      ) {
         return localFailureSnapshot(after);
      }

      // A sample is admissible only when it belongs to the current provider
      // failure epoch and was still fresh when the paid decision consumed it.
      // This prevents both stale in-flight results and cached success that
      // predates a newer systemic worker failure.
      const sample = dependencies.healthProbe.currentSample();
      const sampleFresh = sample !== undefined &&
         dependencies.healthProbe.isSampleFreshForAdmission(
            sample,
            dependencies.maximumEvidenceAgeMilliseconds,
         );
      const pollerReady = sampleFresh && sample?.evidence.polling === true;
      const reconcilerReady = sampleFresh && sample?.evidence.reconciliation === true;
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
         workerGenerations: {
            poller: after.poller.generation,
            reconciler: after.reconciler.generation,
         },
      };
   };

   const refresh = async () => {
      const before = readLocalReadiness(dependencies);
      if (!before.storage || !before.diskHeadroom || !before.workersOperational) {
         return localFailureSnapshot(before);
      }
      await dependencies.healthProbe.runIfDue(
         dependencies.maximumEvidenceAgeMilliseconds,
      );
      return currentSnapshot({
         poller: before.poller.generation,
         reconciler: before.reconciler.generation,
      });
   };

   return Object.assign(refresh, {
      validateCurrent: (refreshed: PaidReadinessSnapshot) =>
         refreshed.ready
            ? currentSnapshot(refreshed.workerGenerations)
            : localFailureSnapshot(readLocalReadiness(dependencies)),
   });
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
