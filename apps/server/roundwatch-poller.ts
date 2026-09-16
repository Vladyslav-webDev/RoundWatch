import type { RoundWatchIndexer } from './roundwatch-indexer.js';
import type { RoundWatchStore } from './roundwatch-store.js';

export class RoundWatchPoller {
   private timer?: NodeJS.Timeout;
   private running = false;
   private started = false;

   constructor(
      private readonly store: RoundWatchStore,
      private readonly indexer: RoundWatchIndexer,
      private readonly intervalMilliseconds = 5_000,
   ) {}

   start(): void {
      if (this.started) {
         return;
      }

      this.started = true;
      void this.tick();
   }

   stop(): void {
      this.started = false;

      if (this.timer) {
         clearTimeout(this.timer);
         this.timer = undefined;
      }
   }

   async runOnce(): Promise<void> {
      const watches = this.store.listActiveWatches();

      if (watches.length === 0) {
         return;
      }

      const currentRound = await this.indexer.getCurrentRound();

      for (const watch of watches) {
         try {
            if (watch.scanAfterRound === undefined) {
               console.error(
                  `RoundWatch watch ${watch.id} has no safe scan baseline; cursor was not advanced`,
               );
               continue;
            }

            const match = await this.indexer.findMatch(
               watch,
               watch.scanAfterRound + 1,
               currentRound,
            );

            if (match) {
               this.store.markMatched(watch.id, match.transaction, match.round);
            } else {
               this.store.advanceScanRound(watch.id, currentRound);
            }
         } catch (error) {
            console.error(
               `RoundWatch poll failed for watch ${watch.id}:`,
               safeErrorMessage(error),
            );
         }
      }
   }

   private async tick(): Promise<void> {
      if (this.running) {
         return;
      }

      this.running = true;

      try {
         await this.runOnce();
      } catch (error) {
         console.error('RoundWatch poll failed:', safeErrorMessage(error));
      } finally {
         this.running = false;

         if (this.started) {
            this.timer = setTimeout(() => {
               void this.tick();
            }, this.intervalMilliseconds);
            this.timer.unref();
         }
      }
   }
}

function safeErrorMessage(error: unknown): string {
   return error instanceof Error ? error.message : 'Unknown poll error';
}
