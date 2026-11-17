import { bloomForLogs, keccak256 } from './cp2c-bloom.ts';
import { normalizeHeader, requireEvidence } from './evidence.ts';
import type { Header, Log, Receipt } from './evidence.ts';

export type ReceiptBlock = Header & { readonly receiptsRoot: string };
export type DepositReceiptRule = 'canyon-v1';

type Rlp = Buffer | readonly Rlp[];
type TrieEntry = { readonly key: readonly number[]; readonly value: Buffer };

const EMPTY = Buffer.alloc(0);
const DEPOSIT_TYPE = 0x7e;
const SUPPORTED_TYPES = new Set([0, 1, 2, 4, DEPOSIT_TYPE]);
const MAX_LOGS = 256;
const MAX_LOG_DATA_BYTES = 4096;

function integerBytes(value: bigint): Buffer {
  if (value === 0n) return EMPTY;
  const digits = value.toString(16);
  return Buffer.from(digits.length % 2 ? `0${digits}` : digits, 'hex');
}

function rlpPrefix(length: number, offset: number): Buffer {
  if (length < 56) return Buffer.from([offset + length]);
  const size = integerBytes(BigInt(length));
  return Buffer.concat([Buffer.from([offset + 55 + size.length]), size]);
}

function rlp(value: Rlp): Buffer {
  if (Buffer.isBuffer(value)) {
    if (value.length === 1 && value[0] < 0x80) return value;
    return Buffer.concat([rlpPrefix(value.length, 0x80), value]);
  }
  const payload = Buffer.concat(value.map(rlp));
  return Buffer.concat([rlpPrefix(payload.length, 0xc0), payload]);
}

function compactPath(path: readonly number[], leaf: boolean): Buffer {
  const flag = leaf ? 2 : 0;
  const nibbles = path.length % 2 ? [flag + 1, ...path] : [flag, 0, ...path];
  const bytes = Buffer.alloc(nibbles.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = 16 * nibbles[2 * i] + nibbles[2 * i + 1];
  }
  return bytes;
}

function trieReference(entries: readonly TrieEntry[], depth: number): Rlp {
  const node = trieNode(entries, depth);
  const encoded = rlp(node);
  return encoded.length < 32 ? node : keccak256(encoded);
}

function trieNode(entries: readonly TrieEntry[], depth: number): Rlp {
  const first = entries[0];
  if (entries.length === 1) return [compactPath(first.key.slice(depth), true), first.value];

  let end = depth;
  while (end < first.key.length && entries.every((entry) => entry.key[end] === first.key[end])) end++;
  if (end > depth) return [compactPath(first.key.slice(depth, end), false), trieReference(entries, end)];

  const branch: Rlp[] = Array(17).fill(EMPTY);
  const children: TrieEntry[][] = Array.from({ length: 16 }, () => []);
  for (const entry of entries) {
    if (entry.key.length === depth) branch[16] = entry.value;
    else children[entry.key[depth]].push(entry);
  }
  for (const [nibble, group] of children.entries()) {
    if (group.length > 0) branch[nibble] = trieReference(group, depth + 1);
  }
  return branch;
}

export function receiptTrieRoot(values: readonly Buffer[]): string {
  const entries = values.map((value, index) => ({
    key: Array.from(rlp(integerBytes(BigInt(index)))).flatMap((byte) => [byte >> 4, byte & 0xf]),
    value,
  }));
  const root = entries.length === 0 ? EMPTY : trieNode(entries, 0);
  return `0x${keccak256(rlp(root)).toString('hex')}`;
}

function object(value: unknown, reason: string): Record<string, unknown> {
  requireEvidence(value !== null && typeof value === 'object' && !Array.isArray(value), reason);
  return value as Record<string, unknown>;
}

function hex(value: unknown, minBytes: number, maxBytes: number, reason: string): string {
  requireEvidence(typeof value === 'string' && value.startsWith('0x') && value.length % 2 === 0 &&
    value.length >= 2 + 2 * minBytes && value.length <= 2 + 2 * maxBytes &&
    !/[^0-9a-f]/i.test(value.slice(2)), reason);
  return value.toLowerCase();
}

function quantity(value: unknown, reason: string): bigint {
  requireEvidence(typeof value === 'string' && value.startsWith('0x') && value.length >= 3 &&
    value.length <= 18 && (value.length === 3 || value[2] !== '0') && !/[^0-9a-f]/i.test(value.slice(2)), reason);
  return BigInt(value);
}

function bytes(data: string): Buffer {
  return Buffer.from(data.slice(2), 'hex');
}

function checkPosition(item: Record<string, unknown>, block: Header, index: number, reason: string) {
  requireEvidence(hex(item.blockHash, 32, 32, reason) === block.hash &&
    quantity(item.blockNumber, reason) === BigInt(block.height) &&
    hex(item.transactionHash, 32, 32, reason) === block.transactions[index] &&
    quantity(item.transactionIndex, reason) === BigInt(index), reason);
}

function parseLog(raw: unknown, block: Header, transactionIndex: number, logIndex: number): Log {
  const reason = 'invalid_consensus_log';
  const log = object(raw, reason);
  checkPosition(log, block, transactionIndex, 'consensus_log_position_disagreement');
  requireEvidence(log.removed === false && quantity(log.logIndex, reason) === BigInt(logIndex) &&
    Array.isArray(log.topics) && log.topics.length <= 4, reason);
  return Object.freeze({
    address: hex(log.address, 20, 20, reason),
    topics: Object.freeze(Array.from(log.topics, (topic) => hex(topic, 32, 32, reason))),
    data: hex(log.data, 0, MAX_LOG_DATA_BYTES, reason),
    blockNumber: block.height, blockHash: block.hash, transactionHash: block.transactions[transactionIndex],
    transactionIndex, logIndex, removed: false,
  });
}

// Ethereum consensus receipts do not commit to RPC transaction hashes or log indices.
// The caller supplies the ordered transaction hashes from the separately validated block body.
// Selecting the Canyon rule requires evidence from the applicable chain and fork schedule.
export function verifyReceiptRoot(
  input: ReceiptBlock, rawReceipts: unknown, depositRule?: DepositReceiptRule,
): readonly Receipt[] {
  const block = normalizeHeader(input);
  const expectedRoot = hex(input.receiptsRoot, 32, 32, 'invalid_receipts_root');
  requireEvidence(Array.isArray(rawReceipts) && rawReceipts.length === block.transactions.length,
    'incomplete_receipts');

  const receipts: Receipt[] = [];
  const encoded: Buffer[] = [];
  let logIndex = 0;
  for (const [index, raw] of rawReceipts.entries()) {
    const reason = 'invalid_consensus_receipt';
    const receipt = object(raw, reason);
    checkPosition(receipt, block, index, 'consensus_receipt_position_disagreement');
    const type = Number(quantity(receipt.type, reason));
    requireEvidence(SUPPORTED_TYPES.has(type), 'unsupported_receipt_type');
    const status = quantity(receipt.status, reason);
    requireEvidence(receipt.root == null && Array.isArray(receipt.logs) &&
      (status === 1n || (status === 0n && receipt.logs.length === 0)), reason);
    requireEvidence(receipt.logs.length <= MAX_LOGS - logIndex, 'receipt_proof_log_limit');
    const logs = Array.from(receipt.logs, (log) => parseLog(log, block, index, logIndex++));
    const bloom = bytes(hex(receipt.logsBloom, 256, 256, reason));
    requireEvidence(bloom.equals(bloomForLogs(logs)), 'receipt_bloom_disagreement');

    const payload: Rlp[] = [integerBytes(status), integerBytes(quantity(receipt.cumulativeGasUsed, reason)), bloom,
      logs.map((log) => [bytes(log.address), log.topics.map(bytes), bytes(log.data)])];
    if (type === DEPOSIT_TYPE) {
      requireEvidence(depositRule === 'canyon-v1', 'unsupported_deposit_fork');
      const version = quantity(receipt.depositReceiptVersion, 'invalid_deposit_receipt');
      requireEvidence(version === 1n, 'unsupported_deposit_receipt_version');
      payload.push(integerBytes(quantity(receipt.depositNonce, 'invalid_deposit_receipt')), integerBytes(version));
    } else {
      requireEvidence(receipt.depositNonce === undefined && receipt.depositReceiptVersion === undefined,
        'unexpected_deposit_receipt_fields');
    }

    const body = rlp(payload);
    encoded.push(type === 0 ? body : Buffer.concat([Buffer.from([type]), body]));
    receipts.push(Object.freeze({
      blockNumber: block.height, blockHash: block.hash, transactionHash: block.transactions[index],
      transactionIndex: index, status: status === 1n ? 1 : 0, logs: Object.freeze(logs),
    }));
  }
  requireEvidence(receiptTrieRoot(encoded) === expectedRoot, 'receipt_root_mismatch');
  return Object.freeze(receipts);
}
