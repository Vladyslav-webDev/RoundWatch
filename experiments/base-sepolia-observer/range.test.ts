import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { block, evidence, hash, scenario, SOURCES, transfer } from './fixtures.ts';
import { MAX_RANGE_BLOCKS, Observer } from './observer.ts';

const ID = 'invoice-a';

function open(t: TestContext) {
  const observer = new Observer(':memory:');
  t.after(() => observer.close());
  return observer;
}

function databasePath(t: TestContext): string {
  const dir = mkdtempSync(fileURLToPath(new URL('./.cp2-test-', import.meta.url)));
  const filename = join(dir, 'watch.sqlite');
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(filename + suffix, { force: true });
    rmdirSync(dir);
  });
  return filename;
}

type Status = ReturnType<Observer['status']>;

function assertPendingAt(status: Status, height: number, occurrences: number) {
  assert.equal(status.outcome, 'unresolved');
  assert.equal(status.cursor.height, height);
  assert.equal(status.coverageBlocks, height - 100);
  assert.equal(status.cutoff, null);
  assert.equal(status.occurrences.length, occurrences);
}

test('range size and finality bound progress and the deadline still excludes its entire second', (t) => {
  const observer = open(t);
  const singleHeight = open(t);
  const { watch, blocks } = scenario([[transfer()]], [[transfer()]]);
  observer.arm(watch, SOURCES);
  singleHeight.arm(watch, SOURCES);

  const honest = evidence(blocks);
  const calls: [string, number, number][] = [];
  for (const view of honest.views) {
    const logsRange = view.logsRange;
    view.logsRange = (from, to, filter) => {
      calls.push([view.id, from, to]);
      return logsRange(from, to, filter);
    };
  }
  for (const size of [0, 1.5, MAX_RANGE_BLOCKS + 1]) {
    assert.throws(() => observer.stepRange(ID, honest, size), /invalid_range_limit/);
  }
  assert.equal(observer.status(ID).work.used, 0);

  const delayed = evidence(blocks, 104);
  for (const view of delayed.views) {
    view.logsRange = () => assert.fail('blocks before the opening boundary require no log read');
  }
  assertPendingAt(observer.stepRange(ID, delayed, 2), 102, 0);
  assert.deepEqual(calls, []);
  assertPendingAt(observer.stepRange(ID, evidence(blocks, 104), MAX_RANGE_BLOCKS), 104, 2);
  const waiting = observer.stepRange(ID, evidence(blocks, 104), MAX_RANGE_BLOCKS);
  assertPendingAt(waiting, 104, 2);
  assert.equal(waiting.reason, 'awaiting_finality');
  const result = observer.stepRange(ID, honest, MAX_RANGE_BLOCKS);
  assert.deepEqual(calls, [[SOURCES[0], 105, 105], [SOURCES[1], 105, 105]]);
  assert.equal(result.cursor.height, 106);
  assert.equal(result.coverageBlocks, 6);
  assert.equal(result.cutoff?.height, 106);
  assert.equal(result.outcome, 'ambiguous');
  assert.deepEqual(result.occurrences.map(({ log }) => log.blockNumber), [103, 104]);

  let cp1 = singleHeight.status(ID);
  for (let i = 0; i < 6; i++) cp1 = singleHeight.step(ID, honest);
  assert.equal(result.outcome, cp1.outcome);
  assert.deepEqual(result.cursor, cp1.cursor);
  assert.deepEqual(result.cutoff, cp1.cutoff);
  assert.deepEqual(result.occurrences, cp1.occurrences);
  assert.deepEqual(observer.stepRange(ID, honest, MAX_RANGE_BLOCKS), result);
});

test('the default range cap slices a longer finalized backlog before expiring an empty watch', (t) => {
  const observer = open(t);
  const scenarioFixture = scenario();
  const blocks = scenarioFixture.blocks.slice(0, 2);
  const cutoff = 100 + MAX_RANGE_BLOCKS + 3;
  for (let height = 102; height <= cutoff + 2; height++) {
    blocks.push(block(height, blocks.at(-1)!.header.hash, height + 897));
  }
  const watch = { ...scenarioFixture.watch, deadlineSec: cutoff + 897 };
  observer.arm(watch, SOURCES);
  const honest = evidence(blocks);

  const partial = observer.stepRange(ID, honest);
  assertPendingAt(partial, 100 + MAX_RANGE_BLOCKS, 0);
  assert.equal(partial.reason, 'awaiting_coverage');

  const result = observer.stepRange(ID, honest);
  assert.equal(result.outcome, 'expired');
  assert.equal(result.cutoff?.height, cutoff);
  assert.equal(result.cursor.height, cutoff);
  assert.equal(result.coverageBlocks, cutoff - 100);
  assert.deepEqual(result.occurrences, []);
});

test('a middle header gap or a missing range response cannot resolve a watch with a prior candidate', (t) => {
  const observer = open(t);
  const { watch, blocks } = scenario();
  const honest = evidence(blocks);
  observer.arm(watch, SOURCES);
  const prefix = observer.stepRange(ID, honest, 3);
  assertPendingAt(prefix, 103, 1);

  const missingHeader = evidence(blocks);
  const header = missingHeader.views[1].header;
  missingHeader.views[1].header = (height) => height === 105 ? undefined : header(height);
  const gap = observer.stepRange(ID, missingHeader, MAX_RANGE_BLOCKS);
  assert.equal(gap.reason, 'missing_finalized_header');
  assertPendingAt(gap, 103, 1);
  assert.deepEqual(gap.occurrences, prefix.occurrences);

  const missingRange = evidence(blocks);
  missingRange.views[1].logsRange = () => undefined;
  const stalled = observer.stepRange(ID, missingRange, MAX_RANGE_BLOCKS);
  assert.equal(stalled.reason, 'logs_unavailable');
  assertPendingAt(stalled, 103, 1);
  assert.ok(stalled.work.used > gap.work.used);
  assert.deepEqual(stalled.occurrences, prefix.occurrences);

  const retried = observer.stepRange(ID, honest, MAX_RANGE_BLOCKS);
  assert.equal(retried.outcome, 'matched');
  assert.equal(retried.cutoff?.height, 106);
  assert.equal(retried.coverageBlocks, 6);
  assert.deepEqual(retried.occurrences, prefix.occurrences);
});

test('the full receipt oracle catches false-empty and correlated truncated range replies', (t) => {
  const observer = open(t);
  const { watch, blocks } = scenario([[transfer()]], [[transfer()]]);
  observer.arm(watch, SOURCES);
  const falseEmpty = evidence(blocks);
  falseEmpty.views[0].logsRange = () => [];
  const oneEmpty = observer.stepRange(ID, falseEmpty, MAX_RANGE_BLOCKS);
  assert.equal(oneEmpty.reason, 'log_view_disagreement');
  assertPendingAt(oneEmpty, 100, 0);

  falseEmpty.views[1].logsRange = () => [];
  const bothEmpty = observer.stepRange(ID, falseEmpty, MAX_RANGE_BLOCKS);
  assert.equal(bothEmpty.reason, 'receipt_log_disagreement');
  assertPendingAt(bothEmpty, 100, 0);

  const truncated = evidence(blocks);
  for (const view of truncated.views) {
    const logsRange = view.logsRange;
    view.logsRange = (from, to, filter) => logsRange(from, to, filter)?.slice(0, 1);
  }
  const partial = observer.stepRange(ID, truncated, MAX_RANGE_BLOCKS);
  assert.equal(partial.reason, 'receipt_log_disagreement');
  assertPendingAt(partial, 100, 0);

  const honest = evidence(blocks);
  const calls: [string, number, number][] = [];
  for (const view of honest.views) {
    const logsRange = view.logsRange;
    view.logsRange = (from, to, filter) => {
      calls.push([view.id, from, to]);
      return logsRange(from, to, filter);
    };
  }
  const result = observer.stepRange(ID, honest, MAX_RANGE_BLOCKS);
  assert.equal(result.outcome, 'ambiguous');
  assert.deepEqual(calls, [[SOURCES[0], 103, 105], [SOURCES[1], 103, 105]]);
  assert.deepEqual(result.work.byRead.filter(({ kind }) => kind === 'range_logs').map(({ source, attempts }) => [
    source, attempts,
  ]), [[SOURCES[0], 4], [SOURCES[1], 4]]);
  assert.deepEqual(result.occurrences.map(({ log }) => log.blockNumber), [103, 104]);
});

test('a conflicting middle header or an out-of-range log leaves the range uncommitted', (t) => {
  const observer = open(t);
  const { watch, blocks } = scenario();
  observer.arm(watch, SOURCES);

  const disagreement = evidence(blocks);
  const header = disagreement.views[1].header;
  disagreement.views[1].header = (height) => height === 104
    ? { ...blocks[4].header, hash: hash(777) } : header(height);
  const conflictingHeader = observer.stepRange(ID, disagreement, MAX_RANGE_BLOCKS);
  assert.equal(conflictingHeader.reason, 'finalized_header_disagreement');
  assertPendingAt(conflictingHeader, 100, 0);

  const extraLog = evidence(blocks);
  const logsRange = extraLog.views[0].logsRange;
  extraLog.views[0].logsRange = (from, to, filter) => [
    ...logsRange(from, to, filter)!, blocks[6].receipts[0].logs[0],
  ];
  const outside = observer.stepRange(ID, extraLog, MAX_RANGE_BLOCKS);
  assert.equal(outside.reason, 'log_outside_range');
  assertPendingAt(outside, 100, 0);
});

test('an SQLite failure after writing earlier rows rolls back the entire range', (t) => {
  const filename = databasePath(t);
  const observer = new Observer(filename);
  const db = new DatabaseSync(filename);
  const { watch, blocks } = scenario();
  try {
    observer.arm(watch, SOURCES);
    db.exec(`
      CREATE TRIGGER fail_range BEFORE INSERT ON coverage WHEN NEW.height = 104 BEGIN
        SELECT RAISE(ABORT, 'injected coverage failure');
      END;
    `);
    assert.throws(() => observer.stepRange(ID, evidence(blocks), MAX_RANGE_BLOCKS), /injected coverage failure/);
    const failed = observer.status(ID);
    assertPendingAt(failed, 100, 0);
    assert.ok(failed.work.used > 0);
    db.exec('DROP TRIGGER fail_range');
    const recovered = observer.stepRange(ID, evidence(blocks), MAX_RANGE_BLOCKS);
    assert.equal(recovered.outcome, 'matched');
    assert.equal(recovered.coverageBlocks, 6);
    assert.equal(recovered.occurrences.length, 1);
  } finally {
    db.close();
    observer.close();
  }
});

test('reopening after process death sees the range on exactly one side of its commit', async (t) => {
  for (const terminal of [false, true]) {
    for (const point of ['before_coverage_commit', 'after_coverage_commit']) {
      await t.test(`${terminal ? 'terminal' : 'candidate'} range ${point}`, (sub) => {
        const filename = databasePath(sub);
        const script = `
          import { Observer } from './observer.ts';
          import { evidence, scenario, SOURCES } from './fixtures.ts';
          const { watch, blocks } = scenario();
          const fixture = evidence(blocks);
          let inject = false;
          const observer = new Observer(process.argv[1], (point) => {
            if (inject && point === '${point}') process.exit(77);
          });
          observer.arm(watch, SOURCES);
          if (${terminal}) observer.stepRange(watch.id, fixture, 2);
          inject = true;
          observer.stepRange(watch.id, fixture, 4);
          process.exit(2);
        `;
        const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script, filename], {
          cwd: new URL('./', import.meta.url), encoding: 'utf8', timeout: 15_000,
        });
        assert.equal(child.status, 77, `${child.error ?? ''} ${child.stderr}`);
        const reopened = new Observer(filename);
        try {
          const status = reopened.status(ID);
          const committed = point === 'after_coverage_commit';
          const priorHeight = terminal ? 102 : 100;
          assert.equal(status.cursor.height, priorHeight + (committed ? 4 : 0));
          assert.equal(status.coverageBlocks, status.cursor.height - 100);
          assert.equal(status.occurrences.length, committed ? 1 : 0);
          assert.equal(status.outcome, terminal && committed ? 'matched' : 'unresolved');
          assert.equal(status.cutoff?.height ?? null, terminal && committed ? 106 : null);
          assert.ok(status.work.used > 0);

          const result = reopened.stepRange(ID, evidence(scenario().blocks), MAX_RANGE_BLOCKS);
          assert.equal(result.outcome, 'matched');
          assert.equal(result.coverageBlocks, 6);
          assert.equal(result.occurrences.length, 1);
          if (!terminal || !committed) assert.ok(result.work.used > status.work.used);
        } finally {
          reopened.close();
        }
      });
    }
  }
});

test('exhausting durable work partway through a range preserves the prior coverage and candidate', (t) => {
  const filename = databasePath(t);
  const { watch, blocks } = scenario();
  const honest = evidence(blocks);
  const reference = open(t);
  reference.arm(watch, SOURCES);
  const prefix = reference.stepRange(ID, honest, 3);
  assertPendingAt(prefix, 103, 1);
  const complete = reference.stepRange(ID, honest, MAX_RANGE_BLOCKS);
  assert.equal(complete.outcome, 'matched');
  const workLimit = complete.work.used - 1;
  assert.ok(workLimit > prefix.work.used);

  const observer = new Observer(filename);
  try {
    observer.arm({ ...watch, workLimit }, SOURCES);
    assertPendingAt(observer.stepRange(ID, honest, 3), 103, 1);
    const failed = observer.stepRange(ID, honest, MAX_RANGE_BLOCKS);
    assert.equal(failed.reason, 'work_budget_exhausted');
    assertPendingAt(failed, 103, 1);
    assert.deepEqual(failed.occurrences, prefix.occurrences);
    assert.equal(failed.work.used, workLimit);
  } finally {
    observer.close();
  }

  const reopened = new Observer(filename);
  try {
    let reads = 0;
    const exhausted = evidence(blocks);
    exhausted.views[0].chainId = () => { reads++; return watch.chainId; };
    const stalled = reopened.stepRange(ID, exhausted, MAX_RANGE_BLOCKS);
    assert.equal(reads, 0);
    assert.equal(stalled.reason, 'work_budget_exhausted');
    assertPendingAt(stalled, 103, 1);
    assert.deepEqual(stalled.occurrences, prefix.occurrences);
    assert.equal(stalled.work.used, workLimit);
    assert.equal(stalled.work.used, stalled.work.byRead.reduce((sum, read) => sum + Number(read.attempts), 0));
  } finally {
    reopened.close();
  }
});
