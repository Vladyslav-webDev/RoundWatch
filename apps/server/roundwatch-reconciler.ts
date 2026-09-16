import type { RoundWatchStore, WatchRecord } from './roundwatch-store.js';

export interface IndexedAssetTransfer {
   transaction: string;
   sender: string;
   receiver: string;
   assetId: number;
   atomicAmount: string;
   round: number;
}

export interface SettlementLookupIndexer {
   lookupAssetTransfer(transactionId: string): Promise<IndexedAssetTransfer | undefined>;
}

export interface SettlementReconcilerConfig {
   network: string;
   receiver: string;
   assetId: number;
   atomicAmount: string;
   intervalMilliseconds: number;
}

export class SettlementReconciler {
   private timer: NodeJS.Timeout | undefined;
   private running = false;

   constructor(
      private readonly store: RoundWatchStore,
      private readonly indexer: SettlementLookupIndexer,
      private readonly config: SettlementReconcilerConfig,
   ) {}

   start(): void {
      if (this.timer) {
         return;
      }

      void this.reconcileOnce().catch(error => {
         console.error('RoundWatch settlement reconciliation failed:', safeErrorMessage(error));
      });

      this.timer = setInterval(() => {
         void this.reconcileOnce().catch(error => {
            console.error('RoundWatch settlement reconciliation failed:', safeErrorMessage(error));
         });
      }, this.config.intervalMilliseconds);
   }

   stop(): void {
      if (this.timer) {
         clearInterval(this.timer);
         this.timer = undefined;
      }
   }

   async reconcileOnce(): Promise<void> {
      if (this.running) {
         return;
      }

      this.running = true;

      try {
         for (const watch of this.store.listSettlementReconciliationCandidates()) {
            await this.reconcileWatch(watch);
         }
      } finally {
         this.running = false;
      }
   }

   private async reconcileWatch(watch: WatchRecord): Promise<void> {
      const expectedTransaction = watch.expectedServiceTransaction;

      if (!expectedTransaction) {
         return;
      }

      const transfer = await this.indexer.lookupAssetTransfer(expectedTransaction);

      if (!transfer) {
         return;
      }

      const matches =
         transfer.transaction === expectedTransaction &&
         (!watch.expectedServiceNetwork ||
            watch.expectedServiceNetwork === this.config.network) &&
         transfer.receiver === this.config.receiver &&
         transfer.assetId === this.config.assetId &&
         transfer.atomicAmount === this.config.atomicAmount &&
         (!watch.expectedServicePayer || transfer.sender === watch.expectedServicePayer);

      if (!matches) {
         this.store.markSettlementInvalid(watch.id);
         console.error(
            `RoundWatch settlement candidate ${expectedTransaction} was found on-chain but did not match the expected service payment`,
         );
         return;
      }

      this.store.activateWatch(
         watch.id,
         {
            transaction: transfer.transaction,
            network: this.config.network,
            payer: transfer.sender,
         },
         transfer.round,
      );

      console.log(
         `RoundWatch reconciled settled watch ${watch.id} from on-chain transaction ${transfer.transaction}`,
      );
   }
}

function safeErrorMessage(error: unknown): string {
   return error instanceof Error ? error.message : 'Unknown reconciliation error';
}
