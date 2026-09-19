import { isValidAlgorandAddress } from '@x402/avm';

import {
   MAINNET_NETWORK_CONFIG,
   TESTNET_NETWORK_CONFIG,
   type RoundWatchNetworkConfig,
} from './network-config.js';

type ProbeName =
   | 'baseline'
   | 'exact-amount-range'
   | 'note-prefix'
   | 'receiver-role';

interface ProbeResult {
   name: ProbeName;
   status: number;
   supported: boolean;
   responseBytes: number;
   detail: string;
}

const network = resolveProbeNetwork(
   process.env.ROUNDWATCH_PROBE_NETWORK?.trim().toLowerCase(),
);
const indexerUrl =
   process.env.ALGORAND_INDEXER_URL?.trim() || network.indexerUrl;

const ZERO_ADDRESS: string =
   'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const PROBE_ADDRESS: string =
   'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';

if (
   !isValidAlgorandAddress(PROBE_ADDRESS) ||
   PROBE_ADDRESS === ZERO_ADDRESS
) {
   throw new Error('Indexer capability probe requires a non-zero valid address');
}

console.log(
   `RoundWatch Indexer capability probe network=${network.name} endpoint=${indexerUrl}`,
);
console.log(
   'Read-only probe: one health request plus four transaction queries with limit=1.',
);

const health = await requestJson(new URL('/health', indexerUrl));
if (!health.response.ok) {
   throw new Error(
      `Indexer health failed with HTTP ${health.response.status}: ${health.text.slice(0, 200)}`,
   );
}
const healthBody = asRecord(health.body, 'health');
const tip = safeRound(healthBody.round, 'health round');

const base = new URL(
   `/v2/assets/${network.usdcAssetIdNumber}/transactions`,
   indexerUrl,
);
base.searchParams.set('tx-type', 'axfer');
base.searchParams.set('address', PROBE_ADDRESS);
base.searchParams.set('address-role', 'sender');
base.searchParams.set('min-round', String(tip));
base.searchParams.set('max-round', String(tip));
base.searchParams.set('limit', '1');

const probes: Array<{ name: ProbeName; url: URL }> = [
   { name: 'baseline', url: new URL(base) },
   {
      name: 'exact-amount-range',
      url: withParams(base, {
         'currency-greater-than': '0',
         'currency-less-than': '2',
      }),
   },
   {
      name: 'note-prefix',
      url: withParams(base, {
         'note-prefix': Buffer.from(
            'roundwatch:capability-probe',
            'utf8',
         ).toString('base64'),
      }),
   },
   {
      name: 'receiver-role',
      url: (() => {
         const url = new URL(base);
         url.searchParams.set('address', PROBE_ADDRESS);
         url.searchParams.set('address-role', 'receiver');
         return url;
      })(),
   },
];

const results: ProbeResult[] = [];
for (const probe of probes) {
   const result = await requestJson(probe.url);
   results.push({
      name: probe.name,
      status: result.response.status,
      supported: result.response.ok,
      responseBytes: Buffer.byteLength(result.text, 'utf8'),
      detail: summarize(result.body, result.text),
   });
}

console.table(results);
console.log(
   'PROBE_SUMMARY ' +
      JSON.stringify({
         network: network.name,
         endpoint: indexerUrl,
         round: tip,
         results,
      }),
);

if (!results[0]?.supported) {
   process.exitCode = 2;
}

function resolveProbeNetwork(
   value: string | undefined,
): RoundWatchNetworkConfig {
   if (!value || value === 'testnet') return TESTNET_NETWORK_CONFIG;
   if (value === 'mainnet') return MAINNET_NETWORK_CONFIG;
   throw new Error(
      'ROUNDWATCH_PROBE_NETWORK must be testnet or mainnet',
   );
}

function withParams(
   source: URL,
   params: Record<string, string>,
): URL {
   const url = new URL(source);
   for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
   }
   return url;
}

async function requestJson(
   url: URL,
): Promise<{
   response: Response;
   text: string;
   body: unknown;
}> {
   const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
   });
   const text = await response.text();

   let body: unknown;
   try {
      body = text.length === 0 ? {} : JSON.parse(text);
   } catch {
      body = undefined;
   }

   return { response, text, body };
}

function summarize(body: unknown, text: string): string {
   if (body && typeof body === 'object' && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      if (typeof record.message === 'string') {
         return record.message.slice(0, 160);
      }
      if (typeof record.error === 'string') {
         return record.error.slice(0, 160);
      }
      if (Array.isArray(record.transactions)) {
         return `ok transactions=${record.transactions.length}`;
      }
   }

   return text.replace(/\s+/g, ' ').slice(0, 160) || 'empty response';
}

function asRecord(
   value: unknown,
   label: string,
): Record<string, unknown> {
   if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${label} response is not an object`);
   }
   return value as Record<string, unknown>;
}

function safeRound(value: unknown, label: string): number {
   if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(`${label} is invalid`);
   }
   return value as number;
}
