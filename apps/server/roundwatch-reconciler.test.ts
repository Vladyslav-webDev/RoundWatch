import assert from 'node:assert/strict';
import test from 'node:test';

import { ALGORAND_TESTNET, TESTNET_USDC_ASSET_ID } from './app.js';
import { AlgorandIndexerClient } from './roundwatch-indexer.js';
import {
   SettlementReconciler,
   type IndexedAssetTransfer,
   type SettlementLookupIndexer,
} from './roundwatch-reconciler.js';
import { RoundWatchStore, type WatchSpec } from './roundwatch-store.js';

const PAYER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const RECEIVER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBAR7CWY';

const SPEC: WatchSpec = {
   idempotencyKey: 'reconcile-0001',
   expectedSender: PAYER,
   expectedReceiver: RECEIVER,
   assetId: TESTNET_USDC_ASSET_ID,
   atomicAmount: '1',
};

test('a pending watch activates after its prepared service transaction appears on-chain', async () => {
   const store = new RoundWatchStore(':memory:');
   const lookup = new FakeSettlementLookup({
      transaction: 'SERVICE_TX',
      sender: PAYER,
      receiver: RECEIVER,
      assetId: TESTNET_USDC_ASSET_ID,
      atomicAmount: '1000',
      round: 900,
   });

   try {
      const prepared = store.prepareWatch(SPEC, {
         expectedTransaction: 'SERVICE_TX',
         network: ALGORAND_TESTNET,
         payer: PAYER,
      });

      const reconciler = new SettlementReconciler(store, lookup, {
         network: ALGORAND_TESTNET,
         receiver: RECEIVER,
         assetId: TESTNET_USDC_ASSET_ID,
         atomicAmount: '1000',
         intervalMilliseconds: 5_000,
      });

      await reconciler.reconcileOnce();

      const recovered = store.getWatch(prepared.watch.id);
      assert.equal(recovered?.state, 'active');
      assert.equal(recovered?.serviceTransaction, 'SERVICE_TX');
      assert.equal(recovered?.servicePayer, PAYER);
      assert.equal(recovered?.activationRound, 900);
   } finally {
      store.close();
   }
});

test('an on-chain transaction that does not match the expected service payment fails closed', async () => {
   const store = new RoundWatchStore(':memory:');
   const lookup = new FakeSettlementLookup({
      transaction: 'WRONG_SERVICE_TX',
      sender: PAYER,
      receiver: PAYER,
      assetId: TESTNET_USDC_ASSET_ID,
      atomicAmount: '1000',
      round: 901,
   });

   try {
      const prepared = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'reconcile-0002' },
         {
            expectedTransaction: 'WRONG_SERVICE_TX',
            network: ALGORAND_TESTNET,
            payer: PAYER,
         },
      );

      const reconciler = new SettlementReconciler(store, lookup, {
         network: ALGORAND_TESTNET,
         receiver: RECEIVER,
         assetId: TESTNET_USDC_ASSET_ID,
         atomicAmount: '1000',
         intervalMilliseconds: 5_000,
      });

      await reconciler.reconcileOnce();

      assert.equal(store.getWatch(prepared.watch.id)?.state, 'settlement_unknown');
   } finally {
      store.close();
   }
});

test('Indexer transaction lookup returns exact settlement evidence', async () => {
   const mockFetch: typeof fetch = async input => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/v2/transactions/SERVICE_TX');

      return Response.json({
         transaction: {
            id: 'SERVICE_TX',
            sender: PAYER,
            'confirmed-round': 999,
            'asset-transfer-transaction': {
               receiver: RECEIVER,
               'asset-id': TESTNET_USDC_ASSET_ID,
               amount: 1000,
            },
         },
      });
   };
   const indexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      mockFetch,
   );

   assert.deepEqual(await indexer.lookupAssetTransfer('SERVICE_TX'), {
      transaction: 'SERVICE_TX',
      sender: PAYER,
      receiver: RECEIVER,
      assetId: TESTNET_USDC_ASSET_ID,
      atomicAmount: '1000',
      round: 999,
   });
});

class FakeSettlementLookup implements SettlementLookupIndexer {
   constructor(private readonly transfer: IndexedAssetTransfer | undefined) {}

   async lookupAssetTransfer(
      _transactionId: string,
   ): Promise<IndexedAssetTransfer | undefined> {
      return this.transfer;
   }
}
