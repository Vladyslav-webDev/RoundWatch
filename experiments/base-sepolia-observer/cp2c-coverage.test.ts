import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { openFixtureCoverage } from './cp2c-coverage.ts';
import type { ProofHeader } from './cp2c-coverage.ts';
import { EMPTY_LOGS_BLOOM, EMPTY_RECEIPTS_ROOT, receiptFixture } from './cp2c-receipt-fixtures.ts';
import { CHAIN_ID } from './evidence.ts';

function hexHeight(height: number): string {
  return `0x${height.toString(16).padStart(64, '0')}`;
}

function emptyHeader(height: number, timestamp: number, parentHash: string, hash = hexHeight(height)): ProofHeader {
  return { height, timestamp, parentHash, hash, transactions: [], logsBloom: EMPTY_LOGS_BLOOM, receiptsRoot: EMPTY_RECEIPTS_ROOT };
}

function scenario() {
  const { block, receipts, watch: tuple } = receiptFixture;
  const anchor = emptyHeader(block.height - 2, block.timestamp - 2, hexHeight(block.height - 3));
  const first = emptyHeader(block.height - 1, block.timestamp - 1, anchor.hash, block.parentHash);
  const following = emptyHeader(block.height + 1, block.timestamp + 1, block.hash);
  const boundary = emptyHeader(block.height + 2, block.timestamp + 2, following.hash);
  const blocks = [
    { header: first }, { header: block, depositRule: 'canyon-v1' as const }, { header: following }, { header: boundary },
  ];
  const watch = { ...tuple, id: 'cp2c', chainId: CHAIN_ID, opensAtSec: first.timestamp, deadlineSec: boundary.timestamp };
  return { watch, fixture: { anchor, blocks }, first, block, following, boundary, receipts };
}

function memory(t: TestContext): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return db;
}

test('provider-only claims, including two false-empty responses, cannot advance the cursor', (t) => {
  const { watch, fixture, first } = scenario();
  const store = openFixtureCoverage(memory(t), watch, { ...fixture, blocks: [] });
  for (const observation of ['OBSERVED_ONLY', 'RECEIPT_INCLUSION', 'PROVIDER_CORROBORATED'] as const) {
    assert.deepEqual(store.advance({ header: first, observation, receipts: [] }),
      { evidence: observation, reason: 'unauthenticated_header' });
  }
  assert.deepEqual(store.advance({ header: first }), { evidence: 'UNRESOLVED', reason: 'unauthenticated_header' });
  assert.deepEqual(store.status(), {
    accepted: [], cursor: fixture.anchor, occurrences: [], deadlineBoundary: null, negativeEligible: false,
  });
});

test('matching a fixture hash and parent cannot authenticate modified proof fields', (t) => {
  const { watch, fixture, first } = scenario();
  const store = openFixtureCoverage(memory(t), watch, fixture);
  for (const forged of [
    { ...first, hash: hexHeight(first.height + 100) },
    { ...first, logsBloom: `0x${'ff'.repeat(256)}` },
    { ...first, receiptsRoot: hexHeight(first.height) },
    { ...first, transactions: [hexHeight(first.height)] },
    { ...first, timestamp: watch.deadlineSec },
  ]) {
    assert.deepEqual(store.advance({ header: forged, observation: 'PROVIDER_CORROBORATED' }),
      { evidence: 'UNRESOLVED', reason: 'canonical_header_mismatch' });
  }
  assert.equal(store.status().cursor.height, fixture.anchor.height);
});

test('a negative bloom covers the opening block and a positive bloom requires rooted receipts', (t) => {
  const { watch, fixture, first, block, receipts, following, boundary } = scenario();
  const store = openFixtureCoverage(memory(t), watch, fixture);
  assert.deepEqual(store.advance({ header: first }), { evidence: 'VERIFIED_COMPLETE', reason: 'BLOOM_EXCLUSION' });
  assert.deepEqual(store.advance({ header: block }), { evidence: 'UNRESOLVED', reason: 'bloom_possible_receipts_required' });
  assert.equal(store.status().cursor.height, first.height);
  assert.deepEqual(store.advance({ header: block, receipts }), { evidence: 'VERIFIED_COMPLETE', reason: 'RECEIPTS_ROOT' });
  assert.equal(store.status().occurrences.length, 1);
  store.advance({ header: following });
  assert.deepEqual(store.advance({ header: boundary }), { evidence: 'VERIFIED_COMPLETE', reason: 'OUTSIDE_WINDOW' });
  assert.deepEqual(store.status().deadlineBoundary, boundary);
  assert.equal(store.status().negativeEligible, false);
});

test('rooted positive bloom with a different amount can support a negative at the authenticated exclusive boundary', (t) => {
  const { watch, fixture, first, block, receipts, following, boundary } = scenario();
  const differentAmount = { ...watch, amountAtomic: String(BigInt(watch.amountAtomic) + 1n) };
  const store = openFixtureCoverage(memory(t), differentAmount, fixture);
  store.advance({ header: first });
  assert.equal(store.advance({ header: block, receipts }).evidence, 'VERIFIED_COMPLETE');
  store.advance({ header: following });
  assert.equal(store.status().negativeEligible, false);
  assert.equal(store.advance({ header: { ...boundary, timestamp: boundary.timestamp + 1 } }).evidence, 'UNRESOLVED');
  assert.equal(store.status().negativeEligible, false);
  assert.deepEqual(store.advance({ header: boundary }), { evidence: 'VERIFIED_COMPLETE', reason: 'OUTSIDE_WINDOW' });
  const { occurrences, deadlineBoundary, negativeEligible } = store.status();
  assert.deepEqual(occurrences, []);
  assert.deepEqual(deadlineBoundary, boundary);
  assert.equal(negativeEligible, true);
});

test('a qualifying transfer in the first deadline-second block is outside the eligible window', (t) => {
  const { watch, fixture, first, block } = scenario();
  const store = openFixtureCoverage(memory(t), { ...watch, deadlineSec: block.timestamp }, fixture);
  assert.equal(store.advance({ header: first }).evidence, 'VERIFIED_COMPLETE');
  assert.deepEqual(store.advance({ header: block }), { evidence: 'VERIFIED_COMPLETE', reason: 'OUTSIDE_WINDOW' });
  assert.deepEqual(store.status().occurrences, []);
  assert.equal(store.status().negativeEligible, true);
});

test('incomplete, reordered and corrupted receipts and ambiguous deposit semantics leave coverage uncommitted', (t) => {
  const { watch, fixture, first, block, receipts } = scenario();
  const store = openFixtureCoverage(memory(t), watch, fixture);
  assert.equal(store.advance({ header: first, receipts: [receipts[0]] }).evidence, 'UNRESOLVED');
  assert.equal(store.status().cursor.height, fixture.anchor.height);
  store.advance({ header: first });
  const corrupted = receipts.map((receipt, index) => index === 0 ? { ...receipt, cumulativeGasUsed: '0x1' } : receipt);
  const unsupported = receipts.map((receipt, index) => index === 0 ? { ...receipt, type: '0x7d' } : receipt);
  for (const invalid of [[], receipts.slice(0, -1), [...receipts].reverse(), corrupted, unsupported]) {
    assert.equal(store.advance({ header: block, receipts: invalid, observation: 'PROVIDER_CORROBORATED' }).evidence, 'UNRESOLVED');
    assert.equal(store.status().cursor.height, first.height);
  }
  const unclearFork = openFixtureCoverage(memory(t), watch, {
    ...fixture, blocks: fixture.blocks.map(({ header }) => ({ header })),
  });
  unclearFork.advance({ header: first });
  assert.equal(unclearFork.advance({ header: block, receipts }).evidence, 'UNRESOLVED');
  assert.equal(unclearFork.status().cursor.height, first.height);
});

test('a middle gap and a broken parent link prevent later coverage and deadline verification', (t) => {
  const { watch, fixture, first, block, following, boundary } = scenario();
  const store = openFixtureCoverage(memory(t), watch, fixture);
  store.advance({ header: first });
  assert.equal(store.advance({}).reason, 'missing_header');
  assert.equal(store.advance({ header: following }).reason, 'noncontiguous_height');
  assert.equal(store.advance({ header: { ...block, parentHash: boundary.hash } }).reason, 'unlinked_header');
  assert.equal(store.advance({ header: boundary }).reason, 'noncontiguous_height');
  assert.equal(store.status().cursor.height, first.height);
  assert.equal(store.status().negativeEligible, false);
});

test('SQLite restart preserves the last complete evidence and cursor on both sides of a process exit', () => {
  const { watch, fixture, first, block, receipts } = scenario();
  const dir = mkdtempSync(join(tmpdir(), 'roundwatch-cp2c-'));
  const filename = join(dir, 'fixture.sqlite');
  const connect = () => new DatabaseSync(filename);
  const moduleUrl = new URL('./cp2c-coverage.ts', import.meta.url).href;
  const worker = `
    import { DatabaseSync } from 'node:sqlite';
    import { openFixtureCoverage } from ${JSON.stringify(moduleUrl)};
    const [file, phase, fixtureJson, watchJson, evidenceJson] = process.argv.slice(1);
    const db = new DatabaseSync(file);
    const store = openFixtureCoverage(db, JSON.parse(watchJson), JSON.parse(fixtureJson));
    if (phase === 'before') {
      db.function('terminate_process', () => process.exit(61));
      db.exec('CREATE TEMP TRIGGER stop_write AFTER INSERT ON cp2c_coverage BEGIN SELECT terminate_process(); END');
    }
    if (store.advance(JSON.parse(evidenceJson)).evidence !== 'VERIFIED_COMPLETE') process.exit(63);
    process.exit(62);
  `;
  const startWorker = (phase: string, expected: number) => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', worker, filename, phase,
      JSON.stringify(fixture), JSON.stringify(watch), JSON.stringify({ header: block, receipts })], { encoding: 'utf8' });
    assert.equal(child.status, expected, String(child.error ?? child.stderr));
  };
  try {
    const before = (() => {
      using initial = connect();
      const store = openFixtureCoverage(initial, watch, fixture);
      assert.equal(store.advance({ header: first }).evidence, 'VERIFIED_COMPLETE');
      return store.status();
    })();
    startWorker('before', 61);
    {
      using recovered = connect();
      assert.deepEqual(openFixtureCoverage(recovered, watch, fixture).status(), before);
    }
    startWorker('after', 62);
    using committed = connect();
    const after = openFixtureCoverage(committed, watch, fixture).status();
    assert.deepEqual(after.cursor, block);
    assert.deepEqual(after.accepted.slice(0, -1), before.accepted);
    assert.equal(after.accepted.at(-1)?.method, 'RECEIPTS_ROOT');
    assert.equal(after.occurrences.length, 1);
    assert.equal(after.negativeEligible, false);
    assert.throws(() => openFixtureCoverage(committed, { ...watch, deadlineSec: watch.deadlineSec + 1 }, fixture),
      /immutable_fixture_definition/);
  } finally {
    for (const suffix of ['', '-shm', '-wal']) rmSync(filename + suffix, { force: true });
    rmdirSync(dir);
  }
});
