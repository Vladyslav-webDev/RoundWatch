import { createHash } from 'node:crypto';
import { CHAIN_ID, TRANSFER, USDC, Unresolved, requireEvidence, sameHeader } from './evidence.ts';
import type { Header, Log } from './evidence.ts';
import { BaseSepoliaRpc, RpcReadError } from './rpc.ts';
import type { RpcLimits, RpcMeasurement } from './rpc.ts';

const BASE = { id: 'base', endpoint: 'https://sepolia.base.org' };
const SECONDARY = {
  onfinality: { id: 'onfinality', endpoint: 'https://base-sepolia.api.onfinality.io/public' },
  publicnode: { id: 'publicnode', endpoint: 'https://base-sepolia-rpc.publicnode.com' },
} as const;

const LIMITS: RpcLimits = {
  maxRequests: 24,
  maxElapsedMs: 30_000,
  requestTimeoutMs: 4_000,
  maxResponseBytes: 262_144,
  maxTotalResponseBytes: 1_048_576,
  maxRangeBlocks: 4,
};

interface BlockRange {
  label: 'historical' | 'recent_finalized';
  fromHeight: number;
  toHeight: number;
}

const HISTORICAL: BlockRange = { label: 'historical', fromHeight: 42_123_681, toHeight: 42_123_684 };
const CANARY = {
  blockNumber: 42_123_682,
  transactionHash: '0xc4b59822afe0905e528e665631f024e798575853f6f1b7d11aff69f04d25237a',
};

function describeHeader({ height, hash, parentHash, timestamp, transactions }: Header) {
  return { height, hash, parentHash, timestamp, transactionCount: transactions.length };
}

function reason(error: unknown) {
  if (error instanceof RpcReadError) return error.reason;
  if (error instanceof Unresolved) return error.message;
  return 'unexpected_probe_error';
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function measure(samples: readonly RpcMeasurement[]) {
  return {
    requests: samples.length,
    requestBytes: samples.reduce((sum, sample) => sum + sample.requestBytes, 0),
    responseBytes: samples.reduce((sum, sample) => sum + sample.responseBytes, 0),
    summedLatencyMs: Number(samples.reduce((sum, sample) => sum + sample.durationMs, 0).toFixed(2)),
    maxLatencyMs: samples.length ? Number(Math.max(...samples.map((sample) => sample.durationMs)).toFixed(2)) : null,
  };
}

function normalizeTransfers(logs: readonly Log[], range: BlockRange, headers: Map<number, Header>) {
  const byPosition = new Map<string, Log>();
  for (const log of logs) {
    const header = headers.get(log.blockNumber);
    requireEvidence(log.blockNumber >= range.fromHeight && log.blockNumber <= range.toHeight &&
      header && header.hash === log.blockHash && header.transactions[log.transactionIndex] === log.transactionHash,
      'log_header_disagreement');
    requireEvidence(log.address === USDC && log.topics.length === 3 && log.topics[0] === TRANSFER &&
      log.topics.slice(1).every((topic) => /^0x0{24}[0-9a-f]{40}$/.test(topic)) &&
      /^0x[0-9a-f]{64}$/.test(log.data) && log.removed === false, 'unexpected_transfer_log');
    const position = `${log.blockNumber}:${log.logIndex}`;
    requireEvidence(!byPosition.has(position), 'duplicate_log_position');
    byPosition.set(position, log);
  }
  return [...byPosition.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

async function sampleTags(rpc: BaseSepoliaRpc, headers: Map<number, Header>) {
  const sample: {
    chainId?: number;
    finalized?: ReturnType<typeof describeHeader>;
    latest?: ReturnType<typeof describeHeader>;
    finalizedLag?: { blocks: number; seconds: number };
    issue?: { at: string; reason: string };
  } = {};
  let at = 'chain_id';
  try {
    sample.chainId = await rpc.chainId();
    requireEvidence(sample.chainId === CHAIN_ID, 'wrong_chain_id');
    at = 'finalized_tag';
    const finalized = await rpc.header('finalized');
    sample.finalized = describeHeader(finalized);
    at = 'latest_tag';
    const latest = await rpc.header('latest');
    sample.latest = describeHeader(latest);
    requireEvidence(latest.height >= finalized.height && latest.timestamp >= finalized.timestamp &&
      (latest.height !== finalized.height || sameHeader(latest, finalized)), 'inconsistent_latest_and_finalized');
    sample.finalizedLag = { blocks: latest.height - finalized.height, seconds: latest.timestamp - finalized.timestamp };
    at = 'numbered_finalized_anchor';
    const anchor = await rpc.header(finalized.height);
    requireEvidence(sameHeader(anchor, finalized), 'finalized_tag_anchor_disagreement');
    headers.set(anchor.height, anchor);
  } catch (error) {
    sample.issue = { at, reason: reason(error) };
  }
  return sample;
}

async function sampleRange(rpc: BaseSepoliaRpc, range: BlockRange, cache: Map<number, Header>) {
  const bounds = { ...range, blocks: range.toHeight - range.fromHeight + 1 };
  const headers = new Map<number, Header>();
  const cost = { headers: measure([]), rangeLogs: measure([]), singleHeightLogs: measure([]) };
  let rangedLogCount: number | undefined;
  let singleHeightLogCount: number | undefined;
  let logPositions: Pick<Log, 'blockNumber' | 'transactionHash' | 'logIndex'>[] | undefined;
  let canaryLogPositions: number[] | undefined;
  let logsDigest: string | undefined;
  let issue: { at: string; reason: string } | undefined;
  let at = 'range_limit';
  let phase: keyof typeof cost = 'headers';
  let start = rpc.metrics().length;

  function measurePhase() {
    cost[phase] = measure(rpc.metrics().slice(start));
    start = rpc.metrics().length;
  }

  try {
    requireEvidence(bounds.blocks > 0 && bounds.blocks <= LIMITS.maxRangeBlocks && range.fromHeight > 0,
      'invalid_range');
    let previous: Header | undefined;
    for (let height = range.fromHeight - 1; height <= range.toHeight; height++) {
      at = `numbered_header_${height}`;
      const header = cache.get(height) ?? await rpc.header(height);
      requireEvidence(header.height === height && (!previous ||
        (header.parentHash === previous.hash && header.timestamp >= previous.timestamp)), 'header_chain_disagreement');
      headers.set(height, header);
      previous = header;
    }

    measurePhase();
    phase = 'rangeLogs';
    at = 'range_logs';
    const ranged = normalizeTransfers(await rpc.logs(range.fromHeight, range.toHeight), range, headers);
    rangedLogCount = ranged.length;
    logPositions = ranged.map(({ blockNumber, transactionHash, logIndex }) => ({ blockNumber, transactionHash, logIndex }));
    measurePhase();
    phase = 'singleHeightLogs';

    const singles: Log[] = [];
    for (let height = range.fromHeight; height <= range.toHeight; height++) {
      at = `single_height_logs_${height}`;
      singles.push(...normalizeTransfers(await rpc.logs(height, height),
        { ...range, fromHeight: height, toHeight: height }, headers));
    }
    singleHeightLogCount = singles.length;
    at = 'range_and_single_height_comparison';
    const rangedDigest = digest(ranged);
    requireEvidence(rangedDigest === digest(singles), 'range_single_height_log_disagreement');
    if (range.label === 'historical') {
      at = 'historical_canary';
      canaryLogPositions = ranged.filter((log) => log.blockNumber === CANARY.blockNumber &&
        log.transactionHash === CANARY.transactionHash).map((log) => log.logIndex);
      requireEvidence(canaryLogPositions.length > 0, 'historical_canary_missing');
    }
    logsDigest = rangedDigest;
  } catch (error) {
    issue = { at, reason: reason(error) };
  } finally {
    measurePhase();
  }

  const numbered = [...headers.values()];
  return {
    ...bounds,
    headers: numbered.map(describeHeader),
    headerDigest: numbered.length === bounds.blocks + 1 ? digest(numbered) : undefined,
    rangedLogCount, singleHeightLogCount, logPositions, canaryLogPositions, logsDigest, cost,
    logRequestsSaved: logsDigest === undefined ? undefined :
      cost.singleHeightLogs.requests - cost.rangeLogs.requests,
    issue,
  };
}

async function qualify(secondary: keyof typeof SECONDARY) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const states = [BASE, SECONDARY[secondary]].map((provider) => ({
    ...provider,
    rpc: new BaseSepoliaRpc(provider.id, provider.endpoint, LIMITS),
    cache: new Map<number, Header>(),
  }));

  const tags = await Promise.all(states.map(({ rpc, cache }) => sampleTags(rpc, cache)));
  const heights = tags.flatMap((tag) => tag.finalized ? [tag.finalized.height] : []);
  const commonHeight = heights.length === states.length && tags.every((tag) => !tag.issue) ?
    Math.min(...heights) : undefined;
  const recent: BlockRange | undefined = commonHeight !== undefined && commonHeight >= LIMITS.maxRangeBlocks ? {
    label: 'recent_finalized', fromHeight: commonHeight - LIMITS.maxRangeBlocks + 1, toHeight: commonHeight,
  } : undefined;

  const samples = await Promise.all(states.map(async ({ rpc, cache }, index) => {
    const tag = tags[index];
    const ranges = [];
    let historicalSkipped: string | undefined;
    if (!tag.issue && tag.finalized && tag.finalized.height >= HISTORICAL.toHeight) {
      ranges.push(await sampleRange(rpc, HISTORICAL, cache));
    } else {
      historicalSkipped = tag.issue ? 'tag_checks_incomplete' : 'historical_range_above_finality';
    }
    if (!tag.issue && recent) ranges.push(await sampleRange(rpc, recent, cache));
    return { tag, ranges, historicalSkipped };
  }));

  const left = samples[0];
  const right = samples[1];
  const compare = (label: BlockRange['label']) => {
    const a = left.ranges.find((range) => range.label === label);
    const b = right.ranges.find((range) => range.label === label);
    if (!a || !b || a.issue || b.issue || !a.headerDigest || !b.headerDigest || !a.logsDigest || !b.logsDigest) {
      return { label, status: 'unresolved', reason: 'insufficient_provider_coverage' };
    }
    if (a.headerDigest !== b.headerDigest) return { label, status: 'unresolved', reason: 'provider_header_disagreement' };
    if (a.logsDigest !== b.logsDigest) return { label, status: 'unresolved', reason: 'provider_log_disagreement' };
    return { label, status: 'operational_agreement' };
  };
  const ranges = [compare('historical'), compare('recent_finalized')];
  const agreed = ranges.every((range) => range.status === 'operational_agreement');
  const result = {
    status: agreed ? 'operational_agreement' : 'unresolved',
    chainId: CHAIN_ID,
    transferFilter: { address: USDC, topics: [TRANSFER] },
    startedAt,
    elapsedMs: Number((performance.now() - started).toFixed(2)),
    limitsPerProvider: LIMITS,
    plannedHistoricalRange: HISTORICAL,
    historicalCanary: CANARY,
    sampledCommonFinalizedHeight: commonHeight,
    finalizedTagSkewBlocks: heights.length === states.length ? Math.max(...heights) - Math.min(...heights) : null,
    plannedRecentRange: recent,
    ranges,
    providers: states.map(({ id, endpoint, rpc }, index) => {
      const requests = rpc.metrics();
      const methods = [...new Set(requests.map(({ method }) => method))];
      return {
        id, endpoint, ...samples[index], totals: measure(requests),
        byMethod: Object.fromEntries(methods.map((method) => [method,
          measure(requests.filter((request) => request.method === method))])),
        requests,
      };
    }),
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = agreed ? 0 : 1;
}

const args = process.argv.slice(2);
const secondary = args[0] ?? 'onfinality';
if (args.length > 1 || (secondary !== 'onfinality' && secondary !== 'publicnode')) {
  console.error('Usage: node qualification.ts [onfinality|publicnode]');
  process.exitCode = 2;
} else {
  await qualify(secondary);
}
