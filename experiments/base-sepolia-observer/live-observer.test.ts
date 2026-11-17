import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressTopic, CHAIN_ID, TRANSFER, USDC } from './evidence.ts';
import { LIVE_OBSERVATION_LIMITS, observeLiveRange } from './live-observer.ts';
import { LiveStore } from './live-store.ts';
import { BaseSepoliaRpc } from './rpc.ts';

const NOW = 1_800_000_000;
const ID = 'sample';
const SOURCES = ['left', 'right'] as const;
const hash = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
const quantity = (value: number) => `0x${value.toString(16)}`;
const tuple = {
  sender: `0x${'aa'.repeat(20)}`, recipient: `0x${'bb'.repeat(20)}`, amountAtomic: '42',
  opensAtSec: NOW - 1_000, deadlineSec: NOW - 900,
};
const txHash = hash(500);
const rawLog = {
  blockNumber: '0x65', blockHash: hash(101), transactionHash: txHash, transactionIndex: '0x0', logIndex: '0xf',
  removed: false, address: USDC, topics: [TRANSFER, addressTopic(tuple.sender), addressTopic(tuple.recipient)], data: hash(42),
};
const rawReceipt = {
  blockNumber: rawLog.blockNumber, blockHash: rawLog.blockHash, transactionHash: txHash,
  transactionIndex: '0x0', status: '0x1', logs: [rawLog],
};
const block = (height: number) => ({
  number: quantity(height), hash: hash(height), parentHash: hash(height - 1),
  timestamp: quantity(NOW - 1_000 + height - 100), transactions: height === 101 ? [txHash] : [],
});

interface RpcRequest { id: number; method: string; params: unknown[] }
type Result = (request: RpcRequest, actual: unknown) => unknown;

function mockRpc(id: string, override?: Result) {
  const calls: RpcRequest[] = [];
  const rpc = new BaseSepoliaRpc(id, 'https://unused.example.invalid/', {
    maxRequests: 24, maxElapsedMs: 5_000, requestTimeoutMs: 1_000,
    maxResponseBytes: 256 * 1024, maxTotalResponseBytes: 1024 * 1024, maxRangeBlocks: 3,
  }, async (_url, init) => {
    const request: RpcRequest = JSON.parse(init?.body as string);
    const { method, params } = request;
    calls.push(request);
    let result: unknown;
    switch (method) {
      case 'eth_chainId':
        result = quantity(CHAIN_ID);
        break;
      case 'eth_getBlockByNumber': {
        const height = params[0] === 'finalized' ? 103 : Number(params[0]);
        assert.ok(height >= 100 && height <= 103, `Unexpected numbered height ${height}`);
        assert.equal(params[1], false);
        result = block(height);
        break;
      }
      case 'eth_getLogs': {
        const { fromBlock, toBlock, address, topics } = params[0] as {
          fromBlock: string; toBlock: string; address: string; topics: string[];
        };
        assert.equal(address, USDC);
        assert.equal(topics[0], TRANSFER);
        result = Number(fromBlock) <= 101 && Number(toBlock) >= 101 ? [rawLog] : [];
        break;
      }
      case 'eth_getTransactionReceipt':
        assert.deepEqual(params, [txHash]);
        result = rawReceipt;
        break;
      default:
        assert.fail(`Unexpected method ${method}`);
    }
    if (override) result = override(request, result);
    if (result instanceof Response) return result;
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  });
  return { rpc, calls };
}

type Options = { exact?: boolean; workLimit?: number; left?: Result; right?: Result };
const observe = (store: LiveStore, left = mockRpc(SOURCES[0]), right = mockRpc(SOURCES[1])) =>
  observeLiveRange(store, ID, [left.rpc, right.rpc], { nowSec: () => NOW });

async function sample(options: Options = {}) {
  const store = LiveStore.create();
  try {
    store.start(ID, SOURCES, options.workLimit ?? LIVE_OBSERVATION_LIMITS.durableWorkLimit, options.exact ? tuple : undefined);
    const left = mockRpc(SOURCES[0], options.left);
    const right = mockRpc(SOURCES[1], options.right);
    return { status: await observe(store, left, right), left, right };
  } finally {
    store.close();
    LiveStore.dispose(store.database);
  }
}

function assertUnresolved(status: ReturnType<LiveStore['status']>) {
  assert.equal(status.outcome, 'unresolved');
  assert.equal(status.verifiedCoverageCursor, null);
  assert.equal(status.verifiedCoverageBlocks, 0);
}

test('retains dual-provider receipt inclusion, fixed positions and the exact tuple in the finalized sample', async () => {
  const duplicate: Result = ({ method }, actual) => method === 'eth_getLogs' && (actual as unknown[]).length ? [rawLog, rawLog] : actual;
  const { status, left, right } = await sample({ exact: true, left: duplicate });
  assertUnresolved(status);
  assert.equal(status.reason, 'receipt_inclusion_only');
  assert.equal(status.observation?.predecessor.height, 100);
  assert.deepEqual(status.observation?.blocks.map(({ height }) => height), [101, 102, 103]);
  assert.deepEqual(status.observation?.watch, tuple);
  assert.deepEqual(status.observation?.candidates.map(({ log, receipt }) => [log.logIndex, receipt.status, receipt.transactionHash]),
    [[15, 1, txHash]]);
  assert.deepEqual(status.observation?.sources.map(({ id }) => id), SOURCES);
  assert.equal(status.work.used, 26);
  for (const { calls } of [left, right]) {
    assert.equal(calls.length, 13);
    assert.equal(calls[0].method, 'eth_chainId');
    assert.deepEqual(calls.find(({ method }) => method === 'eth_getLogs')?.params, [{
      fromBlock: '0x65', toBlock: '0x67', address: USDC, topics: rawLog.topics,
    }]);
  }
});

const receiptResult = (replacement: unknown): Result => ({ method }, actual) =>
  method === 'eth_getTransactionReceipt' ? replacement : actual;
const transferResult = (replacement: unknown): Result => ({ method }, actual) =>
  method === 'eth_getLogs' && (actual as unknown[]).length ? replacement : actual;

for (const [label, right, reason] of [
  ['missing receipt', receiptResult(null), 'receipt_unavailable'],
  ['failed receipt', receiptResult({ ...rawReceipt, status: '0x0', logs: [] }), 'receipt_failed'],
  ['wrong receipt transaction', receiptResult({ ...rawReceipt, transactionHash: hash(501) }), 'receipt_transaction_disagreement'],
  ['wrong receipt block', receiptResult({ ...rawReceipt, blockHash: hash(23), logs: [] }), 'receipt_identity_disagreement'],
  ['wrong receipt log index', receiptResult({ ...rawReceipt, logs: [{ ...rawLog, logIndex: '0x10' }] }), 'receipt_log_disagreement'],
  ['wrong receipt sender', receiptResult({ ...rawReceipt, logs: [{ ...rawLog, topics: [TRANSFER, addressTopic(tuple.recipient), rawLog.topics[2]] }] }), 'receipt_log_disagreement'],
  ['wrong receipt recipient', receiptResult({ ...rawReceipt, logs: [{ ...rawLog, topics: [TRANSFER, rawLog.topics[1], addressTopic(tuple.sender)] }] }), 'receipt_log_disagreement'],
  ['wrong receipt amount', receiptResult({ ...rawReceipt, logs: [{ ...rawLog, data: hash(43) }] }), 'receipt_log_disagreement'],
  ['wrong transfer token', transferResult([{ ...rawLog, address: tuple.sender }]), 'unexpected_transfer_log'],
  ['wrong transfer event', transferResult([{ ...rawLog, topics: [hash(50), ...rawLog.topics.slice(1)] }]), 'invalid_log'],
  ['wrong transfer transaction', transferResult([{ ...rawLog, transactionHash: hash(501) }]), 'log_header_disagreement'],
  ['conflicting duplicate log position', transferResult([rawLog, { ...rawLog, data: hash(43) }]), 'conflicting_log_position'],
  ['provider false-empty disagreement', transferResult([]), 'log_provider_disagreement'],
] as const) {
  test(`rejects ${label} without live coverage or candidates`, async () => {
    const { status } = await sample({ right });
    assertUnresolved(status);
    assert.equal(status.reason, reason);
    assert.equal(status.observation, null);
  });
}

test('rejects a wrong chain before either provider may request block or log evidence', async () => {
  const { status, left, right } = await sample({ right: ({ method }, result) => method === 'eth_chainId' ? '0x1' : result });
  assertUnresolved(status);
  assert.equal(status.reason, 'wrong_chain_id');
  assert.equal(status.diagnostic?.source, SOURCES[1]);
  assert.deepEqual([left, right].map(({ calls }) => calls.map(({ method }) => method)), [['eth_chainId'], ['eth_chainId']]);
});

test('an agreed but false-empty range is rejected when single-height results disagree', async () => {
  const rangeEmpty: Result = ({ method, params }, actual) =>
    method === 'eth_getLogs' && (params[0] as { toBlock: string }).toBlock === '0x67' ? [] : actual;
  const { status } = await sample({ left: rangeEmpty, right: rangeEmpty });
  assertUnresolved(status);
  assert.equal(status.reason, 'range_single_log_disagreement');
  assert.equal(status.observation, null);
});

test('correlated omissions cannot expire a watch even after its deadline or create verified coverage', async () => {
  const omitAll = transferResult([]);
  const { status } = await sample({ exact: true, left: omitAll, right: omitAll });
  assertUnresolved(status);
  assert.equal(status.reason, 'coverage_unproven');
  assert.deepEqual(status.observation?.candidates, []);
});

test('matching receipts expose omissions in the queried transaction', async () => {
  const extra = receiptResult({ ...rawReceipt, logs: [rawLog, { ...rawLog, logIndex: '0x10' }] });
  const { status } = await sample({ left: extra, right: extra });
  assertUnresolved(status);
  assert.equal(status.reason, 'receipt_log_disagreement');
  assert.equal(status.observation, null);
});

test('agreement on a candidate leaves a second transaction unexamined', async () => {
  const omittedTransaction: Result = ({ params }, actual) => params[0] === '0x65'
    ? { ...block(101), transactions: [txHash, hash(501)] } : actual;
  const { status } = await sample({ exact: true, left: omittedTransaction, right: omittedTransaction });
  assertUnresolved(status);
  assert.equal(status.reason, 'receipt_inclusion_only');
  assert.equal(status.observation?.candidates.length, 1);
  assert.equal(status.observation?.blocks[0].transactions.length, 2);
});

test('too many candidate transactions stops acquisition before any receipt requests', async () => {
  const logs = Array.from({ length: 5 }, (_, index) => ({ ...rawLog, transactionHash: hash(500 + index),
    transactionIndex: quantity(index), logIndex: quantity(15 + index) }));
  const manyCandidates: Result = (request, actual) => request.params[0] === '0x65'
    ? { ...block(101), transactions: logs.map(({ transactionHash }) => transactionHash) }
    : transferResult(logs)(request, actual);
  const { status, left, right } = await sample({ left: manyCandidates, right: manyCandidates });
  assertUnresolved(status);
  assert.equal(status.reason, 'receipt_work_limit');
  assert.equal(status.observation, null);
  assert.ok([...left.calls, ...right.calls].every(({ method }) => method !== 'eth_getTransactionReceipt'));
});

test('truncated wire response is unresolved even when the other source succeeds', async () => {
  const { status } = await sample({ right: (request, actual) => request.method === 'eth_getLogs'
    ? new Response('{"jsonrpc":"2.0","id":', { headers: { 'content-length': '200' } }) : actual });
  assertUnresolved(status);
  assert.equal(status.reason, 'rpc_truncated_response');
  assert.equal(status.observation, null);
});

test('missing middle block and RPC pruned history pin the original plan without accepting the range', async () => {
  const gap: Result = ({ method, params }, actual) => method === 'eth_getBlockByNumber' && params[0] === '0x66' ? null : actual;
  const { status, left } = await sample({ right: gap });
  assertUnresolved(status);
  assert.equal(status.reason, 'header_unavailable');
  assert.equal(status.plan?.fromBlock, 101);
  assert.equal(status.observation, null);
  assert.ok(left.calls.every(({ method }) => method !== 'eth_getLogs'));

  const pruned: Result = ({ id, method, params }, actual) => method === 'eth_getBlockByNumber' && params[0] === '0x66'
    ? Response.json({ jsonrpc: '2.0', id, error: { code: 4444, message: 'unavailable history' } }) : actual;
  assert.equal((await sample({ right: pruned })).status.reason, 'rpc_pruned_history');
});

test('rejects stale tags, provider header disagreement and broken canonical linkage', async () => {
  const stale: Result = ({ params }, actual) => params[0] === 'finalized'
    ? { ...block(103), timestamp: quantity(NOW - 3_601) } : actual;
  assert.equal((await sample({ right: stale })).status.reason, 'stale_finalized_tag');
  const wrongParent: Result = ({ params }, actual) => params[0] === '0x66'
    ? { ...block(102), parentHash: hash(999) } : actual;
  assert.equal((await sample({ right: wrongParent })).status.reason, 'header_provider_disagreement');
  assert.equal((await sample({ left: wrongParent, right: wrongParent })).status.reason, 'broken_block_link');
});

test('rechecks finality and rejects a regressed or replaced finalized block before commit', async () => {
  for (const [second, reason] of [[block(102), 'finality_regression'],
    [{ ...block(103), hash: hash(300) }, 'finalized_block_replaced'],
    [{ ...block(104), parentHash: hash(300) }, 'broken_finalized_link']] as const) {
    function changing(): Result {
      let tags = 0;
      return ({ params }, actual) => params[0] === 'finalized' && ++tags > 1 ? second : actual;
    }
    const { status } = await sample({ left: changing(), right: changing() });
    assertUnresolved(status);
    assert.equal(status.reason, reason);
    assert.equal(status.observation, null);
  }
});

test('rejects replacement of the numbered anchor even when the finalized tags remain unchanged', async () => {
  function changing(): Result {
    let checks = 0;
    return ({ params }, actual) => params[0] === '0x67' && ++checks > 1 ? { ...block(103), hash: hash(300) } : actual;
  }
  const { status } = await sample({ left: changing(), right: changing() });
  assertUnresolved(status);
  assert.equal(status.reason, 'numbered_finalized_anchor_disagreement');
  assert.equal(status.observation, null);
});

test('a committed sample returns the same snapshot after reopen without spending further RPC work', async () => {
  let store = LiveStore.create();
  const { database } = store;
  try {
    store.start(ID, SOURCES, LIVE_OBSERVATION_LIMITS.durableWorkLimit);
    const first = await observe(store);
    assert.equal(first.reason, 'receipt_inclusion_only');
    store.close();
    store = LiveStore.open(database);
    const left = mockRpc(SOURCES[0]);
    const right = mockRpc(SOURCES[1]);
    assert.deepEqual(await observe(store, left, right), first);
    assert.equal(left.calls.length + right.calls.length, 0);
  } finally {
    store.close();
    LiveStore.dispose(database);
  }
});

test('replay checks the same pinned heights and spends fresh work; exhaustion makes no extra reads', async () => {
  const store = LiveStore.create();
  try {
    store.start(ID, SOURCES, 13);
    const missing: Result = ({ params }, actual) => params[0] === '0x66' ? null : actual;
    const first = await observe(store, mockRpc(SOURCES[0]), mockRpc(SOURCES[1], missing));
    assert.equal(first.work.used, 12);
    assert.equal(first.plan?.toBlock, 103);
    const left = mockRpc(SOURCES[0]);
    const right = mockRpc(SOURCES[1]);
    const replay = await observe(store, left, right);
    assertUnresolved(replay);
    assert.equal(replay.reason, 'work_budget_exhausted');
    assert.equal(replay.work.used, 13);
    assert.deepEqual(replay.plan, first.plan);
    assert.equal(left.calls.length + right.calls.length, 1);
    await observe(store, left, right);
    assert.equal(left.calls.length + right.calls.length, 1);
  } finally {
    store.close();
    LiveStore.dispose(store.database);
  }
});
