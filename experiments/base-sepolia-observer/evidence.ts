export const CHAIN_ID = 84532;
export const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
export const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const MAX_TRANSACTIONS = 128;
const MAX_LOGS = 256;

export interface Header {
  readonly height: number;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestamp: number;
  readonly transactions: readonly string[];
}

export interface WatchInput {
  id: string;
  chainId: number;
  token: string;
  sender: string;
  recipient: string;
  amountAtomic: string;
  latestAtArm: Header;
  finalizedAtArm: Header;
  armedAtSec: number;
  opensAtSec: number;
  deadlineSec: number;
  workLimit: number;
}

export type Filter = Readonly<{ address: string; topics: readonly string[] }>;

export interface Log {
  address: string;
  topics: readonly string[];
  data: string;
  blockHash: string;
  blockNumber: number;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  removed: boolean;
}

export interface Receipt {
  blockHash: string;
  blockNumber: number;
  transactionHash: string;
  transactionIndex: number;
  status: 0 | 1;
  logs: readonly Log[];
}

export interface LogView {
  id: string;
  chainId(): number;
  finalized(): Header | undefined;
  header(height: number): Header | undefined;
  logs(height: number, filter: Filter): readonly Log[] | undefined;
}

export interface ReceiptOracle {
  id: string;
  chainId(): number;
  finalizedHeader(height: number): Header | undefined;
  receipts(blockHash: string): readonly Receipt[] | undefined;
}

export interface FixtureEvidence {
  views: readonly [LogView, LogView];
  oracle: ReceiptOracle;
}

export interface RangeLogView extends LogView {
  logsRange(fromHeight: number, toHeight: number, filter: Filter): readonly Log[] | undefined;
}

export interface RangeFixtureEvidence extends FixtureEvidence {
  views: readonly [RangeLogView, RangeLogView];
}

export type EvidenceIds = readonly [string, string, string];

export class Unresolved extends Error {}

export function requireEvidence(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Unresolved(reason);
}

function hex(value: unknown, bytes: number, reason: string): string {
  requireEvidence(typeof value === 'string' && value.length === 2 + 2 * bytes &&
    /^0x[0-9a-f]+$/i.test(value), reason);
  return value.toLowerCase();
}

function natural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function normalizeHeader(input: Header): Header {
  const reason = 'invalid_header';
  requireEvidence(input && natural(input.height) && natural(input.timestamp) &&
    Array.isArray(input.transactions) && input.transactions.length <= MAX_TRANSACTIONS, reason);
  const transactions = Array.from(input.transactions, (hash) => hex(hash, 32, reason));
  requireEvidence(new Set(transactions).size === transactions.length, reason);
  return Object.freeze({
    height: input.height,
    hash: hex(input.hash, 32, reason),
    parentHash: hex(input.parentHash, 32, reason),
    timestamp: input.timestamp,
    transactions: Object.freeze(transactions),
  });
}

export function sameHeader(a: Header, b: Header): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function normalizeWatch(input: WatchInput): Readonly<WatchInput> {
  const reason = 'invalid_watch';
  const token = hex(input.token, 20, reason);
  const sender = hex(input.sender, 20, reason);
  const recipient = hex(input.recipient, 20, reason);
  const latestAtArm = normalizeHeader(input.latestAtArm);
  const finalizedAtArm = normalizeHeader(input.finalizedAtArm);
  requireEvidence(typeof input.id === 'string' && /^[a-z0-9_-]{1,64}$/i.test(input.id) &&
    input.chainId === CHAIN_ID && token === USDC && sender !== recipient &&
    sender !== ZERO_ADDRESS && recipient !== ZERO_ADDRESS, reason);
  requireEvidence(typeof input.amountAtomic === 'string' && input.amountAtomic.length <= 78 &&
    /^[1-9][0-9]*$/.test(input.amountAtomic) && BigInt(input.amountAtomic) < 2n ** 256n, reason);
  requireEvidence(natural(input.armedAtSec) && natural(input.opensAtSec) &&
    natural(input.deadlineSec) && input.armedAtSec < input.opensAtSec &&
    input.opensAtSec < input.deadlineSec && latestAtArm.timestamp < input.opensAtSec &&
    finalizedAtArm.height <= latestAtArm.height && finalizedAtArm.timestamp <= latestAtArm.timestamp &&
    (finalizedAtArm.height < latestAtArm.height || sameHeader(finalizedAtArm, latestAtArm)) &&
    natural(input.workLimit) && input.workLimit > 0 && input.workLimit <= 100_000, reason);
  return Object.freeze({
    id: input.id, chainId: CHAIN_ID, token, sender, recipient, amountAtomic: input.amountAtomic,
    latestAtArm, finalizedAtArm, armedAtSec: input.armedAtSec, opensAtSec: input.opensAtSec,
    deadlineSec: input.deadlineSec, workLimit: input.workLimit,
  });
}

export function addressTopic(address: string): string {
  return `0x${address.slice(2).padStart(64, '0')}`;
}

export function filterFor(watch: Readonly<WatchInput>): Filter {
  return Object.freeze({
    address: watch.token,
    topics: Object.freeze([TRANSFER, addressTopic(watch.sender), addressTopic(watch.recipient)]),
  });
}

export function inFilter(log: Log, filter: Filter): boolean {
  return log.address.toLowerCase() === filter.address &&
    filter.topics.every((topic, index) => log.topics[index]?.toLowerCase() === topic);
}

function normalizeLog(log: Log, block: Header): Log {
  const reason = 'invalid_log';
  requireEvidence(log && Array.isArray(log.topics) && log.topics.length <= 4 &&
    typeof log.data === 'string' && log.data.length <= 8194 && /^0x(?:[0-9a-f]{2})*$/i.test(log.data) &&
    log.blockNumber === block.height && natural(log.transactionIndex) && natural(log.logIndex) &&
    log.logIndex < MAX_LOGS && log.removed === false, reason);
  const blockHash = hex(log.blockHash, 32, reason);
  const transactionHash = hex(log.transactionHash, 32, reason);
  requireEvidence(blockHash === block.hash && block.transactions[log.transactionIndex] === transactionHash, reason);
  return {
    address: hex(log.address, 20, reason),
    topics: Array.from(log.topics, (topic) => hex(topic, 32, reason)),
    data: log.data.toLowerCase(), blockHash, blockNumber: log.blockNumber, transactionHash,
    transactionIndex: log.transactionIndex, logIndex: log.logIndex, removed: false,
  };
}

function normalizeResponse(raw: readonly Log[] | undefined, block: Header, filter: Filter): Log[] {
  requireEvidence(raw !== undefined, 'logs_unavailable');
  requireEvidence(Array.isArray(raw) && raw.length <= MAX_LOGS, 'log_response_limit');
  const byPosition = new Map<number, Log>();
  for (const item of raw) {
    const log = normalizeLog(item, block);
    requireEvidence(inFilter(log, filter), 'unexpected_filter_result');
    const prior = byPosition.get(log.logIndex);
    requireEvidence(!prior || JSON.stringify(prior) === JSON.stringify(log), 'conflicting_log_position');
    byPosition.set(log.logIndex, log);
  }
  return [...byPosition.values()].sort((a, b) => a.logIndex - b.logIndex);
}

// Check the range envelope before verifying each block against both views and the receipt oracle.
export function logsByHeight(raw: readonly Log[] | undefined, from: number, to: number) {
  requireEvidence(raw !== undefined, 'logs_unavailable');
  requireEvidence(Array.isArray(raw) && raw.length <= (to - from + 1) * MAX_LOGS, 'log_response_limit');
  const byHeight = new Map<number, Log[]>();
  for (const log of raw) {
    requireEvidence(log && natural(log.blockNumber) && log.blockNumber >= from && log.blockNumber <= to,
      'log_outside_range');
    const logs = byHeight.get(log.blockNumber) ?? [];
    requireEvidence(logs.length < MAX_LOGS, 'log_response_limit');
    logs.push(log);
    byHeight.set(log.blockNumber, logs);
  }
  return byHeight;
}

export function verifyLogs(
  block: Header, filter: Filter, amountAtomic: string,
  responses: readonly [readonly Log[] | undefined, readonly Log[] | undefined],
  rawReceipts: readonly Receipt[] | undefined,
) {
  const left = normalizeResponse(responses[0], block, filter);
  const right = normalizeResponse(responses[1], block, filter);
  requireEvidence(JSON.stringify(left) === JSON.stringify(right), 'log_view_disagreement');
  requireEvidence(rawReceipts !== undefined, 'receipts_unavailable');
  requireEvidence(Array.isArray(rawReceipts) && rawReceipts.length === block.transactions.length,
    'incomplete_receipts');

  const oracleLogs: Log[] = [];
  const candidates: { log: Log; receipt: Omit<Receipt, 'logs'> }[] = [];
  let nextLogIndex = 0;
  for (const [index, raw] of rawReceipts.entries()) {
    const reason = 'invalid_receipt';
    requireEvidence(raw && hex(raw.blockHash, 32, reason) === block.hash &&
      raw.blockNumber === block.height && raw.transactionIndex === index &&
      hex(raw.transactionHash, 32, reason) === block.transactions[index] &&
      Array.isArray(raw.logs) && raw.logs.length <= MAX_LOGS - nextLogIndex &&
      (raw.status === 1 || (raw.status === 0 && raw.logs.length === 0)), reason);
    for (const item of raw.logs) {
      const log = normalizeLog(item, block);
      requireEvidence(log.transactionIndex === index && log.logIndex === nextLogIndex, reason);
      nextLogIndex++;
      if (!inFilter(log, filter)) continue;
      oracleLogs.push(log);
      requireEvidence(log.topics.length === 3 && log.data.length === 66, 'malformed_transfer');
      if (BigInt(log.data) !== BigInt(amountAtomic)) continue;
      candidates.push({ log, receipt: {
        blockHash: log.blockHash, blockNumber: block.height, transactionHash: log.transactionHash,
        transactionIndex: index, status: raw.status,
      } });
    }
  }
  requireEvidence(JSON.stringify(oracleLogs) === JSON.stringify(left), 'receipt_log_disagreement');
  return { logs: left, receiptCount: rawReceipts.length, candidates };
}
