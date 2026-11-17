import { USDC } from './evidence.ts';
import { AMOUNT, block, hash, RECIPIENT, SENDER, transfer } from './fixtures.ts';

export const EMPTY_RECEIPTS_ROOT = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
export const EMPTY_LOGS_BLOOM = `0x${'00'.repeat(256)}`;

// Fixed vectors computed with ethers 6.17.0 encodeRlp and keccak256, independently
// of the CP2C verifier. Trie keys 0x80, 0x01 and 0x02 yield a root branch with
// child 8 a leaf (0x30) and child 0 a branch with leaves 1 and 2 (both 0x20).
const receiptsRoot = '0x582fc75d7babb1b82c8704127f38fb83d201232926e9405ba3b948166129f4e9';
const logsBloom = '0x0400000004000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000040000' +
  '0000000000000000000000080000000000000000000400000000000000000008' +
  '0000000000000000000000000000000000000000000000000000001000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000001000000000000000000000000000000000000000000' +
  '0000000200000000000000000000000000000000000000000000000000004000' +
  '0000000000000000000000000020000000000000008000000000000000000000';

const { header, receipts } = block(103, hash(102), 1000, [[], [transfer()], []]);
const quantity = (value: number) => `0x${value.toString(16)}`;

export const receiptFixture = {
  block: { ...header, logsBloom, receiptsRoot },
  watch: { token: USDC, sender: SENDER, recipient: RECIPIENT, amountAtomic: AMOUNT },
  receipts: receipts.map(({ blockHash, blockNumber, transactionIndex, transactionHash, logs }, index) => {
    const position = {
      blockHash, blockNumber: quantity(blockNumber), transactionIndex: quantity(transactionIndex), transactionHash,
    };
    return {
      ...position,
      type: ['0x0', '0x2', '0x7e'][index],
      status: index === 0 ? '0x0' : '0x1',
      cumulativeGasUsed: ['0x5208', '0xfde8', '0x11770'][index],
      logsBloom: index === 1 ? logsBloom : EMPTY_LOGS_BLOOM,
      logs: logs.map((log) => ({ ...log, ...position, logIndex: quantity(log.logIndex) })),
      ...(index === 2 ? { depositNonce: '0x0', depositReceiptVersion: '0x1' } : {}),
    };
  }),
};
