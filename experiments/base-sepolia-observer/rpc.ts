import { CHAIN_ID, TRANSFER, USDC } from './evidence.ts';
import type { Filter, Header, Log } from './evidence.ts';

type BlockReference = number | 'latest' | 'finalized';
type RpcMethod = 'eth_chainId' | 'eth_getBlockByNumber' | 'eth_getLogs';

export interface HistoricalRpcProvider {
  readonly id: string;
  chainId(): Promise<number>;
  header(block: BlockReference): Promise<Header>;
  logs(fromHeight: number, toHeight: number, filter?: Filter): Promise<readonly Log[]>;
}

export interface RpcLimits {
  readonly maxRequests: number;
  readonly maxElapsedMs: number;
  readonly requestTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxTotalResponseBytes: number;
  readonly maxRangeBlocks: number;
}

export interface RpcMeasurement {
  readonly method: RpcMethod;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly durationMs: number;
  readonly outcome: string;
  readonly httpStatus?: number;
  readonly rpcCode?: number;
  readonly transportCode?: string;
}

export class RpcReadError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'RpcReadError';
    this.reason = reason;
  }
}

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_REQUEST_BYTES = 512;
const READ_CHUNK_BYTES = 16 * 1024;
const ADDRESS_TOPIC_PREFIX = `0x${'0'.repeat(24)}`;
const USDC_TRANSFERS: Filter = Object.freeze({ address: USDC, topics: Object.freeze([TRANSFER]) });
const TRANSPORT_CODES = new Set([
  'EACCES', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EPERM', 'ETIMEDOUT', 'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new RpcReadError(reason);
}

function object(value: unknown, reason: string): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), reason);
  return value as Record<string, unknown>;
}

function array(value: unknown, reason: string): readonly unknown[] {
  check(Array.isArray(value), reason);
  return value;
}

function quantity(value: unknown, reason: string): number {
  check(typeof value === 'string' && value.startsWith('0x'), reason);
  const digits = value.slice(2);
  check(digits.length >= 1 && digits.length <= 14 && !/[^0-9a-f]/i.test(digits) &&
    (digits.length === 1 || !digits.startsWith('0')), reason);
  const result = Number(value);
  check(Number.isSafeInteger(result), reason);
  return result;
}

function blockNumber(height: number): string {
  check(Number.isSafeInteger(height) && height >= 0, 'invalid_block_number');
  return `0x${height.toString(16)}`;
}

function hex(value: unknown, bytes: number, reason: string): string {
  check(typeof value === 'string' && value.length === 2 + 2 * bytes && value.startsWith('0x') &&
    !/[^0-9a-f]/i.test(value.slice(2)), reason);
  return value.toLowerCase();
}

function parseHeader(raw: unknown, reference: BlockReference): Header {
  const reason = 'invalid_header';
  check(raw !== null, 'header_unavailable');
  const block = object(raw, reason);
  const height = quantity(block.number, reason);
  check(typeof reference !== 'number' || reference === height, 'wrong_header_height');
  const transactions = array(block.transactions, reason).map((hash) => hex(hash, 32, reason));
  check(new Set(transactions).size === transactions.length, reason);
  return {
    height, hash: hex(block.hash, 32, reason), parentHash: hex(block.parentHash, 32, reason),
    timestamp: quantity(block.timestamp, reason), transactions,
  };
}

function parseLog(raw: unknown): Log {
  const reason = 'invalid_log';
  const log = object(raw, reason);
  const rawTopics = array(log.topics, reason);
  check(log.removed === false && rawTopics.length === 3, reason);
  const topics = rawTopics.map((topic) => hex(topic, 32, reason));
  check(topics[0] === TRANSFER && topics.slice(1).every((topic) => topic.startsWith(ADDRESS_TOPIC_PREFIX)), reason);
  return {
    address: hex(log.address, 20, reason), topics,
    data: hex(log.data, 32, reason), blockHash: hex(log.blockHash, 32, reason),
    blockNumber: quantity(log.blockNumber, reason), transactionHash: hex(log.transactionHash, 32, reason),
    transactionIndex: quantity(log.transactionIndex, reason), logIndex: quantity(log.logIndex, reason),
    removed: false,
  };
}

function usdcFilter(filter: Filter): Filter {
  const reason = 'invalid_usdc_filter';
  check(filter, reason);
  const address = hex(filter.address, 20, reason);
  check(address === USDC && Array.isArray(filter.topics) &&
    (filter.topics.length === 1 || filter.topics.length === 3), reason);
  const topics = filter.topics.map((topic) => hex(topic, 32, reason));
  check(topics[0] === TRANSFER && topics.slice(1).every((topic) => topic.startsWith(ADDRESS_TOPIC_PREFIX)), reason);
  return { address, topics };
}

function knownTransportCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause = error.cause as { code?: unknown } | undefined;
  const code = cause?.code;
  return typeof code === 'string' && TRANSPORT_CODES.has(code) ? code : undefined;
}

export class BaseSepoliaRpc implements HistoricalRpcProvider {
  readonly id: string;
  readonly #endpoint: URL;
  readonly #limits: RpcLimits;
  readonly #fetch: typeof fetch;
  readonly #startedAt = performance.now();
  readonly #measurements: RpcMeasurement[] = [];
  #responseBytes = 0;
  #busy = false;
  #verifiedChain = false;

  constructor(id: string, endpoint: string, limits: RpcLimits, fetcher: typeof fetch = fetch) {
    check(id.length >= 1 && id.length <= 64 && !/[^a-z0-9_-]/i.test(id), 'invalid_provider_id');
    try {
      this.#endpoint = new URL(endpoint);
    } catch {
      throw new RpcReadError('invalid_rpc_endpoint');
    }
    const { protocol, username, password, search, hash } = this.#endpoint;
    check(protocol === 'https:' && !username && !password && !search && !hash, 'invalid_rpc_endpoint');
    for (const limit of [limits.maxRequests, limits.maxElapsedMs, limits.requestTimeoutMs,
      limits.maxResponseBytes, limits.maxTotalResponseBytes, limits.maxRangeBlocks]) {
      check(Number.isSafeInteger(limit) && limit > 0, 'invalid_rpc_limits');
    }
    check(limits.maxElapsedMs <= MAX_TIMEOUT_MS && limits.requestTimeoutMs <= MAX_TIMEOUT_MS,
      'invalid_rpc_limits');
    this.id = id;
    this.#limits = { ...limits };
    this.#fetch = fetcher;
  }

  metrics(): readonly RpcMeasurement[] {
    return this.#measurements.slice();
  }

  async chainId(): Promise<number> {
    check(!this.#busy, 'rpc_request_in_progress');
    this.#verifiedChain = false;
    const chain = await this.#request('eth_chainId', [], (result) => quantity(result, 'invalid_chain_id'));
    this.#verifiedChain = chain === CHAIN_ID;
    return chain;
  }

  async header(block: BlockReference): Promise<Header> {
    check(this.#verifiedChain, 'base_sepolia_not_verified');
    const reference = block === 'latest' || block === 'finalized' ? block : blockNumber(block);
    return this.#request('eth_getBlockByNumber', [reference, false], (result) => parseHeader(result, block));
  }

  async logs(fromHeight: number, toHeight: number, filter: Filter = USDC_TRANSFERS): Promise<readonly Log[]> {
    check(this.#verifiedChain, 'base_sepolia_not_verified');
    const fromBlock = blockNumber(fromHeight);
    const toBlock = blockNumber(toHeight);
    check(toHeight >= fromHeight && toHeight - fromHeight < this.#limits.maxRangeBlocks, 'log_range_limit');
    const { address, topics } = usdcFilter(filter);
    return this.#request('eth_getLogs', [{ fromBlock, toBlock, address, topics }], (result) => {
      return array(result, 'invalid_log_response').map((item) => {
        const log = parseLog(item);
        check(log.blockNumber >= fromHeight && log.blockNumber <= toHeight && log.address === address &&
          topics.every((topic, index) => log.topics[index] === topic), 'unexpected_transfer_log');
        return log;
      });
    });
  }

  async #request<T>(method: RpcMethod, params: unknown[], parse: (value: unknown) => T): Promise<T> {
    check(!this.#busy, 'rpc_request_in_progress');
    check(this.#measurements.length < this.#limits.maxRequests, 'rpc_request_budget');
    const start = performance.now();
    const remainingMs = this.#limits.maxElapsedMs - (start - this.#startedAt);
    check(remainingMs > 0, 'rpc_time_budget');
    const remainingBytes = this.#limits.maxTotalResponseBytes - this.#responseBytes;
    check(remainingBytes > 0, 'rpc_total_byte_budget');
    const bodyLimit = Math.min(this.#limits.maxResponseBytes, remainingBytes);
    const id = this.#measurements.length + 1;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const requestBytes = Buffer.byteLength(body);
    check(requestBytes <= MAX_REQUEST_BYTES, 'rpc_request_byte_limit');

    const allowanceMs = Math.min(remainingMs, this.#limits.requestTimeoutMs);
    const signal = AbortSignal.timeout(Math.ceil(allowanceMs));
    let responseBytes = 0;
    let httpStatus: number | undefined;
    let rpcCode: number | undefined;
    let transportCode: string | undefined;
    let outcome = 'ok';
    this.#busy = true;
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', 'accept-encoding': 'identity' },
        redirect: 'error', body, signal,
      });
      httpStatus = response.status;
      const encoding = response.headers.get('content-encoding');
      const contentLength = !encoding || encoding.toLowerCase() === 'identity'
        ? response.headers.get('content-length') : null;
      const declaredBytes = contentLength === null ? undefined : Number(contentLength);
      if (!response.ok || (declaredBytes !== undefined && declaredBytes > bodyLimit)) {
        void response.body?.cancel().catch(() => {});
        throw new RpcReadError(response.ok ? 'rpc_response_byte_limit' : 'rpc_http_status');
      }

      const reader = response.body?.getReader({ mode: 'byob' });
      check(reader, 'rpc_empty_response');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const chunks: string[] = [];
      try {
        while (true) {
          // Stop at the ceiling if EOF has not been observed. Reading one more byte could exceed it.
          check(responseBytes < bodyLimit, 'rpc_response_byte_limit');
          const buffer = new Uint8Array(Math.min(READ_CHUNK_BYTES, bodyLimit - responseBytes));
          const { done, value } = await reader.read(buffer);
          if (done) break;
          responseBytes += value.byteLength;
          chunks.push(decoder.decode(value, { stream: true }));
          check(performance.now() - start < allowanceMs, 'rpc_timeout');
        }
        chunks.push(decoder.decode());
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      check(declaredBytes === undefined || declaredBytes === responseBytes, 'rpc_truncated_response');

      let raw: unknown;
      try {
        raw = JSON.parse(chunks.join(''));
      } catch {
        throw new RpcReadError('rpc_invalid_json');
      }
      const envelope = object(raw, 'rpc_invalid_envelope');
      check(envelope.jsonrpc === '2.0' && envelope.id === id, 'rpc_invalid_envelope');
      if (Object.hasOwn(envelope, 'error')) {
        check(!Object.hasOwn(envelope, 'result'), 'rpc_invalid_envelope');
        const error = object(envelope.error, 'rpc_invalid_envelope');
        check(typeof error.code === 'number' && Number.isSafeInteger(error.code) &&
          typeof error.message === 'string', 'rpc_invalid_envelope');
        rpcCode = error.code;
        throw new RpcReadError('rpc_remote_error');
      }
      check(Object.hasOwn(envelope, 'result'), 'rpc_invalid_envelope');
      const result = parse(envelope.result);
      check(performance.now() - start < allowanceMs, 'rpc_timeout');
      return result;
    } catch (error) {
      transportCode = knownTransportCode(error);
      const failure = signal.aborted ? new RpcReadError('rpc_timeout') : error instanceof RpcReadError
        ? error : new RpcReadError('rpc_transport_error');
      outcome = failure.reason;
      throw failure;
    } finally {
      this.#responseBytes += responseBytes;
      this.#measurements.push(Object.freeze({
        method, requestBytes, responseBytes, durationMs: performance.now() - start,
        outcome, httpStatus, rpcCode, transportCode,
      }));
      this.#busy = false;
    }
  }
}
