import { isDeepStrictEqual } from 'node:util';
import { CHAIN_ID, TRANSFER, USDC } from './evidence.ts';
import type { Header } from './evidence.ts';
import { LIVE_OBSERVATION_LIMITS, observeLiveRange } from './live-observer.ts';
import { LiveStore } from './live-store.ts';
import { BASE_RPC_ENDPOINT, BaseSepoliaRpc, MAX_RECEIPT_LOGS, MAX_RPC_REQUEST_BYTES, SECONDARY_RPC_ENDPOINTS } from './rpc.ts';
import type { RpcLimits, RpcMeasurement } from './rpc.ts';

const RUN_ID = 'recent-finalized';
const RPC_LIMITS: RpcLimits = {
  maxRequests: 24,
  maxElapsedMs: 30_000,
  requestTimeoutMs: 4_000,
  maxResponseBytes: 256 * 1024,
  maxTotalResponseBytes: 1024 * 1024,
  maxRangeBlocks: LIVE_OBSERVATION_LIMITS.scanBlocks,
};
// Chain ID, two finalized tags, an anchor recheck and one range request, plus the bounded per-item reads.
const MAX_PLANNED_REQUESTS_PER_PROVIDER = 5 + LIVE_OBSERVATION_LIMITS.numberedBlocks +
  LIVE_OBSERVATION_LIMITS.scanBlocks + LIVE_OBSERVATION_LIMITS.maxReceiptReadsPerProvider;

function totals(requests: readonly RpcMeasurement[]) {
  return {
    requestCount: requests.length,
    requestBytes: requests.reduce((sum, request) => sum + request.requestBytes, 0),
    responseBytes: requests.reduce((sum, request) => sum + request.responseBytes, 0),
    summedLatencyMs: Number(requests.reduce((sum, request) => sum + request.durationMs, 0).toFixed(2)),
  };
}

function describeHeader({ height, hash, parentHash, timestamp, transactions }: Header) {
  return { height, hash, parentHash, timestamp, transactionCount: transactions.length };
}

function describeStatus(status: ReturnType<LiveStore['status']>) {
  const { outcome, reason, diagnostic, plan, observation, verifiedCoverageBlocks, verifiedCoverageCursor, work } = status;
  return {
    outcome,
    reason,
    diagnostic,
    providerIds: status.providerIds,
    range: plan && { fromBlock: plan.fromBlock, toBlock: plan.toBlock },
    finalizedHeads: plan?.finalizedHeads.map(describeHeader),
    verifiedCoverageBlocks,
    verifiedCoverageCursor,
    work,
    evidence: {
      sampleTupleSelected: status.watch !== null,
      receiptConfirmedOccurrences: observation?.candidates.length ?? 0,
      providerAgreement: observation !== null,
      completeFinalizedHistoricalCoverage: false,
      businessInvoiceAttribution: false,
    },
    observation: observation && {
      predecessor: describeHeader(observation.predecessor),
      blocks: observation.blocks.map(describeHeader),
      sources: observation.sources.map(({ id, rangeLogDigest, singleLogDigest, receiptDigests }) => ({
        id, rangeLogDigest, singleLogDigest, receiptDigests: receiptDigests.map(({ digest }) => digest),
      })),
    },
  };
}

async function run(secondary: keyof typeof SECONDARY_RPC_ENDPOINTS) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const endpoints = [BASE_RPC_ENDPOINT, SECONDARY_RPC_ENDPOINTS[secondary]] as const;
  const rpcs = [
    new BaseSepoliaRpc(endpoints[0].id, endpoints[0].endpoint, RPC_LIMITS),
    new BaseSepoliaRpc(endpoints[1].id, endpoints[1].endpoint, RPC_LIMITS),
  ] as const;
  let failure: string | undefined = 'local_experiment_error';
  let reopened: ReturnType<LiveStore['status']> | undefined;
  try {
    const store = LiveStore.create();
    const database = store.database;
    try {
      let observed: ReturnType<LiveStore['status']>;
      try {
        store.start(RUN_ID, [rpcs[0].id, rpcs[1].id], LIVE_OBSERVATION_LIMITS.durableWorkLimit);
        observed = await observeLiveRange(store, RUN_ID, rpcs);
      } finally {
        store.close();
      }
      const check = LiveStore.open(database);
      try {
        reopened = check.status(RUN_ID);
        failure = isDeepStrictEqual(observed, reopened) ? undefined : 'sqlite_reopen_disagreement';
      } finally {
        check.close();
      }
    } finally {
      LiveStore.dispose(database);
    }
  } catch {
    failure = 'local_experiment_error';
  }

  const requests = rpcs.map((rpc) => rpc.metrics());
  const result = {
    startedAt,
    elapsedMs: Number((performance.now() - started).toFixed(2)),
    chainId: CHAIN_ID,
    sampleMode: 'retrospective_finalized_range',
    transferFilter: { address: USDC, topics: [TRANSFER] },
    limits: {
      ...LIVE_OBSERVATION_LIMITS,
      maxReceiptLogs: MAX_RECEIPT_LOGS,
      maxPlannedRequestsPerProvider: MAX_PLANNED_REQUESTS_PER_PROVIDER,
      perProvider: { ...RPC_LIMITS, maxRequestBytes: MAX_RPC_REQUEST_BYTES },
      aggregate: {
        maxRequests: 2 * RPC_LIMITS.maxRequests,
        maxRequestBytes: 2 * RPC_LIMITS.maxRequests * MAX_RPC_REQUEST_BYTES,
        maxDecodedResponseBytes: 2 * RPC_LIMITS.maxTotalResponseBytes,
        maxPlannedRequests: 2 * MAX_PLANNED_REQUESTS_PER_PROVIDER,
      },
    },
    localFailure: failure,
    sqliteReopenVerified: failure === undefined,
    durable: reopened && describeStatus(reopened),
    totals: totals(requests.flat()),
    providers: endpoints.map(({ id, endpoint }, index) => ({
      id,
      endpoint,
      totals: totals(requests[index]),
      byMethod: Object.fromEntries([...new Set(requests[index].map(({ method }) => method))].map((method) => [
        method, totals(requests[index].filter((request) => request.method === method)),
      ])),
      requests: requests[index].map((request) => ({ ...request, durationMs: Number(request.durationMs.toFixed(2)) })),
    })),
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = failure === undefined && reopened?.observation ? 0 : 1;
}

const args = process.argv.slice(2);
const secondary = args[0] ?? 'publicnode';
if (args.length > 1 || (secondary !== 'publicnode' && secondary !== 'onfinality')) {
  console.error('Usage: node live.ts [publicnode|onfinality]');
  process.exitCode = 2;
} else {
  await run(secondary);
}
