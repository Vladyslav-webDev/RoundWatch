import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { addressTopic, TRANSFER } from './evidence.ts';
import type { FixtureEvidence, Receipt } from './evidence.ts';
import { AMOUNT, block, evidence, hash, OTHER, RECIPIENT, scenario, SENDER, SOURCES, transfer, ZERO } from './fixtures.ts';
import { Observer } from './observer.ts';

const ID = 'invoice-a';

function open(t: TestContext, path = ':memory:') {
  const observer = new Observer(path);
  t.after(() => observer.close());
  return observer;
}

function databasePath() {
  const dir = mkdtempSync(fileURLToPath(new URL('./.cp1-test-', import.meta.url)));
  const filename = join(dir, 'watch.sqlite');
  return { filename, cleanup: () => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(filename + suffix, { force: true });
    rmdirSync(dir);
  } };
}

function through(observer: Observer, fixture: FixtureEvidence, height: number) {
  let status = observer.status(ID);
  for (let next = status.cursor.height + 1; next <= height; next++) {
    status = observer.step(ID, fixture);
    assert.equal(status.cursor.height, next, status.reason ?? 'cursor');
  }
  return status;
}

test('discovers an exact hash from events and waits for the exclusive deadline', (t) => {
  const observer = open(t);
  const { watch, blocks } = scenario();
  const fixture = evidence(blocks);
  const armed = observer.arm(watch, SOURCES);
  assert.ok(Object.isFrozen(armed) && Object.isFrozen(armed.latestAtArm.transactions));
  assert.equal(observer.arm({ ...watch, token: `0x${watch.token.slice(2).toUpperCase()}` }, SOURCES).token, watch.token);
  assert.throws(() => observer.arm({ ...watch, deadlineSec: 1003 }, SOURCES), /immutable_watch/);

  const pending = through(observer, fixture, 105);
  assert.equal(pending.outcome, 'unresolved');
  assert.equal(pending.occurrences.length, 1);
  const result = observer.step(ID, fixture);
  assert.equal(result.outcome, 'matched');
  assert.equal(result.occurrences[0].log.transactionHash, blocks[3].header.transactions[0]);
  assert.equal(result.occurrences[0].receipt.status, 1);
  assert.equal(result.cutoff?.height, 106);
  assert.equal(result.coverageBlocks, 6);
  assert.equal(result.work.used, result.work.byRead.reduce((sum, row) => sum + Number(row.attempts), 0));
  assert.deepEqual(observer.step(ID, fixture), result);
});

test('rejects wrong token, event, parties and atomic amount without rounding', (t) => {
  const { blocks, watch } = scenario([[
    transfer({ address: OTHER }),
    transfer({ topics: [hash(800), addressTopic(SENDER), addressTopic(RECIPIENT)] }),
    transfer({ topics: [TRANSFER, addressTopic(OTHER), addressTopic(RECIPIENT)] }),
    transfer({ topics: [TRANSFER, addressTopic(SENDER), addressTopic(OTHER)] }),
    transfer({ topics: [TRANSFER, addressTopic(ZERO), addressTopic(RECIPIENT)] }),
    transfer({ topics: [TRANSFER, addressTopic(SENDER), addressTopic(ZERO)] }),
    transfer({ topics: [TRANSFER, addressTopic(SENDER), addressTopic(SENDER)] }),
    transfer({ data: `0x${(BigInt(AMOUNT) - 1n).toString(16).padStart(64, '0')}` }),
  ]]);
  const observer = open(t);
  for (const invalid of [
    { chainId: 8453 }, { token: OTHER }, { amountAtomic: '0' }, { amountAtomic: '1e6' },
    { amountAtomic: (2n ** 256n).toString() }, { sender: ZERO }, { recipient: SENDER },
    { armedAtSec: watch.opensAtSec }, { opensAtSec: 1000.5 }, { deadlineSec: 1000 },
    { latestAtArm: blocks[3].header },
  ]) assert.throws(() => observer.arm({ ...watch, ...invalid }, SOURCES), /invalid_watch/);
  observer.arm(watch, SOURCES);
  const result = through(observer, evidence(blocks), 106);
  assert.equal(result.outcome, 'expired');
  assert.deepEqual(result.occurrences, []);
});

test('excludes the floor and every deadline-second block, includes both opening-second heights', (t) => {
  const observer = open(t);
  const { blocks, watch } = scenario([[transfer()]], [[transfer()]]);
  observer.arm(watch, SOURCES);
  const result = through(observer, evidence(blocks), 106);
  assert.equal(result.outcome, 'ambiguous');
  assert.deepEqual(result.occurrences.map(({ log }) => log.blockNumber), [103, 104]);
  assert.equal(result.cutoff?.timestamp, 1002);
});

test('normalizes duplicate and out-of-order replies but keeps distinct logs from one transaction', (t) => {
  const observer = open(t);
  const { blocks, watch } = scenario([[transfer(), transfer()]]);
  const fixture = evidence(blocks);
  const original = fixture.views[0].logs;
  fixture.views[0].logs = (height, filter) => {
    const logs = original(height, filter)!;
    return [...logs].reverse().concat(logs);
  };
  observer.arm(watch, SOURCES);
  assert.equal(through(observer, fixture, 104).outcome, 'unresolved');
  const result = through(observer, fixture, 106);
  assert.equal(result.outcome, 'ambiguous');
  assert.deepEqual(result.occurrences.map(({ log }) => log.logIndex), [0, 1]);
  assert.equal(new Set(result.occurrences.map(({ log }) => log.transactionHash)).size, 1);
});

test('reserves an overlapping tuple across connections and after terminal resolution', (t) => {
  const { filename, cleanup } = databasePath();
  const observer = new Observer(filename);
  const competing = new Observer(filename);
  t.after(() => { competing.close(); observer.close(); cleanup(); });
  const { blocks, watch } = scenario();
  observer.arm(watch, SOURCES);
  assert.throws(() => competing.arm({ ...watch, id: 'invoice-b', opensAtSec: 1001 }, SOURCES), /overlapping_reservation/);
  assert.throws(() => competing.status('invoice-b'), /Unknown watch/);
  const differentAmount = { ...watch, id: 'invoice-c', amountAtomic: '1' };
  competing.arm(differentAmount, SOURCES);
  const fixture = evidence(blocks);
  assert.equal(through(observer, fixture, 106).outcome, 'matched');
  assert.throws(() => competing.arm({ ...watch, id: 'invoice-b' }, SOURCES), /overlapping_reservation/);
  competing.arm({ ...watch, id: 'invoice-d', opensAtSec: 1002, deadlineSec: 1003 }, SOURCES);
  for (let i = 0; i < 6; i++) competing.step(differentAmount.id, fixture);
  assert.equal(competing.status(differentAmount.id).outcome, 'expired');
});

test('publishes the watch only after a successful arm transaction', (t) => {
  const { filename, cleanup } = databasePath();
  const observer = new Observer(filename, (point) => {
    if (point === 'before_arm_commit') throw new Error('interrupted arm');
  });
  const reader = new Observer(filename);
  t.after(() => { reader.close(); observer.close(); cleanup(); });
  const { watch } = scenario();
  assert.throws(() => observer.arm(watch, SOURCES), /interrupted arm/);
  assert.throws(() => reader.status(watch.id), /Unknown watch/);
  reader.arm({ ...watch, id: 'retry' }, SOURCES);
  assert.equal(reader.status('retry').outcome, 'unresolved');
});

test('blocks a wrong chain, substituted source, or unavailable finalized tag', (t) => {
  const observer = open(t);
  const { blocks, watch } = scenario();
  observer.arm(watch, SOURCES);
  const wrongChain = evidence(blocks);
  wrongChain.views[1].chainId = () => 8453;
  const swapped = evidence(blocks);
  swapped.oracle.id = 'other-oracle';
  const noTag = evidence(blocks, 0);
  for (const [fixture, reason] of [
    [wrongChain, 'wrong_chain'], [swapped, 'evidence_sources_changed'], [noTag, 'awaiting_finality'],
  ] as const) {
    const result = observer.step(ID, fixture);
    assert.equal(result.reason, reason);
    assert.equal(result.outcome, 'unresolved');
    assert.equal(result.cursor.height, 100);
  }
});

test('rejects one or two false-empty responses and recovers from the same cursor', (t) => {
  const observer = open(t);
  const { blocks, watch } = scenario();
  observer.arm(watch, SOURCES);
  const honest = evidence(blocks);
  through(observer, honest, 102);
  const faulty = evidence(blocks);
  faulty.views[0].logs = () => [];
  assert.equal(observer.step(ID, faulty).reason, 'log_view_disagreement');
  faulty.views[1].logs = () => [];
  const stalled = observer.step(ID, faulty);
  assert.equal(stalled.reason, 'receipt_log_disagreement');
  assert.equal(stalled.outcome, 'unresolved');
  assert.equal(stalled.cursor.height, 102);
  assert.equal(stalled.occurrences.length, 0);
  assert.equal(through(observer, honest, 106).outcome, 'matched');
});

test('a correlated partial reply cannot hide the second qualifying transfer', (t) => {
  const observer = open(t);
  const { blocks, watch } = scenario([[transfer()], [transfer()]]);
  observer.arm(watch, SOURCES);
  through(observer, evidence(blocks), 102);
  const partial = evidence(blocks);
  for (const view of partial.views) {
    const original = view.logs;
    view.logs = (height, filter) => original(height, filter)?.slice(0, 1);
  }
  const result = observer.step(ID, partial);
  assert.equal(result.reason, 'receipt_log_disagreement');
  assert.equal(result.outcome, 'unresolved');
  assert.equal(result.cursor.height, 102);
  assert.equal(through(observer, evidence(blocks), 106).outcome, 'ambiguous');
});

test('missing middle history blocks matching and expiry even with a finalized deadline', async (t) => {
  for (const withCandidate of [true, false]) {
    await t.test(withCandidate ? 'one candidate' : 'zero candidates', (sub) => {
      const observer = open(sub);
      const { blocks, watch } = scenario(withCandidate ? [[transfer()]] : []);
      observer.arm(watch, SOURCES);
      const honest = evidence(blocks);
      through(observer, honest, 103);
      const gap = evidence(blocks.filter(({ header }) => header.height !== 104));
      const stalled = observer.step(ID, gap);
      assert.equal(stalled.outcome, 'unresolved');
      assert.equal(stalled.reason, 'missing_finalized_header');
      assert.equal(stalled.cursor.height, 103);
      assert.equal(stalled.occurrences.length, withCandidate ? 1 : 0);
      assert.equal(stalled.cutoff, null);
      assert.equal(through(observer, honest, 106).outcome, withCandidate ? 'matched' : 'expired');
    });
  }
});

test('receipt faults and malformed, capped or conflicting log replies leave a gap', async (t) => {
  const cases: [string, string, (fixture: FixtureEvidence) => void][] = [
    ['missing transaction receipt', 'incomplete_receipts', (fixture) => { fixture.oracle.receipts = () => []; }],
    ['receipt read unavailable', 'receipts_unavailable', (fixture) => { fixture.oracle.receipts = () => undefined; }],
    ['failed receipt with logs', 'invalid_receipt', (fixture) => changeReceipt(fixture, { status: 0 })],
    ['wrong receipt block hash', 'invalid_receipt', (fixture) => changeReceipt(fixture, { blockHash: hash(900) })],
    ['wrong receipt transaction index', 'invalid_receipt', (fixture) => changeReceipt(fixture, { transactionIndex: 1 })],
    ['receipt omits log', 'receipt_log_disagreement', (fixture) => changeReceipt(fixture, { logs: [] })],
    ['mismatched log index', 'invalid_receipt', (fixture) => changeLog(fixture, { logIndex: 1 })],
    ['malformed transfer data', 'malformed_transfer', (fixture) => changeLog(fixture, { data: '0x01' })],
    ['removed log', 'invalid_log', (fixture) => changeLog(fixture, { removed: true })],
    ['log read unavailable', 'logs_unavailable', (fixture) => { fixture.views[0].logs = () => undefined; }],
    ['conflicting duplicate', 'conflicting_log_position', (fixture) => {
      const original = fixture.views[0].logs;
      fixture.views[0].logs = (height, filter) => {
        const logs = original(height, filter)!;
        return [...logs, { ...logs[0], data: '0x01' }];
      };
    }],
    ['oversized response', 'log_response_limit', (fixture) => {
      const original = fixture.views[0].logs;
      fixture.views[0].logs = (height, filter) => Array(257).fill(original(height, filter)![0]);
    }],
  ];
  for (const [name, reason, fault] of cases) {
    await t.test(name, (sub) => {
      const observer = open(sub);
      const { blocks, watch } = scenario();
      observer.arm(watch, SOURCES);
      through(observer, evidence(blocks), 102);
      const faulty = evidence(blocks);
      fault(faulty);
      const result = observer.step(ID, faulty);
      assert.equal(result.reason, reason);
      assert.equal(result.outcome, 'unresolved');
      assert.equal(result.cursor.height, 102);
      assert.equal(result.occurrences.length, 0);
    });
  }
});

function changeReceipt(fixture: FixtureEvidence, changes: Partial<Receipt>) {
  const original = fixture.oracle.receipts;
  fixture.oracle.receipts = (blockHash) => original(blockHash)?.map((receipt) => ({ ...receipt, ...changes }));
}

function changeLog(fixture: FixtureEvidence, changes: Partial<Receipt['logs'][number]>) {
  const original = fixture.oracle.receipts;
  fixture.oracle.receipts = (blockHash) => original(blockHash)?.map((receipt) => ({
    ...receipt, logs: receipt.logs.map((log) => ({ ...log, ...changes })),
  }));
  for (const view of fixture.views) {
    const logs = view.logs;
    view.logs = (height, filter) => logs(height, filter)?.map((log) => ({ ...log, ...changes }));
  }
}

test('waits for delayed finality and accepts only the canonical fork above the immutable floor', (t) => {
  const observer = open(t);
  const { blocks, watch } = scenario();
  observer.arm(watch, SOURCES);
  const unsafe = evidence(blocks, 100);
  const waiting = observer.step(ID, unsafe);
  assert.equal(waiting.reason, 'awaiting_finality');
  assert.deepEqual(waiting.occurrences, []);
  assert.equal(waiting.cursor.height, 100);

  const replacement = [blocks[0]];
  for (const old of blocks.slice(1)) {
    const { height, timestamp } = old.header;
    const logs = height === 104 ? [[transfer({ address: OTHER }), transfer()]] : [[transfer()]];
    const next = block(height, replacement.at(-1)!.header.hash, height === 101 ? 1000 : Math.max(timestamp, 1000),
      [101, 104, 106].includes(height) ? logs : [], 1);
    // Re-include the unsafe transaction with a different log index on the eventual finalized chain.
    if (height === 104) {
      const transactionHash = blocks[3].header.transactions[0];
      replacement.push({
        header: { ...next.header, transactions: [transactionHash] },
        receipts: next.receipts.map((receipt) => ({ ...receipt, transactionHash,
          logs: receipt.logs.map((log) => ({ ...log, transactionHash })) })),
      });
    } else replacement.push(next);
  }
  const delayed = evidence(replacement, 104);
  delayed.views[1].finalized = () => replacement[2].header;
  through(observer, delayed, 102);
  assert.equal(observer.step(ID, delayed).reason, 'awaiting_finality');
  const beforeCutoff = through(observer, evidence(replacement, 104), 104);
  assert.equal(beforeCutoff.outcome, 'unresolved');
  assert.deepEqual(beforeCutoff.occurrences.map(({ log }) => [log.blockNumber, log.logIndex]), [[104, 1]]);
  const result = through(observer, evidence(replacement), 106);
  assert.equal(result.outcome, 'matched');
  assert.equal(result.occurrences[0].log.blockHash, replacement[4].header.hash);
});

test('stalls on a regressed tag, conflicting finalized hash, or non-contiguous header', (t) => {
  const observer = open(t);
  const { blocks, watch } = scenario();
  observer.arm(watch, SOURCES);
  through(observer, evidence(blocks), 102);
  const regressed = observer.step(ID, evidence(blocks, 106));
  assert.equal(regressed.reason, 'finality_regressed');

  const conflicting = evidence([...blocks.slice(0, -1), block(107, hash(106), 1002, [], 2)]);
  assert.equal(observer.step(ID, conflicting).reason, 'finality_conflict');
  const disconnected = blocks.map((item) => item.header.height === 103
    ? { ...item, header: { ...item.header, parentHash: hash(989) } } : item);
  const gap = observer.step(ID, evidence(disconnected));
  assert.equal(gap.reason, 'non_contiguous_chain');
  assert.equal(gap.outcome, 'unresolved');
  assert.equal(gap.cursor.height, 102);
  assert.equal(gap.cutoff, null);
});

test('reopens after process death on both sides of candidate/cursor and terminal commits', async (t) => {
  for (const height of [103, 106]) {
    for (const point of ['before_coverage_commit', 'after_coverage_commit']) {
      await t.test(`${height} ${point}`, (sub) => {
        const { filename, cleanup } = databasePath();
        sub.after(cleanup);
        const dir = new URL('./', import.meta.url);
        const script = `
          import { Observer } from './observer.ts';
          import { evidence, scenario, SOURCES } from './fixtures.ts';
          const { watch, blocks } = scenario();
          const fixtures = evidence(blocks);
          let current = 100;
          const observer = new Observer(process.argv[1], (point) => {
            if (current === ${height} && point === '${point}') process.exit(77);
          });
          observer.arm(watch, SOURCES);
          while (current < ${height}) { current++; observer.step(watch.id, fixtures); }
          process.exit(2);
        `;
        const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script, filename], {
          cwd: dir, encoding: 'utf8', timeout: 15_000,
        });
        assert.equal(child.status, 77, `${child.error ?? ''} ${child.stderr}`);
        const observer = new Observer(filename);
        try {
          const reopened = observer.status(ID);
          const durable = point === 'after_coverage_commit';
          assert.equal(reopened.cursor.height, durable ? height : height - 1);
          assert.equal(reopened.coverageBlocks, reopened.cursor.height - 100);
          assert.equal(reopened.outcome, durable && height === 106 ? 'matched' : 'unresolved');
          assert.equal(reopened.occurrences.length, durable || height === 106 ? 1 : 0);
          const result = through(observer, evidence(scenario().blocks), 106);
          assert.equal(result.outcome, 'matched');
          assert.equal(result.occurrences.length, 1);
          if (!durable || height !== 106) assert.ok(result.work.used > reopened.work.used);
        } finally { observer.close(); }
      });
    }
  }
});

test('SQLite statement failure rolls back coverage and candidates and allows retry', (t) => {
  const { filename, cleanup } = databasePath();
  const observer = new Observer(filename);
  const db = new DatabaseSync(filename);
  t.after(() => { db.close(); observer.close(); cleanup(); });
  const { blocks, watch } = scenario();
  observer.arm(watch, SOURCES);
  const fixture = evidence(blocks);
  const before = through(observer, fixture, 102);
  db.exec(`
    CREATE TRIGGER fail_cursor BEFORE UPDATE OF cursor ON watches BEGIN
      SELECT RAISE(ABORT, 'injected SQLite write failure');
    END;
  `);
  assert.throws(() => observer.step(ID, fixture), /injected SQLite write failure/);
  const stalled = observer.status(ID);
  assert.equal(stalled.outcome, 'unresolved');
  assert.equal(stalled.cursor.height, 102);
  assert.equal(stalled.coverageBlocks, 2);
  assert.equal(stalled.occurrences.length, 0);
  assert.ok(stalled.work.used > before.work.used);
  db.exec('DROP TRIGGER fail_cursor');
  assert.equal(through(observer, fixture, 106).outcome, 'matched');
  const coverage = db.prepare(`SELECT height, basis, filter_log_digest FROM coverage ORDER BY height`).all();
  assert.deepEqual(coverage.map((row) => row.basis), [
    'excluded_by_boundary', 'excluded_by_boundary', 'verified_logs', 'verified_logs', 'verified_logs', 'deadline',
  ]);
  assert.ok(coverage.slice(2, 5).every((row) => typeof row.filter_log_digest === 'string'));
});

test('a durable work cap leaves incomplete evidence unresolved across restart', (t) => {
  const { filename, cleanup } = databasePath();
  t.after(cleanup);
  const { blocks, watch } = scenario();
  const honest = evidence(blocks);
  const budget = new Observer(':memory:');
  budget.arm(watch, SOURCES);
  const throughCandidate = through(budget, honest, 103).work.used;
  budget.close();
  const observer = new Observer(filename);
  observer.arm({ ...watch, workLimit: throughCandidate + 1 }, SOURCES);
  through(observer, honest, 103);
  assert.equal(observer.step(ID, honest).reason, 'work_budget_exhausted');
  observer.close();
  const restarted = new Observer(filename);
  try {
    const noRead = evidence(blocks);
    noRead.views[0].chainId = () => assert.fail('budget must be charged before read');
    const stalled = restarted.step(ID, noRead);
    assert.equal(stalled.reason, 'work_budget_exhausted');
    assert.equal(stalled.outcome, 'unresolved');
    assert.equal(stalled.cursor.height, 103);
    assert.equal(stalled.cutoff, null);
    assert.equal(stalled.occurrences.length, 1);
    assert.equal(stalled.work.used, stalled.work.limit);
  } finally { restarted.close(); }
});
