import type { RoundWatchStore, WorkClaim } from './roundwatch-store.js';

// Budget/lifecycle tests select a current snapshot for each manual claim. Missing
// legacy or wrong-purpose fields remain deliberately incompatible expectations.
export function currentWorkClaim(
   store: RoundWatchStore,
   id: string,
   purpose: WorkClaim['purpose'],
): WorkClaim {
   const watch = store.getWatch(id);
   if (!watch) throw new Error(`Missing test watch ${id}`);
   return purpose === 'polling' ? {
      purpose,
      expectedScanAfterRound: watch.scanAfterRound ?? -1,
      expectedClosingRound: watch.closingRound ?? null,
      expectedPollingFailureCount: watch.pollingFailureCount ?? 0,
   } : {
      purpose,
      expectedServiceTransaction: watch.expectedServiceTransaction ?? '',
      expectedReconciliationAttempts: watch.reconciliationAttempts ?? 0,
   };
}
