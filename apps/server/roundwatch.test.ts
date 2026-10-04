import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { FacilitatorClient } from '@x402/core/server';
import type {
   PaymentPayload,
   PaymentRequirements,
   SettleResponse,
   SupportedResponse,
   VerifyResponse,
} from '@x402/core/types';
import {
   decodePaymentRequiredHeader,
   encodePaymentSignatureHeader,
} from '@x402/core/http';
import { getTransactionId, isValidAlgorandAddress } from '@x402/avm';

import { ALGORAND_TESTNET, createApp, ROUNDWATCH_SERVICE_ATOMIC_AMOUNT, TESTNET_USDC_ASSET_ID } from './app.js';
import {
   MAINNET_NETWORK_CONFIG,
   resolveRoundWatchNetwork,
   resolveRoundWatchPublicBaseUrl,
} from './network-config.js';
import {
   AlgorandIndexerClient,
   IndexerHttpError,
   matchesWatch,
   MAX_INDEXER_ERROR_BODY_BYTES,
   MAX_INDEXER_NEXT_TOKEN_BYTES,
   resolveScanQueryVariant,
   type IndexedBlock,
   type IndexedWatchTransaction,
   type RoundWatchIndexer,
   type ScanQueryVariant,
   type TransactionIdPage,
   type TransactionPage,
} from './roundwatch-indexer.js';
import {
   DEFAULT_POLL_FAILURE_BASE_BACKOFF_MILLISECONDS,
   MAX_POLL_FAILURE_BACKOFF_MILLISECONDS,
   RoundWatchPoller,
} from './roundwatch-poller.js';
import { hasDatabaseDiskHeadroom } from './roundwatch-readiness.js';
import { IndexerHealthProbe } from './roundwatch-health-probe.js';
import { createPaidAdmissionReadinessCheck, type PaidReadinessSnapshot } from './roundwatch-paid-readiness.js';
import { WorkerHealthTracker } from './roundwatch-worker-health.js';
import { SettlementReconciler } from './roundwatch-reconciler.js';
import { IndexerRequestDispatcher } from './roundwatch-scheduler.js';
import { MAX_INDEXER_REQUESTS_PER_ACTIVE_WORK_TURN } from './roundwatch-work-budget.js';
import {
   MAX_MCP_REQUEST_BODY_BYTES,
   MAX_WATCH_REQUEST_BODY_BYTES,
} from './request-body.js';
import {
   IdempotencyConflictError,
   LegacyIdempotencyReservationError,
   probeSqliteWriteReadiness,
   RoundWatchStore,
   WatchCapacityError,
   type SettlementIntent,
   type WatchRecord,
   type WatchSpec,
} from './roundwatch-store.js';

const PAYER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const WATCH_SENDER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBAKQ4C4';
const RECEIVER = 'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';
const SPEC: WatchSpec = {
   idempotencyKey: 'invoice-0001', expectedSender: PAYER, expectedReceiver: RECEIVER,
   assetId: TESTNET_USDC_ASSET_ID, atomicAmount: '2500000', invoiceNote: 'invoice:1',
};
const intent = (tx = 'SERVICE_TX'): SettlementIntent => ({
   expectedTransaction: tx, network: ALGORAND_TESTNET, payer: PAYER,
   receiver: RECEIVER, assetId: TESTNET_USDC_ASSET_ID, atomicAmount: '1000',
   firstValid: 90, lastValid: 190,
});

const SERVICE_RECEIVER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBAKQ4C4';
const SIGNED_SERVICE_PAYMENT =
   'gqNzaWfEQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACjdHhuiqRhYW10zgABhqCkYXJjdsQgCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCEIQhCEKjZmVlAKJmdmSjZ2VurHRlc3RuZXQtdjEuMKJnaMQgSGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiKibHbMyKNzbmTEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApHR5cGWlYXhmZXKkeGFpZM4An5c9';
const SIGNED_SERVICE_TX_ID = getTransactionId(
   Buffer.from(SIGNED_SERVICE_PAYMENT, 'base64'),
);

test('API root exposes RoundWatch merchant identity metadata without an x402 challenge', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [{ x402Version: 2, scheme: 'exact', network: ALGORAND_TESTNET }],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
      });

      const response = await app.request('/');

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
      assert.equal(response.headers.get('payment-required'), null);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=300');

      const html = await response.text();
      assert.match(html, /<meta property="og:site_name" content="RoundWatch"/);
      assert.match(
         html,
         /<meta property="og:image" content="https:\/\/roundwatch\.observer\/roundwatch-og\.jpg"/,
      );
      assert.match(
         html,
         /<link rel="icon" type="image\/svg\+xml" href="https:\/\/roundwatch\.observer\/favicon\.svg"/,
      );
      assert.match(html, /RoundWatch — Algorand x402 Payment Monitoring API/);
      assert.match(html, /https:\/\/roundwatch\.observer\/start/);
      assert.match(html, /href="\/openapi\.json"/);
      assert.match(html, /href="\/llms\.txt"/);
      assert.match(html, /"@type":"WebAPI"/);
   } finally {
      store.close();
   }
});

test('machine-readable OpenAPI describes the live MainNet RoundWatch contract without payment', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
         networkConfig: MAINNET_NETWORK_CONFIG,
         publicBaseUrl: 'https://roundwatch-api.onrender.com',
         requireSettlementIntent: false,
         syncFacilitatorOnStart: false,
      });

      const response = await app.request('/openapi.json');

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
      assert.equal(response.headers.get('payment-required'), null);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=300');

      const document = await response.json() as {
         openapi?: unknown;
         servers?: Array<{ url?: unknown }>;
         paths?: Record<string, {
            post?: Record<string, unknown>;
            get?: Record<string, unknown>;
         }>;
      };

      assert.equal(document.openapi, '3.1.0');
      assert.equal(document.servers?.[0]?.url, 'https://roundwatch-api.onrender.com');

      const create = document.paths?.['/v1/watch']?.post as
         | {
              operationId?: unknown;
              'x-x402'?: {
                 version?: unknown;
                 network?: unknown;
                 asset?: unknown;
                 servicePriceAtomicAmount?: unknown;
                 payTo?: unknown;
                 watchEligibility?: {
                    roundBoundary?: {
                       operator?: unknown;
                       sameActivationRoundEligible?: unknown;
                    };
                    timeBoundary?: {
                       operator?: unknown;
                       exactDeadlineEligible?: unknown;
                    };
                 };
              };
              responses?: Record<string, {
                 headers?: Record<string, unknown>;
              }>;
           }
         | undefined;

      assert.equal(create?.operationId, 'createWatch');
      assert.equal(create?.['x-x402']?.version, 2);
      assert.equal(
         create?.['x-x402']?.network,
         MAINNET_NETWORK_CONFIG.network,
      );
      assert.equal(
         create?.['x-x402']?.asset,
         MAINNET_NETWORK_CONFIG.usdcAssetId,
      );
      assert.equal(create?.['x-x402']?.servicePriceAtomicAmount, '100000');
      assert.equal(create?.['x-x402']?.payTo, RECEIVER);
      assert.equal(
         create?.['x-x402']?.watchEligibility?.roundBoundary?.operator,
         '>',
      );
      assert.equal(
         create?.['x-x402']?.watchEligibility?.roundBoundary
            ?.sameActivationRoundEligible,
         false,
      );
      assert.equal(
         create?.['x-x402']?.watchEligibility?.timeBoundary?.operator,
         '<',
      );
      assert.equal(
         create?.['x-x402']?.watchEligibility?.timeBoundary
            ?.exactDeadlineEligible,
         false,
      );
      assert.ok(create?.responses?.['402']?.headers?.['PAYMENT-REQUIRED']);
      assert.ok(create?.responses?.['408']);
      assert.ok(create?.responses?.['413']);
      assert.equal(
         document.paths?.['/v1/watch/recover']?.post?.operationId,
         'recoverWatch',
      );
      assert.equal(
         document.paths?.['/v1/watch/{id}']?.get?.operationId,
         'getWatch',
      );
      assert.equal(
         document.paths?.['/ready']?.get?.operationId,
         'getReadiness',
      );
      assert.doesNotMatch(JSON.stringify(document), new RegExp(PAYER));
   } finally {
      store.close();
   }
});

test('llms.txt explains when agents should and should not use RoundWatch', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
         networkConfig: MAINNET_NETWORK_CONFIG,
         publicBaseUrl: 'https://roundwatch-api.onrender.com',
         requireSettlementIntent: false,
         syncFacilitatorOnStart: false,
      });

      const response = await app.request('/llms.txt');

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/plain/);
      assert.equal(response.headers.get('payment-required'), null);
      const body = await response.text();
      assert.match(body, /no transaction ID exists yet/i);
      assert.match(body, /RoundWatch is not a webhook delivery service/i);
      assert.match(body, /POST \/v1\/watch/);
      assert.match(body, /POST \/v1\/watch\/recover/);
      assert.match(body, /do not repay/i);
      assert.match(body, /servicePayer/);
      assert.match(body, /GET \/v1\/watch\/\{id\}/);
      assert.match(body, /Readiness: .*\/ready/);
      assert.match(body, /1800000 ms/);
      assert.match(body, /settlement time consumes (?:part of )?(?:this |the )?window/i);
      assert.match(
         body,
         /confirmed-round must be strictly greater than activationRound/i,
      );
      assert.match(
         body,
         /round-time must be strictly earlier than expiresAt/i,
      );
      assert.match(body, /same-round payment is ineligible/i);
      assert.match(body, /exactly at the deadline is ineligible/i);
      assert.match(
         body,
         /https:\/\/roundwatch-api\.onrender\.com\/openapi\.json/,
      );
      assert.match(body, /0\.10 USDC \(100000 atomic units\)/);
      assert.match(body, /before semantic body validation/i);
      assert.match(body, /invalid watch specifications return HTTP 400/i);
      assert.match(body, /oversized bodies return HTTP 413/i);
      assert.match(body, /body-read timeouts return HTTP 408/i);
      assert.match(body, /cannot spend/i);
      assert.match(body, /nonzero expectedSender/i);
      assert.match(body, /Vladyslav-webDev\/RoundWatch/);
   } finally {
      store.close();
   }
});

test('MCP server supports modern discovery, deterministic tool listing, and watch preparation without payment', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
         networkConfig: MAINNET_NETWORK_CONFIG,
         publicBaseUrl: 'https://roundwatch-api.onrender.com',
         requireSettlementIntent: false,
         syncFacilitatorOnStart: false,
      });

      const modernHeaders = {
         'content-type': 'application/json',
         'mcp-protocol-version': '2026-07-28',
      };

      const discover = await app.request('/mcp', {
         method: 'POST',
         headers: {
            ...modernHeaders,
            'mcp-method': 'server/discover',
         },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'server/discover',
            params: {
               _meta: {
                  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                  'io.modelcontextprotocol/clientCapabilities': {},
               },
            },
         }),
      });

      assert.equal(discover.status, 200);
      assert.equal(discover.headers.get('payment-required'), null);
      const discoverBody = await discover.json() as {
         result?: {
            resultType?: unknown;
            supportedVersions?: unknown;
            capabilities?: { tools?: unknown };
            _meta?: Record<string, unknown>;
         };
      };
      assert.equal(discoverBody.result?.resultType, 'complete');
      assert.deepEqual(discoverBody.result?.supportedVersions, ['2026-07-28']);
      assert.deepEqual(discoverBody.result?.capabilities?.tools, {});
      assert.ok(
         discoverBody.result?._meta?.['io.modelcontextprotocol/serverInfo'],
      );

      const list = await app.request('/mcp', {
         method: 'POST',
         headers: {
            ...modernHeaders,
            'mcp-method': 'tools/list',
         },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {
               _meta: {
                  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                  'io.modelcontextprotocol/clientCapabilities': {},
               },
            },
         }),
      });

      assert.equal(list.status, 200);
      const listBody = await list.json() as {
         result?: {
            resultType?: unknown;
            ttlMs?: unknown;
            cacheScope?: unknown;
            tools?: Array<{ name?: unknown }>;
         };
      };
      assert.equal(listBody.result?.resultType, 'complete');
      assert.equal(listBody.result?.ttlMs, 300000);
      assert.equal(listBody.result?.cacheScope, 'public');
      assert.deepEqual(
         listBody.result?.tools?.map(tool => tool.name),
         [
            'roundwatch.service_info',
            'roundwatch.prepare_watch',
            'roundwatch.prepare_recovery',
            'roundwatch.get_watch',
         ],
      );

      const prepare = await app.request('/mcp', {
         method: 'POST',
         headers: {
            ...modernHeaders,
            'mcp-method': 'tools/call',
            'mcp-name': 'roundwatch.prepare_watch',
         },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
               name: 'roundwatch.prepare_watch',
               arguments: {
                  idempotencyKey: 'mcp-invoice-001',
                  expectedSender: WATCH_SENDER,
                  expectedReceiver: RECEIVER,
                  atomicAmount: '1000000',
                  invoiceNote: 'roundwatch:mcp-invoice-001',
               },
               _meta: {
                  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                  'io.modelcontextprotocol/clientCapabilities': {},
               },
            },
         }),
      });

      assert.equal(prepare.status, 200);
      const prepareBody = await prepare.json() as {
         result?: {
            resultType?: unknown;
            isError?: unknown;
            structuredContent?: {
               created?: unknown;
               request?: { url?: unknown };
               eligibility?: {
                  ttlMs?: unknown;
                  settlementTimeConsumesEligibilityWindow?: unknown;
                  roundBoundary?: {
                     operator?: unknown;
                     sameActivationRoundEligible?: unknown;
                  };
                  timeBoundary?: {
                     operator?: unknown;
                     exactDeadlineEligible?: unknown;
                  };
               };
               x402?: {
                  servicePriceAtomicAmount?: unknown;
                  network?: unknown;
               };
            };
         };
      };
      assert.equal(prepareBody.result?.resultType, 'complete');
      assert.equal(prepareBody.result?.isError, false);
      assert.equal(prepareBody.result?.structuredContent?.created, false);
      assert.equal(
         prepareBody.result?.structuredContent?.request?.url,
         'https://roundwatch-api.onrender.com/v1/watch',
      );
      assert.equal(
         prepareBody.result?.structuredContent?.x402?.servicePriceAtomicAmount,
         '100000',
      );
      assert.equal(
         prepareBody.result?.structuredContent?.x402?.network,
         MAINNET_NETWORK_CONFIG.network,
      );
      assert.equal(
         prepareBody.result?.structuredContent?.eligibility?.ttlMs,
         1_800_000,
      );
      assert.equal(
         prepareBody.result?.structuredContent?.eligibility
            ?.settlementTimeConsumesEligibilityWindow,
         true,
      );
      assert.equal(
         prepareBody.result?.structuredContent?.eligibility?.roundBoundary
            ?.operator,
         '>',
      );
      assert.equal(
         prepareBody.result?.structuredContent?.eligibility?.roundBoundary
            ?.sameActivationRoundEligible,
         false,
      );
      assert.equal(
         prepareBody.result?.structuredContent?.eligibility?.timeBoundary
            ?.operator,
         '<',
      );
      assert.equal(
         prepareBody.result?.structuredContent?.eligibility?.timeBoundary
            ?.exactDeadlineEligible,
         false,
      );
      for (const [id, argumentsValue, expectedMessage] of [
         [
            28,
            {
               idempotencyKey: 'replace-with-unique-idempotency-key',
               expectedSender: WATCH_SENDER,
               expectedReceiver: RECEIVER,
               atomicAmount: '1000000',
            },
            /caller-generated/i,
         ],
         [
            29,
            {
               idempotencyKey: 'mcp-real-caller-key',
               expectedSender: WATCH_SENDER,
               expectedReceiver: RECEIVER,
               atomicAmount: '1000000',
               invoiceNote: 'replace-with-unique-invoice-note',
            },
            /caller-selected/i,
         ],
      ] as const) {
         const rejectedSentinel = await app.request('/mcp', {
            method: 'POST',
            headers: {
               ...modernHeaders,
               'mcp-method': 'tools/call',
               'mcp-name': 'roundwatch.prepare_watch',
            },
            body: JSON.stringify({
               jsonrpc: '2.0',
               id,
               method: 'tools/call',
               params: {
                  name: 'roundwatch.prepare_watch',
                  arguments: argumentsValue,
                  _meta: {
                     'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                     'io.modelcontextprotocol/clientCapabilities': {},
                  },
               },
            }),
         });
         assert.equal(rejectedSentinel.status, 200);
         const rejectedSentinelBody = await rejectedSentinel.json() as {
            result?: {
               isError?: unknown;
               content?: Array<{ text?: unknown }>;
               structuredContent?: unknown;
            };
         };
         assert.equal(rejectedSentinelBody.result?.isError, true);
         assert.match(
            String(rejectedSentinelBody.result?.content?.[0]?.text ?? ''),
            expectedMessage,
         );
         assert.equal(
            rejectedSentinelBody.result?.structuredContent,
            undefined,
         );
      }

      const rejectedZeroSender = await app.request('/mcp', {
         method: 'POST',
         headers: {
            ...modernHeaders,
            'mcp-method': 'tools/call',
            'mcp-name': 'roundwatch.prepare_watch',
         },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 30,
            method: 'tools/call',
            params: {
               name: 'roundwatch.prepare_watch',
               arguments: {
                  idempotencyKey: 'mcp-zero-sender',
                  expectedSender: PAYER,
                  expectedReceiver: RECEIVER,
                  atomicAmount: '1000000',
               },
               _meta: {
                  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                  'io.modelcontextprotocol/clientCapabilities': {},
               },
            },
         }),
      });
      assert.equal(rejectedZeroSender.status, 200);
      assert.equal(rejectedZeroSender.headers.get('payment-required'), null);
      const rejectedZeroSenderBody = await rejectedZeroSender.json() as {
         result?: {
            isError?: unknown;
            content?: Array<{ text?: unknown }>;
            structuredContent?: unknown;
         };
      };
      assert.equal(rejectedZeroSenderBody.result?.isError, true);
      assert.match(
         String(rejectedZeroSenderBody.result?.content?.[0]?.text ?? ''),
         /zero address/i,
      );
      assert.equal(
         rejectedZeroSenderBody.result?.structuredContent,
         undefined,
      );

      const recovery = await app.request('/mcp', {
         method: 'POST',
         headers: {
            ...modernHeaders,
            'mcp-method': 'tools/call',
            'mcp-name': 'roundwatch.prepare_recovery',
         },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 31,
            method: 'tools/call',
            params: {
               name: 'roundwatch.prepare_recovery',
               arguments: {
                  idempotencyKey: 'mcp-invoice-001',
                  expectedSender: PAYER,
                  expectedReceiver: RECEIVER,
                  atomicAmount: '1000000',
                  invoiceNote: 'roundwatch:mcp-invoice-001',
                  servicePayer: PAYER,
               },
               _meta: {
                  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                  'io.modelcontextprotocol/clientCapabilities': {},
               },
            },
         }),
      });
      assert.equal(recovery.status, 200);
      assert.equal(recovery.headers.get('payment-required'), null);
      const recoveryBody = await recovery.json() as {
         result?: {
            isError?: unknown;
            structuredContent?: {
               paid?: unknown;
               recovered?: unknown;
               request?: {
                  method?: unknown;
                  url?: unknown;
                  body?: {
                     servicePayer?: unknown;
                     expectedSender?: unknown;
                  };
               };
            };
         };
      };
      assert.equal(recoveryBody.result?.isError, false);
      assert.equal(recoveryBody.result?.structuredContent?.paid, false);
      assert.equal(recoveryBody.result?.structuredContent?.recovered, false);
      assert.equal(
         recoveryBody.result?.structuredContent?.request?.method,
         'POST',
      );
      assert.equal(
         recoveryBody.result?.structuredContent?.request?.url,
         'https://roundwatch-api.onrender.com/v1/watch/recover',
      );
      assert.equal(
         recoveryBody.result?.structuredContent?.request?.body?.servicePayer,
         PAYER,
      );
      assert.equal(
         recoveryBody.result?.structuredContent?.request?.body?.expectedSender,
         PAYER,
         'exact recovery must remain permissive for legacy zero-sender watches',
      );

      assert.equal(
         store.getByIdempotencyKey('mcp-invoice-001'),
         undefined,
      );
   } finally {
      store.close();
   }
});

test('MCP get_watch returns free durable state and redacts internal fields', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const prepared = store.prepareWatch(SPEC);
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
         publicBaseUrl: 'https://roundwatch-api.onrender.com',
         syncFacilitatorOnStart: false,
      });

      const response = await app.request('/mcp', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': 'tools/call',
            'mcp-name': 'roundwatch.get_watch',
         },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: {
               name: 'roundwatch.get_watch',
               arguments: { watchId: prepared.watch.id },
               _meta: {
                  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                  'io.modelcontextprotocol/clientCapabilities': {},
               },
            },
         }),
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('payment-required'), null);
      const body = await response.json() as {
         result?: {
            isError?: unknown;
            structuredContent?: {
               watch?: Record<string, unknown>;
               statusUrl?: unknown;
            };
         };
      };

      assert.equal(body.result?.isError, false);
      assert.equal(body.result?.structuredContent?.watch?.id, prepared.watch.id);
      assert.equal(
         body.result?.structuredContent?.watch?.idempotencyKey,
         undefined,
      );
      assert.equal(
         body.result?.structuredContent?.statusUrl,
         `https://roundwatch-api.onrender.com/spike/watch/${prepared.watch.id}`,
      );
   } finally {
      store.close();
   }
});

test('MCP endpoint keeps stateless legacy initialize compatibility', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
         syncFacilitatorOnStart: false,
      });

      const response = await app.request('/mcp', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 5,
            method: 'initialize',
            params: {
               protocolVersion: '2025-11-25',
               capabilities: {},
               clientInfo: { name: 'roundwatch-test', version: '1.0.0' },
            },
         }),
      });

      assert.equal(response.status, 200);
      const body = await response.json() as {
         result?: {
            protocolVersion?: unknown;
            capabilities?: { tools?: unknown };
            serverInfo?: { name?: unknown };
         };
      };
      assert.equal(body.result?.protocolVersion, '2025-11-25');
      assert.deepEqual(body.result?.capabilities?.tools, {});
      assert.equal(body.result?.serverInfo?.name, 'roundwatch');
   } finally {
      store.close();
   }
});

test('MCP rejects unsupported and conflicting protocol-version signals', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
         syncFacilitatorOnStart: false,
      });

      const unsupportedInitialize = await app.request('/mcp', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 50,
            method: 'initialize',
            params: {
               protocolVersion: '2099-01-01',
               capabilities: {},
               clientInfo: { name: 'bad-version', version: '1' },
            },
         }),
      });
      assert.equal(unsupportedInitialize.status, 400);
      assert.match(
         await unsupportedInitialize.text(),
         /Unsupported initialize protocolVersion/,
      );

      const unsupportedHeader = await app.request('/mcp', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'mcp-protocol-version': '2099-01-01',
         },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 51,
            method: 'ping',
         }),
      });
      assert.equal(unsupportedHeader.status, 400);
      const unsupportedBody = await unsupportedHeader.json() as {
         error?: {
            code?: number;
            message?: string;
            data?: {
               requested?: string;
               supported?: string[];
            };
         };
      };
      assert.equal(unsupportedBody.error?.code, -32022);
      assert.equal(
         unsupportedBody.error?.message,
         'Unsupported protocol version',
      );
      assert.equal(
         unsupportedBody.error?.data?.requested,
         '2099-01-01',
      );
      assert.deepEqual(
         new Set(unsupportedBody.error?.data?.supported),
         new Set(['2026-07-28', '2025-11-25', '2025-06-18']),
      );

      const conflicting = await app.request('/mcp', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': 'ping',
         },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 52,
            method: 'ping',
            params: {
               _meta: {
                  'io.modelcontextprotocol/protocolVersion': '2025-11-25',
               },
            },
         }),
      });
      assert.equal(conflicting.status, 400);
      const conflictingBody = await conflicting.json() as {
         error?: { code?: number; message?: string };
      };
      assert.equal(conflictingBody.error?.code, -32020);
      assert.match(
         conflictingBody.error?.message ?? '',
         /protocol-version signals disagree/,
      );
   } finally {
      store.close();
   }
});

test('MCP rejects permissive envelope, negotiation, and tool-schema fallbacks', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
         syncFacilitatorOnStart: false,
      });

      const noIdPing = await app.request('/mcp', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'ping',
         }),
      });
      assert.equal(noIdPing.status, 202);
      assert.equal(await noIdPing.text(), '');

      const objectId = await app.request('/mcp', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: { bad: true },
            method: 'ping',
         }),
      });
      assert.equal(objectId.status, 400);
      const objectIdBody = await objectId.json() as {
         error?: { code?: number };
      };
      assert.equal(objectIdBody.error?.code, -32600);

      const arrayArguments = await app.request('/mcp', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 60,
            method: 'tools/call',
            params: {
               name: 'roundwatch.service_info',
               arguments: [],
            },
         }),
      });
      assert.equal(arrayArguments.status, 400);
      const arrayArgumentsBody = await arrayArguments.json() as {
         error?: { code?: number; message?: string };
      };
      assert.equal(arrayArgumentsBody.error?.code, -32602);
      assert.match(
         arrayArgumentsBody.error?.message ?? '',
         /arguments must be an object/,
      );

      const extraWatchArgument = await app.request('/mcp', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 61,
            method: 'tools/call',
            params: {
               name: 'roundwatch.get_watch',
               arguments: {
                  watchId:
                     '00000000-0000-0000-0000-000000000000',
                  extra: true,
               },
            },
         }),
      });
      assert.equal(extraWatchArgument.status, 400);
      const extraBody = await extraWatchArgument.json() as {
         error?: { code?: number; message?: string };
      };
      assert.equal(extraBody.error?.code, -32602);
      assert.match(
         extraBody.error?.message ?? '',
         /exactly one argument/,
      );
      assert.doesNotMatch(
         extraBody.error?.message ?? '',
         /Watch not found/,
      );

      const routedNotification = await app.request('/mcp', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': 'tools/call',
         },
         body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
         }),
      });
      assert.equal(routedNotification.status, 400);
      assert.equal(await routedNotification.text(), '');

      const legacyHeaderConflict = await app.request('/mcp', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-06-18',
         },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 62,
            method: 'initialize',
            params: {
               protocolVersion: '2025-11-25',
               capabilities: {},
               clientInfo: {
                  name: 'legacy-conflict',
                  version: '1',
               },
            },
         }),
      });
      assert.equal(legacyHeaderConflict.status, 400);
      const legacyConflictBody = await legacyHeaderConflict.json() as {
         error?: { code?: number };
      };
      assert.equal(legacyConflictBody.error?.code, -32020);

      const modernLegacyConflict = await app.request('/mcp', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'mcp-protocol-version': '2026-07-28',
         },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 63,
            method: 'initialize',
            params: {
               protocolVersion: '2025-11-25',
               capabilities: {},
               clientInfo: {
                  name: 'modern-legacy-conflict',
                  version: '1',
               },
               _meta: {
                  'io.modelcontextprotocol/protocolVersion':
                     '2026-07-28',
               },
            },
         }),
      });
      assert.equal(modernLegacyConflict.status, 400);
      const modernLegacyBody = await modernLegacyConflict.json() as {
         error?: { code?: number };
      };
      assert.equal(modernLegacyBody.error?.code, -32020);

      const malformedMeta = await app.request('/mcp', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'mcp-protocol-version': '2026-07-28',
         },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 64,
            method: 'ping',
            params: { _meta: [] },
         }),
      });
      assert.equal(malformedMeta.status, 400);
      const malformedMetaBody = await malformedMeta.json() as {
         error?: { code?: number };
      };
      assert.equal(malformedMetaBody.error?.code, -32602);

      const arrayParams = await app.request('/mcp', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 65,
            method: 'ping',
            params: [],
         }),
      });
      assert.equal(arrayParams.status, 400);
      const arrayParamsBody = await arrayParams.json() as {
         error?: { code?: number };
      };
      assert.equal(arrayParamsBody.error?.code, -32602);

      const emptyVersion = await app.request('/mcp', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'mcp-protocol-version': '',
         },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 66,
            method: 'ping',
         }),
      });
      assert.equal(emptyVersion.status, 400);
      const emptyVersionBody = await emptyVersion.json() as {
         error?: {
            code?: number;
            data?: { requested?: string };
         };
      };
      assert.equal(emptyVersionBody.error?.code, -32022);
      assert.equal(emptyVersionBody.error?.data?.requested, '');
   } finally {
      store.close();
   }
});

test('liveness and readiness are separate service signals', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      let workersReady = false;
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
         syncFacilitatorOnStart: false,
         readinessCheck: () => {
            const storage = store.readinessCheck();
            return {
               ready: storage && workersReady,
               checks: {
                  storage,
                  backgroundWorkers: workersReady,
               },
            };
         },
      });

      const live = await app.request('/health');
      assert.equal(live.status, 200);
      assert.equal(live.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await live.json(), {
         status: 'ok',
         purpose: 'liveness',
         network: 'testnet',
      });

      const notReady = await app.request('/ready');
      assert.equal(notReady.status, 503);
      assert.equal(notReady.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await notReady.json(), {
         status: 'not_ready',
         network: 'testnet',
         checks: {
            storage: true,
            backgroundWorkers: false,
         },
      });

      workersReady = true;
      const ready = await app.request('/ready');
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), {
         status: 'ready',
         network: 'testnet',
         checks: {
            storage: true,
            backgroundWorkers: true,
         },
      });
   } finally {
      store.close();
   }
});

test('paid watch admission refreshes readiness before both discovery 402 and signed retry', async () => {
   const store = new RoundWatchStore(':memory:');
   let paidReady = true;
   let paidChecks = 0;
   let verifyCalls = 0;
   let settleCalls = 0;

   try {
      const facilitator = {
         getSupported: async () => ({
            kinds: [
               {
                  x402Version: 2,
                  scheme: 'exact',
                  network: ALGORAND_TESTNET,
               },
            ],
            extensions: [],
            signers: {},
         }),
         verify: async () => {
            verifyCalls += 1;
            return { isValid: true, payer: PAYER };
         },
         settle: async () => {
            settleCalls += 1;
            throw new Error('blocked signed retry must not settle');
         },
      } as unknown as FacilitatorClient;

      const app = createApp({
         avmAddress: SERVICE_RECEIVER,
         facilitatorClient: facilitator,
         store,
         indexer: new MiddlewareIndexer(),
         readinessCheck: () => ({
            ready: true,
            checks: { cached: true },
         }),
         paidAdmissionReadinessCheck: Object.assign(async () => {
            paidChecks += 1;
            return {
               ready: paidReady,
               checks: { freshIndexerCapabilities: paidReady },
            };
         }, { validateCurrent: () => ({ ready: paidReady, checks: { freshIndexerCapabilities: paidReady } }) }),
      });

      const body = JSON.stringify({
         idempotencyKey: 'paid-readiness-refresh',
         expectedSender: WATCH_SENDER,
         expectedReceiver: RECEIVER,
         atomicAmount: SPEC.atomicAmount,
         invoiceNote: SPEC.invoiceNote,
      });

      const unpaid = await app.request('/spike/watch', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body,
      });
      assert.equal(unpaid.status, 402);
      assert.equal(paidChecks, 1);

      const encoded = unpaid.headers.get('payment-required');
      assert.ok(encoded);
      const required = decodePaymentRequiredHeader(encoded).accepts[0]!;
      const paymentHeader = encodePaymentSignatureHeader({
         x402Version: 2,
         accepted: required,
         payload: {
            paymentGroup: [SIGNED_SERVICE_PAYMENT],
            paymentIndex: 0,
         },
      } as PaymentPayload);

      paidReady = false;
      const signed = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': paymentHeader,
         },
         body,
      });

      assert.equal(signed.status, 503);
      assert.equal(paidChecks, 2);
      const rejected = await signed.json() as {
         code?: string;
         checks?: Record<string, boolean>;
      };
      assert.equal(rejected.code, 'service_not_ready');
      assert.equal(rejected.checks?.freshIndexerCapabilities, false);
      assert.equal(verifyCalls, 0);
      assert.equal(settleCalls, 0);
   } finally {
      store.close();
   }
});


test('Wave A: readiness loss or exception during verification rejects before durable preparation and settlement', async t => {
   for (const failure of ['worker', 'exception', 'commit-exception'] as const) {
      const store = new RoundWatchStore(':memory:');
      const spec = { ...SPEC, idempotencyKey: `verification-race-${failure}`, expectedSender: WATCH_SENDER };
      const facilitator = new MiddlewareFacilitator(store, spec.idempotencyKey);
      const indexer = new MiddlewareIndexer();
      const tracker = new WorkerHealthTracker();
      tracker.markStarted();
      tracker.markProbeResult(true);
      const worker = { healthSnapshot: () => tracker.snapshot(45_000) };
      const probe = new IndexerHealthProbe({
         async probeReadinessCapabilities() { return { polling: true, reconciliation: true }; },
      }, TESTNET_USDC_ASSET_ID, () => 1_000);
      const paidReadiness = createPaidAdmissionReadinessCheck({
         storageReady: () => store.readinessCheck(), diskHeadroom: () => true,
         poller: worker, reconciler: worker, healthProbe: probe,
         maximumEvidenceAgeMilliseconds: 30_000,
      });
      let throwReadiness = false;
      let throwCommitReadiness = false;
      let readinessCalls = 0;
      let verifyCalls = 0;
      let enterVerification!: () => void;
      let releaseVerification!: () => void;
      const entered = new Promise<void>(resolve => { enterVerification = resolve; });
      const held = new Promise<void>(resolve => { releaseVerification = resolve; });
      facilitator.verify = async () => {
         verifyCalls += 1;
         enterVerification();
         await held;
         return { isValid: true, payer: PAYER };
      };
      const prepare = t.mock.method(store, 'prepareWatch');
      const app = createApp({
         avmAddress: SERVICE_RECEIVER, facilitatorClient: facilitator, store, indexer,
         requireSettlementIntent: true,
         paidAdmissionReadinessCheck: Object.assign(() => {
            readinessCalls += 1;
            if (throwReadiness) throw new Error('private readiness diagnostic');
            return paidReadiness();
         }, { validateCurrent: (snapshot: PaidReadinessSnapshot) => {
            if (throwCommitReadiness) throw new Error('private commitment diagnostic');
            return paidReadiness.validateCurrent(snapshot);
         } }),
      });
      let pending: Promise<Response> | undefined;
      try {
         const { paymentHeader, body } = await createSyntheticPaidRequest(app, spec);
         readinessCalls = 0; // Count the signed request's two decisions only.
         pending = Promise.resolve(app.request('/spike/watch', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'payment-signature': paymentHeader },
            body,
         }));
         await entered;
         assert.equal(readinessCalls, 1);
         assert.equal(prepare.mock.callCount(), 0);
         assert.equal(facilitator.settleCalls, 0);

         // Change health while the real x402 middleware awaits verify().
         if (failure === 'worker') {
            probe.invalidateForProviderFailure();
            tracker.markCycleFailed();
            assert.equal((await paidReadiness()).ready, false);
         } else if (failure === 'exception') {
            throwReadiness = true;
         } else {
            throwCommitReadiness = true;
         }
         releaseVerification();
         const response = await pending;
         assert.equal(response.status, 503);
         assert.equal(response.headers.get('cache-control'), 'no-store');
         assert.equal(response.headers.get('payment-response'), null);
         assert.equal(response.headers.get('x-roundwatch-id'), null);
         const rejected = await response.json() as { code: string; checks: Record<string, boolean> };
         assert.equal(rejected.code, 'service_not_ready');
         assert.equal(rejected.checks[failure === 'worker' ? 'backgroundWorkers' : 'readinessCheck'], false);
         assert.doesNotMatch(JSON.stringify(rejected), /private (readiness|commitment) diagnostic/);
         assert.equal(readinessCalls, 2);
         assert.equal(verifyCalls, 1);
         assert.equal(prepare.mock.callCount(), 0);
         assert.equal(facilitator.settleCalls, 0);
         assert.equal(store.getByIdempotencyKey(spec.idempotencyKey), undefined);
         assert.equal(store.listActiveWatches().length, 0);
         assert.equal(store.listSettlementReconciliationCandidates().length, 0);
      } finally {
         releaseVerification();
         await pending;
         store.close();
      }
   }
});

test('Wave A follow-up: worker failure in the async readiness return gap is rejected by the synchronous guard', async t => {
   t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
   const store = new RoundWatchStore(':memory:');
   const spec = { ...SPEC, idempotencyKey: 'async-helper-return-gap', expectedSender: WATCH_SENDER };
   const indexer = new MiddlewareIndexer();
   const facilitator = new MiddlewareFacilitator(store, spec.idempotencyKey);
   const probe = new IndexerHealthProbe({
      async probeReadinessCapabilities() { return { polling: true, reconciliation: true }; },
   }, TESTNET_USDC_ASSET_ID, () => 1_000);
   const poller = new RoundWatchPoller(store, indexer, 60_000, 100, undefined,
      undefined, undefined, undefined, probe);
   const reconciler = new SettlementReconciler(store, indexer,
      { network: ALGORAND_TESTNET, intervalMilliseconds: 60_000 }, undefined, probe);
   let enterProvider!: () => void;
   let rejectProvider!: (error: Error) => void;
   const entered = new Promise<void>(resolve => { enterProvider = resolve; });
   const held = new Promise<TransactionPage>((_resolve, reject) => { rejectProvider = reject; });
   indexer.searchWatchPage = () => { enterProvider(); return held; };
   const events: string[] = [];
   const invalidate = probe.invalidateForProviderFailure.bind(probe);
   t.mock.method(probe, 'invalidateForProviderFailure', () => {
      events.push('worker failure published');
      return invalidate();
   });
   facilitator.verify = async () => {
      events.push('verification succeeded');
      return { isValid: true, payer: PAYER };
   };
   const paidReadiness = createPaidAdmissionReadinessCheck({
      storageReady: () => store.readinessCheck(), diskHeadroom: () => true,
      poller, reconciler, healthProbe: probe, maximumEvidenceAgeMilliseconds: 30_000,
   });
   let readinessCalls = 0;
   let guardCalls = 0;
   const app = createApp({
      avmAddress: SERVICE_RECEIVER, facilitatorClient: facilitator, store, indexer,
      requireSettlementIntent: true,
      paidAdmissionReadinessCheck: Object.assign(async () => {
         readinessCalls += 1;
         const snapshot = await paidReadiness();
         if (readinessCalls === 2) {
            assert.equal(snapshot.ready, true);
            events.push('final refresh returned healthy');
            // Return healthy through async promise adoption. Reject the real
            // held worker operation in that return gap, before the handler resumes.
            rejectProvider(new TypeError('synthetic return-gap provider failure'));
            return Promise.resolve(snapshot);
         }
         return snapshot;
      }, { validateCurrent: (snapshot: PaidReadinessSnapshot) => {
         guardCalls += 1;
         events.push('synchronous commitment guard');
         assert.equal(poller.healthSnapshot().providerHealth, 'unhealthy');
         assert.equal(poller.readinessCheck(), false);
         const current = paidReadiness.validateCurrent(snapshot);
         assert.equal(current.ready, false);
         return current;
      } }),
   });
   try {
      poller.start(); reconciler.start();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(poller.readinessCheck(), true);
      assert.equal(reconciler.readinessCheck(), true);
      const existing = store.prepareWatch({ ...SPEC, idempotencyKey: 'return-gap-existing' }, intent('RETURN_GAP_EXISTING')).watch;
      store.activateWatch(existing.id, { transaction: 'RETURN_GAP_EXISTING', network: ALGORAND_TESTNET, payer: PAYER }, 150);
      t.mock.timers.tick(60_000);
      await entered;
      const { paymentHeader, body } = await createSyntheticPaidRequest(app, spec);
      readinessCalls = 0;
      const prepare = t.mock.method(store, 'prepareWatch');
      const before = probe.currentFailureEpoch();
      const response = await app.request('/spike/watch', {
         method: 'POST',
         headers: { 'content-type': 'application/json', 'payment-signature': paymentHeader },
         body,
      });
      assert.equal(response.status, 503);
      assert.deepEqual(events, ['verification succeeded', 'final refresh returned healthy',
         'worker failure published', 'synchronous commitment guard']);
      assert.equal(guardCalls, 1);
      assert.equal(readinessCalls, 2);
      assert.equal(probe.currentFailureEpoch(), before + 1);
      assert.equal((await response.json() as { code: string }).code, 'service_not_ready');
      assert.equal(prepare.mock.callCount(), 0);
      assert.equal(facilitator.settleCalls, 0);
      assert.equal(store.getByIdempotencyKey(spec.idempotencyKey), undefined);
      assert.equal(store.listActiveWatches().length, 1);
      assert.equal(store.listSettlementReconciliationCandidates().length, 0);
   } finally {
      rejectProvider(new TypeError('test cleanup'));
      await new Promise<void>(resolve => setImmediate(resolve));
      poller.stop(); reconciler.stop(); store.close();
   }
});

test('Wave A: healthy two-gate paid request shares one complete capability probe', async t => {
   const store = new RoundWatchStore(':memory:');
   const spec = { ...SPEC, idempotencyKey: 'two-gate-capability-probe', expectedSender: WATCH_SENDER };
   const facilitator = new MiddlewareFacilitator(store, spec.idempotencyKey);
   const paths: string[] = [];
   const capabilitySource = new AlgorandIndexerClient('https://indexer.invalid',
      new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 1 }),
      async input => {
         const path = new URL(String(input)).pathname;
         paths.push(path);
         if (path === '/health') return Response.json({ round: 101 });
         if (path.startsWith('/v2/assets/')) return Response.json({ transactions: [], 'current-round': 101 });
         if (path === '/v2/blocks/101') return Response.json({ round: 101, timestamp: 1_000 });
         if (path.startsWith('/v2/transactions/')) return Response.json({}, { status: 404 });
         if (path === '/v2/transactions') return Response.json({ transactions: [], 'current-round': 101 });
         throw new Error(`unexpected synthetic capability path ${path}`);
      });
   let probeCalls = 0;
   const probe = new IndexerHealthProbe({
      async probeReadinessCapabilities(assetId) {
         probeCalls += 1;
         return capabilitySource.probeReadinessCapabilities(assetId);
      },
   }, TESTNET_USDC_ASSET_ID, () => 1_000);
   const tracker = new WorkerHealthTracker();
   tracker.markStarted();
   tracker.markProbeResult(true);
   const worker = { healthSnapshot: () => tracker.snapshot(45_000) };
   const paidReadiness = createPaidAdmissionReadinessCheck({
      storageReady: () => store.readinessCheck(), diskHeadroom: () => true,
      poller: worker, reconciler: worker, healthProbe: probe,
      maximumEvidenceAgeMilliseconds: 30_000,
   });
   let readinessCalls = 0;
   let countSignedRequest = false;
   let guardRan = false;
   let guardMicrotaskRan = false;
   const prepare = store.prepareWatch.bind(store);
   const prepared = t.mock.method(store, 'prepareWatch', (...args: Parameters<RoundWatchStore['prepareWatch']>) => {
      assert.equal(guardRan, true);
      assert.equal(guardMicrotaskRan, false, 'commit must occur before any queued guard microtask');
      return prepare(...args);
   });
   const app = createApp({
      avmAddress: SERVICE_RECEIVER, facilitatorClient: facilitator, store,
      indexer: new MiddlewareIndexer(), requireSettlementIntent: true,
      paidAdmissionReadinessCheck: Object.assign(() => {
         if (countSignedRequest) readinessCalls += 1;
         // Discovery is tested elsewhere; start this probe at the signed early gate.
         return countSignedRequest ? paidReadiness() : Promise.resolve({ ready: true, checks: {} });
      }, { validateCurrent: (snapshot: PaidReadinessSnapshot) => {
         const current = paidReadiness.validateCurrent(snapshot);
         guardRan = true;
         queueMicrotask(() => { guardMicrotaskRan = true; });
         return current;
      } }),
   });
   try {
      const { paymentHeader, body } = await createSyntheticPaidRequest(app, spec);
      countSignedRequest = true;
      const response = await app.request('/spike/watch', {
         method: 'POST',
         headers: { 'content-type': 'application/json', 'payment-signature': paymentHeader },
         body,
      });
      assert.equal(response.status, 200);
      assert.equal(readinessCalls, 2);
      assert.equal(probeCalls, 1);
      assert.equal(prepared.mock.callCount(), 1);
      assert.equal(paths.length, 5, 'one functional probe exercises all five provider routes');
      assert.equal(new Set(paths).size, 5);
      assert.equal(facilitator.settleCalls, 1);
      assert.deepEqual(facilitator.statesObservedAtSettle, ['settlement_pending']);
      assert.equal(store.getByIdempotencyKey(spec.idempotencyKey)?.state, 'active');
   } finally { store.close(); }
});

test('Wave A: readiness loss after durable preparation preserves settlement and activation', async () => {
   const store = new RoundWatchStore(':memory:');
   const spec = { ...SPEC, idempotencyKey: 'readiness-after-commit', expectedSender: WATCH_SENDER };
   const facilitator = new MiddlewareFacilitator(store, spec.idempotencyKey);
   let ready = true;
   const settle = facilitator.settle.bind(facilitator);
   facilitator.settle = async (payload, requirements) => {
      assert.equal(store.getByIdempotencyKey(spec.idempotencyKey)?.state, 'settlement_pending');
      ready = false;
      return settle(payload, requirements);
   };
   const app = createApp({
      avmAddress: SERVICE_RECEIVER, facilitatorClient: facilitator, store,
      indexer: new MiddlewareIndexer(), requireSettlementIntent: true,
      paidAdmissionReadinessCheck: Object.assign(
         async () => ({ ready, checks: { service: ready } }),
         { validateCurrent: () => ({ ready, checks: { service: ready } }) },
      ),
   });
   try {
      const { paymentHeader, body } = await createSyntheticPaidRequest(app, spec);
      const response = await app.request('/spike/watch', {
         method: 'POST',
         headers: { 'content-type': 'application/json', 'payment-signature': paymentHeader },
         body,
      });
      assert.equal(response.status, 200);
      assert.equal(ready, false);
      assert.equal(facilitator.settleCalls, 1);
      assert.equal(store.getByIdempotencyKey(spec.idempotencyKey)?.state, 'active');
   } finally { store.close(); }
});

test('SQLite readiness requires a real write-capable transaction and fails query-only mode', () => {
   const database = new DatabaseSync(':memory:');
   try {
      database.exec(`
         CREATE TABLE roundwatch_readiness_probe (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            checked_at TEXT NOT NULL
         );
      `);

      assert.equal(
         probeSqliteWriteReadiness(
            database,
            '2026-09-23T18:00:00.000Z',
         ),
         true,
      );

      database.exec('PRAGMA query_only = ON;');
      assert.equal(
         probeSqliteWriteReadiness(
            database,
            '2026-09-23T18:00:01.000Z',
         ),
         false,
      );
   } finally {
      database.close();
   }
});

test('store readiness is cached, writable, and fails after close', () => {
   const store = new RoundWatchStore(':memory:', {
      readinessProbeIntervalMilliseconds: 60_000,
   });

   assert.equal(store.readinessCheck(true), true);
   assert.equal(store.readinessCheck(), true);
   store.close();
   assert.equal(store.readinessCheck(), false);
});

test('worker health isolates contained failures but keeps provider failures sticky through cooldown', () => {
   let now = 1_000;
   const tracker = new WorkerHealthTracker(() => now);

   tracker.markStarted();
   assert.equal(tracker.snapshot(1_000).ready, false);

   // An empty cycle cannot establish provider health.
   tracker.markCycleStarted();
   now = 1_100;
   tracker.markCycleCompleted({ attempted: 0, succeeded: 0, failed: 0 });
   assert.equal(tracker.snapshot(1_000).ready, false);
   tracker.markProbeResult(true);
   assert.equal(tracker.snapshot(1_000).ready, true);

   // Live progress keeps a long-running cycle healthy.
   now = 1_200;
   tracker.markCycleStarted();
   now = 1_900;
   tracker.markCycleProgress();
   now = 2_600;
   const progressing = tracker.snapshot(2_000);
   assert.equal(progressing.ready, true);
   assert.equal(progressing.running, true);
   assert.equal(progressing.lastProgressAtMs, 1_900);

   now = 3_101;
   assert.equal(tracker.snapshot(1_000).ready, false);

   // A provider/systemic all-failed cycle makes readiness fail.
   now = 3_200;
   tracker.markCycleCompleted({ attempted: 2, succeeded: 0, failed: 2 });
   const failed = tracker.snapshot(1_000);
   assert.equal(failed.ready, false);
   assert.equal(failed.consecutiveFailures, 1);

   // Backoff can make the next cycle empty. That must not magically heal the
   // provider failure and reopen paid admission.
   now = 3_250;
   tracker.markCycleStarted();
   tracker.markCycleCompleted({ attempted: 0, succeeded: 0, failed: 0 });
   const coolingDown = tracker.snapshot(1_000);
   assert.equal(coolingDown.ready, false);
   assert.equal(coolingDown.consecutiveFailures, 1);

   // A later isolated permanent watch error also cannot erase the earlier
   // systemic failure. It is contained, but it is not evidence of recovery.
   now = 3_275;
   tracker.markCycleStarted();
   tracker.markCycleCompleted({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      isolatedFailures: 1,
   });
   const stillFailed = tracker.snapshot(1_000);
   assert.equal(stillFailed.ready, false);
   assert.equal(stillFailed.consecutiveFailures, 1);

   // A mixed real success and systemic failure remains unhealthy.
   tracker.markCycleStarted();
   now = 3_300;
   tracker.markCycleProgress();
   tracker.markCycleCompleted({ attempted: 2, succeeded: 1, failed: 1, providerEvidence: 1 });
   assert.equal(tracker.snapshot(1_000).ready, false);
   tracker.markProbeResult(true);
   const recovered = tracker.snapshot(1_000);
   assert.equal(recovered.ready, true);
   assert.equal(recovered.consecutiveFailures, 0);
   assert.equal(recovered.lastErrorAtMs, 3_300);

   // From a healthy baseline, a fully isolated fail-closed obligation must
   // not poison readiness for unrelated customers.
   tracker.markCycleStarted();
   now = 3_350;
   tracker.markCycleCompleted({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      isolatedFailures: 1,
   });
   const isolated = tracker.snapshot(1_000);
   assert.equal(isolated.ready, true);
   assert.equal(isolated.consecutiveFailures, 0);
   assert.equal(isolated.lastErrorAtMs, 3_350);

   assert.throws(
      () =>
         tracker.markCycleCompleted({
            attempted: 1,
            succeeded: 0,
            failed: 1,
            isolatedFailures: 2,
         }),
      /isolatedFailures cannot exceed failed/,
   );

   tracker.markCycleStarted();
   tracker.markCycleFailed();
   assert.equal(tracker.snapshot(1_000).ready, false);

   tracker.markStopped();
   assert.equal(tracker.snapshot(1_000).ready, false);
});

test('poller cycle outcome exposes isolated watch failures to readiness accounting', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      for (let i = 0; i < 2; i += 1) {
         const serviceTx = `WORKER_FAIL_SERVICE_${i}`;
         const watch = store.prepareWatch(
            {
               ...SPEC,
               idempotencyKey: `worker-failure-${i}`,
            },
            intent(serviceTx),
         ).watch;
         store.activateWatch(
            watch.id,
            {
               transaction: serviceTx,
               network: ALGORAND_TESTNET,
               payer: PAYER,
            },
            100,
         );
      }

      const failingIndexer: RoundWatchIndexer = {
         getCurrentRound: async () => {
            throw new Error('synthetic total provider failure');
         },
         lookupAssetTransfer: async () => undefined,
         getBlock: async round => ({ round, timestamp: 0 }),
         searchWatchPage: async () => {
            throw new Error('unexpected page request');
         },
         searchTransactionPage: async () => ({
            transactions: [],
            currentRound: 100,
         }),
      };

      let progressSignals = 0;
      const outcome = await new RoundWatchPoller(
         store,
         failingIndexer,
      ).runOnce(() => {
         progressSignals += 1;
      });

      assert.deepEqual(outcome, {
         attempted: 2,
         succeeded: 0,
         failed: 2,
      });
      assert.equal(progressSignals, 0);
   } finally {
      store.close();
   }
});

test('disk-headroom readiness uses available filesystem blocks and fails closed on stat errors', () => {
   assert.equal(
      hasDatabaseDiskHeadroom(
         '/data/roundwatch.sqlite',
         1_000,
         () => ({ bavail: 10, bsize: 200 }),
      ),
      true,
   );
   assert.equal(
      hasDatabaseDiskHeadroom(
         '/data/roundwatch.sqlite',
         2_001,
         () => ({ bavail: 10, bsize: 200 }),
      ),
      false,
   );
   assert.equal(
      hasDatabaseDiskHeadroom(
         '/data/roundwatch.sqlite',
         1,
         () => {
            throw new Error('statfs unavailable');
         },
      ),
      false,
   );
   assert.equal(hasDatabaseDiskHeadroom(':memory:', Number.MAX_SAFE_INTEGER), true);
});

test('non-ready durable service refuses paid watch admission before x402 verification', async () => {
   const store = new RoundWatchStore(':memory:');
   let facilitatorCalls = 0;

   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            verify: async () => {
               facilitatorCalls += 1;
               throw new Error('not-ready request must not verify payment');
            },
            settle: async () => {
               facilitatorCalls += 1;
               throw new Error('not-ready request must not settle payment');
            },
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
         syncFacilitatorOnStart: false,
         readinessCheck: () => ({
            ready: false,
            checks: {
               storage: true,
               poller: false,
               reconciler: true,
               backgroundWorkers: false,
               diskHeadroom: true,
            },
         }),
      });

      const response = await app.request('/spike/watch', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
            idempotencyKey: 'not-ready-watch',
            expectedSender: PAYER,
            expectedReceiver: RECEIVER,
            atomicAmount: '1',
         }),
      });

      assert.equal(response.status, 503);
      assert.equal(response.headers.get('payment-required'), null);
      const body = await response.json() as {
         code?: string;
         checks?: Record<string, boolean>;
      };
      assert.equal(body.code, 'service_not_ready');
      assert.equal(body.checks?.backgroundWorkers, false);
      assert.equal(facilitatorCalls, 0);
      assert.equal(
         store.getByIdempotencyKey('not-ready-watch'),
         undefined,
      );
   } finally {
      store.close();
   }
});

test('watch status is no-store and exposes terminal settlement reconciliation explicitly', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const prepared = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'terminal-settlement-public' },
         intent('TERMINAL_SETTLEMENT_TX'),
      ).watch;
      store.markSettlementUnknown(prepared.id);
      store.markSettlementInvalid(prepared.id);

      const stored = store.getWatch(prepared.id);
      assert.equal(stored?.state, 'settlement_unknown');
      assert.equal(stored?.settlementReconciliationTerminal, true);

      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
         syncFacilitatorOnStart: false,
      });

      const status = await app.request(`/spike/watch/${prepared.id}`);
      assert.equal(status.status, 200);
      assert.equal(status.headers.get('cache-control'), 'no-store');
      const body = await status.json() as {
         watch?: {
            state?: string;
            settlementReconciliationTerminal?: boolean;
         };
      };
      assert.equal(body.watch?.state, 'settlement_unknown');
      assert.equal(body.watch?.settlementReconciliationTerminal, true);

      const missing = await app.request(
         '/spike/watch/00000000-0000-0000-0000-000000000000',
      );
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get('cache-control'), 'no-store');
   } finally {
      store.close();
   }
});

test('store creates indexes for active, reconciliation, and payer-capacity queries', () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-indexes-'));
   const path = join(directory, 'watch.sqlite');

   try {
      const store = new RoundWatchStore(path);
      store.close();

      const database = new DatabaseSync(path);
      const rows = database.prepare(
         'PRAGMA index_list(roundwatch_watches)',
      ).all() as unknown as Array<{ name: string }>;
      const names = new Set(rows.map(row => row.name));

      assert.ok(names.has('roundwatch_active_created_idx'));
      assert.ok(names.has('roundwatch_reconcile_due_idx'));
      assert.ok(names.has('roundwatch_open_payer_idx'));

      database.close();
   } finally {
      rmSync(directory, { recursive: true, force: true });
   }
});

test('MCP rejects oversized bodies before JSON-RPC dispatch and bounds reflected identifiers', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
         syncFacilitatorOnStart: false,
      });

      const oversized = await app.request('/mcp', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'ping',
            padding: 'x'.repeat(MAX_MCP_REQUEST_BODY_BYTES),
         }),
      });
      assert.equal(oversized.status, 413);
      assert.equal(oversized.headers.get('payment-required'), null);

      const reflectedId = 'r'.repeat(129);
      const bounded = await app.request('/mcp', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: reflectedId,
            method: 'ping',
         }),
      });
      assert.equal(bounded.status, 400);
      const boundedText = await bounded.text();
      assert.equal(boundedText.includes(reflectedId), false);
      assert.ok(Buffer.byteLength(boundedText, 'utf8') < 512);
   } finally {
      store.close();
   }
});

test('MCP anonymous request gate rate-limits free parsing work', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
         syncFacilitatorOnStart: false,
         mcpRequestGateOptions: {
            requestsPerSecond: 0.001,
            burst: 1,
            concurrency: 1,
         },
      });

      const pingBody = JSON.stringify({
         jsonrpc: '2.0',
         id: 1,
         method: 'ping',
      });

      const first = await app.request('/mcp', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: pingBody,
      });
      assert.equal(first.status, 200);

      const second = await app.request('/mcp', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: pingBody,
      });
      assert.equal(second.status, 429);
      assert.equal(second.headers.get('retry-after'), '1');
      const secondBody = await second.json() as { code?: string };
      assert.equal(secondBody.code, 'mcp_request_rate_limited');
   } finally {
      store.close();
   }
});

test('watch creation rejects oversized JSON before payment verification middleware', async () => {
   const store = new RoundWatchStore(':memory:');
   const facilitator = new DelayedRejectingFacilitator();
   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: facilitator,
         store,
         indexer: new FakeIndexer(100),
         syncFacilitatorOnStart: false,
      });

      const response = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': encodePaymentSignatureHeader({
               x402Version: 2,
               accepted: {
                  scheme: 'exact',
                  network: ALGORAND_TESTNET,
                  amount: ROUNDWATCH_SERVICE_ATOMIC_AMOUNT,
                  asset: String(TESTNET_USDC_ASSET_ID),
                  payTo: RECEIVER,
                  maxTimeoutSeconds: 60,
                  extra: {},
               },
               payload: {
                  paymentGroup: [SIGNED_SERVICE_PAYMENT],
                  paymentIndex: 0,
               },
            } as PaymentPayload),
         },
         body: JSON.stringify({
            idempotencyKey: 'oversized-watch-body',
            expectedSender: PAYER,
            expectedReceiver: RECEIVER,
            atomicAmount: '1',
            padding: 'x'.repeat(MAX_WATCH_REQUEST_BODY_BYTES),
         }),
      });

      assert.equal(response.status, 413);
      assert.equal(facilitator.verifyCalls, 0);
      assert.equal(store.getByIdempotencyKey('oversized-watch-body'), undefined);
   } finally {
      store.close();
   }
});

test('signed watch body admission bounds slow readers and releases after timeout', async () => {
   const store = new RoundWatchStore(':memory:');
   const facilitator = new DelayedRejectingFacilitator();

   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: facilitator,
         store,
         indexer: new FakeIndexer(100),
         signedWatchBodyGateOptions: {
            requestsPerSecond: 1_000,
            burst: 8,
            concurrency: 1,
         },
         signedWatchBodyReadTimeoutMilliseconds: 100,
      });

      const unsigned = await app.request('/spike/watch', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: '{}',
      });
      assert.equal(unsigned.status, 402);
      const encoded = unsigned.headers.get('payment-required');
      assert.ok(encoded);
      const required = decodePaymentRequiredHeader(encoded).accepts[0]!;
      const paymentHeader = encodePaymentSignatureHeader({
         x402Version: 2,
         accepted: required,
         payload: {
            paymentGroup: [SIGNED_SERVICE_PAYMENT],
            paymentIndex: 0,
         },
      });

      let signalReadStarted!: () => void;
      const readStarted = new Promise<void>(resolve => {
         signalReadStarted = resolve;
      });
      let signalled = false;
      const slowBody = new ReadableStream<Uint8Array>(
         {
            pull() {
               if (!signalled) {
                  signalled = true;
                  signalReadStarted();
               }
            },
         },
         { highWaterMark: 0 },
      );
      const slowRequest = new Request('http://localhost/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': paymentHeader,
         },
         body: slowBody,
         duplex: 'half',
      } as RequestInit & { duplex: 'half' });

      const slowResponsePromise = app.fetch(slowRequest);
      await readStarted;

      const validBody = JSON.stringify({
         idempotencyKey: 'body-admission-after-timeout',
         expectedSender: WATCH_SENDER,
         expectedReceiver: RECEIVER,
         atomicAmount: '1',
      });

      const blocked = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': paymentHeader,
         },
         body: validBody,
      });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get('retry-after'), '1');
      const blockedBody = await blocked.json() as { code?: string };
      assert.equal(
         blockedBody.code,
         'signed_watch_body_rate_limited',
      );
      assert.equal(facilitator.verifyCalls, 0);

      const timedOut = await slowResponsePromise;
      assert.equal(timedOut.status, 408);
      const timeoutBody = await timedOut.json() as { code?: string };
      assert.equal(timeoutBody.code, 'watch_request_body_timeout');
      assert.equal(facilitator.verifyCalls, 0);

      const afterTimeout = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': paymentHeader,
         },
         body: validBody,
      });
      assert.equal(afterTimeout.status, 402);
      assert.equal(facilitator.verifyCalls, 1);
      assert.equal(
         store.getByIdempotencyKey('body-admission-after-timeout'),
         undefined,
      );
   } finally {
      store.close();
   }
});

test('all paid resources share the signed-payment verification admission gate', async () => {
   for (const route of ['demo', 'watch'] as const) {
      const store = new RoundWatchStore(':memory:');
      const facilitator = new DelayedRejectingFacilitator();
      try {
         const app = createApp({
            avmAddress: RECEIVER,
            facilitatorClient: facilitator,
            store,
            indexer: new FakeIndexer(100),
            signedPaymentGateOptions: {
               requestsPerSecond: 1_000,
               burst: 8,
               concurrency: 1,
            },
         });

         const path = route === 'demo' ? '/demo' : '/spike/watch';
         const method = route === 'demo' ? 'GET' : 'POST';
         const unpaid = await app.request(path, {
            method,
            ...(route === 'watch'
               ? {
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                       idempotencyKey: 'gate-regression-watch',
                       expectedSender: WATCH_SENDER,
                       expectedReceiver: RECEIVER,
                       atomicAmount: '1',
                    }),
                 }
               : {}),
         });
         assert.equal(unpaid.status, 402);
         const encoded = unpaid.headers.get('payment-required');
         assert.ok(encoded);
         const required = decodePaymentRequiredHeader(encoded).accepts[0]!;
         const paymentHeader = encodePaymentSignatureHeader({
            x402Version: 2,
            accepted: required,
            payload: {
               paymentGroup: [SIGNED_SERVICE_PAYMENT],
               paymentIndex: 0,
            },
         });

         const requests = Array.from({ length: 6 }, () =>
            app.request(path, {
               method,
               headers: {
                  'payment-signature': paymentHeader,
                  ...(route === 'watch'
                     ? { 'content-type': 'application/json' }
                     : {}),
               },
               ...(route === 'watch'
                  ? {
                       body: JSON.stringify({
                          idempotencyKey: 'gate-regression-watch',
                          expectedSender: WATCH_SENDER,
                          expectedReceiver: RECEIVER,
                          atomicAmount: '1',
                       }),
                    }
                  : {}),
            }),
         );

         const responses = await Promise.all(requests);
         assert.equal(
            responses.filter(response => response.status === 429).length,
            5,
            `${route} must reject five concurrent verification attempts`,
         );
         assert.equal(
            facilitator.verifyCalls,
            1,
            `${route} must admit only one facilitator verification`,
         );
         assert.equal(facilitator.peakVerifyCalls, 1);
      } finally {
         store.close();
      }
   }
});

test('noncanonical paid-route aliases are rejected before x402 verification', async () => {
   const cases = [
      {
         canonical: '/demo',
         method: 'GET',
         aliases: ['/DEMO', '/demo/', '/demo//', '//demo'],
      },
      {
         canonical: '/spike/watch',
         method: 'POST',
         aliases: [
            '/SPIKE/WATCH',
            '/spike/watch/',
            '/spike/watch//',
            '//spike///watch//',
         ],
      },
   ] as const;

   for (const route of cases) {
      const store = new RoundWatchStore(':memory:');
      const facilitator = new DelayedRejectingFacilitator();

      try {
         const app = createApp({
            avmAddress: RECEIVER,
            facilitatorClient: facilitator,
            store,
            indexer: new FakeIndexer(100),
            signedPaymentGateOptions: {
               requestsPerSecond: 1_000,
               burst: 8,
               concurrency: 1,
            },
         });

         const watchBody = JSON.stringify({
            idempotencyKey: 'alias-gate-regression',
            expectedSender: PAYER,
            expectedReceiver: RECEIVER,
            atomicAmount: '1',
         });
         const unpaid = await app.request(route.canonical, {
            method: route.method,
            ...(route.method === 'POST'
               ? {
                    headers: { 'content-type': 'application/json' },
                    body: watchBody,
                 }
               : {}),
         });
         assert.equal(unpaid.status, 402);

         const encoded = unpaid.headers.get('payment-required');
         assert.ok(encoded);
         const required = decodePaymentRequiredHeader(encoded).accepts[0]!;
         const paymentHeader = encodePaymentSignatureHeader({
            x402Version: 2,
            accepted: required,
            payload: {
               paymentGroup: [SIGNED_SERVICE_PAYMENT],
               paymentIndex: 0,
            },
         });

         for (const alias of route.aliases) {
            const requests = Array.from({ length: 6 }, () =>
               app.request(alias, {
                  method: route.method,
                  headers: {
                     'payment-signature': paymentHeader,
                     ...(route.method === 'POST'
                        ? { 'content-type': 'application/json' }
                        : {}),
                  },
                  ...(route.method === 'POST'
                     ? { body: watchBody }
                     : {}),
               }),
            );

            const responses = await Promise.all(requests);
            assert.equal(
               responses.every(response => response.status === 404),
               true,
               `${alias} must be rejected before x402 middleware`,
            );
            for (const response of responses) {
               assert.equal(response.headers.get('payment-required'), null);
               const body = await response.json() as {
                  code?: string;
                  canonicalPath?: string;
               };
               assert.equal(
                  body.code,
                  'non_canonical_paid_resource_path',
               );
               assert.equal(body.canonicalPath, route.canonical);
            }
         }

         assert.equal(
            facilitator.verifyCalls,
            0,
            `${route.canonical} aliases must not reach facilitator verification`,
         );
         assert.equal(facilitator.peakVerifyCalls, 0);
      } finally {
         store.close();
      }
   }
});

test('unpaid malformed watch input receives discovery 402, while signed malformed input cannot reach facilitator', async () => {
   const store = new RoundWatchStore(':memory:');
   let verifyCalls = 0;
   let settleCalls = 0;

   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [
                  {
                     x402Version: 2,
                     scheme: 'exact',
                     network: ALGORAND_TESTNET,
                  },
               ],
               extensions: [],
               signers: {},
            }),
            verify: async () => {
               verifyCalls += 1;
               throw new Error('unexpected verification');
            },
            settle: async () => {
               settleCalls += 1;
               throw new Error('unexpected settlement');
            },
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
      });

      const unpaid = await app.request('/spike/watch', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: '{}',
      });

      assert.equal(unpaid.status, 402);
      assert.ok(unpaid.headers.get('payment-required'));
      assert.equal(unpaid.headers.get('payment-response'), null);

      const paymentHeader = encodePaymentSignatureHeader({
         x402Version: 2,
         accepted: {
            scheme: 'exact',
            network: ALGORAND_TESTNET,
            amount: ROUNDWATCH_SERVICE_ATOMIC_AMOUNT,
            asset: String(TESTNET_USDC_ASSET_ID),
            payTo: RECEIVER,
            maxTimeoutSeconds: 60,
            extra: {},
         },
         payload: {
            paymentGroup: [SIGNED_SERVICE_PAYMENT],
            paymentIndex: 0,
         },
      } as PaymentPayload);

      const signed = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': paymentHeader,
         },
         body: '{}',
      });

      assert.equal(signed.status, 400);
      assert.equal(signed.headers.get('payment-required'), null);
      assert.equal(signed.headers.get('payment-response'), null);
      const signedBody = await signed.json() as {
         error?: string;
         code?: string;
      };
      assert.equal(signedBody.code, 'invalid_watch_request');
      assert.match(signedBody.error ?? '', /idempotencyKey/i);

      assert.equal(verifyCalls, 0);
      assert.equal(settleCalls, 0);
   } finally {
      store.close();
   }
});

test('zero expectedSender is discovery-only when unsigned and rejected before payment verification when signed', async () => {
   const store = new RoundWatchStore(':memory:');
   let verifyCalls = 0;
   let settleCalls = 0;

   try {
      const facilitator = {
         getSupported: async () => ({
            kinds: [
               {
                  x402Version: 2,
                  scheme: 'exact',
                  network: ALGORAND_TESTNET,
               },
            ],
            extensions: [],
            signers: {},
         }),
         verify: async () => {
            verifyCalls += 1;
            throw new Error('zero-sender watch must not reach verification');
         },
         settle: async () => {
            settleCalls += 1;
            throw new Error('zero-sender watch must not settle');
         },
      } as unknown as FacilitatorClient;

      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: facilitator,
         store,
         indexer: new FakeIndexer(100),
      });

      const body = JSON.stringify({
         idempotencyKey: 'zero-sender-regression',
         expectedSender: PAYER,
         expectedReceiver: RECEIVER,
         atomicAmount: '1',
      });

      const unpaid = await app.request('/spike/watch', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body,
      });

      assert.equal(unpaid.status, 402);
      assert.ok(unpaid.headers.get('payment-required'));
      assert.equal(verifyCalls, 0);
      assert.equal(settleCalls, 0);
      assert.equal(
         store.getByIdempotencyKey('zero-sender-regression'),
         undefined,
      );

      const encoded = unpaid.headers.get('payment-required');
      assert.ok(encoded);
      const required = decodePaymentRequiredHeader(encoded).accepts[0]!;
      const paymentHeader = encodePaymentSignatureHeader({
         x402Version: 2,
         accepted: required,
         payload: {
            paymentGroup: [SIGNED_SERVICE_PAYMENT],
            paymentIndex: 0,
         },
      });

      const signed = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': paymentHeader,
         },
         body,
      });

      assert.equal(signed.status, 400);
      assert.equal(signed.headers.get('payment-required'), null);
      assert.equal(signed.headers.get('payment-response'), null);
      const rejected = await signed.json() as {
         error?: string;
         code?: string;
      };
      assert.equal(rejected.code, 'unsupported_expected_sender');
      assert.match(rejected.error ?? '', /zero address/i);
      assert.equal(verifyCalls, 0);
      assert.equal(settleCalls, 0);
      assert.equal(
         store.getByIdempotencyKey('zero-sender-regression'),
         undefined,
      );
   } finally {
      store.close();
   }
});

test('x402 payment headers are exposed to browser clients and preflight allows payment signatures', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [{ x402Version: 2, scheme: 'exact', network: ALGORAND_TESTNET }],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
      });

      const unpaid = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            origin: 'https://roundwatch.observer',
            'content-type': 'application/json',
         },
         body: JSON.stringify({
            idempotencyKey: SPEC.idempotencyKey,
            expectedSender: PAYER,
            expectedReceiver: RECEIVER,
            atomicAmount: SPEC.atomicAmount,
            invoiceNote: SPEC.invoiceNote,
         }),
      });

      assert.equal(unpaid.status, 402);
      assert.equal(unpaid.headers.get('access-control-allow-origin'), '*');
      const exposed = (unpaid.headers.get('access-control-expose-headers') ?? '')
         .toLowerCase()
         .split(',')
         .map(value => value.trim());
      assert.ok(exposed.includes('payment-required'));
      assert.ok(exposed.includes('payment-response'));
      assert.ok(exposed.includes('x-roundwatch-id'));

      const preflight = await app.request('/spike/watch', {
         method: 'OPTIONS',
         headers: {
            origin: 'https://example-browser-payer.test',
            'access-control-request-method': 'POST',
            'access-control-request-headers':
               'content-type,payment-signature,mcp-protocol-version,mcp-method,mcp-name',
         },
      });

      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
      const allowed = (preflight.headers.get('access-control-allow-headers') ?? '')
         .toLowerCase()
         .split(',')
         .map(value => value.trim());
      assert.ok(allowed.includes('content-type'));
      assert.ok(allowed.includes('payment-signature'));
      assert.ok(allowed.includes('mcp-protocol-version'));
      assert.ok(allowed.includes('mcp-method'));
      assert.ok(allowed.includes('mcp-name'));
   } finally {
      store.close();
   }
});

test('TestNet remains the default and the x402 requirement preserves network, asset, amount, and receiver', async () => {
   assert.equal(resolveRoundWatchNetwork(undefined).name, 'testnet');
   assert.equal(resolveRoundWatchNetwork('mainnet'), MAINNET_NETWORK_CONFIG);
   const store = new RoundWatchStore(':memory:');
   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [{ x402Version: 2, scheme: 'exact', network: ALGORAND_TESTNET }],
               extensions: [], signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
      });
      const response = await app.request('/spike/watch', {
         method: 'POST', headers: { 'content-type': 'application/json' },
         body: JSON.stringify({ idempotencyKey: SPEC.idempotencyKey, expectedSender: PAYER,
            expectedReceiver: RECEIVER, atomicAmount: SPEC.atomicAmount, invoiceNote: SPEC.invoiceNote }),
      });
      assert.equal(response.status, 402);
      const encoded = response.headers.get('payment-required'); assert.ok(encoded);
      const required = decodePaymentRequiredHeader(encoded).accepts[0]!;
      assert.equal(required.network, ALGORAND_TESTNET);
      assert.equal(required.payTo, RECEIVER);
      assert.equal(ROUNDWATCH_SERVICE_ATOMIC_AMOUNT, '100000');
      assert.equal(required.amount, ROUNDWATCH_SERVICE_ATOMIC_AMOUNT);
      assert.equal(required.extra?.asset, String(TESTNET_USDC_ASSET_ID));
      const description = String(
         (decodePaymentRequiredHeader(encoded) as unknown as {
            resource?: { description?: unknown };
         }).resource?.description,
      );
      assert.match(description, /Eligibility lasts 1800000 ms/i);
      assert.match(
         description,
         /round strictly greater than activationRound/i,
      );
      assert.match(
         description,
         /round-time must be strictly earlier than expiresAt/i,
      );
      assert.match(description, /same-round payment is ineligible/i);
      assert.match(description, /exactly at the deadline is ineligible/i);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(store.getByIdempotencyKey(SPEC.idempotencyKey), undefined);
   } finally { store.close(); }
});

test('Bazaar discovery watch example uses checksum-valid Algorand addresses', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [{ x402Version: 2, scheme: 'exact', network: ALGORAND_TESTNET }],
               extensions: [], signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(100),
      });
      const response = await app.request('/spike/watch', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
            idempotencyKey: 'bazaar-address-smoke',
            expectedSender: PAYER,
            expectedReceiver: RECEIVER,
            atomicAmount: '1',
         }),
      });
      assert.equal(response.status, 402);

      const encoded = response.headers.get('payment-required');
      assert.ok(encoded);
      const decoded = decodePaymentRequiredHeader(encoded) as unknown as {
         resource?: {
            serviceName?: unknown;
            tags?: unknown;
            iconUrl?: unknown;
            description?: unknown;
         };
         extensions?: {
            bazaar?: {
               info?: {
                  input?: {
                     body?: {
                        idempotencyKey?: unknown;
                        expectedSender?: unknown;
                        expectedReceiver?: unknown;
                     };
                  };
                  output?: {
                     example?: {
                        watchId?: unknown;
                        expiresAt?: unknown;
                        message?: unknown;
                     };
                  };
               };
            };
         };
      };

      assert.equal(decoded.resource?.serviceName, 'RoundWatch');
      assert.deepEqual(decoded.resource?.tags, [
         'algorand',
         'usdc',
         'payment-monitoring',
         'ai-agents',
         'x402',
      ]);
      assert.equal(
         decoded.resource?.iconUrl,
         'https://roundwatch.observer/favicon.svg',
      );
      assert.match(
         String(decoded.resource?.description),
         /future Algorand USDC payment/i,
      );

      const example = decoded.extensions?.bazaar?.info?.input?.body;
      assert.ok(example);
      const expectedSender = example.expectedSender;
      const expectedReceiver = example.expectedReceiver;
      if (typeof expectedSender !== 'string' || typeof expectedReceiver !== 'string') {
         assert.fail('Bazaar watch example must contain string Algorand addresses');
      }
      assert.equal(isValidAlgorandAddress(expectedSender), true);
      assert.equal(isValidAlgorandAddress(expectedReceiver), true);
      assert.equal(expectedSender, WATCH_SENDER);
      assert.notEqual(expectedSender, PAYER);
      assert.equal(expectedReceiver, RECEIVER);
      assert.equal(
         example.idempotencyKey,
         'replace-with-unique-idempotency-key',
      );

      const outputExample =
         decoded.extensions?.bazaar?.info?.output?.example;
      assert.ok(outputExample);
      assert.equal(
         outputExample.watchId,
         'WATCH_ID_RETURNED_AFTER_SUCCESSFUL_PAID_CREATION',
      );
      assert.equal(
         outputExample.expiresAt,
         'ISO_8601_DEADLINE_RETURNED_FOR_THIS_WATCH',
      );
      assert.match(String(outputExample.message), /Example only/i);
   } finally {
      store.close();
   }
});

test('signed discovery idempotency placeholder is rejected before facilitator verification or settlement', async () => {
   const store = new RoundWatchStore(':memory:');
   let verifyCalls = 0;
   let settleCalls = 0;

   try {
      const facilitator = {
         getSupported: async () => ({
            kinds: [
               {
                  x402Version: 2,
                  scheme: 'exact',
                  network: ALGORAND_TESTNET,
               },
            ],
            extensions: [],
            signers: {},
         }),
         verify: async () => {
            verifyCalls += 1;
            throw new Error('discovery placeholder must not reach verification');
         },
         settle: async () => {
            settleCalls += 1;
            throw new Error('discovery placeholder must not settle');
         },
      } as unknown as FacilitatorClient;
      const app = createApp({
         avmAddress: SERVICE_RECEIVER,
         facilitatorClient: facilitator,
         store,
         indexer: new MiddlewareIndexer(),
         requireSettlementIntent: true,
      });

      const spec = {
         ...SPEC,
         idempotencyKey: 'replace-with-unique-idempotency-key',
         expectedSender: WATCH_SENDER,
      };
      const { paymentHeader, body } = await createSyntheticPaidRequest(app, spec);
      const response = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': paymentHeader,
         },
         body,
      });

      assert.equal(response.status, 400);
      const rejected = await response.json() as {
         code?: string;
         error?: string;
      };
      assert.equal(rejected.code, 'example_idempotency_key');
      assert.match(rejected.error ?? '', /caller-generated/i);
      assert.equal(verifyCalls, 0);
      assert.equal(settleCalls, 0);
      assert.equal(
         store.getByIdempotencyKey(spec.idempotencyKey),
         undefined,
      );

      const noteSpec = {
         ...SPEC,
         idempotencyKey: 'caller-generated-note-sentinel-test',
         expectedSender: WATCH_SENDER,
         invoiceNote: 'replace-with-unique-invoice-note',
      };
      const noteRequest = await createSyntheticPaidRequest(app, noteSpec);
      const noteResponse = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': noteRequest.paymentHeader,
         },
         body: noteRequest.body,
      });
      assert.equal(noteResponse.status, 400);
      const noteRejected = await noteResponse.json() as {
         code?: string;
         error?: string;
      };
      assert.equal(noteRejected.code, 'example_invoice_note');
      assert.match(noteRejected.error ?? '', /caller-selected/i);
      assert.equal(verifyCalls, 0);
      assert.equal(settleCalls, 0);
      assert.equal(
         store.getByIdempotencyKey(noteSpec.idempotencyKey),
         undefined,
      );
   } finally {
      store.close();
   }
});

test('served OpenAPI watch example is structurally useful but cannot execute unchanged', async () => {
   const store = new RoundWatchStore(':memory:');
   let verifyCalls = 0;
   let settleCalls = 0;

   try {
      const app = createApp({
         avmAddress: SERVICE_RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [
                  {
                     x402Version: 2,
                     scheme: 'exact',
                     network: ALGORAND_TESTNET,
                  },
               ],
               extensions: [],
               signers: {},
            }),
            verify: async () => {
               verifyCalls += 1;
               throw new Error('OpenAPI example must not reach verification');
            },
            settle: async () => {
               settleCalls += 1;
               throw new Error('OpenAPI example must not settle');
            },
         } as unknown as FacilitatorClient,
         store,
         indexer: new MiddlewareIndexer(),
         requireSettlementIntent: true,
      });

      const docs = await (await app.request('/openapi.json')).json() as any;
      const example =
         docs.paths['/spike/watch'].post.requestBody.content['application/json']
            .example as Record<string, unknown>;
      assert.equal(
         example.idempotencyKey,
         'replace-with-unique-idempotency-key',
      );
      assert.equal(
         example.invoiceNote,
         'replace-with-unique-invoice-note',
      );

      const unpaid = await app.request('/spike/watch', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify(example),
      });
      assert.equal(unpaid.status, 402);
      const required = decodePaymentRequiredHeader(
         unpaid.headers.get('payment-required')!,
      ).accepts[0]!;
      const paymentHeader = encodePaymentSignatureHeader({
         x402Version: 2,
         accepted: required,
         payload: {
            paymentGroup: [SIGNED_SERVICE_PAYMENT],
            paymentIndex: 0,
         },
      } as PaymentPayload);

      const paid = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': paymentHeader,
         },
         body: JSON.stringify(example),
      });
      assert.equal(paid.status, 400);
      assert.equal(verifyCalls, 0);
      assert.equal(settleCalls, 0);
   } finally {
      store.close();
   }
});

test('verified payer cannot obtain a legacy NULL-payer watch through replay', async () => {
   const store = new RoundWatchStore(':memory:');

   try {
      const legacySpec = {
         ...SPEC,
         idempotencyKey: 'legacy-null-payer-http',
         expectedSender: WATCH_SENDER,
      };
      const legacy = store.prepareWatch(legacySpec).watch;
      const facilitator = new MiddlewareFacilitator(
         store,
         legacySpec.idempotencyKey,
      );
      const app = createApp({
         avmAddress: SERVICE_RECEIVER,
         facilitatorClient: facilitator,
         store,
         indexer: new MiddlewareIndexer(),
         requireSettlementIntent: true,
      });
      const { paymentHeader, body } =
         await createSyntheticPaidRequest(app, legacySpec);

      const response = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': paymentHeader,
         },
         body,
      });

      assert.equal(response.status, 409);
      const rejected = await response.json() as {
         code?: string;
         watch?: unknown;
         watchId?: unknown;
      };
      assert.equal(rejected.code, 'legacy_idempotency_conflict');
      assert.equal(rejected.watch, undefined);
      assert.equal(rejected.watchId, undefined);
      assert.equal(facilitator.settleCalls, 0);
      assert.equal(
         store.getByIdempotencyKey(legacySpec.idempotencyKey)?.id,
         legacy.id,
      );
   } finally {
      store.close();
   }
});

test('paid x402 middleware persists signed purchase terms and activates from the exact service round', async () => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new MiddlewareIndexer();
   const facilitator = new MiddlewareFacilitator(store, 'middleware-paid');
   const app = createApp({
      avmAddress: SERVICE_RECEIVER,
      facilitatorClient: facilitator,
      store,
      indexer,
      requireSettlementIntent: true,
   });

   try {
      const spec = {
         ...SPEC,
         idempotencyKey: 'middleware-paid',
         expectedSender: WATCH_SENDER,
      };
      const { paymentHeader, body } = await createSyntheticPaidRequest(app, spec);
      const paid = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': paymentHeader,
         },
         body,
      });

      assert.equal(paid.status, 200);
      assert.equal(facilitator.settleCalls, 1);
      assert.deepEqual(facilitator.statesObservedAtSettle, ['settlement_pending']);

      const active = store.getByIdempotencyKey(spec.idempotencyKey);
      assert.equal(active?.state, 'active');
      assert.equal(active?.expectedServiceTransaction, SIGNED_SERVICE_TX_ID);
      assert.equal(active?.expectedServicePayer, PAYER);
      assert.equal(active?.serviceReceiver, SERVICE_RECEIVER);
      assert.equal(active?.serviceAssetId, TESTNET_USDC_ASSET_ID);
      assert.equal(active?.serviceAtomicAmount, ROUNDWATCH_SERVICE_ATOMIC_AMOUNT);
      assert.equal(active?.serviceFirstValid, 100);
      assert.equal(active?.serviceLastValid, 200);
      assert.equal(active?.evidenceVersion, 1);
      assert.equal(active?.activationRound, 150);
      assert.equal(active?.scanAfterRound, 150);

      const duplicate = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': paymentHeader,
         },
         body,
      });

      assert.equal(duplicate.status, 409);
      const duplicateBody = await duplicate.json() as { code?: string };
      assert.equal(duplicateBody.code, 'idempotency_replay');
      assert.equal(facilitator.settleCalls, 1, 'duplicate must not settle again');
   } finally {
      store.close();
   }
});

test('settled payment survives activation lookup failure and reconciles without a second settlement', async () => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new MiddlewareIndexer();
   indexer.activationFailuresRemaining = 1;
   const facilitator = new MiddlewareFacilitator(store, 'middleware-recovery');
   const app = createApp({
      avmAddress: SERVICE_RECEIVER,
      facilitatorClient: facilitator,
      store,
      indexer,
      requireSettlementIntent: true,
   });

   try {
      const spec = {
         ...SPEC,
         idempotencyKey: 'middleware-recovery',
         expectedSender: WATCH_SENDER,
      };
      const { paymentHeader, body } = await createSyntheticPaidRequest(app, spec);
      const paid = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'payment-signature': paymentHeader,
         },
         body,
      });

      assert.equal(paid.status, 500);
      assert.equal(facilitator.settleCalls, 1);

      const pending = store.getByIdempotencyKey(spec.idempotencyKey);
      assert.equal(pending?.state, 'settlement_pending');
      assert.equal(pending?.expectedServiceTransaction, SIGNED_SERVICE_TX_ID);
      assert.equal(pending?.scanAfterRound, undefined);

      const reconciler = new SettlementReconciler(store, indexer, {
         network: ALGORAND_TESTNET,
         intervalMilliseconds: 5_000,
      });
      await reconciler.reconcileOnce();

      const recovered = store.getByIdempotencyKey(spec.idempotencyKey);
      assert.equal(recovered?.state, 'active');
      assert.equal(recovered?.activationRound, 150);
      assert.equal(recovered?.scanAfterRound, 150);
      assert.equal(facilitator.settleCalls, 1, 'recovery must not settle again');
   } finally {
      store.close();
   }
});

test('route-level global and payer admission rejection occur before x402 settlement', async () => {
   for (const scope of ['global', 'payer'] as const) {
      const store = new RoundWatchStore(':memory:', {
         maxOpenWatches: scope === 'global' ? 1 : 10,
         maxOpenWatchesPerPayer: 1,
      });

      try {
         store.prepareWatch(
            { ...SPEC, idempotencyKey: `${scope}-existing` },
            intent(`${scope.toUpperCase()}_EXISTING_TX`),
         );

         const rejectedKey = `${scope}-route-rejected`;
         const facilitator = new MiddlewareFacilitator(store, rejectedKey);
         const app = createApp({
            avmAddress: SERVICE_RECEIVER,
            facilitatorClient: facilitator,
            store,
            indexer: new MiddlewareIndexer(),
            requireSettlementIntent: true,
         });
         const spec = {
            ...SPEC,
            idempotencyKey: rejectedKey,
            expectedSender: WATCH_SENDER,
         };
         const { paymentHeader, body } = await createSyntheticPaidRequest(app, spec);
         const response = await app.request('/spike/watch', {
            method: 'POST',
            headers: {
               'content-type': 'application/json',
               'payment-signature': paymentHeader,
            },
            body,
         });
         const responseBody = await response.json() as { code?: string };

         assert.equal(response.status, 429);
         assert.equal(
            responseBody.code,
            scope === 'global'
               ? 'global_watch_capacity_exhausted'
               : 'payer_watch_capacity_exhausted',
         );
         assert.equal(facilitator.settleCalls, 0);
         assert.equal(store.getByIdempotencyKey(rejectedKey), undefined);
      } finally {
         store.close();
      }
   }
});

test('recovery lookup returns only an exact existing activated watch and never invokes x402', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const prepared = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'recovery-lookup-existing' },
         intent('RECOVERY_LOOKUP_SERVICE_TX'),
      ).watch;
      store.activateWatch(
         prepared.id,
         {
            transaction: 'RECOVERY_LOOKUP_SERVICE_TX',
            network: ALGORAND_TESTNET,
            payer: PAYER,
         },
         150,
      );

      let facilitatorCalls = 0;
      const app = createApp({
         avmAddress: SERVICE_RECEIVER,
         facilitatorClient: {
            verify: async () => {
               facilitatorCalls += 1;
               throw new Error('recovery lookup must not verify payment');
            },
            settle: async () => {
               facilitatorCalls += 1;
               throw new Error('recovery lookup must not settle payment');
            },
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new MiddlewareIndexer(),
         syncFacilitatorOnStart: false,
      });

      const exact = await app.request('/spike/watch/recover', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
            idempotencyKey: 'recovery-lookup-existing',
            expectedSender: SPEC.expectedSender,
            expectedReceiver: SPEC.expectedReceiver,
            atomicAmount: SPEC.atomicAmount,
            invoiceNote: SPEC.invoiceNote,
            servicePayer: PAYER,
         }),
      });

      assert.equal(exact.status, 200);
      assert.equal(exact.headers.get('payment-required'), null);
      assert.equal(exact.headers.get('cache-control'), 'no-store');
      const exactBody = await exact.json() as {
         watch?: Record<string, unknown>;
      };
      assert.equal(exactBody.watch?.id, prepared.id);
      assert.equal(exactBody.watch?.idempotencyKey, undefined);
      assert.equal(facilitatorCalls, 0);

      const wrongPayer = await app.request('/spike/watch/recover', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
            idempotencyKey: 'recovery-lookup-existing',
            expectedSender: SPEC.expectedSender,
            expectedReceiver: SPEC.expectedReceiver,
            atomicAmount: SPEC.atomicAmount,
            invoiceNote: SPEC.invoiceNote,
            servicePayer: RECEIVER,
         }),
      });
      assert.equal(wrongPayer.status, 404);
      assert.equal(facilitatorCalls, 0);

      const missing = await app.request('/spike/watch/recover', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
            idempotencyKey: 'recovery-lookup-missing',
            expectedSender: SPEC.expectedSender,
            expectedReceiver: SPEC.expectedReceiver,
            atomicAmount: SPEC.atomicAmount,
            invoiceNote: SPEC.invoiceNote,
            servicePayer: PAYER,
         }),
      });
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get('payment-required'), null);
      assert.equal(facilitatorCalls, 0);
   } finally {
      store.close();
   }
});

test('recovery preserves exact legacy zero-sender watches created before admission hardening', async () => {
   const store = new RoundWatchStore(':memory:');

   try {
      const legacySpec: WatchSpec = {
         ...SPEC,
         idempotencyKey: 'legacy-zero-sender-recovery',
         expectedSender: PAYER,
      };
      const prepared = store.prepareWatch(
         legacySpec,
         intent('LEGACY_ZERO_SENDER_SERVICE_TX'),
      ).watch;
      store.activateWatch(
         prepared.id,
         {
            transaction: 'LEGACY_ZERO_SENDER_SERVICE_TX',
            network: ALGORAND_TESTNET,
            payer: PAYER,
         },
         150,
      );

      const app = createApp({
         avmAddress: SERVICE_RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new MiddlewareIndexer(),
         syncFacilitatorOnStart: false,
      });

      const response = await app.request('/spike/watch/recover', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
            idempotencyKey: legacySpec.idempotencyKey,
            expectedSender: legacySpec.expectedSender,
            expectedReceiver: legacySpec.expectedReceiver,
            atomicAmount: legacySpec.atomicAmount,
            invoiceNote: legacySpec.invoiceNote,
            servicePayer: PAYER,
         }),
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('payment-required'), null);
      const recovered = await response.json() as {
         watch?: Record<string, unknown>;
      };
      assert.equal(recovered.watch?.id, prepared.id);
      assert.equal(recovered.watch?.expectedSender, PAYER);
   } finally {
      store.close();
   }
});

test('recovery lookup keeps confirmed-settlement terminal watches recoverable', async () => {
   const store = new RoundWatchStore(':memory:', { workUnitBudget: 1 });
   try {
      const expired = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'recovery-expired-settled' },
         intent('RECOVERY_EXPIRED_SERVICE_TX'),
      ).watch;
      store.activateWatch(
         expired.id,
         {
            transaction: 'RECOVERY_EXPIRED_SERVICE_TX',
            network: ALGORAND_TESTNET,
            payer: PAYER,
         },
         150,
      );
      assert.equal(store.setClosingRound(expired.id, 151), 151);
      assert.equal(store.advanceScanRound(expired.id, 150, 151), true);
      assert.equal(store.markExpired(expired.id, 151, 151), true);

      const indeterminate = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'recovery-indeterminate-settled' },
         intent('RECOVERY_INDETERMINATE_SERVICE_TX'),
      ).watch;
      store.activateWatch(
         indeterminate.id,
         {
            transaction: 'RECOVERY_INDETERMINATE_SERVICE_TX',
            network: ALGORAND_TESTNET,
            payer: PAYER,
         },
         160,
      );
      assert.equal(store.claimWorkUnit(indeterminate.id), 'claimed');
      assert.equal(store.claimWorkUnit(indeterminate.id), 'exhausted');
      assert.equal(store.getWatch(indeterminate.id)?.state, 'indeterminate');

      const app = createApp({
         avmAddress: SERVICE_RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new MiddlewareIndexer(),
         syncFacilitatorOnStart: false,
      });

      const recover = async (
         idempotencyKey: string,
      ): Promise<{ status: number; body: { watch?: Record<string, unknown> } }> => {
         const response = await app.request('/spike/watch/recover', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
               idempotencyKey,
               expectedSender: SPEC.expectedSender,
               expectedReceiver: SPEC.expectedReceiver,
               atomicAmount: SPEC.atomicAmount,
               invoiceNote: SPEC.invoiceNote,
               servicePayer: PAYER,
            }),
         });

         return {
            status: response.status,
            body: await response.json() as { watch?: Record<string, unknown> },
         };
      };

      const expiredRecovery = await recover('recovery-expired-settled');
      assert.equal(expiredRecovery.status, 200);
      assert.equal(expiredRecovery.body.watch?.id, expired.id);
      assert.equal(expiredRecovery.body.watch?.state, 'expired');

      const indeterminateRecovery = await recover(
         'recovery-indeterminate-settled',
      );
      assert.equal(indeterminateRecovery.status, 200);
      assert.equal(indeterminateRecovery.body.watch?.id, indeterminate.id);
      assert.equal(indeterminateRecovery.body.watch?.state, 'indeterminate');
   } finally {
      store.close();
   }
});

test('recovery lookup refuses non-active obligations without exposing a watch ID', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      store.prepareWatch(
         { ...SPEC, idempotencyKey: 'recovery-lookup-pending' },
         intent('RECOVERY_LOOKUP_PENDING_TX'),
      );

      const app = createApp({
         avmAddress: SERVICE_RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new MiddlewareIndexer(),
         syncFacilitatorOnStart: false,
      });

      const response = await app.request('/spike/watch/recover', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
            idempotencyKey: 'recovery-lookup-pending',
            expectedSender: SPEC.expectedSender,
            expectedReceiver: SPEC.expectedReceiver,
            atomicAmount: SPEC.atomicAmount,
            invoiceNote: SPEC.invoiceNote,
            servicePayer: PAYER,
         }),
      });

      assert.equal(response.status, 409);
      const body = await response.json() as {
         state?: string;
         watchId?: string;
         recovery?: {
            retryable?: boolean;
            terminal?: boolean;
            reason?: string;
            nextAction?: string;
         };
      };
      assert.equal(body.state, 'settlement_pending');
      assert.equal(body.watchId, undefined);
      assert.equal(body.recovery?.retryable, true);
      assert.equal(body.recovery?.terminal, false);
      assert.equal(
         body.recovery?.reason,
         'settlement_reconciliation_pending',
      );
      assert.equal(
         body.recovery?.nextAction,
         'retry_recovery_later',
      );
   } finally {
      store.close();
   }
});

test('recovery lookup distinguishes retryable from terminal settlement reconciliation without disclosing watch ID', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const watch = store.prepareWatch(
         {
            ...SPEC,
            idempotencyKey: 'recovery-terminal-distinction',
         },
         intent('RECOVERY_TERMINAL_DISTINCTION_TX'),
      ).watch;
      store.markSettlementUnknown(watch.id);

      const app = createApp({
         avmAddress: SERVICE_RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new MiddlewareIndexer(),
         syncFacilitatorOnStart: false,
      });

      const recoveryRequest = () =>
         app.request('/spike/watch/recover', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
               idempotencyKey: 'recovery-terminal-distinction',
               expectedSender: SPEC.expectedSender,
               expectedReceiver: SPEC.expectedReceiver,
               atomicAmount: SPEC.atomicAmount,
               invoiceNote: SPEC.invoiceNote,
               servicePayer: PAYER,
            }),
         });

      const retryable = await recoveryRequest();
      assert.equal(retryable.status, 409);
      assert.equal(retryable.headers.get('cache-control'), 'no-store');
      const retryableBody = await retryable.json() as {
         state?: string;
         watchId?: string;
         recovery?: {
            retryable?: boolean;
            terminal?: boolean;
            reason?: string;
            nextAction?: string;
         };
      };
      assert.equal(retryableBody.state, 'settlement_unknown');
      assert.equal(retryableBody.watchId, undefined);
      assert.equal(retryableBody.recovery?.retryable, true);
      assert.equal(retryableBody.recovery?.terminal, false);
      assert.equal(
         retryableBody.recovery?.reason,
         'settlement_reconciliation_pending',
      );
      assert.equal(
         retryableBody.recovery?.nextAction,
         'retry_recovery_later',
      );

      store.markSettlementInvalid(watch.id);

      const terminal = await recoveryRequest();
      assert.equal(terminal.status, 409);
      assert.equal(terminal.headers.get('cache-control'), 'no-store');
      const terminalBody = await terminal.json() as {
         state?: string;
         watchId?: string;
         recovery?: {
            retryable?: boolean;
            terminal?: boolean;
            reason?: string;
            nextAction?: string;
         };
      };
      assert.equal(terminalBody.state, 'settlement_unknown');
      assert.equal(terminalBody.watchId, undefined);
      assert.equal(terminalBody.recovery?.retryable, false);
      assert.equal(terminalBody.recovery?.terminal, true);
      assert.equal(
         terminalBody.recovery?.reason,
         'settlement_reconciliation_terminal',
      );
      assert.equal(
         terminalBody.recovery?.nextAction,
         'retain_checkpoint_and_investigate',
      );
   } finally {
      store.close();
   }
});

test('free recovery lookup has independent bounded admission before body parsing', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const app = createApp({
         avmAddress: SERVICE_RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new MiddlewareIndexer(),
         syncFacilitatorOnStart: false,
         recoveryRequestGateOptions: {
            requestsPerSecond: 0.001,
            burst: 1,
            concurrency: 1,
         },
      });

      const body = JSON.stringify({
         idempotencyKey: 'bounded-recovery-missing',
         expectedSender: SPEC.expectedSender,
         expectedReceiver: SPEC.expectedReceiver,
         atomicAmount: SPEC.atomicAmount,
         invoiceNote: SPEC.invoiceNote,
         servicePayer: PAYER,
      });

      const first = await app.request('/spike/watch/recover', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body,
      });
      assert.equal(first.status, 404);

      const second = await app.request('/spike/watch/recover', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body,
      });
      assert.equal(second.status, 429);
      assert.equal(second.headers.get('retry-after'), '1');
      const secondBody = await second.json() as { code?: string };
      assert.equal(
         secondBody.code,
         'watch_recovery_rate_limited',
      );
   } finally {
      store.close();
   }
});

test('MainNet public base URL remains required, HTTPS-only, loopback-safe, and normalized', () => {
   assert.throws(
      () => resolveRoundWatchPublicBaseUrl(undefined, 'mainnet'),
      /required on MainNet/,
   );
   assert.throws(
      () => resolveRoundWatchPublicBaseUrl('http://roundwatch.example', 'mainnet'),
      /must use HTTPS/,
   );
   assert.throws(
      () => resolveRoundWatchPublicBaseUrl('https://127.0.0.1', 'mainnet'),
      /loopback/,
   );
   assert.throws(
      () => resolveRoundWatchPublicBaseUrl('https://localhost.', 'mainnet'),
      /localhost/,
   );
   assert.equal(
      resolveRoundWatchPublicBaseUrl(
         'https://roundwatch-api.onrender.com///',
         'mainnet',
      ),
      'https://roundwatch-api.onrender.com',
   );
   assert.equal(resolveRoundWatchPublicBaseUrl(undefined, 'testnet'), undefined);
});

test('exact watch matching rejects every changed field and compares note bytes exactly', () => {
   const watch = watchRecord({
      activationRound: 100,
      expiresAt: '2030-01-01T00:00:00.000Z',
   });
   const matching = invoiceTx(101, 1_800_000_000);

   assert.equal(matchesWatch(matching, watch), true);
   assert.equal(matchesWatch({ ...matching, sender: RECEIVER }, watch), false);
   assert.equal(matchesWatch({ ...matching, receiver: PAYER }, watch), false);
   assert.equal(matchesWatch({ ...matching, assetId: TESTNET_USDC_ASSET_ID + 1 }, watch), false);
   assert.equal(matchesWatch({ ...matching, atomicAmount: '2500001' }, watch), false);
   assert.equal(
      matchesWatch({
         ...matching,
         note: Buffer.from('different-note', 'utf8').toString('base64'),
      }, watch),
      false,
   );

   const replacementWatch = watchRecord({
      invoiceNote: '\uFFFD',
      activationRound: 100,
      expiresAt: '2030-01-01T00:00:00.000Z',
   });
   assert.equal(
      matchesWatch({
         ...matching,
         note: Buffer.from([0xff]).toString('base64'),
      }, replacementWatch),
      false,
      'invalid UTF-8 bytes must not match U+FFFD through replacement decoding',
   );
});

test('evidence version 1 is never fabricated without immutable settlement intent', () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const withoutEvidence = store.prepareWatch({
         ...SPEC,
         idempotencyKey: 'evidence-version-zero',
      }).watch;
      const withEvidence = store.prepareWatch({
         ...SPEC,
         idempotencyKey: 'evidence-version-one',
      }, intent('EVIDENCE_VERSION_ONE_TX')).watch;

      assert.equal(withoutEvidence.evidenceVersion, 0);
      assert.equal(withEvidence.evidenceVersion, 1);
   } finally {
      store.close();
   }
});

test('proof-compatible active watch without a cursor remains unresolved and is not scanned', async () => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new FakeIndexer(101);
   try {
      const watch = store.prepareWatch({
         ...SPEC,
         idempotencyKey: 'cursorless-proof-watch',
      }, intent('CURSORLESS_PROOF_TX')).watch;
      store.activateWatch(
         watch.id,
         {
            transaction: 'CURSORLESS_PROOF_TX',
            network: ALGORAND_TESTNET,
            payer: PAYER,
         },
      );

      await new RoundWatchPoller(store, indexer).runOnce();

      assert.equal(store.getWatch(watch.id)?.state, 'active');
      assert.equal(store.getWatch(watch.id)?.scanAfterRound, undefined);
      assert.equal(indexer.pageCalls.length, 0);
   } finally {
      store.close();
   }
});

test('creation deadline is stable and wall-clock reads never terminalize a watch', () => {
   let now = new Date('2026-09-18T10:00:00.123Z');
   const store = new RoundWatchStore(':memory:', { watchTtlMilliseconds: 1_000, now: () => now });
   try {
      const prepared = store.prepareWatch(SPEC, intent());
      assert.equal(prepared.watch.expiresAt, '2026-09-18T10:00:01.123Z');
      store.activateWatch(prepared.watch.id, { transaction: 'SERVICE_TX', network: ALGORAND_TESTNET, payer: PAYER }, 100);
      now = new Date('2026-09-18T10:01:00.000Z');
      assert.equal(store.getWatch(prepared.watch.id)?.state, 'active');
      assert.equal(store.getByIdempotencyKey(SPEC.idempotencyKey)?.state, 'active');
   } finally { store.close(); }
});

test('chain time is exclusive at the deadline and fractional milliseconds are explicit', () => {
   const watch = watchRecord({ expiresAt: '2026-09-18T10:00:01.123Z', activationRound: 100 });
   assert.equal(matchesWatch(invoiceTx(101, 1_789_722_000), watch), true);
   // Indexer timestamps have second precision: 10:00:01.000 remains before .123.
   assert.equal(matchesWatch(invoiceTx(101, Date.parse('2026-09-18T10:00:01Z') / 1_000), watch), true);
   const exact = watchRecord({ expiresAt: '2026-09-18T10:00:01.000Z', activationRound: 100 });
   assert.equal(matchesWatch(invoiceTx(101, Date.parse(exact.expiresAt!) / 1_000), exact), false);
   assert.equal(matchesWatch(invoiceTx(101, Date.parse(exact.expiresAt!) / 1_000 + 1), exact), false);
   assert.equal(matchesWatch(invoiceTx(100, 1), watch), false, 'same settlement round is excluded');
});

test('an eligible invoice is found after local deadline and a scan spanning the deadline may match', async () => {
   let now = new Date('2026-09-18T10:00:00Z');
   const store = new RoundWatchStore(':memory:', { watchTtlMilliseconds: 2_000, now: () => now });
   const indexer = new FakeIndexer(105);
   try {
      const watch = store.prepareWatch(SPEC, intent()).watch;
      store.activateWatch(watch.id, { transaction: 'SERVICE_TX', network: ALGORAND_TESTNET, payer: PAYER }, 100);
      now = new Date('2026-09-18T10:00:10Z');
      indexer.block = { round: 105, timestamp: Date.parse('2026-09-18T10:00:03Z') / 1_000 };
      indexer.pages.push({ transactions: [invoiceTx(101, Date.parse('2026-09-18T10:00:01Z') / 1_000)], currentRound: 105 });
      await new RoundWatchPoller(store, indexer, 1, 100, () => now).runOnce();
      assert.equal(store.getWatch(watch.id)?.state, 'matched');
      assert.equal(store.getWatch(watch.id)?.closingRound, 105);
   } finally { store.close(); }
});

test('closing checkpoint is fixed and complete validated coverage alone expires', async () => {
   let now = new Date('2026-09-18T10:00:00Z');
   const store = new RoundWatchStore(':memory:', { watchTtlMilliseconds: 1_000, now: () => now });
   const indexer = new FakeIndexer(110);
   try {
      const watch = store.prepareWatch(SPEC, intent()).watch;
      store.activateWatch(watch.id, { transaction: 'SERVICE_TX', network: ALGORAND_TESTNET, payer: PAYER }, 100);
      now = new Date('2026-09-18T10:00:02Z');
      indexer.block = { round: 110, timestamp: Date.parse('2026-09-18T10:00:01Z') / 1_000 };
      indexer.pages.push({ transactions: [], currentRound: 110 });
      const poller = new RoundWatchPoller(store, indexer, 1, 100, () => now);
      await poller.runOnce();
      assert.equal(store.getWatch(watch.id)?.state, 'expired');
      assert.equal(store.getWatch(watch.id)?.closingRound, 110);
      indexer.round = 999;
      assert.equal(store.setClosingRound(watch.id, 999), 110);
   } finally { store.close(); }
});

test('closing checkpoint survives restart and provider advancement', () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-closing-'));
   const path = join(directory, 'watch.sqlite');
   try {
      const first = new RoundWatchStore(path);
      const watch = first.prepareWatch(SPEC, intent()).watch;
      first.activateWatch(watch.id, { transaction: 'SERVICE_TX', network: ALGORAND_TESTNET, payer: PAYER }, 100);
      assert.equal(first.setClosingRound(watch.id, 110), 110);
      first.close();
      const restarted = new RoundWatchStore(path);
      assert.equal(restarted.getWatch(watch.id)?.closingRound, 110);
      assert.equal(restarted.setClosingRound(watch.id, 999), 110);
      restarted.close();
   } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('low coverage, pagination failure, and repeated tokens cannot advance or expire', async () => {
   let now = new Date('2026-09-18T10:00:00Z');
   const store = new RoundWatchStore(':memory:', { watchTtlMilliseconds: 1_000, now: () => now });
   const indexer = new FakeIndexer(105);
   try {
      const watch = store.prepareWatch(SPEC, intent()).watch;
      store.activateWatch(watch.id, { transaction: 'SERVICE_TX', network: ALGORAND_TESTNET, payer: PAYER }, 100);
      now = new Date('2026-09-18T10:00:02Z');
      indexer.block = { round: 105, timestamp: Date.parse('2026-09-18T10:00:02Z') / 1_000 };
      indexer.pages.push({ transactions: [], currentRound: 104, nextToken: 'more' });
      const poller = new RoundWatchPoller(store, indexer, 1, 100, () => now);
      await poller.runOnce();
      assert.equal(store.getWatch(watch.id)?.scanAfterRound, 100);
      assert.equal(store.getWatch(watch.id)?.state, 'active');
      indexer.pages.push({ transactions: [], currentRound: 105, nextToken: 'same' });
      await poller.runOnce();
      indexer.pages.push({ transactions: [], currentRound: 105, nextToken: 'same' });
      await poller.runOnce();
      assert.equal(store.getWatch(watch.id)?.scanAfterRound, 100);
   } finally { store.close(); }
});

test('restart mid-pagination replays the bounded window from the durable cursor', async () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-page-'));
   const path = join(directory, 'watch.sqlite');
   try {
      const first = new RoundWatchStore(path);
      const watch = first.prepareWatch(SPEC, intent()).watch;
      first.activateWatch(watch.id, { transaction: 'SERVICE_TX', network: ALGORAND_TESTNET, payer: PAYER }, 100);
      const firstIndexer = new FakeIndexer(105);
      firstIndexer.pages.push({ transactions: [], currentRound: 105, nextToken: 'page-2' });
      await new RoundWatchPoller(first, firstIndexer).runOnce();
      assert.equal(first.getWatch(watch.id)?.scanAfterRound, 100);
      first.close();
      const restarted = new RoundWatchStore(path);
      const secondIndexer = new FakeIndexer(105);
      secondIndexer.pages.push({ transactions: [invoiceTx(102, 1)], currentRound: 105 });
      await new RoundWatchPoller(restarted, secondIndexer).runOnce();
      assert.equal(secondIndexer.pageCalls[0]?.nextToken, undefined);
      assert.equal(restarted.getWatch(watch.id)?.state, 'matched');
      restarted.close();
   } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('cursor updates are monotonic and stale competing work cannot overwrite progress', () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const watch = store.prepareWatch(SPEC, intent()).watch;
      store.activateWatch(watch.id, { transaction: 'SERVICE_TX', network: ALGORAND_TESTNET, payer: PAYER }, 100);
      assert.equal(store.advanceScanRound(watch.id, 100, 110), true);
      assert.equal(store.advanceScanRound(watch.id, 100, 105), false);
      assert.equal(store.advanceScanRound(watch.id, 110, 109), false);
      assert.equal(store.getWatch(watch.id)?.scanAfterRound, 110);
   } finally { store.close(); }
});

test('runtime scan query strategy defaults to C and validates explicit rollback variants', () => {
   assert.equal(resolveScanQueryVariant(undefined), 'C');
   assert.equal(resolveScanQueryVariant(''), 'C');
   assert.equal(resolveScanQueryVariant(' c '), 'C');
   assert.equal(resolveScanQueryVariant('A'), 'A');
   assert.equal(resolveScanQueryVariant('B'), 'B');
   assert.equal(resolveScanQueryVariant('D'), 'D');
   assert.throws(
      () => resolveScanQueryVariant('E'),
      /must be one of A, B, C, D/,
   );
});

test('scan query variants apply only declared server filters and keep exact matching local', async () => {
   const watch = watchRecord({});
   const variants: Array<{
      variant: ScanQueryVariant;
      expectedRole: 'sender' | 'receiver';
      expectedAddress: string;
      expectAmount: boolean;
      expectNote: boolean;
   }> = [
      {
         variant: 'A',
         expectedRole: 'sender',
         expectedAddress: PAYER,
         expectAmount: false,
         expectNote: false,
      },
      {
         variant: 'B',
         expectedRole: 'sender',
         expectedAddress: PAYER,
         expectAmount: true,
         expectNote: false,
      },
      {
         variant: 'C',
         expectedRole: 'sender',
         expectedAddress: PAYER,
         expectAmount: true,
         expectNote: true,
      },
      {
         variant: 'D',
         expectedRole: 'receiver',
         expectedAddress: RECEIVER,
         expectAmount: true,
         expectNote: true,
      },
   ];

   for (const expected of variants) {
      let requested: URL | undefined;
      const dispatcher = new IndexerRequestDispatcher({
         requestsPerSecond: 1_000,
         burst: 10,
         concurrency: 1,
      });
      const mockFetch: typeof fetch = async input => {
         requested = new URL(String(input));

         const sender =
            expected.variant === 'D' ? RECEIVER : PAYER;
         const note = Buffer.from(
            `${SPEC.invoiceNote}:suffix`,
            'utf8',
         ).toString('base64');

         return Response.json({
            transactions: [{
               id: `TX_${expected.variant}`,
               sender,
               note,
               'confirmed-round': 11,
               'round-time': 1,
               'tx-type': 'axfer',
               'asset-transfer-transaction': {
                  receiver: RECEIVER,
                  'asset-id': TESTNET_USDC_ASSET_ID,
                  amount: Number(SPEC.atomicAmount),
               },
            }],
            'current-round': 20,
         });
      };

      const indexer = new AlgorandIndexerClient(
         'https://indexer.invalid',
         dispatcher,
         mockFetch,
         1_000,
         undefined,
         expected.variant,
      );

      const page = await indexer.searchWatchPage(watch, 10, 20);
      assert.equal(page.transactions.length, 1);
      assert.ok(requested);

      assert.equal(
         requested.searchParams.get('address-role'),
         expected.expectedRole,
      );
      assert.equal(
         requested.searchParams.get('address'),
         expected.expectedAddress,
      );
      assert.equal(
         requested.searchParams.get('exclude-close-to'),
         'true',
      );

      if (expected.expectAmount) {
         assert.equal(
            requested.searchParams.get('currency-greater-than'),
            String(BigInt(SPEC.atomicAmount) - 1n),
         );
         assert.equal(
            requested.searchParams.get('currency-less-than'),
            String(BigInt(SPEC.atomicAmount) + 1n),
         );
      } else {
         assert.equal(
            requested.searchParams.has('currency-greater-than'),
            false,
         );
         assert.equal(
            requested.searchParams.has('currency-less-than'),
            false,
         );
      }

      if (expected.expectNote) {
         assert.equal(
            requested.searchParams.get('note-prefix'),
            Buffer.from(SPEC.invoiceNote!, 'utf8').toString('base64'),
         );
      } else {
         assert.equal(requested.searchParams.has('note-prefix'), false);
      }

      // D is receiver-oriented. A different sender is allowed through
      // server-filter validation and is rejected later by matchesWatch().
      if (expected.variant === 'D') {
         assert.equal(page.transactions[0]?.sender, RECEIVER);
         assert.equal(matchesWatch(page.transactions[0]!, watch), false);
      }
   }

   const noNote = watchRecord({ invoiceNote: undefined });
   let cUrl: URL | undefined;
   const cIndexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      new IndexerRequestDispatcher({
         requestsPerSecond: 1_000,
         burst: 10,
         concurrency: 1,
      }),
      async input => {
         cUrl = new URL(String(input));
         return Response.json({
            transactions: [],
            'current-round': 20,
         });
      },
      1_000,
      undefined,
      'C',
   );
   await cIndexer.searchWatchPage(noNote, 10, 20);
   assert.ok(cUrl);
   assert.equal(cUrl.searchParams.has('note-prefix'), false);
});

test('watch scanning explicitly excludes inner, clawback, and close-out asset transfers', async () => {
   const watch = watchRecord({});
   const note = Buffer.from(
      SPEC.invoiceNote!,
      'utf8',
   ).toString('base64');

   const unsupported: Array<Record<string, unknown>> = [
      {
         id: 'INNER_PARENT',
         sender: PAYER,
         'confirmed-round': 11,
         'round-time': 1,
         'tx-type': 'appl',
         'inner-txns': [{
            id: 'INNER_CHILD',
            sender: PAYER,
            note,
            'confirmed-round': 11,
            'round-time': 1,
            'tx-type': 'axfer',
            'asset-transfer-transaction': {
               receiver: RECEIVER,
               'asset-id': TESTNET_USDC_ASSET_ID,
               amount: Number(SPEC.atomicAmount),
            },
         }],
      },
      {
         id: 'CLAWBACK',
         sender: RECEIVER,
         note,
         'confirmed-round': 11,
         'round-time': 1,
         'tx-type': 'axfer',
         'asset-transfer-transaction': {
            sender: PAYER,
            receiver: RECEIVER,
            'asset-id': TESTNET_USDC_ASSET_ID,
            amount: Number(SPEC.atomicAmount),
         },
      },
      {
         id: 'CLOSE_OUT',
         sender: PAYER,
         note,
         'confirmed-round': 11,
         'round-time': 1,
         'tx-type': 'axfer',
         'asset-transfer-transaction': {
            receiver: RECEIVER,
            'asset-id': TESTNET_USDC_ASSET_ID,
            amount: Number(SPEC.atomicAmount),
            'close-to': RECEIVER,
            'close-amount': 7,
         },
      },
   ];

   let call = 0;
   const indexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      new IndexerRequestDispatcher({
         requestsPerSecond: 1_000,
         burst: 10,
         concurrency: 1,
      }),
      async input => {
         const requested = new URL(String(input));
         assert.equal(requested.searchParams.get('tx-type'), 'axfer');
         assert.equal(
            requested.searchParams.get('exclude-close-to'),
            'true',
         );

         return Response.json({
            transactions: [unsupported[call++]!],
            'current-round': 20,
         });
      },
      1_000,
      undefined,
      'C',
   );

   for (let i = 0; i < unsupported.length; i += 1) {
      const page = await indexer.searchWatchPage(watch, 10, 20);
      assert.deepEqual(page.transactions, []);
   }

   assert.equal(call, unsupported.length);
});

test('watch scanning still fails closed on malformed transaction envelopes', async () => {
   const malformed: Array<Record<string, unknown>> = [
      {
         id: 'NON_AXFER_WITHOUT_INNER',
         sender: PAYER,
         'confirmed-round': 11,
         'round-time': 1,
         'tx-type': 'appl',
      },
      {
         id: 'MALFORMED_INNER_ROOT',
         sender: PAYER,
         'confirmed-round': 11,
         'round-time': 1,
         'tx-type': 'appl',
         'inner-txns': [null],
      },
      {
         id: 'MALFORMED_CLAWBACK',
         sender: PAYER,
         'confirmed-round': 11,
         'round-time': 1,
         'tx-type': 'axfer',
         'asset-transfer-transaction': {
            sender: PAYER,
         },
      },
      {
         id: 'MALFORMED_CLOSE',
         sender: PAYER,
         'confirmed-round': 11,
         'round-time': 1,
         'tx-type': 'axfer',
         'asset-transfer-transaction': {
            'close-to': RECEIVER,
         },
      },
      {
         ...rawTx(11),
         'asset-transfer-transaction': {
            receiver: RECEIVER,
            'asset-id': TESTNET_USDC_ASSET_ID,
            amount: Number(SPEC.atomicAmount),
            'close-amount': 7,
         },
      },
      {
         ...rawTx(11),
         'tx-type': undefined,
      },
   ];

   const indexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      new IndexerRequestDispatcher({
         requestsPerSecond: 1_000,
         burst: 10,
         concurrency: 1,
      }),
      async () =>
         Response.json({
            transactions: [malformed.shift()!],
            'current-round': 20,
         }),
      1_000,
      undefined,
      'A',
   );
   const watch = watchRecord({});

   await assert.rejects(
      indexer.searchWatchPage(watch, 10, 20),
      /no inner transaction evidence/,
   );
   await assert.rejects(
      indexer.searchWatchPage(watch, 10, 20),
      /not an object/,
   );
   await assert.rejects(
      indexer.searchWatchPage(watch, 10, 20),
      /receiver/,
   );
   await assert.rejects(
      indexer.searchWatchPage(watch, 10, 20),
      /receiver/,
   );
   await assert.rejects(
      indexer.searchWatchPage(watch, 10, 20),
      /positive close-amount without close-to/,
   );
   await assert.rejects(
      indexer.searchWatchPage(watch, 10, 20),
      /tx-type/,
   );
});

test('malformed excluded evidence cannot advance coverage or produce expiry', async () => {
   const matchingInner: Record<string, unknown> = {
      id: 'N01_MATCHING_INNER',
      sender: PAYER,
      note: Buffer.from(SPEC.invoiceNote!, 'utf8').toString('base64'),
      'confirmed-round': 101,
      'round-time': 1_800_000_000,
      'tx-type': 'axfer',
      'asset-transfer-transaction': {
         receiver: RECEIVER,
         'asset-id': TESTNET_USDC_ASSET_ID,
         amount: Number(SPEC.atomicAmount),
         'close-amount': 0,
      },
   };
   const validInnerParent: Record<string, unknown> = {
      id: 'N01_VALID_PARENT',
      sender: RECEIVER,
      'confirmed-round': 101,
      'round-time': 1_800_000_000,
      'tx-type': 'appl',
      'inner-txns': [matchingInner],
   };
   const malformedVariants: Array<Record<string, unknown>> = [
      {
         id: 'N01_INNER_ROOT',
         sender: PAYER,
         'confirmed-round': 101,
         'round-time': 1_800_000_002,
         'tx-type': 'appl',
         'inner-txns': [null],
      },
      {
         id: 'N01_CLAWBACK',
         sender: PAYER,
         'confirmed-round': 101,
         'round-time': 1_800_000_002,
         'tx-type': 'axfer',
         'asset-transfer-transaction': {
            sender: PAYER,
         },
      },
      {
         id: 'N01_CLOSE',
         sender: PAYER,
         'confirmed-round': 101,
         'round-time': 1_800_000_002,
         'tx-type': 'axfer',
         'asset-transfer-transaction': {
            'close-to': RECEIVER,
         },
      },
      {
         ...validInnerParent,
         id: 'N01_UNKNOWN_PARENT_TYPE',
         'tx-type': 'not-a-transaction-type',
      },
      {
         ...validInnerParent,
         id: 'N01_PAY_PARENT_WITH_INNER',
         'tx-type': 'pay',
      },
      {
         ...validInnerParent,
         id: 'N01_CONTRADICTORY_TRANSFER_ENVELOPE',
         'asset-transfer-transaction':
            matchingInner['asset-transfer-transaction'],
      },
      {
         ...validInnerParent,
         id: 'N01_AXFER_WITH_MALFORMED_DESCENDANT',
         'inner-txns': [{
            ...matchingInner,
            'inner-txns': [null],
         }],
      },
      {
         ...validInnerParent,
         id: 'N01_UNKNOWN_SIBLING_TYPE',
         'inner-txns': [
            matchingInner,
            {
               id: 'N01_UNKNOWN_SIBLING',
               sender: PAYER,
               'confirmed-round': 101,
               'round-time': 1_800_000_000,
               'tx-type': 'garbage',
            },
         ],
      },
   ];

   for (let i = 0; i < malformedVariants.length; i += 1) {
      let now = new Date(1_800_000_000_000);
      const store = new RoundWatchStore(':memory:', {
         watchTtlMilliseconds: 1_000,
         now: () => now,
      });

      try {
         const serviceTx = `N01_SERVICE_${i}`;
         const watch = store.prepareWatch(
            {
               ...SPEC,
               idempotencyKey: `n01-malformed-evidence-${i}`,
            },
            intent(serviceTx),
         ).watch;
         store.activateWatch(
            watch.id,
            {
               transaction: serviceTx,
               network: ALGORAND_TESTNET,
               payer: PAYER,
            },
            100,
         );

         now = new Date(1_800_000_002_000);
         const indexer = new AlgorandIndexerClient(
            'https://indexer.invalid',
            new IndexerRequestDispatcher({
               requestsPerSecond: 1_000,
               burst: 10,
               concurrency: 1,
            }),
            async input => {
               const url = new URL(String(input));
               if (url.pathname === '/health') {
                  return Response.json({ round: 101 });
               }
               if (url.pathname === '/v2/blocks/101') {
                  return Response.json({
                     round: 101,
                     timestamp: 1_800_000_002,
                  });
               }
               if (
                  url.pathname ===
                  `/v2/assets/${TESTNET_USDC_ASSET_ID}/transactions`
               ) {
                  return Response.json({
                     transactions: [malformedVariants[i]!],
                     'current-round': 101,
                  });
               }
               throw new Error(`unexpected Indexer request ${url.pathname}`);
            },
            1_000,
            undefined,
            'C',
         );

         await new RoundWatchPoller(
            store,
            indexer,
            1,
            100,
            () => now,
         ).runOnce();

         const after = store.getWatch(watch.id);
         assert.equal(after?.state, 'active');
         assert.equal(after?.scanAfterRound, 100);
         assert.equal(after?.closingRound, 101);
      } finally {
         store.close();
      }
   }
});

test('settlement evidence accepts only direct axfer classification', async () => {
   const direct = {
      ...rawTx(100),
      id: 'SERVICE',
      'asset-transfer-transaction': {
         receiver: RECEIVER,
         'asset-id': TESTNET_USDC_ASSET_ID,
         amount: 1,
         'close-amount': 0,
      },
   };

   const directClient = new AlgorandIndexerClient(
      'https://indexer.invalid',
      new IndexerRequestDispatcher({
         requestsPerSecond: 1_000,
         burst: 10,
         concurrency: 1,
      }),
      async input => {
         const url = new URL(String(input));
         if (url.pathname === '/v2/transactions/SERVICE') {
            return Response.json({ transaction: direct });
         }
         return Response.json({
            transactions: [direct],
            'current-round': 101,
         });
      },
   );

   assert.equal(
      (await directClient.lookupAssetTransfer('SERVICE'))?.transaction,
      'SERVICE',
   );
   assert.equal(
      (await directClient.searchTransactionPage('SERVICE')).transactions
         .length,
      1,
   );

   const invalid = [
      {
         ...direct,
         'tx-type': 'pay',
      },
      {
         ...direct,
         'asset-transfer-transaction': {
            ...direct['asset-transfer-transaction'],
            sender: PAYER,
         },
      },
      {
         ...direct,
         'asset-transfer-transaction': {
            ...direct['asset-transfer-transaction'],
            'close-to': RECEIVER,
            'close-amount': 7,
         },
      },
   ];

   for (const fixture of invalid) {
      const client = new AlgorandIndexerClient(
         'https://indexer.invalid',
         new IndexerRequestDispatcher({
            requestsPerSecond: 1_000,
            burst: 10,
            concurrency: 1,
         }),
         async input => {
            const url = new URL(String(input));
            if (url.pathname === '/v2/transactions/SERVICE') {
               return Response.json({ transaction: fixture });
            }
            return Response.json({
               transactions: [fixture],
               'current-round': 101,
            });
         },
      );

      await assert.rejects(
         client.lookupAssetTransfer('SERVICE'),
         /not an axfer|clawback|close-out/,
      );
      await assert.rejects(
         client.searchTransactionPage('SERVICE'),
         /not an axfer|clawback|close-out/,
      );
   }
});

test('Indexer page validation rejects malformed fields, bounds, JSON, and inadequate watermark', async () => {
   const bodies: Array<Response> = [
      Response.json({ 'current-round': 10 }),
      Response.json({ transactions: 'wrong', 'current-round': 10 }),
      Response.json({ transactions: [{ ...rawTx(11), 'confirmed-round': 99 }], 'current-round': 99 }),
      Response.json({ transactions: [rawTx(11)], 'current-round': 20, 'next-token': 7 }),
      Response.json({ transactions: [{ ...rawTx(11), 'round-time': 'bad' }], 'current-round': 20 }),
      Response.json({
         transactions: Array.from({ length: 1_001 }, () => rawTx(11)),
         'current-round': 20,
      }),
      new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
   ];
   const dispatcher = new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 2 });
   const indexer = new AlgorandIndexerClient('https://indexer.invalid', dispatcher, async () => bodies.shift()!);
   const watch = watchRecord({});
   await assert.rejects(indexer.searchWatchPage(watch, 10, 20), /missing transactions/);
   await assert.rejects(indexer.searchWatchPage(watch, 10, 20), /not an array/);
   await assert.rejects(indexer.searchWatchPage(watch, 10, 20), /outside/);
   await assert.rejects(indexer.searchWatchPage(watch, 10, 20), /next-token/);
   await assert.rejects(indexer.searchWatchPage(watch, 10, 20), /round-time/);
   await assert.rejects(
      indexer.searchWatchPage(watch, 10, 20),
      /exceeded requested page limit/,
   );
   await assert.rejects(indexer.searchWatchPage(watch, 10, 20), /valid JSON/);
});

test('Indexer bounds response bytes and continuation-token memory before state can advance', async () => {
   const dispatcher = new IndexerRequestDispatcher({
      requestsPerSecond: 1_000,
      burst: 10,
      concurrency: 1,
   });
   const smallLimitResponses = [
      new Response('{}', {
         status: 200,
         headers: {
            'content-type': 'application/json',
            'content-length': '65',
         },
      }),
      new Response('x'.repeat(65), {
         status: 200,
         headers: {
            'content-type': 'application/json',
         },
      }),
   ];
   const limited = new AlgorandIndexerClient(
      'https://indexer.invalid',
      dispatcher,
      async () => smallLimitResponses.shift()!,
      1_000,
      undefined,
      'A',
      64,
   );
   const watch = watchRecord({});

   await assert.rejects(
      limited.searchWatchPage(watch, 10, 20),
      /response exceeded 64 byte limit/,
   );
   await assert.rejects(
      limited.searchWatchPage(watch, 10, 20),
      /response exceeded 64 byte limit/,
   );

   const tokenIndexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      new IndexerRequestDispatcher({
         requestsPerSecond: 1_000,
         burst: 10,
         concurrency: 1,
      }),
      async () =>
         Response.json({
            transactions: [],
            'current-round': 20,
            'next-token': 't'.repeat(MAX_INDEXER_NEXT_TOKEN_BYTES + 1),
         }),
      1_000,
      undefined,
      'A',
      16 * 1024,
   );

   await assert.rejects(
      tokenIndexer.searchWatchPage(watch, 10, 20),
      /next-token exceeds 4096 byte limit/,
   );
});

test('Indexer cancels every unconsumed response body on early exits', async () => {
   const cancellations: string[] = [];
   const trackedResponse = (
      label: string,
      status: number,
      contentLength: number,
   ) =>
      new Response(
         new ReadableStream<Uint8Array>({
            start() {
               // Leave the stream open so cancellation is observable.
            },
            cancel() {
               cancellations.push(label);
            },
         }),
         {
            status,
            headers: {
               'content-type': 'application/json',
               'content-length': String(contentLength),
            },
         },
      );

   const responses = [
      trackedResponse('declared-oversize', 200, 65),
      trackedResponse('not-found', 404, 16),
   ];

   const indexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      new IndexerRequestDispatcher({
         requestsPerSecond: 1_000,
         burst: 10,
         concurrency: 1,
      }),
      async () => responses.shift()!,
      1_000,
      undefined,
      'A',
      64,
   );

   await assert.rejects(
      indexer.searchWatchPage(watchRecord({}), 10, 20),
      /response exceeded 64 byte limit/,
   );
   assert.deepEqual(cancellations, ['declared-oversize']);

   assert.equal(
      await indexer.lookupAssetTransfer('MISSING'),
      undefined,
   );
   assert.deepEqual(
      cancellations,
      ['declared-oversize', 'not-found'],
   );

});

test('Indexer HTTP failures expose bounded structured diagnostics without leaking provider bodies or query values', async () => {
   const zeroSenderMessage =
      'invalid input: searching transactions by zero address with asset sender role is not supported';
   const responseBody = JSON.stringify({ message: zeroSenderMessage });
   const indexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      new IndexerRequestDispatcher({
         requestsPerSecond: 1_000,
         burst: 10,
         concurrency: 1,
      }),
      async () =>
         new Response(responseBody, {
            status: 400,
            headers: {
               'content-type': 'application/json; charset=utf-8',
               'content-length': String(Buffer.byteLength(responseBody)),
               'cf-ray': 'abc123-TEST',
            },
         }),
      1_000,
      undefined,
      'C',
   );

   let caught: unknown;
   try {
      await indexer.searchWatchPage(watchRecord({}), 10, 20);
   } catch (error) {
      caught = error;
   }

   assert.ok(caught instanceof IndexerHttpError);
   assert.equal(caught.status, 400);
   assert.equal(caught.purpose, 'scan-page');
   assert.equal(caught.providerHost, 'indexer.invalid');
   assert.equal(
      caught.pathTemplate,
      '/v2/assets/{assetId}/transactions',
   );
   assert.equal(caught.variant, 'C');
   assert.equal(caught.code, 'zero_address_sender_unsupported');
   assert.equal(caught.retryDisposition, 'permanent');
   assert.equal(caught.providerRequestId, 'cf-ray:abc123-TEST');
   assert.equal(caught.contentType, 'application/json');
   assert.equal(caught.bodyTruncated, false);
   assert.equal(caught.bodyReadFailed, false);
   assert.equal(
      caught.capturedBodyBytes,
      Buffer.byteLength(responseBody),
   );
   assert.ok(caught.parameterNames.includes('address'));
   assert.ok(caught.parameterNames.includes('address-role'));
   assert.ok(caught.parameterNames.includes('note-prefix'));
   assert.doesNotMatch(caught.message, new RegExp(PAYER));
   assert.doesNotMatch(caught.message, /invoice:1/);
   assert.doesNotMatch(
      JSON.stringify(caught.telemetry()),
      new RegExp(PAYER),
   );
   assert.doesNotMatch(
      JSON.stringify(caught.telemetry()),
      /invoice:1/,
   );
});

test('contradictory zero-sender provider message cannot override status or nonzero request context', async () => {
   const zeroSenderMessage =
      'invalid input: searching transactions by zero address with asset sender role is not supported';

   const cases = [
      { status: 400, code: 'provider_request_rejected', disposition: 'unknown' },
      { status: 401, code: 'provider_unauthorized', disposition: 'permanent' },
      { status: 403, code: 'provider_forbidden', disposition: 'permanent' },
      { status: 404, code: 'provider_not_found', disposition: 'permanent' },
      { status: 429, code: 'rate_limited', disposition: 'transient' },
      { status: 503, code: 'provider_server_error', disposition: 'transient' },
   ] as const;

   for (const testCase of cases) {
      const indexer = new AlgorandIndexerClient(
         'https://indexer.invalid',
         new IndexerRequestDispatcher({
            requestsPerSecond: 1_000,
            burst: 10,
            concurrency: 1,
         }),
         async () =>
            Response.json(
               { message: zeroSenderMessage },
               { status: testCase.status },
            ),
         1_000,
         undefined,
         'C',
      );

      let caught: unknown;
      try {
         await indexer.searchWatchPage(
            watchRecord({ expectedSender: WATCH_SENDER }),
            10,
            20,
         );
      } catch (error) {
         caught = error;
      }

      assert.ok(caught instanceof IndexerHttpError);
      assert.equal(caught.status, testCase.status);
      assert.equal(caught.code, testCase.code);
      assert.equal(caught.retryDisposition, testCase.disposition);
   }
});

test('zero-sender classification requires HTTP 400 even when request context is exact', async () => {
   const zeroSenderMessage =
      'invalid input: searching transactions by zero address with asset sender role is not supported';

   for (const testCase of [
      { status: 401, code: 'provider_unauthorized', disposition: 'permanent' },
      { status: 403, code: 'provider_forbidden', disposition: 'permanent' },
      { status: 404, code: 'provider_not_found', disposition: 'permanent' },
      { status: 429, code: 'rate_limited', disposition: 'transient' },
      { status: 503, code: 'provider_server_error', disposition: 'transient' },
   ] as const) {
      const indexer = new AlgorandIndexerClient(
         'https://indexer.invalid',
         new IndexerRequestDispatcher({
            requestsPerSecond: 1_000,
            burst: 10,
            concurrency: 1,
         }),
         async () =>
            Response.json(
               { message: zeroSenderMessage },
               { status: testCase.status },
            ),
         1_000,
         undefined,
         'C',
      );

      let caught: unknown;
      try {
         await indexer.searchWatchPage(watchRecord({}), 10, 20);
      } catch (error) {
         caught = error;
      }

      assert.ok(caught instanceof IndexerHttpError);
      assert.equal(caught.status, testCase.status);
      assert.equal(caught.code, testCase.code);
      assert.equal(caught.retryDisposition, testCase.disposition);
   }
});

test('Indexer unknown 400 bodies remain private and do not become trusted telemetry text', async () => {
   const secret =
      `private=${PAYER};note=${SPEC.invoiceNote};PAYMENT-SIGNATURE=topsecret`;
   const indexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      new IndexerRequestDispatcher({
         requestsPerSecond: 1_000,
         burst: 10,
         concurrency: 1,
      }),
      async () =>
         Response.json(
            { message: secret },
            { status: 400 },
         ),
      1_000,
      undefined,
      'C',
   );

   let caught: unknown;
   try {
      await indexer.searchWatchPage(watchRecord({}), 10, 20);
   } catch (error) {
      caught = error;
   }

   assert.ok(caught instanceof IndexerHttpError);
   assert.equal(caught.code, 'provider_request_rejected');
   assert.equal(caught.retryDisposition, 'unknown');
   const visible = `${caught.message}\n${JSON.stringify(caught.telemetry())}`;
   assert.doesNotMatch(visible, new RegExp(PAYER));
   assert.doesNotMatch(visible, new RegExp(SPEC.invoiceNote!));
   assert.doesNotMatch(visible, /topsecret/);
});

test('Indexer 429 exposes bounded Retry-After as transient structured failure', async () => {
   const indexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      new IndexerRequestDispatcher({
         requestsPerSecond: 1_000,
         burst: 10,
         concurrency: 1,
      }),
      async () =>
         Response.json(
            { message: 'slow down' },
            {
               status: 429,
               headers: { 'retry-after': '12' },
            },
         ),
   );

   let caught: unknown;
   try {
      await indexer.getCurrentRound('health');
   } catch (error) {
      caught = error;
   }

   assert.ok(caught instanceof IndexerHttpError);
   assert.equal(caught.status, 429);
   assert.equal(caught.code, 'rate_limited');
   assert.equal(caught.retryDisposition, 'transient');
   assert.equal(caught.retryAfterMilliseconds, 12_000);
   assert.equal(caught.pathTemplate, '/health');
   assert.equal(caught.variant, undefined);
});

test('Indexer error-body capture is byte-bounded and cancels the remainder', async () => {
   let cancelled = false;
   const oversized = new TextEncoder().encode(
      'x'.repeat(MAX_INDEXER_ERROR_BODY_BYTES + 128),
   );
   const indexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      new IndexerRequestDispatcher({
         requestsPerSecond: 1_000,
         burst: 10,
         concurrency: 1,
      }),
      async () =>
         new Response(
            new ReadableStream<Uint8Array>({
               start(controller) {
                  controller.enqueue(oversized);
               },
               cancel() {
                  cancelled = true;
               },
            }),
            {
               status: 503,
               headers: { 'content-type': 'text/plain' },
            },
         ),
   );

   let caught: unknown;
   try {
      await indexer.getCurrentRound('health');
   } catch (error) {
      caught = error;
   }

   assert.ok(caught instanceof IndexerHttpError);
   assert.equal(caught.code, 'provider_server_error');
   assert.equal(caught.retryDisposition, 'transient');
   assert.equal(caught.capturedBodyBytes, MAX_INDEXER_ERROR_BODY_BYTES);
   assert.equal(caught.bodyTruncated, true);
   assert.equal(caught.bodyReadFailed, false);
   assert.equal(cancelled, true);
});


test('permanent Indexer rejection consumes one turn, persists fail-closed terminal state, and never hot-retries', async () => {
   let now = new Date('2026-09-27T12:00:00.000Z');
   const store = new RoundWatchStore(':memory:', {
      workUnitBudget: 5,
      now: () => now,
   });

   try {
      const prepared = store.prepareWatch(
         {
            ...SPEC,
            idempotencyKey: 'permanent-indexer-rejection',
         },
         intent('PERMANENT_INDEXER_SERVICE_TX'),
      ).watch;
      store.activateWatch(
         prepared.id,
         {
            transaction: 'PERMANENT_INDEXER_SERVICE_TX',
            network: ALGORAND_TESTNET,
            payer: PAYER,
         },
         100,
      );

      const providerMessage =
         'invalid input: searching transactions by zero address with asset sender role is not supported';
      const indexer = new AlgorandIndexerClient(
         'https://indexer.invalid',
         new IndexerRequestDispatcher({
            requestsPerSecond: 1_000,
            burst: 10,
            concurrency: 1,
         }),
         async input => {
            const url = new URL(String(input));
            if (url.pathname === '/health') {
               return Response.json({ round: 101 });
            }
            if (
               url.pathname ===
               `/v2/assets/${TESTNET_USDC_ASSET_ID}/transactions`
            ) {
               return Response.json(
                  { message: providerMessage },
                  { status: 400 },
               );
            }
            throw new Error(`unexpected Indexer path ${url.pathname}`);
         },
         1_000,
         undefined,
         'C',
      );
      const poller = new RoundWatchPoller(
         store,
         indexer,
         5_000,
         100,
         () => now,
      );

      const first = await poller.runOnce();
      assert.deepEqual(first, {
         attempted: 1,
         succeeded: 0,
         failed: 1,
         isolatedFailures: 1,
      });

      const terminal = store.getWatch(prepared.id);
      assert.equal(terminal?.state, 'indeterminate');
      assert.equal(terminal?.terminalReason, 'indexer_permanent_failure');
      assert.equal(terminal?.pollingFailureCode, 'zero_address_sender_unsupported');
      assert.equal(terminal?.pollingFailureStatus, 400);
      assert.equal(terminal?.pollingFailureDisposition, 'permanent');
      assert.equal(terminal?.pollingFailureCount, 1);
      assert.equal(terminal?.pollingRetryAt, undefined);
      assert.equal(terminal?.workUnitsUsed, 1);
      assert.equal(terminal?.scanAfterRound, 100);

      now = new Date(now.getTime() + 60_000);
      const second = await poller.runOnce();
      assert.deepEqual(second, { attempted: 0, succeeded: 0, failed: 0 });
      assert.equal(store.getWatch(prepared.id)?.workUnitsUsed, 1);

      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: new FakeIndexer(101),
         syncFacilitatorOnStart: false,
      });
      const status = await app.request(`/spike/watch/${prepared.id}`);
      assert.equal(status.status, 200);
      const body = await status.json() as {
         watch?: Record<string, unknown>;
      };
      assert.equal(
         body.watch?.terminalReason,
         'indexer_permanent_failure',
      );
      for (const internal of [
         'pollingFailureCode',
         'pollingFailureStatus',
         'pollingFailureDisposition',
         'pollingFailureCount',
         'pollingLastFailureAt',
         'pollingRetryAt',
      ]) {
         assert.equal(body.watch?.[internal], undefined);
      }
   } finally {
      store.close();
   }
});

test('nonzero watch is never terminalized by spoofed zero-sender HTTP 400 body', async () => {
   let now = new Date('2026-09-28T18:00:00.000Z');
   const store = new RoundWatchStore(':memory:', {
      workUnitBudget: 5,
      now: () => now,
   });

   try {
      const prepared = store.prepareWatch(
         {
            ...SPEC,
            expectedSender: WATCH_SENDER,
            idempotencyKey: 'spoofed-zero-sender-message',
         },
         intent('SPOOFED_ZERO_SENDER_SERVICE_TX'),
      ).watch;
      store.activateWatch(
         prepared.id,
         {
            transaction: 'SPOOFED_ZERO_SENDER_SERVICE_TX',
            network: ALGORAND_TESTNET,
            payer: PAYER,
         },
         100,
      );

      const providerMessage =
         'invalid input: searching transactions by zero address with asset sender role is not supported';
      const indexer = new AlgorandIndexerClient(
         'https://indexer.invalid',
         new IndexerRequestDispatcher({
            requestsPerSecond: 1_000,
            burst: 10,
            concurrency: 1,
         }),
         async input => {
            const url = new URL(String(input));
            if (url.pathname === '/health') {
               return Response.json({ round: 101 });
            }
            if (
               url.pathname ===
               `/v2/assets/${TESTNET_USDC_ASSET_ID}/transactions`
            ) {
               return Response.json(
                  { message: providerMessage },
                  { status: 400 },
               );
            }
            throw new Error(`unexpected Indexer path ${url.pathname}`);
         },
         1_000,
         undefined,
         'C',
      );

      const result = await new RoundWatchPoller(
         store,
         indexer,
         5_000,
         100,
         () => now,
      ).runOnce();

      assert.deepEqual(result, {
         attempted: 1,
         succeeded: 0,
         failed: 1,
      });

      const deferred = store.getWatch(prepared.id);
      assert.equal(deferred?.state, 'active');
      assert.equal(deferred?.terminalReason, undefined);
      assert.equal(deferred?.pollingFailureCode, 'provider_request_rejected');
      assert.equal(deferred?.pollingFailureStatus, 400);
      assert.equal(deferred?.pollingFailureDisposition, 'unknown');
      assert.equal(deferred?.pollingFailureCount, 1);
      assert.equal(deferred?.workUnitsUsed, 1);
      assert.equal(deferred?.scanAfterRound, 100);
      assert.ok(deferred?.pollingRetryAt);
   } finally {
      store.close();
   }
});

test('provider-wide permanent HTTP error stays active and readiness-impacting instead of being isolated to one watch', async () => {
   let now = new Date('2026-09-27T12:05:00.000Z');
   const store = new RoundWatchStore(':memory:', {
      workUnitBudget: 5,
      now: () => now,
   });

   try {
      const prepared = store.prepareWatch(
         {
            ...SPEC,
            idempotencyKey: 'provider-auth-readiness',
         },
         intent('PROVIDER_AUTH_SERVICE_TX'),
      ).watch;
      store.activateWatch(
         prepared.id,
         {
            transaction: 'PROVIDER_AUTH_SERVICE_TX',
            network: ALGORAND_TESTNET,
            payer: PAYER,
         },
         100,
      );

      const indexer = new AlgorandIndexerClient(
         'https://indexer.invalid',
         new IndexerRequestDispatcher({
            requestsPerSecond: 1_000,
            burst: 10,
            concurrency: 1,
         }),
         async () =>
            Response.json(
               { message: 'synthetic provider auth failure' },
               { status: 401 },
            ),
         1_000,
         undefined,
         'C',
      );
      const poller = new RoundWatchPoller(
         store,
         indexer,
         5_000,
         100,
         () => now,
      );

      const first = await poller.runOnce();
      assert.deepEqual(first, {
         attempted: 1,
         succeeded: 0,
         failed: 1,
      });

      const deferred = store.getWatch(prepared.id);
      assert.equal(deferred?.state, 'active');
      assert.equal(deferred?.terminalReason, undefined);
      assert.equal(deferred?.pollingFailureCode, 'provider_unauthorized');
      assert.equal(deferred?.pollingFailureDisposition, 'unknown');
      assert.equal(deferred?.pollingFailureCount, 1);
      assert.equal(deferred?.workUnitsUsed, 1);
      assert.equal(deferred?.scanAfterRound, 100);
      assert.ok(deferred?.pollingRetryAt);

      const tracker = new WorkerHealthTracker(() => now.getTime());
      tracker.markStarted();
      tracker.markCycleStarted();
      tracker.markCycleCompleted(first);
      assert.equal(tracker.snapshot(60_000).ready, false);

      // The persisted cooldown produces no provider request, but that no-op
      // cycle cannot turn readiness green while provider recovery is unproven.
      const coolingDown = await poller.runOnce();
      assert.deepEqual(coolingDown, {
         attempted: 0,
         succeeded: 0,
         failed: 0,
      });
      tracker.markCycleStarted();
      tracker.markCycleCompleted(coolingDown);
      assert.equal(tracker.snapshot(60_000).ready, false);
      assert.equal(store.getWatch(prepared.id)?.workUnitsUsed, 1);
   } finally {
      store.close();
   }
});

test('polling jitter respects the configured hard cap while Retry-After may extend it', async () => {
   let now = new Date('2026-09-28T18:30:00.000Z');
   const store = new RoundWatchStore(':memory:', {
      workUnitBudget: 20,
      now: () => now,
   });

   try {
      const prepared = store.prepareWatch(
         {
            ...SPEC,
            idempotencyKey: 'hard-backoff-cap',
         },
         intent('HARD_BACKOFF_CAP_SERVICE_TX'),
      ).watch;
      store.activateWatch(
         prepared.id,
         {
            transaction: 'HARD_BACKOFF_CAP_SERVICE_TX',
            network: ALGORAND_TESTNET,
            payer: PAYER,
         },
         100,
      );

      const database = (
         store as unknown as { database: DatabaseSync }
      ).database;
      database.prepare(
         'UPDATE roundwatch_watches SET id=?, polling_failure_count=8 WHERE id=?',
      ).run('deterministic-review-watch', prepared.id);

      const offlineIndexer = new FakeIndexer(101);
      offlineIndexer.getCurrentRound = async () => {
         throw new TypeError('offline');
      };

      await new RoundWatchPoller(
         store,
         offlineIndexer,
         5_000,
         100,
         () => now,
      ).runOnce();

      const failed = store.getWatch('deterministic-review-watch');
      assert.ok(failed?.pollingRetryAt);
      const delay =
         Date.parse(failed.pollingRetryAt) - now.getTime();
      assert.equal(failed.pollingFailureCount, 9);
      assert.ok(delay >= DEFAULT_POLL_FAILURE_BASE_BACKOFF_MILLISECONDS);
      assert.ok(delay <= MAX_POLL_FAILURE_BACKOFF_MILLISECONDS);
   } finally {
      store.close();
   }

   const retryAfterStore = new RoundWatchStore(':memory:', {
      workUnitBudget: 5,
      now: () => now,
   });
   try {
      const prepared = retryAfterStore.prepareWatch(
         {
            ...SPEC,
            idempotencyKey: 'retry-after-over-backoff-cap',
         },
         intent('RETRY_AFTER_OVER_CAP_SERVICE_TX'),
      ).watch;
      retryAfterStore.activateWatch(
         prepared.id,
         {
            transaction: 'RETRY_AFTER_OVER_CAP_SERVICE_TX',
            network: ALGORAND_TESTNET,
            payer: PAYER,
         },
         100,
      );

      const indexer = new AlgorandIndexerClient(
         'https://indexer.invalid',
         new IndexerRequestDispatcher({
            requestsPerSecond: 1_000,
            burst: 10,
            concurrency: 1,
         }),
         async input => {
            const url = new URL(String(input));
            if (url.pathname === '/health') {
               return Response.json({ round: 101 });
            }
            return Response.json(
               { message: 'slow down' },
               {
                  status: 429,
                  headers: { 'retry-after': '600' },
               },
            );
         },
         1_000,
         undefined,
         'C',
      );

      await new RoundWatchPoller(
         retryAfterStore,
         indexer,
         5_000,
         100,
         () => now,
      ).runOnce();

      const failed = retryAfterStore.getWatch(prepared.id);
      assert.ok(failed?.pollingRetryAt);
      assert.equal(
         Date.parse(failed.pollingRetryAt) - now.getTime(),
         600_000,
      );
   } finally {
      retryAfterStore.close();
   }
});

test('429 polling failure persists cooldown across restart without spending work while waiting', async () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-poll-backoff-'));
   const databasePath = join(directory, 'roundwatch.sqlite');
   let now = new Date('2026-09-27T12:10:00.000Z');
   let mode: 'rate-limit' | 'success' = 'rate-limit';
   let watchId = '';

   const createIndexer = () =>
      new AlgorandIndexerClient(
         'https://indexer.invalid',
         new IndexerRequestDispatcher({
            requestsPerSecond: 1_000,
            burst: 10,
            concurrency: 1,
         }),
         async input => {
            const url = new URL(String(input));
            if (url.pathname === '/health') {
               return Response.json({ round: 101 });
            }
            if (
               url.pathname ===
               `/v2/assets/${TESTNET_USDC_ASSET_ID}/transactions`
            ) {
               if (mode === 'rate-limit') {
                  return Response.json(
                     { message: 'slow down' },
                     {
                        status: 429,
                        headers: { 'retry-after': '12' },
                     },
                  );
               }
               return Response.json({
                  transactions: [],
                  'current-round': 101,
               });
            }
            throw new Error(`unexpected Indexer path ${url.pathname}`);
         },
         1_000,
         undefined,
         'C',
      );

   try {
      {
         const store = new RoundWatchStore(databasePath, {
            workUnitBudget: 5,
            now: () => now,
         });
         try {
            const prepared = store.prepareWatch(
               {
                  ...SPEC,
                  idempotencyKey: 'persisted-rate-limit',
               },
               intent('PERSISTED_RATE_LIMIT_SERVICE_TX'),
            ).watch;
            watchId = prepared.id;
            store.activateWatch(
               prepared.id,
               {
                  transaction: 'PERSISTED_RATE_LIMIT_SERVICE_TX',
                  network: ALGORAND_TESTNET,
                  payer: PAYER,
               },
               100,
            );

            const poller = new RoundWatchPoller(
               store,
               createIndexer(),
               5_000,
               100,
               () => now,
            );
            const failed = await poller.runOnce();
            assert.deepEqual(
               failed,
               { attempted: 1, succeeded: 0, failed: 1 },
            );

            const deferred = store.getWatch(prepared.id);
            assert.equal(deferred?.state, 'active');
            assert.equal(deferred?.workUnitsUsed, 1);
            assert.equal(deferred?.scanAfterRound, 100);
            assert.equal(deferred?.pollingFailureCode, 'rate_limited');
            assert.equal(deferred?.pollingFailureDisposition, 'transient');
            assert.equal(deferred?.pollingFailureCount, 1);
            assert.ok(deferred?.pollingRetryAt);
            assert.ok(
               Date.parse(deferred!.pollingRetryAt!) - now.getTime() >= 12_000,
            );

            const waiting = await poller.runOnce();
            assert.deepEqual(
               waiting,
               { attempted: 0, succeeded: 0, failed: 0 },
            );
            assert.equal(store.getWatch(prepared.id)?.workUnitsUsed, 1);
         } finally {
            store.close();
         }
      }

      const restarted = new RoundWatchStore(databasePath, {
         workUnitBudget: 5,
         now: () => now,
      });
      try {
         const persisted = restarted.getWatch(watchId);
         assert.ok(persisted?.pollingRetryAt);
         assert.equal(restarted.listPollingCandidates().length, 0);
         assert.equal(persisted?.workUnitsUsed, 1);

         now = new Date(Date.parse(persisted!.pollingRetryAt!) + 1);
         assert.equal(restarted.listPollingCandidates().length, 1);

         mode = 'success';
         const recoveredPoller = new RoundWatchPoller(
            restarted,
            createIndexer(),
            5_000,
            100,
            () => now,
         );
         const recovered = await recoveredPoller.runOnce();
         assert.deepEqual(
            recovered,
            { attempted: 1, succeeded: 1, failed: 0, providerEvidence: 1 },
         );

         const after = restarted.getWatch(watchId);
         assert.equal(after?.state, 'active');
         assert.equal(after?.scanAfterRound, 101);
         assert.equal(after?.workUnitsUsed, 2);
         assert.equal(after?.pollingFailureCount, 0);
         assert.equal(after?.pollingFailureCode, undefined);
         assert.equal(after?.pollingRetryAt, undefined);
      } finally {
         restarted.close();
      }
   } finally {
      rmSync(directory, { recursive: true, force: true });
   }
});

test('malformed successful Indexer response is deferred as protocol uncertainty without advancing coverage', async () => {
   let now = new Date('2026-09-27T12:20:00.000Z');
   const store = new RoundWatchStore(':memory:', {
      workUnitBudget: 5,
      now: () => now,
   });

   try {
      const prepared = store.prepareWatch(
         {
            ...SPEC,
            idempotencyKey: 'protocol-failure-backoff',
         },
         intent('PROTOCOL_FAILURE_SERVICE_TX'),
      ).watch;
      store.activateWatch(
         prepared.id,
         {
            transaction: 'PROTOCOL_FAILURE_SERVICE_TX',
            network: ALGORAND_TESTNET,
            payer: PAYER,
         },
         100,
      );

      const indexer = new AlgorandIndexerClient(
         'https://indexer.invalid',
         new IndexerRequestDispatcher({
            requestsPerSecond: 1_000,
            burst: 10,
            concurrency: 1,
         }),
         async input => {
            const url = new URL(String(input));
            if (url.pathname === '/health') {
               return Response.json({ round: 101 });
            }
            return new Response('{', {
               status: 200,
               headers: { 'content-type': 'application/json' },
            });
         },
         1_000,
         undefined,
         'C',
      );
      const poller = new RoundWatchPoller(
         store,
         indexer,
         5_000,
         100,
         () => now,
      );

      const result = await poller.runOnce();
      assert.deepEqual(result, { attempted: 1, succeeded: 0, failed: 1 });

      const after = store.getWatch(prepared.id);
      assert.equal(after?.state, 'active');
      assert.equal(after?.scanAfterRound, 100);
      assert.equal(after?.workUnitsUsed, 1);
      assert.equal(after?.pollingFailureCode, 'indexer_protocol_failure');
      assert.equal(after?.pollingFailureDisposition, 'unknown');
      assert.equal(after?.pollingFailureCount, 1);
      assert.ok(after?.pollingRetryAt);

      const waiting = await poller.runOnce();
      assert.deepEqual(waiting, { attempted: 0, succeeded: 0, failed: 0 });
      assert.equal(store.getWatch(prepared.id)?.workUnitsUsed, 1);
   } finally {
      store.close();
   }
});

test('Indexer rejects responses that violate requested filters and disables redirects', async () => {
   const wrongSender = {
      ...rawTx(11),
      sender: RECEIVER,
   };
   const wrongAsset = {
      ...rawTx(11),
      'asset-transfer-transaction': {
         receiver: RECEIVER,
         'asset-id': TESTNET_USDC_ASSET_ID + 1,
         amount: 1,
      },
   };
   const wrongTransactionId = {
      ...rawTx(11),
      id: 'OTHER_TRANSACTION',
   };
   const bodies = [
      Response.json({ transactions: [wrongSender], 'current-round': 20 }),
      Response.json({ transactions: [wrongAsset], 'current-round': 20 }),
      Response.json({ transactions: [wrongTransactionId], 'current-round': 20 }),
   ];
   const dispatcher = new IndexerRequestDispatcher({
      requestsPerSecond: 1_000,
      burst: 10,
      concurrency: 2,
   });
   const mockFetch: typeof fetch = async (_input, init) => {
      assert.equal(init?.redirect, 'error');
      return bodies.shift()!;
   };
   const indexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      dispatcher,
      mockFetch,
   );

   await assert.rejects(
      indexer.searchWatchPage(watchRecord({}), 10, 20),
      /requested sender filter/,
   );
   await assert.rejects(
      indexer.searchWatchPage(watchRecord({}), 10, 20),
      /requested asset filter/,
   );
   await assert.rejects(
      indexer.searchTransactionPage('SERVICE'),
      /requested transaction ID/,
   );
});

test('dispatcher does not mint tokens when its clock moves backwards', async () => {
   let clock = 1_000;
   let starts = 0;
   const dispatcher = new IndexerRequestDispatcher({
      requestsPerSecond: 100,
      burst: 1,
      concurrency: 1,
      now: () => clock,
   });

   await dispatcher.dispatch('health', async () => {
      starts += 1;
   });
   assert.equal(starts, 1);

   clock = 900;
   const pending = dispatcher.dispatch('health', async () => {
      starts += 1;
   });

   await new Promise(resolve => setTimeout(resolve, 20));
   assert.equal(starts, 1);

   clock = 1_000;
   await new Promise(resolve => setTimeout(resolve, 20));
   assert.equal(starts, 1);

   clock = 1_010;
   await new Promise(resolve => setTimeout(resolve, 20));
   assert.equal(starts, 2);
   await pending;
});

test('shared dispatcher caps aggregate concurrency and finite restart burst', async () => {
   const dispatcher = new IndexerRequestDispatcher({ requestsPerSecond: 20, burst: 2, concurrency: 2 });
   let active = 0; let peak = 0; const starts: number[] = []; const began = Date.now();
   const work = Array.from({ length: 6 }, (_, i) => dispatcher.dispatch(i % 2 ? 'scan-page' : 'reconciliation', async () => {
      starts.push(Date.now() - began); active += 1; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 15)); active -= 1;
   }));
   await Promise.all(work);
   assert.ok(peak <= 2);
   assert.equal(starts.filter(value => value < 20).length, 2);
   assert.equal(dispatcher.snapshot().requests['scan-page'], 3);
   assert.equal(dispatcher.snapshot().requests.reconciliation, 3);
});

test('health, activation, checkpoint, scan pages, and absence pages all consume shared capacity', async () => {
   const dispatcher = new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 2 });
   const client = new AlgorandIndexerClient('https://indexer.invalid', dispatcher, async input => {
      const url = new URL(String(input));
      if (url.pathname === '/health') return Response.json({ round: 20 });
      if (url.pathname === '/v2/blocks/20') return Response.json({ round: 20, timestamp: 1 });
      if (url.pathname === '/v2/transactions/SERVICE') return Response.json({ transaction: { ...rawTx(10), id: 'SERVICE' } });
      return Response.json({ transactions: [], 'current-round': 20 });
   });
   await client.getCurrentRound('health');
   await client.lookupAssetTransfer('SERVICE', 'activation');
   await client.getBlock(20);
   await client.searchWatchPage(watchRecord({}), 10, 20);
   await client.searchTransactionPage('SERVICE');
   assert.deepEqual(dispatcher.snapshot().requests, {
      health: 1, activation: 1, checkpoint: 1, 'scan-page': 1, 'absence-proof': 1,
   });
});

test('each pagination page consumes a separate dispatcher credit', async () => {
   const dispatcher = new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 1 });
   let calls = 0;
   const client = new AlgorandIndexerClient('https://indexer.invalid', dispatcher, async () => {
      calls += 1;
      return Response.json({ transactions: [], 'current-round': 20, ...(calls === 1 ? { 'next-token': 'p2' } : {}) });
   });
   const first = await client.searchWatchPage(watchRecord({}), 10, 20);
   assert.equal(first.nextToken, 'p2');
   await client.searchWatchPage(watchRecord({}), 10, 20, first.nextToken);
   assert.equal(dispatcher.snapshot().requests['scan-page'], 2);
});

test('identical scan pages are fetched once and reused within a poll sweep', async () => {
   const store = new RoundWatchStore(':memory:', {
      maxOpenWatches: 2,
      maxOpenWatchesPerPayer: 2,
   });
   const indexer = new SharedPageFakeIndexer(101);

   try {
      for (let i = 0; i < 2; i += 1) {
         const tx = `SHARED_PAGE_SERVICE_${i}`;
         const watch = store.prepareWatch(
            { ...SPEC, idempotencyKey: `shared-page-${i}` },
            intent(tx),
         ).watch;
         store.activateWatch(
            watch.id,
            { transaction: tx, network: ALGORAND_TESTNET, payer: PAYER },
            100,
         );
      }

      indexer.pages.push({
         transactions: [],
         currentRound: 101,
         nextToken: 'page-2',
      });

      const poller = new RoundWatchPoller(store, indexer);
      await poller.runOnce();

      assert.equal(indexer.currentRoundCalls, 1);
      assert.equal(indexer.pageCalls.length, 1);
      assert.equal(
         store.listActiveWatches().every(watch => watch.scanAfterRound === 100),
         true,
      );

      indexer.pages.push({
         transactions: [],
         currentRound: 101,
      });
      await poller.runOnce();

      assert.equal(indexer.currentRoundCalls, 1);
      assert.equal(indexer.pageCalls.length, 2);
      assert.equal(indexer.pageCalls.at(-1)?.nextToken, 'page-2');
      assert.equal(
         store.listActiveWatches().every(watch => watch.scanAfterRound === 101),
         true,
      );
   } finally {
      store.close();
   }
});

test('validated historical pages are reused across staggered poll sweeps', async () => {
   const store = new RoundWatchStore(':memory:', {
      maxOpenWatches: 2,
      maxOpenWatchesPerPayer: 2,
   });
   const indexer = new SharedPageFakeIndexer(101);

   const createActiveWatch = (index: number): void => {
      const tx = `CROSS_SWEEP_SERVICE_${index}`;
      const watch = store.prepareWatch(
         { ...SPEC, idempotencyKey: `cross-sweep-${index}` },
         intent(tx),
      ).watch;
      store.activateWatch(
         watch.id,
         { transaction: tx, network: ALGORAND_TESTNET, payer: PAYER },
         100,
      );
   };

   try {
      createActiveWatch(0);
      indexer.pages.push({
         transactions: [],
         currentRound: 101,
         nextToken: 'page-2',
      });

      const poller = new RoundWatchPoller(store, indexer);
      await poller.runOnce();
      assert.equal(indexer.pageCalls.length, 1);

      createActiveWatch(1);
      indexer.pages.push({
         transactions: [],
         currentRound: 101,
      });

      await poller.runOnce();

      // Watch 0 physically fetches page 2. The newly admitted watch 1 reuses
      // page 1 from the bounded cross-sweep cache.
      assert.equal(indexer.pageCalls.length, 2);

      await poller.runOnce();

      // Watch 1 now reuses the previously fetched page 2 as well.
      assert.equal(indexer.pageCalls.length, 2);
      assert.equal(
         store.listActiveWatches().every(
            watch => watch.scanAfterRound === 101,
         ),
         true,
      );
   } finally {
      store.close();
   }
});

test('historical cache payload-byte budget prevents oversized cross-sweep retention', async () => {
   const store = new RoundWatchStore(':memory:', {
      maxOpenWatches: 2,
      maxOpenWatchesPerPayer: 2,
   });
   const indexer = new SharedPageFakeIndexer(101);

   const createActiveWatch = (index: number): void => {
      const tx = `BYTE_CACHE_SERVICE_${index}`;
      const watch = store.prepareWatch(
         { ...SPEC, idempotencyKey: `byte-cache-${index}` },
         intent(tx),
      ).watch;
      store.activateWatch(
         watch.id,
         { transaction: tx, network: ALGORAND_TESTNET, payer: PAYER },
         100,
      );
   };

   try {
      createActiveWatch(0);
      indexer.pages.push({
         transactions: [],
         currentRound: 101,
         nextToken: 'page-2',
      });

      const poller = new RoundWatchPoller(
         store,
         indexer,
         5_000,
         100,
         () => new Date(),
         undefined,
         16,
         1,
      );
      await poller.runOnce();
      assert.equal(indexer.pageCalls.length, 1);

      createActiveWatch(1);
      indexer.pages.push(
         {
            transactions: [],
            currentRound: 101,
         },
         {
            transactions: [],
            currentRound: 101,
            nextToken: 'page-2',
         },
      );

      await poller.runOnce();

      // A one-byte cache budget cannot retain either validated page, so the
      // staggered watch must physically fetch page 1 instead of reusing it.
      assert.equal(indexer.pageCalls.length, 3);
   } finally {
      store.close();
   }
});

test('scan failure clears historical pages so stale provider tokens cannot loop forever', async () => {
   let now = new Date('2026-09-27T13:00:00.000Z');
   const store = new RoundWatchStore(':memory:', {
      maxOpenWatches: 1,
      maxOpenWatchesPerPayer: 1,
      now: () => now,
   });
   const indexer = new SharedPageFakeIndexer(101);

   try {
      const tx = 'STALE_TOKEN_SERVICE';
      const watch = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'stale-token-cache' },
         intent(tx),
      ).watch;
      store.activateWatch(
         watch.id,
         { transaction: tx, network: ALGORAND_TESTNET, payer: PAYER },
         100,
      );

      indexer.pages.push({
         transactions: [],
         currentRound: 101,
         nextToken: 'provider-token',
      });

      const poller = new RoundWatchPoller(
         store,
         indexer,
         5_000,
         100,
         () => now,
      );
      await poller.runOnce();
      assert.equal(indexer.pageCalls.length, 1);

      indexer.failPageCalls.add(1);
      await poller.runOnce();
      assert.equal(indexer.pageCalls.length, 2);

      const deferred = store.getWatch(watch.id);
      assert.ok(deferred?.pollingRetryAt);

      indexer.pages.push({
         transactions: [],
         currentRound: 101,
      });

      // Cooldown itself performs no provider work and spends no extra turn.
      await poller.runOnce();
      assert.equal(indexer.pageCalls.length, 2);
      assert.equal(store.getWatch(watch.id)?.scanAfterRound, 100);

      now = new Date(Date.parse(deferred!.pollingRetryAt!) + 1);
      await poller.runOnce();

      // After the persisted cooldown, page 1 is fetched again from the durable
      // cursor. The failed continuation token is never reused.
      assert.equal(indexer.pageCalls.length, 3);
      assert.equal(store.getWatch(watch.id)?.scanAfterRound, 101);
   } finally {
      store.close();
   }
});

test('historical page cache can be disabled without disabling within-sweep reuse', async () => {
   const store = new RoundWatchStore(':memory:', {
      maxOpenWatches: 1,
      maxOpenWatchesPerPayer: 1,
   });
   const indexer = new SharedPageFakeIndexer(101);

   try {
      const tx = 'CACHE_DISABLED_SERVICE';
      const watch = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'cache-disabled' },
         intent(tx),
      ).watch;
      store.activateWatch(
         watch.id,
         { transaction: tx, network: ALGORAND_TESTNET, payer: PAYER },
         100,
      );

      indexer.pages.push({
         transactions: [],
         currentRound: 101,
         nextToken: 'page-2',
      });
      indexer.pages.push({
         transactions: [],
         currentRound: 101,
      });

      const poller = new RoundWatchPoller(
         store,
         indexer,
         5_000,
         100,
         () => new Date(),
         undefined,
         0,
      );
      await poller.runOnce();
      await poller.runOnce();

      assert.equal(indexer.pageCalls.length, 2);
      assert.equal(store.getWatch(watch.id)?.scanAfterRound, 101);
   } finally {
      store.close();
   }
});

test('one active polling work turn cannot exceed the four-request invariant', async () => {
   let now = new Date('2026-09-18T09:29:59Z');
   const store = new RoundWatchStore(':memory:', {
      maxOpenWatches: 1,
      maxOpenWatchesPerPayer: 1,
      now: () => now,
   });
   const indexer = new FakeIndexer(200);

   try {
      const tx = 'MAX_ACTIVE_TURN_SERVICE';
      const watch = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'max-active-turn' },
         intent(tx),
      ).watch;
      store.activateWatch(
         watch.id,
         { transaction: tx, network: ALGORAND_TESTNET, payer: PAYER },
         100,
      );

      now = new Date('2026-09-18T10:00:01Z');
      indexer.block = {
         round: 200,
         timestamp: Math.floor(now.getTime() / 1_000),
      };
      indexer.pages.push({
         transactions: [],
         currentRound: 200,
      });

      const poller = new RoundWatchPoller(
         store,
         indexer,
         5_000,
         100,
         () => now,
      );
      await poller.runOnce();

      const requests =
         indexer.currentRoundCalls + indexer.blockCalls + indexer.pageCalls.length;
      assert.equal(requests, MAX_INDEXER_REQUESTS_PER_ACTIVE_WORK_TURN);
      assert.equal(store.getWatch(watch.id)?.state, 'expired');
   } finally {
      store.close();
   }
});

test('active polling stops before extra work after durable budget exhaustion', async () => {
   const store = new RoundWatchStore(':memory:', {
      maxOpenWatches: 1,
      maxOpenWatchesPerPayer: 1,
      workUnitBudget: 1,
   });
   const indexer = new FakeIndexer(101);

   try {
      const tx = 'WORK_BUDGET_SERVICE';
      const watch = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'work-budget-active' },
         intent(tx),
      ).watch;
      store.activateWatch(
         watch.id,
         { transaction: tx, network: ALGORAND_TESTNET, payer: PAYER },
         100,
      );

      indexer.pages.push({
         transactions: [],
         currentRound: 101,
         nextToken: 'page-2',
      });

      const poller = new RoundWatchPoller(store, indexer);
      await poller.runOnce();

      const afterFirst = store.getWatch(watch.id);
      assert.equal(afterFirst?.state, 'active');
      assert.equal(afterFirst?.workUnitsUsed, 1);
      assert.equal(indexer.pageCalls.length, 1);

      await poller.runOnce();

      const exhausted = store.getWatch(watch.id);
      assert.equal(exhausted?.state, 'indeterminate');
      assert.equal(exhausted?.terminalReason, 'work_budget_exhausted');
      assert.equal(exhausted?.workUnitsUsed, 1);
      assert.equal(indexer.pageCalls.length, 1);
   } finally {
      store.close();
   }
});

test('watch-page query identity follows the actual server-side filters', () => {
   const dispatcher = new IndexerRequestDispatcher({
      requestsPerSecond: 1_000,
      burst: 10,
      concurrency: 1,
   });
   const cIndexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      dispatcher,
      async () => Response.json({ transactions: [], 'current-round': 20 }),
      1_000,
      undefined,
      'C',
   );
   const dIndexer = new AlgorandIndexerClient(
      'https://indexer.invalid',
      dispatcher,
      async () => Response.json({ transactions: [], 'current-round': 20 }),
      1_000,
      undefined,
      'D',
   );

   const base = watchRecord({});
   const otherReceiver = watchRecord({
      id: 'other-receiver',
      expectedReceiver:
         'AEBAGBAFAYDQQCIKBMGA2DQPCAIREEYUCULBOGAZDINRYHI6D4QCC5T6YA',
   });
   const otherNote = watchRecord({
      id: 'other-note',
      invoiceNote: 'different-note',
   });

   assert.equal(
      cIndexer.watchPageQueryKey(base, 101, 200),
      cIndexer.watchPageQueryKey(otherReceiver, 101, 200),
   );
   assert.notEqual(
      cIndexer.watchPageQueryKey(base, 101, 200),
      cIndexer.watchPageQueryKey(otherNote, 101, 200),
   );
   assert.notEqual(
      dIndexer.watchPageQueryKey(base, 101, 200),
      dIndexer.watchPageQueryKey(otherReceiver, 101, 200),
   );
});

test('50 watches each receive at most one page turn in one fair sweep', async () => {
   const store = new RoundWatchStore(':memory:', { maxOpenWatches: 50, maxOpenWatchesPerPayer: 50 });
   const indexer = new FakeIndexer(101);
   try {
      for (let i = 0; i < 50; i += 1) {
         const tx = `SERVICE_${i}`;
         const watch = store.prepareWatch({ ...SPEC, idempotencyKey: `load-watch-${i}` }, intent(tx)).watch;
         store.activateWatch(watch.id, { transaction: tx, network: ALGORAND_TESTNET, payer: PAYER }, 100);
      }

      // The first watch has another page. It must yield after that first page
      // while every later watch still receives its own turn in the same sweep.
      indexer.pages.push({ transactions: [], currentRound: 101, nextToken: 'busy-page-2' });
      for (let i = 1; i < 50; i += 1) {
         indexer.pages.push({ transactions: [], currentRound: 101 });
      }

      const poller = new RoundWatchPoller(store, indexer);
      await poller.runOnce();

      assert.equal(indexer.pageCalls.length, 50);
      assert.equal(
         indexer.currentRoundCalls,
         1,
         'one sweep must share one health tip across all watches',
      );
      assert.equal(
         store.listActiveWatches().filter(watch => watch.scanAfterRound === 101).length,
         49,
      );
      assert.equal(
         store.listActiveWatches().filter(watch => watch.scanAfterRound === 100).length,
         1,
      );

      // Only the unfinished continuation needs another transaction page.
      indexer.pages.push({ transactions: [], currentRound: 101 });
      await poller.runOnce();

      assert.equal(indexer.pageCalls.length, 51);
      assert.equal(
         indexer.currentRoundCalls,
         2,
         'the next sweep may fetch one fresh shared tip',
      );
      assert.equal(indexer.pageCalls.at(-1)?.nextToken, 'busy-page-2');
      assert.equal(
         store.listActiveWatches().every(watch => watch.scanAfterRound === 101),
         true,
      );
   } finally { store.close(); }
});

test('one watch page failure does not block later watches in the same fair sweep', async () => {
   const store = new RoundWatchStore(':memory:', { maxOpenWatches: 2, maxOpenWatchesPerPayer: 2 });
   const indexer = new FakeIndexer(101);
   try {
      for (let i = 0; i < 2; i += 1) {
         const tx = `FAILURE_ISOLATION_SERVICE_${i}`;
         const watch = store.prepareWatch(
            { ...SPEC, idempotencyKey: `failure-isolation-${i}` },
            intent(tx),
         ).watch;
         store.activateWatch(
            watch.id,
            { transaction: tx, network: ALGORAND_TESTNET, payer: PAYER },
            100,
         );
      }

      indexer.failPageCalls.add(0);
      indexer.pages.push({ transactions: [], currentRound: 101 });

      await new RoundWatchPoller(store, indexer).runOnce();

      assert.equal(indexer.pageCalls.length, 2);
      assert.equal(
         store.listActiveWatches().filter(watch => watch.scanAfterRound === 100).length,
         1,
      );
      assert.equal(
         store.listActiveWatches().filter(watch => watch.scanAfterRound === 101).length,
         1,
      );
   } finally { store.close(); }
});

test('idempotency keys are scoped by service payer and exact replays stay within one payer scope', () => {
   const store = new RoundWatchStore(':memory:', {
      maxOpenWatches: 10,
      maxOpenWatchesPerPayer: 10,
   });

   try {
      const sharedKey = 'shared-across-payers';
      const firstIntent = intent('PAYER_A_SERVICE_TX');
      const secondIntent = {
         ...intent('PAYER_B_SERVICE_TX'),
         payer: WATCH_SENDER,
      };

      const first = store.prepareWatch(
         { ...SPEC, idempotencyKey: sharedKey },
         firstIntent,
      );
      const second = store.prepareWatch(
         { ...SPEC, idempotencyKey: sharedKey },
         secondIntent,
      );
      const replay = store.prepareWatch(
         { ...SPEC, idempotencyKey: sharedKey },
         firstIntent,
      );

      assert.equal(first.created, true);
      assert.equal(second.created, true);
      assert.notEqual(first.watch.id, second.watch.id);
      assert.equal(replay.created, false);
      assert.equal(replay.watch.id, first.watch.id);
      assert.equal(
         store.getByPayerAndIdempotencyKey(PAYER, sharedKey)?.id,
         first.watch.id,
      );
      assert.equal(
         store.getByPayerAndIdempotencyKey(WATCH_SENDER, sharedKey)?.id,
         second.watch.id,
      );
   } finally {
      store.close();
   }
});

test('same payer and idempotency key cannot be rebound to a different watch specification', () => {
   const store = new RoundWatchStore(':memory:', {
      maxOpenWatches: 10,
      maxOpenWatchesPerPayer: 10,
   });

   try {
      const key = 'same-payer-conflict';
      store.prepareWatch(
         { ...SPEC, idempotencyKey: key },
         intent('CONFLICT_SERVICE_TX'),
      );

      assert.throws(
         () => store.prepareWatch(
            {
               ...SPEC,
               idempotencyKey: key,
               atomicAmount: '2500001',
            },
            intent('CONFLICT_SERVICE_TX_RETRY'),
         ),
         IdempotencyConflictError,
      );
      assert.equal(store.listSettlementReconciliationCandidates().length, 1);
   } finally {
      store.close();
   }
});

test('legacy NULL-payer idempotency rows remain opaque global reservations', () => {
   const store = new RoundWatchStore(':memory:', {
      maxOpenWatches: 10,
      maxOpenWatchesPerPayer: 10,
   });

   try {
      const legacySpec = {
         ...SPEC,
         idempotencyKey: 'legacy-null-payer-reservation',
      };
      const legacy = store.prepareWatch(legacySpec).watch;

      assert.equal(legacy.expectedServicePayer, undefined);
      assert.throws(
         () => store.prepareWatch(
            legacySpec,
            intent('LEGACY_FOREIGN_RETRY'),
         ),
         LegacyIdempotencyReservationError,
      );
      assert.equal(
         store.getByIdempotencyKey(legacySpec.idempotencyKey)?.id,
         legacy.id,
      );
      assert.equal(
         store.getByPayerAndIdempotencyKey(
            PAYER,
            legacySpec.idempotencyKey,
         ),
         undefined,
      );
   } finally {
      store.close();
   }
});

test('capacity and transaction uniqueness reject before creating another obligation', () => {
   const store = new RoundWatchStore(':memory:', { maxOpenWatches: 1, maxOpenWatchesPerPayer: 1 });
   try {
      const first = store.prepareWatch(SPEC, intent());
      assert.throws(() => store.prepareWatch({ ...SPEC, idempotencyKey: 'invoice-0002' }, intent('OTHER')), WatchCapacityError);
      assert.equal(store.prepareWatch(SPEC, intent()).watch.id, first.watch.id);
   } finally { store.close(); }
});

test('one signed service transaction cannot reserve watches under different idempotency keys', () => {
   const store = new RoundWatchStore(':memory:', { maxOpenWatches: 10, maxOpenWatchesPerPayer: 10 });
   try {
      store.prepareWatch(SPEC, intent('UNIQUE_SERVICE'));
      assert.throws(
         () => store.prepareWatch({ ...SPEC, idempotencyKey: 'different-key' }, intent('UNIQUE_SERVICE')),
         /UNIQUE constraint failed/,
      );
      assert.equal(store.listSettlementReconciliationCandidates().length, 1);
   } finally { store.close(); }
});

test('concurrent admission attempts cannot exceed the transactional global limit', async () => {
   const store = new RoundWatchStore(':memory:', { maxOpenWatches: 3, maxOpenWatchesPerPayer: 10 });
   try {
      const attempts = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
         Promise.resolve().then(() => store.prepareWatch(
            { ...SPEC, idempotencyKey: `concurrent-${i}` }, intent(`CONCURRENT_${i}`),
         )),
      ));
      assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 3);
      assert.equal(store.listSettlementReconciliationCandidates().length, 3);
   } finally { store.close(); }
});

test('refund audit evidence persists separately and never rewrites the watch lifecycle state', () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-refund-audit-'));
   const path = join(directory, 'refund.sqlite');

   try {
      let store = new RoundWatchStore(path, { workUnitBudget: 1 });
      const watch = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'refund-audit-watch' },
         intent('REFUND_AUDIT_SERVICE_TX'),
      ).watch;
      assert.equal(store.claimWorkUnit(watch.id), 'claimed');
      assert.equal(store.claimWorkUnit(watch.id), 'exhausted');
      assert.equal(store.getWatch(watch.id)?.state, 'indeterminate');

      const first = store.recordRefundEvidence(watch.id, {
         transaction: SIGNED_SERVICE_TX_ID,
         network: ALGORAND_TESTNET,
         atomicAmount: '20000',
         reason: 'service failure refund',
      });
      const replay = store.recordRefundEvidence(watch.id, {
         transaction: SIGNED_SERVICE_TX_ID,
         network: ALGORAND_TESTNET,
         atomicAmount: '20000',
         reason: 'service failure refund',
      });

      assert.equal(first.id, replay.id);
      assert.equal(store.getWatch(watch.id)?.state, 'indeterminate');
      assert.equal(store.listRefundEvidence(watch.id).length, 1);
      store.close();

      store = new RoundWatchStore(path, {
         schemaMode: 'existing-refund-audit',
      });
      const persisted = store.listRefundEvidence(watch.id);
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0]?.transaction, SIGNED_SERVICE_TX_ID);
      assert.equal(persisted[0]?.atomicAmount, '20000');
      assert.equal(persisted[0]?.reason, 'service failure refund');
      assert.equal(store.getWatch(watch.id)?.state, 'indeterminate');

      const other = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'refund-audit-other' },
         intent('REFUND_AUDIT_OTHER_SERVICE_TX'),
      ).watch;
      assert.throws(
         () => store.recordRefundEvidence(other.id, {
            transaction: SIGNED_SERVICE_TX_ID,
            network: ALGORAND_TESTNET,
            atomicAmount: '20000',
            reason: 'service failure refund',
         }),
         /different audit evidence/,
      );
      store.close();
   } finally {
      rmSync(directory, { recursive: true, force: true });
   }
});


test('refund audit validation rejects malformed transaction, network, and uint64 overflow', () => {
   const store = new RoundWatchStore(':memory:');

   try {
      const watch = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'refund-validation-watch' },
         intent('REFUND_VALIDATION_SERVICE_TX'),
      ).watch;
      const valid = {
         transaction: SIGNED_SERVICE_TX_ID,
         network: ALGORAND_TESTNET,
         atomicAmount: '20000',
      };

      for (const invalid of [
         { transaction: ' ' },
         { transaction: 'A'.repeat(51) },
         { transaction: '0'.repeat(52) },
         { network: 'not-a-network' },
         { atomicAmount: '18446744073709551616' },
         { atomicAmount: '020000' },
      ]) {
         assert.throws(
            () => store.recordRefundEvidence(watch.id, {
               ...valid,
               ...invalid,
            }),
         );
      }

      assert.deepEqual(store.listRefundEvidence(watch.id), []);
   } finally {
      store.close();
   }
});

test('refund CLI refuses a nonexistent or unrelated database without creating or migrating it', () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-refund-cli-'));
   const missingPath = join(directory, 'typo.sqlite');
   const unrelatedPath = join(directory, 'unrelated.sqlite');
   const tsxCli = fileURLToPath(
      new URL('./node_modules/tsx/dist/cli.mjs', import.meta.url),
   );
   const script = fileURLToPath(new URL('./record-refund.ts', import.meta.url));
   const args = [
      'missing-watch',
      SIGNED_SERVICE_TX_ID,
      ALGORAND_TESTNET,
      '20000',
      'operator evidence',
   ];

   const run = (path: string, extra: string[] = []) =>
      spawnSync(
         process.execPath,
         [tsxCli, script, ...extra, ...args],
         {
            env: {
               ...process.env,
               ROUNDWATCH_DB_PATH: path,
            },
            encoding: 'utf8',
         },
      );

   try {
      const missing = run(missingPath);
      assert.notEqual(missing.status, 0);
      assert.equal(existsSync(missingPath), false);

      const unrelated = new DatabaseSync(unrelatedPath);
      unrelated.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
      unrelated.close();

      const rejected = run(unrelatedPath);
      assert.notEqual(rejected.status, 0);
      const check = new DatabaseSync(unrelatedPath, { readOnly: true });
      const watchTableCount = check.prepare(
         "SELECT count(*) AS n FROM sqlite_master WHERE name = 'roundwatch_watches'",
      ).get() as unknown as { n: number };
      assert.equal(watchTableCount.n, 0);
      check.close();

      // An explicit separator is tolerated by the script itself. The database
      // is still nonexistent, so failure must occur at safe target validation,
      // not because "--" was mistaken for the watch ID.
      const separator = run(missingPath, ['--']);
      assert.notEqual(separator.status, 0);
      assert.equal(existsSync(missingPath), false);
      assert.doesNotMatch(separator.stderr, /Watch not found: --/);
   } finally {
      rmSync(directory, { recursive: true, force: true });
   }
});

test('refund CLI appends evidence to an existing current store without changing watch lifecycle', () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-refund-cli-success-'));
   const path = join(directory, 'roundwatch.sqlite');
   const tsxCli = fileURLToPath(
      new URL('./node_modules/tsx/dist/cli.mjs', import.meta.url),
   );
   const script = fileURLToPath(new URL('./record-refund.ts', import.meta.url));

   try {
      let store = new RoundWatchStore(path, { workUnitBudget: 1 });
      const watch = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'refund-cli-success-watch' },
         intent('REFUND_CLI_SUCCESS_SERVICE_TX'),
      ).watch;
      assert.equal(store.claimWorkUnit(watch.id), 'claimed');
      assert.equal(store.claimWorkUnit(watch.id), 'exhausted');
      const before = store.getWatch(watch.id)!;
      assert.equal(before.state, 'indeterminate');
      store.close();

      const result = spawnSync(
         process.execPath,
         [
            tsxCli,
            script,
            '--',
            watch.id,
            SIGNED_SERVICE_TX_ID,
            ALGORAND_TESTNET,
            '20000',
            'service failure refund',
         ],
         {
            env: {
               ...process.env,
               ROUNDWATCH_DB_PATH: path,
            },
            encoding: 'utf8',
         },
      );
      assert.equal(result.status, 0, result.stderr);

      const output = JSON.parse(result.stdout) as {
         watchState?: string;
         refund?: {
            transaction?: string;
            atomicAmount?: string;
         };
      };
      assert.equal(output.watchState, 'indeterminate');
      assert.equal(output.refund?.transaction, SIGNED_SERVICE_TX_ID);
      assert.equal(output.refund?.atomicAmount, '20000');

      store = new RoundWatchStore(path, {
         schemaMode: 'existing-refund-audit',
      });
      assert.deepEqual(store.getWatch(watch.id), before);
      const refunds = store.listRefundEvidence(watch.id);
      assert.equal(refunds.length, 1);
      assert.equal(refunds[0]?.transaction, SIGNED_SERVICE_TX_ID);
      store.close();
   } finally {
      rmSync(directory, { recursive: true, force: true });
   }
});

test('legacy migration is idempotent and does not fabricate proof or alter matched state', () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-legacy-'));
   const path = join(directory, 'legacy.sqlite');
   try {
      const db = new DatabaseSync(path);
      db.exec(`CREATE TABLE roundwatch_watches (
         id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
         expected_sender TEXT NOT NULL, expected_receiver TEXT NOT NULL, asset_id INTEGER NOT NULL,
         atomic_amount TEXT NOT NULL, invoice_note TEXT, service_transaction TEXT UNIQUE,
         service_network TEXT, service_payer TEXT, activation_round INTEGER, activated_at TEXT,
         scan_after_round INTEGER, created_at TEXT NOT NULL, matched_transaction TEXT, matched_round INTEGER
      );`);
      db.prepare(`INSERT INTO roundwatch_watches VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
         'legacy-match', 'legacy-key', 'matched', PAYER, RECEIVER, TESTNET_USDC_ASSET_ID, '1', null,
         'service', ALGORAND_TESTNET, PAYER, 10, '2026-01-01T00:00:00Z', 10,
         '2026-01-01T00:00:00Z', 'invoice', 11,
      );
      db.close();
      for (let i = 0; i < 2; i += 1) {
         const store = new RoundWatchStore(path);
         const legacy = store.getWatch('legacy-match');
         assert.equal(legacy?.state, 'matched');
         assert.equal(legacy?.evidenceVersion, 0);
         assert.equal(legacy?.expiresAt, undefined);
         assert.equal(legacy?.closingRound, undefined);
         assert.equal(legacy?.workUnitBudget, 500);
         assert.equal(legacy?.workUnitsUsed, 0);
         store.close();
      }

      const migrated = new DatabaseSync(path);
      const schema = migrated.prepare(`
         SELECT sql FROM sqlite_master
         WHERE type = 'table' AND name = 'roundwatch_watches'
      `).get() as unknown as { sql?: string };
      const indexes = migrated.prepare(`
         SELECT name FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'roundwatch_watches'
      `).all() as unknown as Array<{ name: string }>;
      migrated.close();

      assert.doesNotMatch(
         schema.sql ?? '',
         /idempotency_key\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i,
      );
      assert.ok(
         indexes.some(index => index.name === 'roundwatch_idempotency_scope_unique'),
      );
   } finally { rmSync(directory, { recursive: true, force: true }); }
});

async function createSyntheticPaidRequest(
   app: ReturnType<typeof createApp>,
   spec: WatchSpec,
): Promise<{ paymentHeader: string; body: string }> {
   const body = JSON.stringify({
      idempotencyKey: spec.idempotencyKey,
      expectedSender: spec.expectedSender,
      expectedReceiver: spec.expectedReceiver,
      atomicAmount: spec.atomicAmount,
      invoiceNote: spec.invoiceNote,
   });
   const unpaid = await app.request('/spike/watch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
   });

   assert.equal(unpaid.status, 402);
   const encoded = unpaid.headers.get('payment-required');
   assert.ok(encoded);
   const required = decodePaymentRequiredHeader(encoded).accepts[0]!;
   const payload: PaymentPayload = {
      x402Version: 2,
      accepted: required,
      payload: {
         paymentGroup: [SIGNED_SERVICE_PAYMENT],
         paymentIndex: 0,
      },
   };

   return {
      paymentHeader: encodePaymentSignatureHeader(payload),
      body,
   };
}

function paymentTransactionId(payload: PaymentPayload): string {
   const exact = payload.payload as unknown as {
      paymentGroup?: unknown;
      paymentIndex?: unknown;
   };
   if (
      !Array.isArray(exact.paymentGroup) ||
      !exact.paymentGroup.every(item => typeof item === 'string') ||
      !Number.isSafeInteger(exact.paymentIndex) ||
      (exact.paymentIndex as number) < 0 ||
      (exact.paymentIndex as number) >= exact.paymentGroup.length
   ) {
      throw new Error('synthetic facilitator received malformed payment payload');
   }

   return getTransactionId(
      Buffer.from(exact.paymentGroup[exact.paymentIndex as number] as string, 'base64'),
   );
}

class DelayedRejectingFacilitator implements FacilitatorClient {
   verifyCalls = 0;
   peakVerifyCalls = 0;
   private inFlightVerifyCalls = 0;

   async verify(
      _paymentPayload: PaymentPayload,
      _paymentRequirements: PaymentRequirements,
   ): Promise<VerifyResponse> {
      this.verifyCalls += 1;
      this.inFlightVerifyCalls += 1;
      this.peakVerifyCalls = Math.max(
         this.peakVerifyCalls,
         this.inFlightVerifyCalls,
      );

      try {
         await new Promise(resolve => setTimeout(resolve, 25));
         return {
            isValid: false,
            invalidReason: 'synthetic rejection',
         } as VerifyResponse;
      } finally {
         this.inFlightVerifyCalls -= 1;
      }
   }

   async settle(
      _paymentPayload: PaymentPayload,
      _paymentRequirements: PaymentRequirements,
   ): Promise<SettleResponse> {
      throw new Error('settle must not run after rejected verification');
   }

   async getSupported(): Promise<SupportedResponse> {
      return {
         kinds: [
            {
               x402Version: 2,
               scheme: 'exact',
               network: ALGORAND_TESTNET,
            },
         ],
         extensions: [],
         signers: {},
      };
   }
}

class MiddlewareFacilitator implements FacilitatorClient {
   settleCalls = 0;
   readonly statesObservedAtSettle: Array<WatchRecord['state'] | undefined> = [];

   constructor(
      private readonly store: RoundWatchStore,
      private readonly idempotencyKey: string,
   ) {}

   async verify(
      _paymentPayload: PaymentPayload,
      _paymentRequirements: PaymentRequirements,
   ): Promise<VerifyResponse> {
      return { isValid: true, payer: PAYER };
   }

   async settle(
      paymentPayload: PaymentPayload,
      _paymentRequirements: PaymentRequirements,
   ): Promise<SettleResponse> {
      this.settleCalls += 1;
      this.statesObservedAtSettle.push(
         this.store.getByIdempotencyKey(this.idempotencyKey)?.state,
      );

      return {
         success: true,
         payer: PAYER,
         transaction: paymentTransactionId(paymentPayload),
         network: ALGORAND_TESTNET,
      };
   }

   async getSupported(): Promise<SupportedResponse> {
      return {
         kinds: [
            {
               x402Version: 2,
               scheme: 'exact',
               network: ALGORAND_TESTNET,
            },
         ],
         extensions: [],
         signers: {},
      };
   }
}

class MiddlewareIndexer implements RoundWatchIndexer {
   activationFailuresRemaining = 0;
   readonly lookupPurposes: string[] = [];

   async getCurrentRound(): Promise<number> {
      return 201;
   }

   async lookupAssetTransfer(
      transactionId: string,
      purpose = 'reconciliation',
   ) {
      this.lookupPurposes.push(purpose);
      if (purpose === 'activation' && this.activationFailuresRemaining > 0) {
         this.activationFailuresRemaining -= 1;
         throw new Error('synthetic activation lookup failure');
      }

      return {
         transaction: transactionId,
         sender: PAYER,
         receiver: SERVICE_RECEIVER,
         assetId: TESTNET_USDC_ASSET_ID,
         atomicAmount: ROUNDWATCH_SERVICE_ATOMIC_AMOUNT,
         round: 150,
      };
   }

   async getBlock(round: number): Promise<IndexedBlock> {
      return { round, timestamp: 1_800_000_000 };
   }

   async searchWatchPage(): Promise<TransactionPage> {
      return { transactions: [], currentRound: 201 };
   }

   async searchTransactionPage(): Promise<TransactionIdPage> {
      return { transactions: [], currentRound: 201 };
   }
}

class FakeIndexer implements RoundWatchIndexer {
   pages: TransactionPage[] = [];
   pageCalls: Array<{ min: number; max: number; nextToken?: string }> = [];
   failPageCalls = new Set<number>();
   currentRoundCalls = 0;
   blockCalls = 0;
   block: IndexedBlock;
   constructor(public round: number) { this.block = { round, timestamp: 0 }; }
   async getCurrentRound(): Promise<number> {
      this.currentRoundCalls += 1;
      return this.round;
   }
   async lookupAssetTransfer(): Promise<undefined> { return undefined; }
   async getBlock(): Promise<IndexedBlock> {
      this.blockCalls += 1;
      return this.block;
   }
   async searchWatchPage(_watch: WatchRecord, min: number, max: number, nextToken?: string): Promise<TransactionPage> {
      const callIndex = this.pageCalls.length;
      this.pageCalls.push({ min, max, ...(nextToken ? { nextToken } : {}) });
      if (this.failPageCalls.has(callIndex)) throw new Error('synthetic page failure');
      const page = this.pages.shift(); if (!page) throw new Error('no fake page'); return page;
   }
   async searchTransactionPage(): Promise<TransactionIdPage> { return { transactions: [], currentRound: this.round }; }
}

class SharedPageFakeIndexer extends FakeIndexer {
   watchPageQueryKey(
      _watch: WatchRecord,
      min: number,
      max: number,
      nextToken?: string,
   ): string {
      return `${min}:${max}:${nextToken ?? ''}`;
   }
}

function watchRecord(overrides: Partial<WatchRecord>): WatchRecord {
   return {
      ...SPEC,
      id: 'watch',
      state: 'active',
      activationRound: 100,
      scanAfterRound: 100,
      createdAt: '2026-09-18T09:30:00Z',
      expiresAt: '2026-09-18T10:00:00Z',
      evidenceVersion: 1,
      reconciliationAttempts: 0,
      workUnitBudget: 500,
      workUnitsUsed: 0,
      ...overrides,
      settlementReconciliationTerminal:
         overrides.settlementReconciliationTerminal ?? false,
   };
}
function invoiceTx(round: number, roundTime: number): IndexedWatchTransaction {
   return { transaction: `INVOICE_${round}`, sender: PAYER, receiver: RECEIVER,
      assetId: TESTNET_USDC_ASSET_ID, atomicAmount: SPEC.atomicAmount, round, roundTime,
      note: Buffer.from(SPEC.invoiceNote!, 'utf8').toString('base64') };
}
function rawTx(round: number): Record<string, unknown> {
   return {
      id: 'TX',
      sender: PAYER,
      'confirmed-round': round,
      'round-time': 1,
      'tx-type': 'axfer',
      'asset-transfer-transaction': {
         receiver: RECEIVER,
         'asset-id': TESTNET_USDC_ASSET_ID,
         amount: 1,
         'close-amount': 0,
      },
   };
}
