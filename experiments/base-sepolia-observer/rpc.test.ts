import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAIN_ID, TRANSFER, USDC } from './evidence.ts';
import { BaseSepoliaRpc, RpcReadError } from './rpc.ts';
import type { RpcLimits } from './rpc.ts';

const endpoint = 'https://rpc.example.invalid/';
const limits: RpcLimits = {
  maxRequests: 8, maxElapsedMs: 2_000, requestTimeoutMs: 1_000,
  maxResponseBytes: 10_000, maxTotalResponseBytes: 20_000, maxRangeBlocks: 3,
};
const chainQuantity = `0x${CHAIN_ID.toString(16)}`;
const hash = `0x${'aa'.repeat(32)}`;
const parentHash = `0x${'bb'.repeat(32)}`;
const transactionHash = `0x${'cc'.repeat(32)}`;
const parties = [`0x${'0'.repeat(24)}${'11'.repeat(20)}`, `0x${'0'.repeat(24)}${'22'.repeat(20)}`];
const rawLog = {
  address: USDC, topics: [TRANSFER, ...parties], data: `0x${'0'.repeat(63)}1`,
  blockNumber: '0x2', blockHash: hash, transactionHash, transactionIndex: '0x0',
  logIndex: '0x200', removed: false,
};

interface RequestBody { jsonrpc: string; id: number; method: string; params: unknown[] }

function requestBody(init: RequestInit | undefined): RequestBody {
  assert.equal(typeof init?.body, 'string');
  return JSON.parse(init?.body as string) as RequestBody;
}

function resultBody(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function fromResults(results: readonly unknown[], overrides: Partial<RpcLimits> = {}): BaseSepoliaRpc {
  return new BaseSepoliaRpc('fixture', endpoint, { ...limits, ...overrides }, async (_url, init) => {
    const { id } = requestBody(init);
    assert.ok(id <= results.length);
    return new Response(resultBody(id, results[id - 1]));
  });
}

function reason(reason: string) {
  return (error: unknown) => error instanceof RpcReadError && error.reason === reason;
}

test('sends only the intended Base Sepolia reads and measures the encoded bodies', async () => {
  const bodies: RequestBody[] = [];
  const block = { number: '0x2', hash, parentHash, timestamp: '0x123', transactions: [transactionHash] };
  const results = [chainQuantity, block, [rawLog]];
  const rpc = new BaseSepoliaRpc('fixture', endpoint, limits, async (url, init) => {
    assert.equal(String(url), endpoint);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const body = requestBody(init);
    bodies.push(body);
    return new Response(resultBody(body.id, results[body.id - 1]));
  });
  assert.equal(await rpc.chainId(), CHAIN_ID);
  assert.deepEqual(await rpc.header('finalized'), {
    height: 2, hash, parentHash, timestamp: 291, transactions: [transactionHash],
  });
  const [log] = await rpc.logs(1, 3, { address: USDC, topics: [TRANSFER, ...parties] });
  assert.equal(log.logIndex, 512);
  assert.deepEqual(bodies.map(({ method, params }) => [method, params]), [
    ['eth_chainId', []],
    ['eth_getBlockByNumber', ['finalized', false]],
    ['eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x3', address: USDC, topics: [TRANSFER, ...parties] }]],
  ]);
  for (const [index, measurement] of rpc.metrics().entries()) {
    assert.equal(measurement.requestBytes, Buffer.byteLength(JSON.stringify(bodies[index])));
    assert.equal(measurement.responseBytes, Buffer.byteLength(resultBody(index + 1, results[index])));
    assert.equal(measurement.outcome, 'ok');
    assert.ok(measurement.durationMs >= 0);
  }
});

test('blocks non-Base chains, out-of-bounds ranges and non-USDC filters before sending a read', async () => {
  const wrongChain = fromResults(['0x1']);
  assert.equal(await wrongChain.chainId(), 1);
  await assert.rejects(wrongChain.header('finalized'), reason('base_sepolia_not_verified'));
  assert.equal(wrongChain.metrics().length, 1);

  const rpc = fromResults([chainQuantity]);
  await rpc.chainId();
  await assert.rejects(rpc.logs(1, 4), reason('log_range_limit'));
  await assert.rejects(rpc.logs(1, 1, { address: `0x${'01'.repeat(20)}`, topics: [TRANSFER] }),
    reason('invalid_usdc_filter'));
  assert.equal(rpc.metrics().length, 1);
});

test('rejects wrong numbered headers, malformed transfers and logs outside the requested range', async () => {
  const wrongHeader = { number: '0x3', hash, parentHash, timestamp: '0x123', transactions: [transactionHash] };
  const rpc = fromResults([chainQuantity, wrongHeader, [{ ...rawLog, blockNumber: '0x2\n' }], [rawLog]]);
  await rpc.chainId();
  await assert.rejects(rpc.header(2), reason('wrong_header_height'));
  await assert.rejects(rpc.logs(1, 3), reason('invalid_log'));
  await assert.rejects(rpc.logs(1, 1), reason('unexpected_transfer_log'));
});

test('records truncation and safe RPC error codes without exposing response content', async () => {
  const rpc = new BaseSepoliaRpc('fixture', endpoint, limits, async (_url, init) => {
    const { id } = requestBody(init);
    if (id === 1) return new Response(resultBody(id, chainQuantity));
    if (id === 2) {
      const body = resultBody(id, []);
      return new Response(body, { headers: { 'content-length': String(body.length + 1) } });
    }
    if (id === 3) return new Response(resultBody(id, []).slice(0, -1));
    if (id === 4) return new Response(resultBody(id + 1, []));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'untrusted text' } }));
  });
  await rpc.chainId();
  await assert.rejects(rpc.logs(1, 1), reason('rpc_truncated_response'));
  await assert.rejects(rpc.logs(1, 1), reason('rpc_invalid_json'));
  await assert.rejects(rpc.logs(1, 1), reason('rpc_invalid_envelope'));
  await assert.rejects(rpc.logs(1, 1), reason('rpc_remote_error'));
  assert.equal(rpc.metrics().at(-1)?.rpcCode, -32601);
  assert.doesNotMatch(JSON.stringify(rpc.metrics()), /untrusted text/);
});

test('request and decoded response budgets include failed calls and prevent further reads', async () => {
  const maxRequests = fromResults([chainQuantity, null], { maxRequests: 2 });
  await maxRequests.chainId();
  await assert.rejects(maxRequests.header('finalized'), reason('header_unavailable'));
  await assert.rejects(maxRequests.header('finalized'), reason('rpc_request_budget'));
  assert.equal(maxRequests.metrics().length, 2);

  const maxResponseBytes = 100;
  const maxTotalResponseBytes = Buffer.byteLength(resultBody(1, chainQuantity)) + maxResponseBytes + 10;
  const oversized = ' '.repeat(1_000);
  const maxBytes = fromResults([chainQuantity, oversized, oversized], { maxResponseBytes, maxTotalResponseBytes });
  await maxBytes.chainId();
  await assert.rejects(maxBytes.logs(1, 1), reason('rpc_response_byte_limit'));
  assert.equal(maxBytes.metrics().at(-1)?.responseBytes, maxResponseBytes);
  await assert.rejects(maxBytes.logs(1, 1), reason('rpc_response_byte_limit'));
  assert.equal(maxBytes.metrics().at(-1)?.responseBytes, 10);
  await assert.rejects(maxBytes.logs(1, 1), reason('rpc_total_byte_budget'));
  assert.equal(maxBytes.metrics().reduce((sum, measurement) => sum + measurement.responseBytes, 0),
    maxTotalResponseBytes);
});

test('aborts a stalled body and retains the failed attempt in the metrics', { timeout: 2_000 }, async () => {
  const rpc = new BaseSepoliaRpc('fixture', endpoint, { ...limits, requestTimeoutMs: 100 }, async (_url, init) => {
    const { id } = requestBody(init);
    if (id === 1) return new Response(resultBody(id, chainQuantity));
    const body = new ReadableStream<Uint8Array>({
      type: 'bytes',
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
      },
    });
    return new Response(body);
  });
  // AbortSignal.timeout uses an unref'ed timer. Keep the fake network read alive for this test.
  const keepAlive = setTimeout(() => {}, 2_000);
  try {
    await rpc.chainId();
    await assert.rejects(rpc.logs(1, 1), reason('rpc_timeout'));
    assert.equal(rpc.metrics().at(-1)?.outcome, 'rpc_timeout');
  } finally {
    clearTimeout(keepAlive);
  }
});
