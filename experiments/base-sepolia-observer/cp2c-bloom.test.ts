import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { bloomForLogs, keccak256, transferBloomResult } from './cp2c-bloom.ts';
import { filterFor, inFilter, TRANSFER, USDC, type Log } from './evidence.ts';

const watch = { token: USDC, sender: `0x${'11'.repeat(20)}`, recipient: `0x${'22'.repeat(20)}` };
const filter = filterFor(watch);
const transfer: Log = {
  ...filter,
  data: `0x${'0'.repeat(63)}1`,
  blockHash: `0x${'55'.repeat(32)}`,
  blockNumber: 1,
  transactionHash: `0x${'77'.repeat(32)}`,
  transactionIndex: 0,
  logIndex: 0,
  removed: false,
};

// Fixed positions for this tuple in the order address, Transfer signature, from, to.
// Encode the fixture as a big-endian integer, independently of the production byte indexing.
const requiredBits = [[2010, 149, 1283], [1443, 481, 1060], [762, 1041, 765], [1565, 1651, 107]];

function fixtureBloom(bits: readonly number[]): string {
  const word = bits.reduce((bloom, bit) => bloom | (1n << BigInt(bit)), 0n);
  return `0x${word.toString(16).padStart(512, '0')}`;
}

test('legacy Keccak-256 derives the ERC-20 event signature', () => {
  const signature = Buffer.from('Transfer(address,address,uint256)');
  assert.equal(`0x${keccak256(signature).toString('hex')}`, TRANSFER);
  assert.notEqual(`0x${createHash('sha3-256').update(signature).digest('hex')}`, TRANSFER);
});

test('go-ethereum reference fixture pins bloom generation and Keccak digest', () => {
  // BenchmarkCreateBloom, https://github.com/ethereum/go-ethereum/blob/master/core/types/bloom9_test.go
  const logs = ['11', '0111', '22', '0222'].map((address) => ({
    address: `0x${address.padStart(40, '0')}`,
    topics: [],
  }));
  assert.equal(keccak256(bloomForLogs(logs)).toString('hex'),
    'c384c56ece49458a427c67b90fefe979ebf7104795be65dc398b280f24104949');
});

test('a negative result for any necessary address or indexed topic excludes the transfer', () => {
  assert.equal(transferBloomResult(fixtureBloom([]), watch), 'EXCLUDED');
  for (const omitted of requiredBits) {
    const bloom = fixtureBloom(requiredBits.filter((group) => group !== omitted).flat());
    assert.equal(transferBloomResult(bloom, watch), 'EXCLUDED');
  }
});

test('a positive bloom can come from logs that never match the transfer filter', () => {
  const [signature, from, to] = transfer.topics;
  assert.ok(inFilter(transfer, filter));
  const otherLogs = [
    { ...transfer, topics: [signature, to, from] },
    { ...transfer, address: `0x${'33'.repeat(20)}`, logIndex: 1 },
  ];
  assert.ok(otherLogs.every((log) => !inFilter(log, filter)));
  const bloom = `0x${bloomForLogs(otherLogs).toString('hex')}`;
  assert.equal(transferBloomResult(bloom, watch), 'POSSIBLE');
});

test('the transfer fixture distinguishes Ethereum ordering from reversed bytes, reversed bits and SHA3', () => {
  const bits = requiredBits.flat();
  const bloom = fixtureBloom(bits);
  assert.equal(`0x${bloomForLogs([transfer]).toString('hex')}`, bloom);
  assert.equal(transferBloomResult(bloom, watch), 'POSSIBLE');

  const wrongByteOrder = bits.map((bit) => (255 - (bit >> 3)) * 8 + (bit & 7));
  const wrongBitOrder = bits.map((bit) => (bit & ~7) + (7 - (bit & 7)));
  const sha3Bits = [1523, 1136, 1541, 1009, 1893, 1230, 1967, 346, 95, 1112, 947, 1001];
  for (const wrongBits of [wrongByteOrder, wrongBitOrder, sha3Bits]) {
    assert.equal(transferBloomResult(fixtureBloom(wrongBits), watch), 'EXCLUDED');
  }
});

test('malformed bloom and watch elements produce no membership result', () => {
  assert.throws(() => transferBloomResult('0x00', watch), /invalid_logs_bloom/);
  assert.throws(() => transferBloomResult(`0xgg${'00'.repeat(255)}`, watch), /invalid_logs_bloom/);
  assert.throws(() => transferBloomResult(fixtureBloom([]), { ...watch, token: '0x01' }), /invalid_bloom_address/);
  assert.throws(() => transferBloomResult(fixtureBloom([]), { ...watch, sender: '0x11' }), /invalid_bloom_sender/);
  assert.throws(() => transferBloomResult(fixtureBloom([]), { ...watch, recipient: '0x22' }), /invalid_bloom_recipient/);
});
