import { addressTopic, CHAIN_ID, inFilter, TRANSFER, USDC } from './evidence.ts';
import type { EvidenceIds, FixtureEvidence, Header, Log, Receipt, WatchInput } from './evidence.ts';

export const SOURCES: EvidenceIds = ['view-a', 'view-b', 'receipt-oracle'];
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
export const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
export const SENDER = address(1);
export const RECIPIENT = address(2);
export const OTHER = address(3);
export const ZERO = address(0);
export const AMOUNT = '9007199254740993';

export function transfer(overrides: Partial<Pick<Log, 'address' | 'topics' | 'data'>> = {}) {
  return { address: USDC, topics: [TRANSFER, addressTopic(SENDER), addressTopic(RECIPIENT)],
    data: `0x${BigInt(AMOUNT).toString(16).padStart(64, '0')}`, ...overrides };
}

export interface BlockFixture {
  header: Header;
  receipts: readonly Receipt[];
}

// Each nested array is the complete log list for one successful transaction.
export function block(height: number, parentHash: string, timestamp: number,
  transactions: readonly (readonly ReturnType<typeof transfer>[])[] = [], fork = 0): BlockFixture {
  const blockHash = hash(height + fork * 1000);
  const header = { height, hash: blockHash, parentHash, timestamp,
    transactions: transactions.map((_, index) => hash(100_000 + height * 100 + index + fork * 100_000)) };
  let logIndex = 0;
  const receipts: Receipt[] = transactions.map((logs, transactionIndex) => {
    const position = { blockNumber: height, blockHash, transactionIndex,
      transactionHash: header.transactions[transactionIndex] };
    return { ...position, status: 1, logs: logs.map((log) => ({ ...log, ...position, logIndex: logIndex++, removed: false })) };
  });
  return { header, receipts };
}

export function scenario(
  at103: readonly (readonly ReturnType<typeof transfer>[])[] = [[transfer()]],
  at104: readonly (readonly ReturnType<typeof transfer>[])[] = [],
) {
  const blocks = [
    block(100, hash(99), 997),
    block(101, hash(100), 998, [[transfer()]]),
    block(102, hash(101), 999, [[transfer()]]),
    block(103, hash(102), 1000, at103),
    block(104, hash(103), 1000, at104),
    block(105, hash(104), 1001),
    block(106, hash(105), 1002, [[transfer()]]),
    block(107, hash(106), 1002, [[transfer()]]),
  ];
  const watch: WatchInput = {
    id: 'invoice-a', chainId: CHAIN_ID, token: USDC, sender: SENDER, recipient: RECIPIENT,
    amountAtomic: AMOUNT, finalizedAtArm: blocks[0].header, latestAtArm: blocks[1].header,
    armedAtSec: 999, opensAtSec: 1000, deadlineSec: 1002, workLimit: 500,
  };
  return { blocks, watch };
}

export function evidence(blocks: readonly BlockFixture[], finalizedHeight = blocks.at(-1)!.header.height): FixtureEvidence {
  const byHeight = new Map(blocks.map((entry) => [entry.header.height, entry]));
  const byHash = new Map(blocks.map((entry) => [entry.header.hash, entry]));
  // The fixture range responses are materialized independently of receipt reads so either can be faulted.
  const rangeLogs = new Map(blocks.map((entry) => [entry.header.height, entry.receipts.flatMap(({ logs }) => logs)]));
  const view = (id: string): FixtureEvidence['views'][number] => ({
    id,
    chainId: () => CHAIN_ID,
    finalized: () => byHeight.get(finalizedHeight)?.header,
    header: (height) => byHeight.get(height)?.header,
    logs: (height, filter) => rangeLogs.get(height)?.filter((log) => inFilter(log, filter)),
  });
  return {
    views: [view(SOURCES[0]), view(SOURCES[1])],
    oracle: {
      id: SOURCES[2], chainId: () => CHAIN_ID,
      finalizedHeader: (height) => height <= finalizedHeight ? byHeight.get(height)?.header : undefined,
      receipts: (blockHash) => {
        const entry = byHash.get(blockHash);
        return entry && entry.header.height <= finalizedHeight ? entry.receipts : undefined;
      },
    },
  };
}
