export const MAX_INDEXER_REQUESTS_PER_ACTIVE_WORK_TURN = 4;
export const MAX_INDEXER_REQUESTS_PER_RECONCILIATION_WORK_TURN = 3;
export const MAX_BACKGROUND_INDEXER_REQUESTS_PER_WORK_TURN =
   MAX_INDEXER_REQUESTS_PER_ACTIVE_WORK_TURN;

export class IndexerRequestTurnBudget {
   private used = 0;

   constructor(
      private readonly limit: number,
      private readonly label: string,
   ) {
      if (!Number.isSafeInteger(limit) || limit <= 0) {
         throw new Error('Indexer request turn budget must be a positive safe integer');
      }
   }

   run<T>(operation: () => Promise<T>): Promise<T> {
      if (this.used >= this.limit) {
         throw new Error(
            `RoundWatch ${this.label} exceeded the ${this.limit}-Indexer-request work-turn invariant`,
         );
      }

      this.used += 1;
      return operation();
   }

   consumed(): number {
      return this.used;
   }
}

export function maxBackgroundIndexerRequestsForWorkBudget(
   workUnitBudget: number,
): number {
   if (!Number.isSafeInteger(workUnitBudget) || workUnitBudget <= 0) {
      throw new Error('workUnitBudget must be a positive safe integer');
   }

   const maximum =
      workUnitBudget * MAX_BACKGROUND_INDEXER_REQUESTS_PER_WORK_TURN;
   if (!Number.isSafeInteger(maximum)) {
      throw new Error('workUnitBudget exceeds the safe request-ceiling range');
   }

   return maximum;
}
