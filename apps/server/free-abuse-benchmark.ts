import { performance } from 'node:perf_hooks';

import type { FacilitatorClient } from '@x402/core/server';
import type {
   PaymentPayload,
   PaymentRequirements,
   VerifyResponse,
} from '@x402/core/types';
import {
   decodePaymentRequiredHeader,
   encodePaymentSignatureHeader,
} from '@x402/core/http';

import {
   ALGORAND_TESTNET,
   createApp,
   TESTNET_USDC_ASSET_ID,
} from './app.js';
import {
   FREE_REQUEST_CATEGORIES,
   RoundWatchEconomicsMetrics,
   type FreeRequestCategory,
   type FreeWorkSnapshot,
} from './roundwatch-metrics.js';
import { RoundWatchStore } from './roundwatch-store.js';

const REQUESTS = positiveInteger(
   envNumber('ROUNDWATCH_FREE_BENCH_REQUESTS', 5_000),
   'ROUNDWATCH_FREE_BENCH_REQUESTS',
);
const CONCURRENCY = positiveInteger(
   envNumber('ROUNDWATCH_FREE_BENCH_CONCURRENCY', 50),
   'ROUNDWATCH_FREE_BENCH_CONCURRENCY',
);

const PAYER =
   'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const RECEIVER =
   'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';
const SIGNED_SERVICE_PAYMENT =
   'gqNzaWfEQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACjdHhuiqRhYW10zQPopGFyY3bEIAhCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCo2ZlZQCiZnZko2dlbqx0ZXN0bmV0LXYxLjCiZ2jEIEhjtRiks8hOyBDyLU8QgcsPcfBZp6wg3sYvf3DlCToiomx2zMijc25kxCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKR0eXBlpWF4ZmVypHhhaWTOAJ+XPQ==';

interface Scenario {
   name: string;
   category: FreeRequestCategory;
   request: () => Response | Promise<Response>;
}

interface ScenarioResult {
   name: string;
   category: FreeRequestCategory;
   requests: number;
   concurrency: number;
   elapsedMs: number;
   requestsPerSecond: number;
   cpuUserMs: number;
   cpuSystemMs: number;
   cpuMsPerRequest: number;
   clientLatencyMs: Distribution;
   requestBytes: number;
   responseBytes: number;
   responseBytesPerRequest: number;
   metricWallMsPerRequest: number;
   statuses: Record<string, number>;
   thrown: number;
   facilitatorVerifyCalls: number;
}

interface Distribution {
   mean: number;
   p50: number;
   p95: number;
   max: number;
}

class RejectingFacilitator {
   verifyCalls = 0;

   async verify(
      _payload: PaymentPayload,
      _requirements: PaymentRequirements,
   ): Promise<VerifyResponse> {
      this.verifyCalls += 1;
      return {
         isValid: false,
         invalidReason: 'synthetic free-abuse rejection',
      } as VerifyResponse;
   }

   async settle(): Promise<never> {
      throw new Error(
         'free-abuse benchmark must never settle a payment',
      );
   }

   async getSupported() {
      return {
         kinds: [
            {
               x402Version: 2 as const,
               scheme: 'exact',
               network: ALGORAND_TESTNET,
            },
         ],
         extensions: [],
         signers: {},
      };
   }
}

const metrics = new RoundWatchEconomicsMetrics();
const store = new RoundWatchStore(':memory:', {
   maxOpenWatches: 5,
   maxOpenWatchesPerPayer: 5,
});
const facilitator = new RejectingFacilitator();

const app = createApp({
   avmAddress: RECEIVER,
   facilitatorClient: facilitator as unknown as FacilitatorClient,
   store,
   indexer: {} as never,
   economicsMetrics: metrics,
   syncFacilitatorOnStart: false,
});

const validBody = JSON.stringify({
   idempotencyKey: 'free-abuse-benchmark-001',
   expectedSender: PAYER,
   expectedReceiver: RECEIVER,
   atomicAmount: '1',
   invoiceNote: 'free-abuse-benchmark',
});
const malformedBody = '{"idempotencyKey":';

const statusWatch = store.prepareWatch(
   {
      idempotencyKey: 'free-status-hit-001',
      expectedSender: PAYER,
      expectedReceiver: RECEIVER,
      assetId: TESTNET_USDC_ASSET_ID,
      atomicAmount: '1',
      invoiceNote: 'free-status-hit',
   },
   {
      expectedTransaction: 'FREE_STATUS_SERVICE_TX',
      network: ALGORAND_TESTNET,
      payer: PAYER,
      receiver: RECEIVER,
      assetId: TESTNET_USDC_ASSET_ID,
      atomicAmount: '1000',
      firstValid: 1,
      lastValid: 100,
   },
).watch;
store.activateWatch(
   statusWatch.id,
   {
      transaction: 'FREE_STATUS_SERVICE_TX',
      network: ALGORAND_TESTNET,
      payer: PAYER,
   },
   1,
);

const setupChallenge = await app.request('/spike/watch', {
   method: 'POST',
   headers: bodyHeaders(validBody),
   body: validBody,
});
await setupChallenge.arrayBuffer();

if (setupChallenge.status !== 402) {
   throw new Error(
      `Expected setup challenge 402, got ${setupChallenge.status}`,
   );
}

const encodedRequired = setupChallenge.headers.get('payment-required');
if (!encodedRequired) {
   throw new Error('Setup challenge had no payment-required header');
}
const accepted = decodePaymentRequiredHeader(encodedRequired).accepts[0];
if (!accepted) {
   throw new Error('Setup challenge advertised no accepted payment');
}

const rejectedPaymentHeader = encodePaymentSignatureHeader({
   x402Version: 2,
   accepted,
   payload: {
      paymentGroup: [SIGNED_SERVICE_PAYMENT],
      paymentIndex: 0,
   },
});

const scenarios: Scenario[] = [
   {
      name: 'health',
      category: 'health',
      request: () => app.request('/health'),
   },
   {
      name: 'status-miss',
      category: 'watch-status',
      request: () =>
         app.request(
            '/spike/watch/00000000-0000-0000-0000-000000000000',
         ),
   },
   {
      name: 'status-hit',
      category: 'watch-status',
      request: () => app.request(`/spike/watch/${statusWatch.id}`),
   },
   {
      name: 'unpaid-create',
      category: 'watch-create-402',
      request: () =>
         app.request('/spike/watch', {
            method: 'POST',
            headers: bodyHeaders(validBody),
            body: validBody,
         }),
   },
   {
      name: 'unpaid-malformed-body',
      category: 'watch-create-402',
      request: () =>
         app.request('/spike/watch', {
            method: 'POST',
            headers: bodyHeaders(malformedBody),
            body: malformedBody,
         }),
   },
   {
      name: 'malformed-payment-header',
      category: 'watch-create-payment-rejected',
      request: () =>
         app.request('/spike/watch', {
            method: 'POST',
            headers: {
               ...bodyHeaders(validBody),
               'payment-signature': 'not-a-valid-x402-header',
            },
            body: validBody,
         }),
   },
   {
      name: 'facilitator-rejected-payment',
      category: 'watch-create-payment-rejected',
      request: () =>
         app.request('/spike/watch', {
            method: 'POST',
            headers: {
               ...bodyHeaders(validBody),
               'payment-signature': rejectedPaymentHeader,
            },
            body: validBody,
         }),
   },
];

const results: ScenarioResult[] = [];

try {
   console.log(
      [
         'RoundWatch Free-Abuse Benchmark v1',
         `requests/scenario: ${REQUESTS}`,
         `concurrency: ${CONCURRENCY}`,
         'In-process Hono benchmark: structural CPU/serialization/SQLite/payment-middleware cost, not internet throughput or Render SLA.',
      ].join('\n'),
   );

   for (const scenario of scenarios) {
      const result = await runScenario(scenario);
      results.push(result);
      console.log(`FREE_BENCH_RESULT ${JSON.stringify(result)}`);
   }

   console.table(
      results.map(result => ({
         scenario: result.name,
         category: result.category,
         requests: result.requests,
         status: summarizeStatuses(result.statuses),
         'req/s': round(result.requestsPerSecond),
         'CPU ms/req': round(result.cpuMsPerRequest, 4),
         'p50 ms': round(result.clientLatencyMs.p50, 3),
         'p95 ms': round(result.clientLatencyMs.p95, 3),
         'max ms': round(result.clientLatencyMs.max, 3),
         'resp B/req': round(result.responseBytesPerRequest, 1),
         'verify calls': result.facilitatorVerifyCalls,
         thrown: result.thrown,
      })),
   );

   console.log(
      'FREE_BENCH_SUMMARY ' +
         JSON.stringify({
            requestsPerScenario: REQUESTS,
            concurrency: CONCURRENCY,
            results,
         }),
   );
} finally {
   store.close();
}

async function runScenario(
   scenario: Scenario,
): Promise<ScenarioResult> {
   const beforeMetric = metrics.snapshotFreeWork(scenario.category);
   const verifyCallsBefore = facilitator.verifyCalls;
   const cpuBefore = process.cpuUsage();
   const startedAt = performance.now();
   const latencies: number[] = [];
   let thrown = 0;

   for (let offset = 0; offset < REQUESTS; offset += CONCURRENCY) {
      const batchSize = Math.min(CONCURRENCY, REQUESTS - offset);
      await Promise.all(
         Array.from({ length: batchSize }, async () => {
            const requestStartedAt = performance.now();
            try {
               const response = await scenario.request();
               await response.arrayBuffer();
            } catch {
               thrown += 1;
            } finally {
               latencies.push(performance.now() - requestStartedAt);
            }
         }),
      );
   }

   const elapsedMs = performance.now() - startedAt;
   const cpu = process.cpuUsage(cpuBefore);
   const afterMetric = metrics.snapshotFreeWork(scenario.category);
   const metric = subtractFreeWork(afterMetric, beforeMetric);
   const cpuTotalMs = (cpu.user + cpu.system) / 1_000;

   return {
      name: scenario.name,
      category: scenario.category,
      requests: REQUESTS,
      concurrency: CONCURRENCY,
      elapsedMs,
      requestsPerSecond:
         elapsedMs === 0 ? 0 : REQUESTS / (elapsedMs / 1_000),
      cpuUserMs: cpu.user / 1_000,
      cpuSystemMs: cpu.system / 1_000,
      cpuMsPerRequest: cpuTotalMs / REQUESTS,
      clientLatencyMs: distribution(latencies),
      requestBytes: metric.requestBytes,
      responseBytes: metric.responseBytes,
      responseBytesPerRequest: metric.responseBytes / REQUESTS,
      metricWallMsPerRequest:
         metric.wallTime.totalMs / Math.max(1, metric.wallTime.samples),
      statuses: metric.statuses,
      thrown,
      facilitatorVerifyCalls:
         facilitator.verifyCalls - verifyCallsBefore,
   };
}

function subtractFreeWork(
   after: FreeWorkSnapshot,
   before: FreeWorkSnapshot,
): FreeWorkSnapshot {
   const statuses: Record<string, number> = {};
   const keys = new Set([
      ...Object.keys(after.statuses),
      ...Object.keys(before.statuses),
   ]);
   for (const key of keys) {
      const value = (after.statuses[key] ?? 0) - (before.statuses[key] ?? 0);
      if (value !== 0) statuses[key] = value;
   }

   return {
      requests: after.requests - before.requests,
      requestBytes: after.requestBytes - before.requestBytes,
      responseBytes: after.responseBytes - before.responseBytes,
      wallTime: {
         samples: after.wallTime.samples - before.wallTime.samples,
         totalMs: after.wallTime.totalMs - before.wallTime.totalMs,
         maxMs: after.wallTime.maxMs,
      },
      statuses,
   };
}

function bodyHeaders(body: string): Record<string, string> {
   return {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body, 'utf8')),
   };
}

function distribution(values: number[]): Distribution {
   if (values.length === 0) {
      return { mean: 0, p50: 0, p95: 0, max: 0 };
   }
   const sorted = [...values].sort((a, b) => a - b);
   return {
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted.at(-1) ?? 0,
   };
}

function percentile(sorted: number[], quantile: number): number {
   const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(sorted.length * quantile) - 1),
   );
   return sorted[index] ?? 0;
}

function summarizeStatuses(statuses: Record<string, number>): string {
   return Object.entries(statuses)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([status, count]) => `${status}:${count}`)
      .join(',');
}

function envNumber(name: string, fallback: number): number {
   const raw = process.env[name]?.trim();
   if (!raw) return fallback;
   const parsed = Number(raw);
   if (!Number.isFinite(parsed)) {
      throw new Error(`${name} must be numeric`);
   }
   return parsed;
}

function positiveInteger(value: number, name: string): number {
   if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
   }
   return value;
}

function round(value: number, digits = 2): number {
   const scale = 10 ** digits;
   return Math.round(value * scale) / scale;
}

// Keep the list imported and type-checked against the benchmark categories.
void FREE_REQUEST_CATEGORIES;
