import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const serverDir = dirname(fileURLToPath(import.meta.url));

test('economics benchmark synthetic transactions satisfy the current Indexer parser contract', () => {
   const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'economics-benchmark.ts'],
      {
         cwd: serverDir,
         encoding: 'utf8',
         timeout: 15_000,
         env: {
            ...process.env,
            ROUNDWATCH_BENCH_WATCH_COUNTS: '1',
            ROUNDWATCH_BENCH_QUERY_VARIANTS: 'C',
            ROUNDWATCH_BENCH_PROFILES: 'quiet-exact-note',
            ROUNDWATCH_BENCH_TARGET_ROUNDS: '100',
            ROUNDWATCH_BENCH_ROUND_WINDOW: '100',
            ROUNDWATCH_BENCH_QUIET_TX_PER_WINDOW: '5',
            ROUNDWATCH_BENCH_REQUESTS_PER_SECOND: '100000',
            ROUNDWATCH_BENCH_BURST: '100000',
            ROUNDWATCH_BENCH_DISPATCH_CONCURRENCY: '2',
         },
      },
   );

   assert.equal(
      result.error,
      undefined,
      result.error?.message,
   );
   assert.equal(
      result.status,
      0,
      `benchmark failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
   );
   assert.match(result.stdout, /BENCH_RESULT /);
   assert.match(result.stdout, /"activeWatches":1/);
});
