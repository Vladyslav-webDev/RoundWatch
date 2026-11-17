import { createHash } from 'node:crypto';
import {
  CHAIN_ID, filterFor, inFilter, normalizeHeader, requireEvidence, sameHeader, TRANSFER, Unresolved, USDC,
} from './evidence.ts';
import type { Filter, Header, Log, Receipt } from './evidence.ts';
import { MAX_LIVE_RANGE_BLOCKS } from './live-store.ts';
import type { LiveCandidate, LivePlan, LiveStore, LiveWatchTuple } from './live-store.ts';
import { RpcReadError } from './rpc.ts';
import type { HistoricalRpcProvider } from './rpc.ts';

export const LIVE_OBSERVATION_LIMITS = Object.freeze({
  scanBlocks: MAX_LIVE_RANGE_BLOCKS,
  numberedBlocks: MAX_LIVE_RANGE_BLOCKS + 1,
  maxReceiptReadsPerProvider: 4,
  maxTransferLogs: 128,
  maxFinalizedAgeSec: 3_600,
  maxFutureSkewSec: 30,
  durableWorkLimit: 64,
});

type Pair<T> = readonly [T, T];
type ReadMethod = Parameters<LiveStore['charge']>[2];
const TRANSFERS: Filter = Object.freeze({ address: USDC, topics: Object.freeze([TRANSFER]) });
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

class ProviderFailure extends Unresolved {
  readonly source: string;

  constructor(source: string, reason: string) {
    super(reason);
    this.source = source;
  }
}

function rpcReason(error: RpcReadError) {
  if (error.rpcCode === 4444) return 'rpc_pruned_history';
  if (error.httpStatus === 429) return 'rpc_rate_limited';
  return error.reason;
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function verifyFinality(before: Header, after: Header, source: string) {
  if (after.height < before.height || after.timestamp < before.timestamp) {
    throw new ProviderFailure(source, 'finality_regression');
  }
  if (after.height === before.height && !sameHeader(before, after)) {
    throw new ProviderFailure(source, 'finalized_block_replaced');
  }
  if (after.height - before.height === 1 && after.parentHash !== before.hash) {
    throw new ProviderFailure(source, 'broken_finalized_link');
  }
}

function verifyAnchor(actual: Header, expected: Header) {
  requireEvidence(sameHeader(actual, expected), 'numbered_finalized_anchor_disagreement');
}

function normalizeTransfers(raw: readonly Log[], blocks: ReadonlyMap<number, Header>, filter: Filter): Log[] {
  const rows: readonly Log[] = raw;
  requireEvidence(Array.isArray(raw) && rows.length <= LIVE_OBSERVATION_LIMITS.maxTransferLogs,
    'transfer_log_limit');
  const positions = new Map<string, Log>();
  for (const log of rows) {
    const block = blocks.get(log.blockNumber);
    requireEvidence(block && log.blockHash === block.hash && Number.isSafeInteger(log.transactionIndex) &&
      log.transactionIndex >= 0 && block.transactions[log.transactionIndex] === log.transactionHash &&
      Number.isSafeInteger(log.logIndex) && log.logIndex >= 0 && log.removed === false, 'log_header_disagreement');
    requireEvidence(log.address === USDC && log.topics.length === 3 && log.topics[0] === TRANSFER &&
      log.topics.slice(1).every((topic) => /^0x0{24}[0-9a-f]{40}$/.test(topic)) &&
      /^0x[0-9a-f]{64}$/.test(log.data) && inFilter(log, filter), 'unexpected_transfer_log');
    const key = `${block.height}:${log.logIndex}`;
    const prior = positions.get(key);
    requireEvidence(!prior || digest(prior) === digest(log), 'conflicting_log_position');
    positions.set(key, log);
  }
  return [...positions.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

function transferTuple(log: Log) {
  return {
    sender: `0x${log.topics[1].slice(26)}`,
    recipient: `0x${log.topics[2].slice(26)}`,
    amountAtomic: BigInt(log.data).toString(),
  };
}

function chooseSample(logs: readonly Log[], blocks: readonly Header[]): LiveWatchTuple | null {
  for (const log of logs) {
    const tuple = transferTuple(log);
    if (tuple.sender !== ZERO_ADDRESS && tuple.recipient !== ZERO_ADDRESS && tuple.sender !== tuple.recipient &&
      tuple.amountAtomic !== '0') {
      return { ...tuple, opensAtSec: blocks[0].timestamp, deadlineSec: blocks[blocks.length - 1].timestamp + 1 };
    }
  }
  return null;
}

function verifyReceipt(receipt: Receipt, expected: Log, block: Header, filter: Filter, transactionLogs: readonly Log[]) {
  requireEvidence(receipt.blockNumber === expected.blockNumber && receipt.blockHash === expected.blockHash &&
    receipt.transactionHash === expected.transactionHash && receipt.transactionIndex === expected.transactionIndex,
    'receipt_identity_disagreement');
  requireEvidence(receipt.status === 1, 'receipt_failed');
  let previousIndex: number | undefined;
  for (const log of receipt.logs) {
    requireEvidence(log.blockHash === block.hash && log.blockNumber === block.height &&
      log.transactionHash === receipt.transactionHash && log.transactionIndex === receipt.transactionIndex &&
      log.removed === false && Number.isSafeInteger(log.logIndex) && log.logIndex >= 0 &&
      (previousIndex === undefined || log.logIndex === previousIndex + 1), 'receipt_log_position_disagreement');
    previousIndex = log.logIndex;
  }
  const transfers = normalizeTransfers(receipt.logs.filter((log) => inFilter(log, filter)),
    new Map([[block.height, block]]), filter);
  requireEvidence(digest(transfers) === digest(transactionLogs), 'receipt_log_disagreement');
  return {
    blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, transactionHash: receipt.transactionHash,
    transactionIndex: receipt.transactionIndex, status: receipt.status,
  };
}

/** Read a pinned recent sample and keep its evidence outside the trusted fixture coverage path. */
export async function observeLiveRange(
  store: LiveStore, id: string, providers: Pair<HistoricalRpcProvider>,
  { nowSec = () => Math.floor(Date.now() / 1_000) }: { nowSec?: () => number } = {},
) {
  const state = store.status(id);
  requireEvidence(providers.every((provider, index) => provider.id === state.providerIds[index]),
    'wrong_evidence_providers');
  if (state.observation) return state;

  // Wait for both sides to settle, including on failure, before writing diagnostics or closing SQLite.
  async function readBoth<T>(method: ReadMethod, read: (provider: HistoricalRpcProvider) => Promise<T>): Promise<Pair<T>> {
    async function readOne(provider: HistoricalRpcProvider) {
      try {
        store.charge(id, provider.id, method);
        return await read(provider);
      } catch (error) {
        if (error instanceof RpcReadError || error instanceof Unresolved) {
          throw new ProviderFailure(provider.id, error instanceof RpcReadError ? rpcReason(error) : error.message);
        }
        throw error;
      }
    }
    const results = await Promise.allSettled([readOne(providers[0]), readOne(providers[1])]);
    const [left, right] = results;
    if (left.status === 'fulfilled' && right.status === 'fulfilled') return [left.value, right.value];
    const failures = results.filter((result) => result.status === 'rejected');
    throw (failures.find((failure) => !(failure.reason instanceof ProviderFailure)) ?? failures[0]).reason;
  }

  async function finalizedTags() {
    const sampled = await readBoth('eth_getBlockByNumber', async (provider) => normalizeHeader(await provider.header('finalized')));
    const now = nowSec();
    requireEvidence(Number.isSafeInteger(now) && now >= 0, 'invalid_observation_clock');
    for (const [index, header] of sampled.entries()) {
      if (now - header.timestamp > LIVE_OBSERVATION_LIMITS.maxFinalizedAgeSec) {
        throw new ProviderFailure(providers[index].id, 'stale_finalized_tag');
      }
      if (header.timestamp - now > LIVE_OBSERVATION_LIMITS.maxFutureSkewSec) {
        throw new ProviderFailure(providers[index].id, 'future_finalized_tag');
      }
    }
    requireEvidence(sampled[0].height !== sampled[1].height || sameHeader(sampled[0], sampled[1]),
      'finalized_provider_disagreement');
    return sampled;
  }

  async function numbered(height: number) {
    const headers = await readBoth('eth_getBlockByNumber', async (provider) => {
      const header = normalizeHeader(await provider.header(height));
      requireEvidence(header.height === height, 'wrong_header_height');
      return header;
    });
    requireEvidence(sameHeader(headers[0], headers[1]), 'header_provider_disagreement');
    return headers[0];
  }

  let stage = 'chain_id';
  try {
    // Both chain gates must pass before either provider can supply block or log evidence.
    await readBoth('eth_chainId', async (provider) => {
      requireEvidence(await provider.chainId() === CHAIN_ID, 'wrong_chain_id');
    });
    stage = 'finalized_tag';
    const initial = await finalizedTags();
    const { scanBlocks, maxFinalizedAgeSec, maxReceiptReadsPerProvider } = LIVE_OBSERVATION_LIMITS;
    let plan: LivePlan | null = state.plan;
    stage = 'finalized_anchor';
    if (plan) {
      for (const [index, header] of initial.entries()) verifyFinality(plan.finalizedHeads[index], header, providers[index].id);
      requireEvidence(nowSec() - plan.finalizedHeads[0].timestamp <= maxFinalizedAgeSec, 'stale_pinned_range');
    } else {
      requireEvidence(initial[0].height === initial[1].height, 'finalized_height_disagreement');
      requireEvidence(initial[0].height >= scanBlocks, 'finalized_history_too_short');
      plan = { fromBlock: initial[0].height - scanBlocks + 1, toBlock: initial[0].height, finalizedHeads: initial };
    }
    const anchor = await numbered(plan.toBlock);
    verifyAnchor(anchor, plan.finalizedHeads[0]);
    if (!state.plan) store.pin(id, plan);

    stage = 'linked_headers';
    const predecessor = await numbered(plan.fromBlock - 1);
    const blocks: Header[] = [];
    let previous = predecessor;
    for (let height = plan.fromBlock; height <= plan.toBlock; height++) {
      const block = height === plan.toBlock ? anchor : await numbered(height);
      requireEvidence(block.parentHash === previous.hash && block.timestamp >= previous.timestamp, 'broken_block_link');
      blocks.push(block);
      previous = block;
    }
    const byHeight = new Map(blocks.map((block) => [block.height, block]));
    const filter = state.watch ? filterFor({ token: USDC, ...state.watch }) : TRANSFERS;

    stage = 'range_logs';
    const { fromBlock, toBlock } = plan;
    const ranged = await readBoth('eth_getLogs', async (provider) =>
      normalizeTransfers(await provider.logs(fromBlock, toBlock, filter), byHeight, filter));
    const rangeDigests = ranged.map(digest);
    requireEvidence(rangeDigests[0] === rangeDigests[1], 'log_provider_disagreement');

    stage = 'single_block_logs';
    const singles: Pair<Log[]> = [[], []];
    for (const block of blocks) {
      const height = block.height;
      const rows = await readBoth('eth_getLogs', async (provider) =>
        normalizeTransfers(await provider.logs(height, height, filter), new Map([[height, block]]), filter));
      singles[0].push(...rows[0]);
      singles[1].push(...rows[1]);
      requireEvidence(singles.every((logs) => logs.length <= LIVE_OBSERVATION_LIMITS.maxTransferLogs), 'transfer_log_limit');
    }
    const singleDigests = singles.map(digest);
    requireEvidence(rangeDigests.every((value, index) => value === singleDigests[index]), 'range_single_log_disagreement');

    stage = 'candidate_receipts';
    const watch = state.watch ?? chooseSample(ranged[0], blocks);
    const hits = watch ? ranged[0].filter((log) => {
      const { sender, recipient, amountAtomic } = transferTuple(log);
      const { timestamp } = byHeight.get(log.blockNumber)!;
      return sender === watch.sender && recipient === watch.recipient && amountAtomic === watch.amountAtomic &&
        timestamp >= watch.opensAtSec && timestamp < watch.deadlineSec;
    }) : [];
    const transactions = new Map(hits.map((log) => [log.transactionHash, log]));
    requireEvidence(transactions.size <= maxReceiptReadsPerProvider, 'receipt_work_limit');
    const receiptDigests: Pair<{ transactionHash: string; digest: string }[]> = [[], []];
    const receipts = new Map<string, LiveCandidate['receipt']>();
    for (const [transactionHash, log] of transactions) {
      const block = byHeight.get(log.blockNumber)!;
      const transactionLogs = ranged[0].filter((row) => row.transactionHash === transactionHash);
      const verified = await readBoth('eth_getTransactionReceipt', async (provider) => {
        const receipt = await provider.receipt(transactionHash);
        requireEvidence(receipt, 'receipt_unavailable');
        return { evidence: verifyReceipt(receipt, log, block, filter, transactionLogs), digest: digest(receipt) };
      });
      requireEvidence(verified[0].digest === verified[1].digest, 'receipt_provider_disagreement');
      receiptDigests[0].push({ transactionHash, digest: verified[0].digest });
      receiptDigests[1].push({ transactionHash, digest: verified[1].digest });
      receipts.set(transactionHash, verified[0].evidence);
    }

    stage = 'finality_recheck';
    const final = await finalizedTags();
    for (const [index, header] of final.entries()) verifyFinality(initial[index], header, providers[index].id);
    verifyAnchor(await numbered(plan.toBlock), anchor);

    stage = 'observation_commit';
    store.commit(id, {
      predecessor, blocks, watch,
      candidates: hits.map((log) => ({ log, receipt: receipts.get(log.transactionHash)! })),
      sources: [
        { id: providers[0].id, rangeLogDigest: rangeDigests[0], singleLogDigest: singleDigests[0], receiptDigests: receiptDigests[0] },
        { id: providers[1].id, rangeLogDigest: rangeDigests[1], singleLogDigest: singleDigests[1], receiptDigests: receiptDigests[1] },
      ],
    });
  } catch (error) {
    if (!(error instanceof Unresolved)) throw error;
    store.stall(id, error.message, { stage, source: error instanceof ProviderFailure ? error.source : undefined });
  }
  return store.status(id);
}
