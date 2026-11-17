import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { scenario } from './fixtures.ts';
import { LiveStore } from './live-store.ts';
import type { LiveObservation, LivePlan } from './live-store.ts';

const IDS = ['base', 'second-source'] as const;
const ID = 'sample';

function sample(timestampOffset = 0): { plan: LivePlan; observation: LiveObservation } {
  const { blocks, watch } = scenario();
  const { logs, ...receipt } = blocks[3].receipts[0];
  const header = (index: number) => ({ ...blocks[index].header, timestamp: blocks[index].header.timestamp + timestampOffset });
  const head = header(5);
  const plan: LivePlan = { fromBlock: 103, toBlock: 105, finalizedHeads: [head, head] };
  const source = (id: string) => ({
    id, rangeLogDigest: '1'.repeat(64), singleLogDigest: '1'.repeat(64),
    receiptDigests: [{ transactionHash: receipt.transactionHash, digest: '2'.repeat(64) }],
  });
  const observation: LiveObservation = {
    predecessor: header(2), blocks: [header(3), header(4), head],
    watch: { sender: watch.sender, recipient: watch.recipient, amountAtomic: watch.amountAtomic,
      opensAtSec: watch.opensAtSec + timestampOffset, deadlineSec: watch.deadlineSec + timestampOffset },
    candidates: [{ log: logs[0], receipt }],
    sources: [source(IDS[0]), source(IDS[1])],
  };
  return { plan, observation };
}

function open(t: TestContext): LiveStore {
  const store = LiveStore.create();
  t.after(() => {
    store.close();
    LiveStore.dispose(store.database);
  });
  return store;
}

test('the live store reopens its own disposable database and preserves a nonterminal, idempotent snapshot', () => {
  assert.throws(() => LiveStore.open({ kind: 'base-sepolia-cp2b', token: '../production.sqlite' }), /invalid_live_database/);
  let store = LiveStore.create();
  const { database } = store;
  const { plan, observation } = sample();
  try {
    store.start(ID, IDS, 48);
    store.charge(ID, IDS[0], 'eth_chainId');
    store.pin(ID, plan);
    store.commit(ID, observation);
    const status = store.status(ID);
    assert.equal(status.outcome, 'unresolved');
    assert.equal(status.reason, 'receipt_inclusion_only');
    assert.equal(status.verifiedCoverageBlocks, 0);
    assert.equal(status.verifiedCoverageCursor, null);
    assert.deepEqual(status.observation, observation);
    store.close();
    store = LiveStore.open(database);
    store.start(ID, IDS, 48);
    store.pin(ID, plan);
    store.commit(ID, observation);
    store.stall(ID, 'late_failed_attempt');
    assert.throws(() => store.charge(ID, IDS[0], 'eth_chainId'), /live_observation_committed/);
    assert.deepEqual(store.status(ID), status);
  } finally {
    store.close();
    LiveStore.dispose(database);
  }
});

test('a regular SQLite file with a CP2B-shaped token and marker is still refused without the CP2B header', () => {
  const database = { kind: 'base-sepolia-cp2b', token: randomBytes(16).toString('hex') } as const;
  const directory = join(tmpdir(), `roundwatch-base-sepolia-cp2b-${database.token}`);
  const filename = join(directory, 'observations.sqlite');
  const marker = join(directory, 'cp2b.marker');
  mkdirSync(directory, { mode: 0o700 });
  try {
    writeFileSync(marker, database.token, { flag: 'wx', mode: 0o600 });
    const ordinary = new DatabaseSync(filename);
    try {
      ordinary.exec('CREATE TABLE watch_state (id TEXT PRIMARY KEY)');
      assert.throws(() => LiveStore.open(database), /invalid_live_database/);
      assert.throws(() => LiveStore.dispose(database), /invalid_live_database/);
      assert.equal(ordinary.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'live_runs'").get()!.count, 0);
    } finally {
      ordinary.close();
    }
  } finally {
    rmSync(filename, { force: true });
    rmSync(marker, { force: true });
    rmdirSync(directory);
  }
});

test('the SQLite write boundary rejects an oversized plan or inconsistent receipt provenance', (t) => {
  const store = open(t);
  const { plan, observation } = sample();
  store.start(ID, IDS, 48);
  assert.throws(() => store.pin(ID, { ...plan, fromBlock: plan.fromBlock - 1 }), /invalid_live_plan/);
  store.pin(ID, plan);
  const [left, right] = observation.sources;
  for (const receiptDigests of [[], [{ ...right.receiptDigests[0], digest: 'a'.repeat(64) }],
    [...right.receiptDigests, ...right.receiptDigests]]) {
    const conflicting: LiveObservation = { ...observation, sources: [left, { ...right, receiptDigests }] };
    assert.throws(() => store.commit(ID, conflicting), /invalid_live_observation/);
    assert.equal(store.status(ID).observation, null);
  }
  store.commit(ID, observation);
  assert.deepEqual(store.status(ID).observation, observation);
});

test('tuple reservations and occurrence keys are global within the disposable store', (t) => {
  const store = open(t);
  const { plan, observation } = sample();
  const watch = observation.watch!;
  const disjoint = sample(120);
  store.start(ID, IDS, 48, watch);
  assert.throws(() => store.start('overlap', IDS, 48, { ...watch, opensAtSec: watch.opensAtSec + 1 }),
    /overlapping_reservation/);
  store.pin(ID, plan);
  assert.throws(() => store.commit(ID, { ...observation, watch: { ...watch, deadlineSec: watch.deadlineSec + 1 } }),
    /immutable_live_watch/);
  store.commit(ID, observation);
  store.start('overlap', IDS, 48);
  store.pin('overlap', plan);
  assert.throws(() => store.commit('overlap', observation), /overlapping_reservation/);
  assert.equal(store.status('overlap').watch, null);
  assert.equal(store.status('overlap').observation, null);

  // Even if a contradictory report presents the same block hash at a disjoint time, its occurrence cannot be reinserted.
  store.start('disjoint', IDS, 48, disjoint.observation.watch!);
  store.pin('disjoint', disjoint.plan);
  assert.throws(() => store.commit('disjoint', disjoint.observation), /occurrence_already_reserved/);
  assert.equal(store.status('disjoint').observation, null);
  assert.deepEqual(store.status(ID).observation, observation);
});

test('the plan, work ceiling and sanitized failure reason survive a reopen before observation', () => {
  let store = LiveStore.create();
  const { database } = store;
  const { plan } = sample();
  try {
    store.start(ID, IDS, 2);
    store.charge(ID, IDS[0], 'eth_chainId');
    store.pin(ID, plan);
    store.stall(ID, 'rpc_rate_limited', { source: IDS[0], stage: 'range_logs' });
    const status = store.status(ID);
    store.close();
    store = LiveStore.open(database);
    assert.deepEqual(store.status(ID), status);
    assert.throws(() => store.pin(ID, { ...plan, fromBlock: plan.fromBlock + 1 }), /immutable_live_plan/);
    store.charge(ID, IDS[1], 'eth_chainId');
    assert.throws(() => store.charge(ID, IDS[1], 'eth_getBlockByNumber'), /work_budget_exhausted/);
    assert.equal(store.status(ID).work.used, 2);
    assert.equal(store.status(ID).work.byRead.reduce((sum, row) => sum + Number(row.attempts), 0), 2);
    assert.equal(store.status(ID).verifiedCoverageCursor, null);
  } finally {
    store.close();
    LiveStore.dispose(database);
  }
});

test('abrupt exit at the observation commit boundary preserves all or none of the observation and claim rows', async (t) => {
  const { plan, observation } = sample();
  for (const point of ['before_observation_commit', 'after_observation_commit']) {
    await t.test(point, () => {
      const store = LiveStore.create();
      const { database } = store;
      store.start(ID, IDS, 48);
      store.pin(ID, plan);
      store.close();
      const script = `
        import { LiveStore } from './live-store.ts';
        const { database, observation } = JSON.parse(process.argv[1]);
        const store = LiveStore.open(database, (point) => { if (point === process.argv[2]) process.exit(77); });
        store.charge('${ID}', '${IDS[0]}', 'eth_chainId');
        store.commit('${ID}', observation);
        process.exit(2);
      `;
      try {
        const payload = JSON.stringify({ database, observation });
        const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script, payload, point], {
          cwd: new URL('./', import.meta.url), encoding: 'utf8', timeout: 15_000,
        });
        assert.equal(child.status, 77, `${child.error ?? ''} ${child.stderr}`);
        const reopened = LiveStore.open(database);
        try {
          const status = reopened.status(ID);
          const committed = point === 'after_observation_commit';
          assert.equal(status.reason, committed ? 'receipt_inclusion_only' : 'awaiting_observation');
          assert.deepEqual(status.observation, committed ? observation : null);
          assert.deepEqual(status.plan, plan);
          assert.equal(status.outcome, 'unresolved');
          assert.equal(status.work.used, 1);
          assert.equal(status.work.byRead[0].attempts, 1);
          if (!committed) {
            reopened.charge(ID, IDS[0], 'eth_chainId');
            // A leftover claim from the interrupted transaction would reject this retry.
            reopened.commit(ID, observation);
            assert.equal(reopened.status(ID).work.used, 2);
          }
          const disjoint = sample(120);
          reopened.start('disjoint', IDS, 48);
          reopened.pin('disjoint', disjoint.plan);
          assert.throws(() => reopened.commit('disjoint', disjoint.observation), /occurrence_already_reserved/);
        } finally {
          reopened.close();
        }
      } finally {
        LiveStore.dispose(database);
      }
    });
  }
});
