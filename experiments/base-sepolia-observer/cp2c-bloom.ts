import { keccak_256 } from '@noble/hashes/sha3.js';
import { filterFor, requireEvidence, type Log, type WatchInput } from './evidence.ts';

const BLOOM_BYTES = 256;

export function keccak256(bytes: Uint8Array): Buffer {
  return Buffer.from(keccak_256(bytes));
}

function fixedBytes(value: unknown, length: number, reason: string): Buffer {
  requireEvidence(typeof value === 'string' && value.length === 2 + 2 * length &&
    /^0x[0-9a-f]+$/i.test(value), reason);
  return Buffer.from(value.slice(2), 'hex');
}

// Yellow Paper §4.4.1. Interpret the first three hash pairs as big-endian
// uint16s. Their low 11 bits index from the least-significant end of the bloom.
function bloomPositions(value: Uint8Array): number[] {
  const hash = keccak256(value);
  return [0, 2, 4].map((offset) => hash.readUInt16BE(offset) & 0x7ff);
}

function bloomElements(log: Pick<Log, 'address' | 'topics'>): Buffer[] {
  requireEvidence(log && Array.isArray(log.topics) && log.topics.length <= 4, 'invalid_bloom_topics');
  return [fixedBytes(log.address, 20, 'invalid_bloom_address'),
    ...Array.from(log.topics, (topic) => fixedBytes(topic, 32, 'invalid_bloom_topic'))];
}

export function bloomForLogs(logs: readonly Pick<Log, 'address' | 'topics'>[]): Buffer {
  const bloom = Buffer.alloc(BLOOM_BYTES);
  for (const log of logs) {
    for (const element of bloomElements(log)) {
      for (const bit of bloomPositions(element)) {
        bloom[BLOOM_BYTES - 1 - (bit >> 3)] |= 1 << (bit & 7);
      }
    }
  }
  return bloom;
}

// Membership applies to each element separately. The caller is responsible
// for binding logsBloom to authenticated finalized history before exclusion.
export function transferBloomResult(
  logsBloom: string, watch: Pick<WatchInput, 'token' | 'sender' | 'recipient'>,
): 'EXCLUDED' | 'POSSIBLE' {
  const bloom = fixedBytes(logsBloom, BLOOM_BYTES, 'invalid_logs_bloom');
  fixedBytes(watch.sender, 20, 'invalid_bloom_sender');
  fixedBytes(watch.recipient, 20, 'invalid_bloom_recipient');
  const filter = filterFor(watch);
  const elements = bloomElements(filter);
  const possible = elements.every((element) => bloomPositions(element).every((bit) =>
    (bloom[BLOOM_BYTES - 1 - (bit >> 3)] & (1 << (bit & 7))) !== 0));
  return possible ? 'POSSIBLE' : 'EXCLUDED';
}
