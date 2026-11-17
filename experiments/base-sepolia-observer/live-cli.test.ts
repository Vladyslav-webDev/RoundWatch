import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { USDC } from './evidence.ts';

const CLI = fileURLToPath(new URL('./live.ts', import.meta.url));
const TOKEN = USDC;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SENDER = 'ab'.repeat(20);
const RECIPIENT = 'cd'.repeat(20);
const TRANSACTION_HASH = `0x${'ef'.repeat(32)}`;
const MOCK_FETCH = `data:text/javascript,${encodeURIComponent(`
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (!['https://sepolia.base.org/', 'https://base-sepolia-rpc.publicnode.com/'].includes(url.href) ||
        options.method !== 'POST' || options.redirect !== 'error' || body.method !== 'eth_chainId' ||
        body.jsonrpc !== '2.0' || body.id !== 1 || JSON.stringify(body.params) !== '[]') {
      throw new Error('unexpected mock request');
    }
    return new Response('simulated untrusted provider details', { status: 429 });
  };
`)}`;
const MOCK_FINALIZED_FETCH = `data:text/javascript,${encodeURIComponent(`
  const height = 110;
  const eventHeight = 109;
  const timestamp = Math.floor(Date.now() / 1000) - 60;
  const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
  const quantity = (n) => '0x' + n.toString(16);
  const token = '${TOKEN}';
  const transfer = '${TRANSFER_TOPIC}';
  const log = {
    address: token,
    topics: [transfer, '0x' + '0'.repeat(24) + '${SENDER}', '0x' + '0'.repeat(24) + '${RECIPIENT}'],
    data: hash(10),
    blockNumber: quantity(eventHeight),
    blockHash: hash(eventHeight),
    transactionHash: '${TRANSACTION_HASH}',
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
  };
  globalThis.fetch = async (url, { body, method, redirect }) => {
    if (!['https://sepolia.base.org/', 'https://base-sepolia-rpc.publicnode.com/'].includes(url.href) ||
        method !== 'POST' || redirect !== 'error') throw new Error('unexpected mock endpoint or options');
    const request = JSON.parse(body);
    let result;
    switch (request.method) {
      case 'eth_chainId':
        result = '0x14a34';
        break;
      case 'eth_getBlockByNumber': {
        const [reference, full] = request.params;
        const number = reference === 'finalized' ? height : Number(reference);
        if (!(number >= height - 3 && number <= height) || full !== false) throw new Error('unexpected mock block');
        result = {
          number: quantity(number), hash: hash(number), parentHash: hash(number - 1),
          timestamp: quantity(timestamp + (number - height) * 2),
          transactions: number === eventHeight ? ['${TRANSACTION_HASH}'] : [],
        };
        break;
      }
      case 'eth_getLogs': {
        const [{ address, topics, fromBlock, toBlock }] = request.params;
        const from = Number(fromBlock);
        const to = Number(toBlock);
        if (!(from >= height - 2 && from <= to && to <= height) || address !== token ||
            JSON.stringify(topics) !== JSON.stringify([transfer])) throw new Error('unexpected mock log query');
        result = eventHeight >= from && eventHeight <= to ? [log] : [];
        break;
      }
      case 'eth_getTransactionReceipt':
        if (request.params[0] !== '${TRANSACTION_HASH}') throw new Error('unexpected mock receipt query');
        result = { blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash,
          transactionIndex: log.transactionIndex, status: '0x1', logs: [log] };
        break;
      default:
        throw new Error('unexpected mock method');
    }
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  };
`)}`;

test('the finite CLI rejects arbitrary endpoint and database arguments before making requests', () => {
  const fetchIsForbidden = 'data:text/javascript,globalThis.fetch%20%3D%20()%20%3D%3E%20process.exit(99)';
  for (const args of [['https://example.invalid'], ['publicnode', 'external.sqlite']]) {
    const child = spawnSync(process.execPath, ['--import', fetchIsForbidden, CLI, ...args], {
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(child.status, 2, child.stderr);
    assert.match(child.stderr, /Usage: /);
    assert.equal(child.stdout, '');
  }
});

test('the CLI persists and reopens an unresolved rate limit and disposes its private database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'roundwatch-cp2b-cli-test-'));
  try {
    const child = spawnSync(process.execPath, ['--import', MOCK_FETCH, CLI], {
      encoding: 'utf8', timeout: 10_000, env: { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory },
    });
    assert.equal(child.status, 1, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.sqliteReopenVerified, true);
    assert.equal(result.durable.outcome, 'unresolved');
    assert.equal(result.durable.reason, 'rpc_rate_limited');
    assert.deepEqual(result.durable.diagnostic, { source: 'base', stage: 'chain_id' });
    assert.equal(result.durable.verifiedCoverageCursor, null);
    assert.equal(result.durable.evidence.providerAgreement, false);
    assert.equal(result.durable.evidence.completeFinalizedHistoricalCoverage, false);
    assert.equal(result.durable.evidence.businessInvoiceAttribution, false);
    assert.equal(result.totals.requestCount, 2);
    assert.equal(result.totals.responseBytes, 0);
    for (const provider of result.providers) {
      assert.equal(provider.requests.length, 1);
      assert.equal(provider.requests[0].method, 'eth_chainId');
      assert.equal(provider.requests[0].httpStatus, 429);
    }
    assert.equal(child.stdout.includes(JSON.stringify(directory).slice(1, -1)), false);
    assert.doesNotMatch(child.stdout, /simulated untrusted provider details/);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmdirSync(directory);
  }
});

test('the CLI reports a durable receipt-confirmed sample without redacted fields or a terminal result', () => {
  const child = spawnSync(process.execPath, ['--import', MOCK_FINALIZED_FETCH, CLI], {
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  const result = JSON.parse(child.stdout);
  assert.equal(result.sqliteReopenVerified, true);
  assert.equal(result.durable.outcome, 'unresolved');
  assert.deepEqual(result.durable.range, { fromBlock: 108, toBlock: 110 });
  assert.equal(result.durable.verifiedCoverageCursor, null);
  assert.equal(result.durable.evidence.providerAgreement, true);
  assert.equal(result.durable.evidence.receiptConfirmedOccurrences, 1);
  assert.equal(result.durable.evidence.completeFinalizedHistoricalCoverage, false);
  assert.equal(result.durable.evidence.businessInvoiceAttribution, false);
  assert.equal(result.durable.observation.sources.length, 2);
  for (const provider of result.providers) {
    assert.equal(provider.byMethod.eth_getTransactionReceipt.requestCount, 1);
  }
  for (const redacted of [SENDER, RECIPIENT, TRANSACTION_HASH]) assert.equal(child.stdout.includes(redacted), false);
});
