import { verifyReceiptRoot } from './cp2c-receipts.ts';
import { CHAIN_ID, Unresolved, sameHeader } from './evidence.ts';
import { BASE_RPC_ENDPOINT, BaseSepoliaRpc, MAX_RPC_REQUEST_BYTES, RpcReadError, SECONDARY_RPC_ENDPOINTS } from './rpc.ts';
import type { ReceiptBlock, ReceiptProbeFields, RpcLimits, RpcMeasurement } from './rpc.ts';

const MAX_FALLBACK_TRANSACTIONS = 8;
const MAX_FINALIZED_AGE_SECONDS = 3_600;
const MAX_CLOCK_SKEW_SECONDS = 30;
// Base Sepolia Canyon activation in Base v1.5.5 crates/common/chains/src/config.rs.
const CANYON_ACTIVATION_SECONDS = 1_699_981_200;
const LIMITS: RpcLimits = Object.freeze({
  maxRequests: 4 + MAX_FALLBACK_TRANSACTIONS,
  maxElapsedMs: 20_000,
  requestTimeoutMs: 3_000,
  maxResponseBytes: 256 * 1024,
  maxTotalResponseBytes: 1024 * 1024,
  maxRangeBlocks: 1,
});

type Secondary = keyof typeof SECONDARY_RPC_ENDPOINTS;
type Endpoint = typeof BASE_RPC_ENDPOINT | (typeof SECONDARY_RPC_ENDPOINTS)[Secondary];
type SampleMode = 'head' | 'predecessor';

function summarizeBlock(block: ReceiptBlock) {
  const { height, hash, parentHash, timestamp, transactions, receiptsRoot } = block;
  return { height, hash, parentHash, timestamp, transactionCount: transactions.length, receiptsRoot };
}

function checkReportedRoot(block: ReceiptBlock, receipts: readonly ReceiptProbeFields[]) {
  try {
    const depositRule = block.timestamp >= CANYON_ACTIVATION_SECONDS ? 'canyon-v1' : undefined;
    verifyReceiptRoot(block, receipts.map(({ raw }) => raw), depositRule);
    return { matched: true, recomputed: true };
  } catch (error) {
    const failure = reason(error);
    return { matched: false, recomputed: failure === 'receipt_root_mismatch', reason: failure };
  }
}

function summarizeReceipts(block: ReceiptBlock, receipts: readonly ReceiptProbeFields[]) {
  const types = new Map<string, number>();
  for (const { type } of receipts) {
    const key = type ?? 'missing';
    types.set(key, (types.get(key) ?? 0) + 1);
  }
  return {
    receiptCount: receipts.length,
    types: Object.fromEntries(types),
    withDepositNonce: receipts.filter(({ depositNonce }) => depositNonce).length,
    withDepositReceiptVersion: receipts.filter(({ depositReceiptVersion }) => depositReceiptVersion).length,
    reportedRoot: checkReportedRoot(block, receipts),
  };
}

function summarizeRequests(requests: readonly RpcMeasurement[]) {
  return {
    requests: requests.length,
    requestBytes: requests.reduce((total, row) => total + row.requestBytes, 0),
    decodedResponseBytes: requests.reduce((total, row) => total + row.responseBytes, 0),
  };
}

function session(endpoint: Endpoint, fetcher: typeof fetch) {
  const requestParams: unknown[][] = [];
  const rpc = new BaseSepoliaRpc(endpoint.id, endpoint.endpoint, LIMITS, (url, init) => {
    // The transport generated these params from fixed read methods and validated chain data.
    const request = JSON.parse(String(init?.body)) as { params: unknown[] };
    requestParams.push(request.params);
    return fetcher(url, init);
  });
  return { endpoint, rpc, requestParams };
}

function sameCommitments(first: ReceiptBlock, second: ReceiptBlock) {
  return sameHeader(first, second) && first.receiptsRoot === second.receiptsRoot && first.logsBloom === second.logsBloom;
}

function matchesLowerTag(block: ReceiptBlock, tag: ReceiptBlock, lowerTagHeight: number) {
  if (tag.height !== lowerTagHeight) return true;
  if (block.height === tag.height) return sameCommitments(block, tag);
  return block.height === tag.height - 1 && tag.parentHash === block.hash && tag.timestamp >= block.timestamp;
}

function recent(block: ReceiptBlock, nowSec: number) {
  return block.timestamp >= nowSec - MAX_FINALIZED_AGE_SECONDS && block.timestamp <= nowSec + MAX_CLOCK_SKEW_SECONDS;
}

function reason(error: unknown) {
  if (error instanceof RpcReadError) return error.reason;
  if (error instanceof Unresolved) return error.message;
  return 'unexpected_probe_error';
}

async function finalized(rpc: BaseSepoliaRpc, nowSec: number) {
  const chainId = await rpc.chainId();
  if (chainId !== CHAIN_ID) throw new RpcReadError('wrong_chain');
  const block = await rpc.receiptBlock('finalized');
  if (!recent(block, nowSec)) throw new RpcReadError('finalized_tag_outside_recent_window');
  return block;
}

async function acquireReceipts(rpc: BaseSepoliaRpc, block: ReceiptBlock) {
  let batchFailure: string;
  try {
    const receipts = await rpc.blockReceipts(block);
    return { batch: summarizeReceipts(block, receipts), fallback: { reason: 'batch_returned_ordered_set' } };
  } catch (error) {
    batchFailure = reason(error);
  }

  const count = block.transactions.length;
  if (count === 0 || count > MAX_FALLBACK_TRANSACTIONS) {
    return { batchFailure, fallback: { reason: count === 0 ? 'no_transactions' : 'transaction_limit' } };
  }

  const receipts: ReceiptProbeFields[] = [];
  try {
    for (let index = 0; index < count; index++) {
      receipts.push(await rpc.transactionReceiptFields(block, index));
    }
    return { batchFailure, fallback: { orderedSet: summarizeReceipts(block, receipts) } };
  } catch (error) {
    return { batchFailure, fallback: { reason: reason(error), receiptsBeforeFailure: receipts.length } };
  }
}

export async function probeReceiptCapabilities(
  secondary: Secondary,
  fetcher: typeof fetch = fetch,
  startedAt = new Date(),
  sampleMode: SampleMode = 'head',
) {
  if (secondary !== 'publicnode' && secondary !== 'onfinality') throw new RpcReadError('invalid_secondary');
  if (sampleMode !== 'head' && sampleMode !== 'predecessor') throw new RpcReadError('invalid_sample_mode');
  const sources = [session(BASE_RPC_ENDPOINT, fetcher), session(SECONDARY_RPC_ENDPOINTS[secondary], fetcher)];
  const started = performance.now();
  const nowSec = Math.floor(startedAt.getTime() / 1000);
  const tags = await Promise.allSettled(sources.map(({ rpc }) => finalized(rpc, nowSec)));
  let sample: ReceiptBlock | undefined;
  let failure: string | undefined;
  let numbered: PromiseSettledResult<ReceiptBlock>[] = [];
  let receiptCapabilities: Awaited<ReturnType<typeof acquireReceipts>>[] = [];

  const [firstTag, secondTag] = tags;
  if (firstTag.status !== 'fulfilled' || secondTag.status !== 'fulfilled') {
    failure = 'finalized_tag_unavailable';
  } else {
    const lowerTagHeight = Math.min(firstTag.value.height, secondTag.value.height);
    const height = lowerTagHeight - (sampleMode === 'predecessor' ? 1 : 0);
    numbered = await Promise.allSettled(sources.map(({ rpc }) => rpc.receiptBlock(height)));
    const [first, second] = numbered;
    if (first.status !== 'fulfilled' || second.status !== 'fulfilled') {
      failure = 'numbered_header_unavailable';
    } else if (!recent(first.value, nowSec) || !recent(second.value, nowSec)) {
      failure = 'sample_outside_recent_window';
    } else if (!sameCommitments(first.value, second.value) ||
      !matchesLowerTag(first.value, firstTag.value, lowerTagHeight) ||
      !matchesLowerTag(second.value, secondTag.value, lowerTagHeight)) {
      failure = 'header_disagreement';
    } else {
      sample = first.value;
      receiptCapabilities = await Promise.all([
        acquireReceipts(sources[0].rpc, first.value),
        acquireReceipts(sources[1].rpc, second.value),
      ]);
      if (!receiptCapabilities.some((capability) => capability.batch || capability.fallback.orderedSet)) {
        failure = 'ordered_receipt_set_unavailable';
      }
    }
  }

  const metrics = sources.map(({ rpc }) => rpc.metrics());
  const rootChecks = receiptCapabilities.map(({ batch, fallback }) => (batch ?? fallback.orderedSet)?.reportedRoot);
  return {
    startedAt: startedAt.toISOString(),
    elapsedMs: Number((performance.now() - started).toFixed(2)),
    chainId: CHAIN_ID,
    sampleMode,
    status: failure ? 'BLOCKED' : 'CAPABILITY_SAMPLE',
    failure,
    evidence: {
      headerAgreement: sample ? 'PROVIDER_CORROBORATED' : 'UNRESOLVED',
      authenticatedFinality: false,
      receiptsRootRecomputed: rootChecks.some((result) => result?.recomputed),
      providerReportedRootMatched: rootChecks.some((result) => result?.matched),
      verifiedCoverage: 'BLOCKED',
    },
    sample: sample && summarizeBlock(sample),
    limits: {
      sampledNumberedHeights: 1,
      fallbackTransactionsPerProvider: MAX_FALLBACK_TRANSACTIONS,
      finalizedTagMaxAgeSeconds: MAX_FINALIZED_AGE_SECONDS,
      clockSkewSeconds: MAX_CLOCK_SKEW_SECONDS,
      perProvider: { ...LIMITS, maxRequestBytes: MAX_RPC_REQUEST_BYTES },
      maxAggregateRequests: sources.length * LIMITS.maxRequests,
      maxAggregateRequestBytes: sources.length * LIMITS.maxRequests * MAX_RPC_REQUEST_BYTES,
      maxAggregateDecodedResponseBytes: sources.length * LIMITS.maxTotalResponseBytes,
    },
    totals: summarizeRequests(metrics.flat()),
    providers: sources.map(({ endpoint, requestParams }, index) => {
      const tag = tags[index];
      const block = numbered[index];
      return {
        ...endpoint,
        finalizedTag: tag.status === 'fulfilled' ? summarizeBlock(tag.value) : { reason: reason(tag.reason) },
        numberedBlock: block?.status === 'fulfilled' ? summarizeBlock(block.value) :
          block && { reason: reason(block.reason) },
        receiptCapabilities: receiptCapabilities[index],
        totals: summarizeRequests(metrics[index]),
        requests: metrics[index].map((row, requestIndex) => ({
          ...row,
          params: requestParams[requestIndex],
          durationMs: Number(row.durationMs.toFixed(2)),
        })),
      };
    }),
  };
}

if (import.meta.main) {
  const [secondary, mode = 'head', ...rest] = process.argv.slice(2);
  if (rest.length || (secondary !== 'publicnode' && secondary !== 'onfinality') ||
    (mode !== 'head' && mode !== 'predecessor')) {
    console.error('Usage: node cp2c-probe.ts publicnode|onfinality [head|predecessor]');
    process.exitCode = 2;
  } else {
    const result = await probeReceiptCapabilities(secondary, fetch, new Date(), mode);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'CAPABILITY_SAMPLE' ? 0 : 1;
  }
}
