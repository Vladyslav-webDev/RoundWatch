import assert from 'node:assert/strict';
import test from 'node:test';
import { probeReceiptCapabilities } from './cp2c-probe.ts';
import { receiptFixture } from './cp2c-receipt-fixtures.ts';
import { BASE_RPC_ENDPOINT, SECONDARY_RPC_ENDPOINTS } from './rpc.ts';

const START = new Date('2026-11-17T09:30:00Z');
const HEIGHT = '0x3926198';
const HASH = `0x${'ab'.repeat(32)}`;
const PARENT = `0x${'cd'.repeat(32)}`;
const ROOT = `0x${'ef'.repeat(32)}`;
const BLOOM = `0x${'00'.repeat(256)}`;

interface Request {
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

function fixture(
  count: number,
  override: (operator: 'base' | 'publicnode', request: Request) => Response | undefined = () => undefined,
) {
  const transactions = Array.from({ length: count }, (_, index) => `0x${(index + 1).toString(16).padStart(64, '0')}`);
  const block = {
    number: HEIGHT, hash: HASH, parentHash: PARENT,
    timestamp: `0x${(START.getTime() / 1000 - 1_200).toString(16)}`,
    receiptsRoot: ROOT, logsBloom: BLOOM, transactions,
  };
  const receipts = transactions.map((hash, index) => ({
    blockHash: HASH, blockNumber: HEIGHT, transactionHash: hash, transactionIndex: `0x${index.toString(16)}`,
    type: index === 0 ? '0x7e' : '0x2', cumulativeGasUsed: '0x5208', status: '0x1', logsBloom: BLOOM, logs: [],
    ...(index === 0 && { depositNonce: '0x0', depositReceiptVersion: '0x1' }),
  }));
  const fetcher: typeof fetch = async (url, init) => {
    const endpoint = String(url).replace(/\/$/, '');
    assert.ok(endpoint === BASE_RPC_ENDPOINT.endpoint || endpoint === SECONDARY_RPC_ENDPOINTS.publicnode.endpoint);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const request = JSON.parse(String(init?.body)) as Request;
    const operator = endpoint === BASE_RPC_ENDPOINT.endpoint ? 'base' : 'publicnode';
    const replacement = override(operator, request);
    if (replacement) return replacement;
    switch (request.method) {
      case 'eth_chainId':
        assert.deepEqual(request.params, []);
        return result(request.id, '0x14a34');
      case 'eth_getBlockByNumber':
        assert.equal(request.params[0], request.id === 2 ? 'finalized' : HEIGHT);
        assert.equal(request.params[1], false);
        return result(request.id, block);
      case 'eth_getBlockReceipts':
        assert.deepEqual(request.params, [HEIGHT]);
        return operator === 'base' ? new Response('untrusted detail', { status: 403 }) :
          result(request.id, receipts);
      case 'eth_getTransactionReceipt':
        assert.deepEqual(request.params, [transactions[request.id - 5]]);
        return result(request.id, receipts.find(({ transactionHash }) => transactionHash === request.params[0]));
      default:
        throw new Error(`Unexpected method ${request.method}`);
    }
  };
  return { block, receipts, fetcher };
}

function result(id: number, value: unknown) {
  return Response.json({ jsonrpc: '2.0', id, result: value });
}

function rpcError(id: number, code: number) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message: 'untrusted detail' } });
}

test('records one numbered commitment, exact requests and bounded fallback for HTTP 403', async () => {
  const { fetcher, receipts } = fixture(2);
  const report = await probeReceiptCapabilities('publicnode', fetcher, START);
  assert.equal(report.status, 'CAPABILITY_SAMPLE');
  assert.equal(report.evidence.headerAgreement, 'PROVIDER_CORROBORATED');
  assert.equal(report.evidence.authenticatedFinality, false);
  assert.equal(report.evidence.verifiedCoverage, 'BLOCKED');
  assert.equal(report.evidence.receiptsRootRecomputed, true);
  assert.equal(report.evidence.providerReportedRootMatched, false);
  assert.equal(report.sample?.receiptsRoot, ROOT);
  assert.equal(report.totals.requests, 10);

  const [base, publicnode] = report.providers;
  assert.deepEqual(base.requests.map(({ method, params, httpStatus }) => [method, params, httpStatus]), [
    ['eth_chainId', [], 200],
    ['eth_getBlockByNumber', ['finalized', false], 200],
    ['eth_getBlockByNumber', [HEIGHT, false], 200],
    ['eth_getBlockReceipts', [HEIGHT], 403],
    ['eth_getTransactionReceipt', [receipts[0].transactionHash], 200],
    ['eth_getTransactionReceipt', [receipts[1].transactionHash], 200],
  ]);
  assert.deepEqual(base.receiptCapabilities, {
    batchFailure: 'rpc_http_status',
    fallback: {
      orderedSet: {
        receiptCount: 2, types: { '0x7e': 1, '0x2': 1 }, withDepositNonce: 1, withDepositReceiptVersion: 1,
        reportedRoot: { matched: false, recomputed: true, reason: 'receipt_root_mismatch' },
      },
    },
  });
  assert.equal(publicnode.requests.length, 4);
  assert.deepEqual(publicnode.receiptCapabilities?.batch, base.receiptCapabilities?.fallback.orderedSet);
  assert.equal(report.totals.decodedResponseBytes, base.totals.decodedResponseBytes + publicnode.totals.decodedResponseBytes);
  assert.ok(base.requests.at(-1)!.responseBytes > 0);
  assert.doesNotMatch(JSON.stringify(report), /untrusted detail/);
});

test('records method unsupported and skips fallback above the transaction cap', async () => {
  const { fetcher } = fixture(9, (_operator, request) =>
    request.method === 'eth_getBlockReceipts' ? rpcError(request.id, -32601) : undefined);
  const report = await probeReceiptCapabilities('publicnode', fetcher, START);
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.failure, 'ordered_receipt_set_unavailable');
  assert.equal(report.totals.requests, 8);
  for (const { requests, receiptCapabilities } of report.providers) {
    assert.equal(requests.at(-1)?.rpcCode, -32601);
    assert.deepEqual(receiptCapabilities?.fallback, { reason: 'transaction_limit' });
  }
});

test('rejects common false-empty batch and incomplete transaction fallback', async () => {
  const { fetcher } = fixture(2, (_operator, request) => {
    if (request.method === 'eth_getBlockReceipts') return result(request.id, []);
    if (request.method === 'eth_getTransactionReceipt' && request.id === 6) return result(request.id, null);
  });
  const report = await probeReceiptCapabilities('publicnode', fetcher, START);
  assert.equal(report.status, 'BLOCKED');
  for (const { receiptCapabilities } of report.providers) {
    assert.deepEqual(receiptCapabilities, {
      batchFailure: 'receipt_count_disagreement',
      fallback: { reason: 'receipt_unavailable', receiptsBeforeFailure: 1 },
    });
  }
});

test('does not request receipts when same-height commitment or chain gates conflict', async () => {
  const { block } = fixture(1);
  const conflicting = fixture(1, (operator, request) => {
    if (operator === 'base' && request.method === 'eth_getBlockByNumber' && request.id === 3) {
      return result(request.id, { ...block, receiptsRoot: HASH });
    }
  });
  const conflict = await probeReceiptCapabilities('publicnode', conflicting.fetcher, START);
  assert.equal(conflict.failure, 'header_disagreement');
  assert.equal(conflict.totals.requests, 6);
  assert.equal(conflict.sample, undefined);

  const wrongChain = fixture(1, (_operator, request) => {
    if (request.method === 'eth_chainId') return result(request.id, '0x1');
  });
  const chainReport = await probeReceiptCapabilities('publicnode', wrongChain.fetcher, START);
  assert.equal(chainReport.failure, 'finalized_tag_unavailable');
  assert.equal(chainReport.totals.requests, 2);
  assert.deepEqual(chainReport.providers.map(({ finalizedTag }) => finalizedTag), [
    { reason: 'wrong_chain' }, { reason: 'wrong_chain' },
  ]);
});

test('rejects stale finalized tags and unknown endpoints before numbered or receipt reads', async () => {
  const { fetcher } = fixture(1);
  const stale = await probeReceiptCapabilities('publicnode', fetcher, new Date(START.getTime() + 4_000_000));
  assert.equal(stale.failure, 'finalized_tag_unavailable');
  assert.equal(stale.totals.requests, 4);
  assert.deepEqual(stale.providers.map(({ finalizedTag }) => finalizedTag), [
    { reason: 'finalized_tag_outside_recent_window' }, { reason: 'finalized_tag_outside_recent_window' },
  ]);
  await assert.rejects(probeReceiptCapabilities('invalid' as never, () => assert.fail('unexpected fetch'), START),
    { message: 'invalid_secondary' });
});

test('samples only the immediate predecessor with linked tags and compares the reported root', async () => {
  const { height, timestamp: _fixtureTime, ...header } = receiptFixture.block;
  const sample = {
    ...header,
    number: `0x${height.toString(16)}`,
    timestamp: `0x${(START.getTime() / 1000 - 1_200).toString(16)}`,
  };
  const tag = {
    ...sample, number: `0x${(height + 1).toString(16)}`, parentHash: sample.hash, hash: HASH,
  };
  const makeFixture = (parentHash: string) => fixture(0, (_operator, request) => {
    if (request.method === 'eth_getBlockByNumber') {
      return request.params[0] === 'finalized' ? result(request.id, { ...tag, parentHash }) :
        result(request.id, sample);
    }
    if (request.method === 'eth_getBlockReceipts') return result(request.id, receiptFixture.receipts);
  });

  const report = await probeReceiptCapabilities('publicnode', makeFixture(sample.hash).fetcher, START, 'predecessor');
  assert.equal(report.status, 'CAPABILITY_SAMPLE');
  assert.equal(report.sampleMode, 'predecessor');
  assert.equal(report.sample?.height, height);
  assert.equal(report.evidence.providerReportedRootMatched, true);
  assert.equal(report.evidence.verifiedCoverage, 'BLOCKED');
  for (const { requests, receiptCapabilities } of report.providers) {
    assert.deepEqual(requests.map(({ params }) => params), [[], ['finalized', false], [sample.number, false],
      [sample.number]]);
    assert.deepEqual(receiptCapabilities?.batch?.reportedRoot, { matched: true, recomputed: true });
  }

  const badParent = await probeReceiptCapabilities('publicnode', makeFixture(PARENT).fetcher, START, 'predecessor');
  assert.equal(badParent.failure, 'header_disagreement');
  assert.equal(badParent.totals.requests, 6);
  assert.equal(badParent.evidence.providerReportedRootMatched, false);
});
