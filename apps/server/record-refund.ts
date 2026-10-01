import { resolve } from 'node:path';

import { RoundWatchStore } from './roundwatch-store.js';

const cliArguments = process.argv.slice(2);
if (cliArguments[0] === '--') cliArguments.shift();

const [watchId, transaction, network, atomicAmount, ...reasonParts] =
   cliArguments;
const reason = reasonParts.join(' ').trim() || undefined;

if (!watchId || !transaction || !network || !atomicAmount) {
   console.error(
      'Usage: pnpm -C apps/server run record:refund -- <watchId> <transactionId> <network> <atomicAmount> [reason]',
   );
   process.exit(2);
}

const configuredDatabasePath = process.env.ROUNDWATCH_DB_PATH?.trim();
if (!configuredDatabasePath) {
   console.error(
      'ROUNDWATCH_DB_PATH is required so refund evidence cannot be written to an accidental database',
   );
   process.exit(2);
}

const databasePath = resolve(configuredDatabasePath);
const store = new RoundWatchStore(databasePath, {
   schemaMode: 'existing-refund-audit',
});

try {
   const watch = store.getWatch(watchId);
   if (!watch) {
      throw new Error(`Watch not found: ${watchId}`);
   }

   const refund = store.recordRefundEvidence(watchId, {
      transaction,
      network,
      atomicAmount,
      ...(reason ? { reason } : {}),
   });

   console.log(JSON.stringify({
      watchId,
      watchState: watch.state,
      refund,
      note:
         'Refund evidence was recorded separately; the original watch lifecycle state was not changed.',
   }, null, 2));
} finally {
   store.close();
}
