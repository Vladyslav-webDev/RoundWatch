import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_LOGS_BLOOM, EMPTY_RECEIPTS_ROOT, receiptFixture } from './cp2c-receipt-fixtures.ts';
import { receiptTrieRoot, verifyReceiptRoot } from './cp2c-receipts.ts';
import { hash, transfer } from './fixtures.ts';

const { block, receipts } = receiptFixture;

test('reproduces an independent mixed legacy, EIP-1559 and Canyon deposit receipts root', () => {
  const verified = verifyReceiptRoot(block, receipts, 'canyon-v1');
  assert.deepEqual(verified.map((receipt) => receipt.status), [0, 1, 1]);
  assert.deepEqual(verified.map((receipt) => receipt.transactionHash), block.transactions);
  assert.deepEqual(verified[1].logs, [{
    ...transfer(), blockNumber: block.height, blockHash: block.hash, transactionHash: block.transactions[1],
    transactionIndex: 1, logIndex: 0, removed: false,
  }]);
});

test('reproduces independent empty and single-receipt roots', () => {
  assert.deepEqual(verifyReceiptRoot({ ...block, transactions: [], receiptsRoot: EMPTY_RECEIPTS_ROOT }, []), []);
  const single = { ...block, transactions: [block.transactions[0]],
    receiptsRoot: '0xef168ffb749ab66bc9cb8b45df3d161af58309818bf1df62981b8b08e27a2cc8' };
  assert.equal(verifyReceiptRoot(single, [{ ...receipts[0], type: '0x4', status: '0x1' }]).length, 1);
});

test('reproduces a type-1 block root across the first nibble boundary', () => {
  // Independent ethers fixture. Nibbles 1 and 8 select leaves for indices 16
  // and 0, while nibble 0 selects the branch for indices 1 through 15.
  const transactions = Array.from({ length: 17 }, (_, i) => hash(i + 1));
  const accessListBlock = { ...block, transactions,
    receiptsRoot: '0x20cef43af0ea116d87c74df00930ed92fabe56a2c502e6952dc2102ac8337337' };
  const accessListReceipts = transactions.map((transactionHash, index) => ({
    ...receipts[0], transactionHash, transactionIndex: `0x${index.toString(16)}`,
    type: '0x1', status: '0x1', cumulativeGasUsed: `0x${((index + 1) * 21000).toString(16)}`,
  }));
  assert.equal(verifyReceiptRoot(accessListBlock, accessListReceipts).length, 17);
});

test('reproduces the trie using extension nodes once receipt indices require multi-byte RLP', () => {
  // Independent ethers fixture. The encoded keys 0x8180 and 0x8181 share
  // prefix 8,1,8. Root branch child 8 contains split 0 (index 0) and 1
  // (extension 0x18 leading to the branch for indices 128 and 129).
  const emptyReceipt = Buffer.from(`02f9010801825208b90100${'00'.repeat(256)}c0`, 'hex');
  const values = Array<Buffer>(130).fill(emptyReceipt);
  assert.equal(receiptTrieRoot(values), '0xfa25ac62458663dd134b1b55b18a0738c5ed7f53c70802580b0010ca4afbf130');
});

test('matches the singleton root derived from a Base client Canyon encoding vector', () => {
  // Base v1.5.5 post_canyon_receipt_roundtrip provides exact payload bytes.
  // https://github.com/base/base/blob/v1.5.5/crates/common/consensus/src/receipts/deposit.rs#L483-L506
  // The expected root is ethers keccak256(encodeRlp(["0x2080", typeByte + payload])).
  const depositBlock = { ...block, transactions: [block.transactions[0]],
    receiptsRoot: '0xad2f5caa3cb54a9c22797bc73f64c524fcd6c7756eea20a4d24db410fe49a3ce' };
  const deposit = { ...receipts[0], type: '0x7e', status: '0x1', cumulativeGasUsed: '0xb741',
    depositNonce: '0x3d3bbf', depositReceiptVersion: '0x1' };
  assert.equal(verifyReceiptRoot(depositBlock, [deposit], 'canyon-v1').length, 1);
});

test('rejects missing, unordered and duplicate receipt positions', () => {
  assert.throws(() => verifyReceiptRoot(block, null, 'canyon-v1'), /incomplete_receipts/);
  assert.throws(() => verifyReceiptRoot(block, receipts.slice(1), 'canyon-v1'), /incomplete_receipts/);
  assert.throws(() => verifyReceiptRoot(block, [receipts[0], receipts[2], receipts[1]], 'canyon-v1'),
    /consensus_receipt_position_disagreement/);
  assert.throws(() => verifyReceiptRoot(block, [receipts[0], receipts[1], receipts[1]], 'canyon-v1'),
    /consensus_receipt_position_disagreement/);
});

test('rejects a provider omitting transactions and the corresponding receipts', () => {
  const truncated = { ...block, transactions: block.transactions.slice(0, 1) };
  assert.throws(() => verifyReceiptRoot(truncated, receipts.slice(0, 1), 'canyon-v1'), /receipt_root_mismatch/);
  assert.throws(() => verifyReceiptRoot({ ...block, transactions: [] }, [], 'canyon-v1'), /receipt_root_mismatch/);
});

test('rejects a corrupted event, cumulative gas or receipt commitment', () => {
  const event = receipts[1].logs[0];
  const edited = { ...receipts[1], logs: [{ ...event, data: `0x${'00'.repeat(32)}` }] };
  const falseEmpty = { ...receipts[1], logs: [], logsBloom: EMPTY_LOGS_BLOOM };
  const gasEdited = { ...receipts[1], cumulativeGasUsed: '0xfde9' };
  for (const replaced of [edited, falseEmpty, gasEdited]) {
    assert.throws(() => verifyReceiptRoot(block, [receipts[0], replaced, receipts[2]], 'canyon-v1'),
      /receipt_root_mismatch/);
  }
  assert.throws(() => verifyReceiptRoot({ ...block, receiptsRoot: hash(1) }, receipts, 'canyon-v1'),
    /receipt_root_mismatch/);
});

test('rejects inconsistent RPC log positions and receipt blooms', () => {
  const logs = [{ ...receipts[1].logs[0], logIndex: '0x1' }];
  assert.throws(() => verifyReceiptRoot(block, [receipts[0], { ...receipts[1], logs }, receipts[2]], 'canyon-v1'),
    /invalid_consensus_log/);
  const zeroBloom = { ...receipts[1], logsBloom: EMPTY_LOGS_BLOOM };
  assert.throws(() => verifyReceiptRoot(block, [receipts[0], zeroBloom, receipts[2]], 'canyon-v1'),
    /receipt_bloom_disagreement/);
});

test('rejects unknown receipt types, ambiguous deposit forks and invalid Canyon extensions', () => {
  const replaced = (fields: Record<string, unknown>) => [receipts[0], receipts[1], { ...receipts[2], ...fields }];
  assert.throws(() => verifyReceiptRoot(block, replaced({ type: '0x7d' }), 'canyon-v1'), /unsupported_receipt_type/);
  assert.throws(() => verifyReceiptRoot(block, receipts), /unsupported_deposit_fork/);
  for (const fields of [{ depositReceiptVersion: undefined }, { depositNonce: undefined }, { depositNonce: '0x00' }]) {
    assert.throws(() => verifyReceiptRoot(block, replaced(fields), 'canyon-v1'), /invalid_deposit_receipt/);
  }
  assert.throws(() => verifyReceiptRoot(block, replaced({ depositReceiptVersion: '0x2' }), 'canyon-v1'),
    /unsupported_deposit_receipt_version/);
  assert.throws(() => verifyReceiptRoot(block, replaced({ depositNonce: '0x1' }), 'canyon-v1'), /receipt_root_mismatch/);
  assert.throws(() => verifyReceiptRoot(block, replaced({ type: '0x2' }), 'canyon-v1'), /unexpected_deposit_receipt_fields/);
});
