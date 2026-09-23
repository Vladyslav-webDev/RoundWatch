import type { RoundWatchNetworkConfig } from './network-config.js';
import {
   buildWatchEligibilityContract,
   eligibilityBoundarySummary,
} from './roundwatch-contract.js';

interface MachineReadableDocsOptions {
   networkConfig: RoundWatchNetworkConfig;
   publicBaseUrl?: string;
   serviceReceiver: string;
   servicePriceUsd: string;
   serviceAtomicAmount: string;
   workUnitBudget: number;
   watchTtlMilliseconds: number;
   watchPath: string;
}

const PRODUCT_SITE = 'https://roundwatch.observer';
const QUICKSTART_URL = `${PRODUCT_SITE}/start`;
const TECHNICAL_GUIDE_URL =
   `${PRODUCT_SITE}/algorand-payment-monitoring-api`;
const GITHUB_URL = 'https://github.com/Vladyslav-webDev/RoundWatch';

export function buildOpenApiDocument(
   options: MachineReadableDocsOptions,
): Record<string, unknown> {
   const {
      networkConfig,
      publicBaseUrl,
      serviceReceiver,
      servicePriceUsd,
      serviceAtomicAmount,
      workUnitBudget,
      watchTtlMilliseconds,
      watchPath,
   } = options;

   const watchStatusPath = `${watchPath}/{id}`;
   const eligibility = buildWatchEligibilityContract(
      watchTtlMilliseconds,
   );
   const eligibilitySummary = eligibilityBoundarySummary(
      watchTtlMilliseconds,
   );
   const x402Contract = {
      version: 2,
      scheme: 'exact',
      network: networkConfig.network,
      asset: networkConfig.usdcAssetId,
      payTo: serviceReceiver,
      servicePriceUsd,
      servicePriceAtomicAmount: serviceAtomicAmount,
      challengeTag: networkConfig.challengeTag,
      requestHeader: 'PAYMENT-SIGNATURE',
      challengeHeader: 'PAYMENT-REQUIRED',
      settlementHeader: 'PAYMENT-RESPONSE',
      watchEligibility: eligibility,
   };

   return {
      openapi: '3.1.0',
      info: {
         title: 'RoundWatch API',
         version: '1.0.0',
         summary: 'Durable Algorand USDC payment monitoring for autonomous workflows',
         description:
            'RoundWatch creates one durable watch for an exact future top-level direct Algorand USDC payment when no transaction ID exists yet. Inner transactions, clawback transfers, and asset close-out transfers are outside the current matching contract. The create operation is paid through x402; status retrieval is free.',
         license: {
            name: 'MIT',
            identifier: 'MIT',
         },
         contact: {
            url: PRODUCT_SITE,
         },
      },
      ...(publicBaseUrl
         ? {
              servers: [
                 {
                    url: publicBaseUrl,
                    description: `RoundWatch ${networkConfig.name} API`,
                 },
              ],
           }
         : {}),
      externalDocs: {
         description: 'RoundWatch quickstart',
         url: QUICKSTART_URL,
      },
      tags: [
         {
            name: 'RoundWatch',
            description:
               'Create and retrieve durable watches for exact future Algorand USDC payments.',
         },
         {
            name: 'Service',
            description: 'Free service metadata and health endpoints.',
         },
      ],
      paths: {
         '/health': {
            get: {
               tags: ['Service'],
               operationId: 'getHealth',
               summary: 'Check RoundWatch process liveness',
               description:
                  'Liveness only. A 200 response does not claim that durable storage and background workers are ready to accept paid obligations.',
               responses: {
                  '200': {
                     description: 'The HTTP process is alive.',
                     content: {
                        'application/json': {
                           schema: {
                              $ref: '#/components/schemas/HealthResponse',
                           },
                        },
                     },
                  },
               },
            },
         },
         '/ready': {
            get: {
               tags: ['Service'],
               operationId: 'getReadiness',
               summary: 'Check durable-service readiness',
               description:
                  'Readiness checks cached durable-write capability plus production worker progress/error freshness. A non-ready service refuses new paid watch obligations before x402 verification. Use this endpoint before directing paid traffic.',
               responses: {
                  '200': {
                     description: 'RoundWatch is ready to accept paid obligations.',
                     content: {
                        'application/json': {
                           schema: {
                              $ref: '#/components/schemas/ReadinessResponse',
                           },
                        },
                     },
                  },
                  '503': {
                     description: 'The process is alive but the durable service is not ready.',
                     content: {
                        'application/json': {
                           schema: {
                              $ref: '#/components/schemas/ReadinessResponse',
                           },
                        },
                     },
                  },
               },
            },
         },
         [watchPath]: {
            post: {
               tags: ['RoundWatch'],
               operationId: 'createWatch',
               summary: 'Create a durable watch for one exact future USDC payment',
               description:
                  `Submit the expected sender, receiver, atomic amount, and optional exact note for one top-level direct USDC asset transfer. Inner transactions, clawback transfers, and asset close-out transfers do not count as matches. The service contract includes a ${workUnitBudget}-turn work budget. ${eligibilitySummary} An unpaid request receives HTTP 402 with a PAYMENT-REQUIRED x402 v2 challenge. After a valid PAYMENT-SIGNATURE is settled and durable activation is confirmed, the same request returns a watch ID. The watched asset is selected by the server and is not supplied by the caller.`,
               'x-x402': x402Contract,
               requestBody: {
                  required: true,
                  content: {
                     'application/json': {
                        schema: {
                           $ref: '#/components/schemas/CreateWatchRequest',
                        },
                        example: {
                           idempotencyKey: 'invoice-2026-09-22-001',
                           expectedSender:
                              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
                           expectedReceiver:
                              'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI',
                           atomicAmount: '1000000',
                           invoiceNote: 'roundwatch:invoice-2026-09-22-001',
                        },
                     },
                  },
               },
               responses: {
                  '200': {
                     description:
                        'x402 settlement succeeded and the durable watch was activated.',
                     headers: {
                        'PAYMENT-RESPONSE': {
                           description:
                              'x402 settlement response exposed to browser clients.',
                           schema: { type: 'string' },
                        },
                        'X-RoundWatch-Id': {
                           description: 'Durable RoundWatch watch ID.',
                           schema: { type: 'string', format: 'uuid' },
                        },
                     },
                     content: {
                        'application/json': {
                           schema: {
                              $ref: '#/components/schemas/CreateWatchResponse',
                           },
                        },
                     },
                  },
                  '400': {
                     description:
                        'Invalid watch request or invalid PAYMENT-SIGNATURE header.',
                     content: {
                        'application/json': {
                           schema: { $ref: '#/components/schemas/ErrorResponse' },
                        },
                     },
                  },
                  '402': {
                     description:
                        'Payment required. Read the PAYMENT-REQUIRED header, create the advertised x402 payment, then retry the same request with PAYMENT-SIGNATURE.',
                     headers: {
                        'PAYMENT-REQUIRED': {
                           required: true,
                           description:
                              'Base64-encoded canonical x402 v2 payment challenge.',
                           schema: { type: 'string' },
                        },
                     },
                  },
                  '409': {
                     description:
                        'The idempotency key already belongs to an existing watch.',
                     content: {
                        'application/json': {
                           schema: { $ref: '#/components/schemas/ErrorResponse' },
                        },
                     },
                  },
                  '429': {
                     description:
                        'RoundWatch or payment-verification admission capacity is temporarily exhausted.',
                     headers: {
                        'Retry-After': {
                           description:
                              'Retry delay in seconds when payment verification is rate-limited.',
                           schema: { type: 'string' },
                        },
                     },
                     content: {
                        'application/json': {
                           schema: { $ref: '#/components/schemas/ErrorResponse' },
                        },
                     },
                  },
                  '500': {
                     description:
                        'Settlement or durable activation could not be confirmed safely.',
                     content: {
                        'application/json': {
                           schema: { $ref: '#/components/schemas/ErrorResponse' },
                        },
                     },
                  },
               },
            },
         },
         [watchStatusPath]: {
            get: {
               tags: ['RoundWatch'],
               operationId: 'getWatch',
               summary: 'Retrieve durable watch state and evidence',
               description:
                  'Free status lookup. The caller may exit after successful creation and retrieve the watch later using its durable ID.',
               parameters: [
                  {
                     name: 'id',
                     in: 'path',
                     required: true,
                     description: 'RoundWatch watch ID returned by createWatch.',
                     schema: {
                        type: 'string',
                        format: 'uuid',
                     },
                  },
               ],
               responses: {
                  '200': {
                     description: 'Current durable watch state.',
                     content: {
                        'application/json': {
                           schema: {
                              type: 'object',
                              required: ['watch'],
                              properties: {
                                 watch: {
                                    $ref: '#/components/schemas/Watch',
                                 },
                              },
                           },
                        },
                     },
                  },
                  '404': {
                     description: 'No watch exists with this ID.',
                     content: {
                        'application/json': {
                           schema: { $ref: '#/components/schemas/ErrorResponse' },
                        },
                     },
                  },
               },
            },
         },
      },
      components: {
         schemas: {
            HealthResponse: {
               type: 'object',
               additionalProperties: false,
               required: ['status', 'purpose', 'network'],
               properties: {
                  status: {
                     type: 'string',
                     const: 'ok',
                  },
                  purpose: {
                     type: 'string',
                     const: 'liveness',
                  },
                  network: {
                     type: 'string',
                     enum: ['mainnet', 'testnet'],
                  },
               },
            },
            ReadinessResponse: {
               type: 'object',
               additionalProperties: false,
               required: ['status', 'network', 'checks'],
               properties: {
                  status: {
                     type: 'string',
                     enum: ['ready', 'not_ready'],
                  },
                  network: {
                     type: 'string',
                     enum: ['mainnet', 'testnet'],
                  },
                  checks: {
                     type: 'object',
                     additionalProperties: {
                        type: 'boolean',
                     },
                  },
               },
            },
            CreateWatchRequest: {
               type: 'object',
               additionalProperties: true,
               required: [
                  'idempotencyKey',
                  'expectedSender',
                  'expectedReceiver',
                  'atomicAmount',
               ],
               properties: {
                  idempotencyKey: {
                     type: 'string',
                     minLength: 8,
                     maxLength: 128,
                     description:
                        'Stable caller-supplied key used to prevent duplicate durable watches for the same payment intent.',
                  },
                  expectedSender: {
                     type: 'string',
                     minLength: 58,
                     maxLength: 58,
                     description:
                        'Checksum-valid Algorand address expected to send the future USDC payment.',
                  },
                  expectedReceiver: {
                     type: 'string',
                     minLength: 58,
                     maxLength: 58,
                     description:
                        'Checksum-valid Algorand address expected to receive the future USDC payment.',
                  },
                  atomicAmount: {
                     type: 'string',
                     pattern: '^[1-9]\\d*$',
                     description:
                        'Exact watched USDC amount in atomic units. Algorand USDC uses 6 decimals, so 1000000 means 1 USDC.',
                  },
                  invoiceNote: {
                     type: 'string',
                     minLength: 1,
                     maxLength: 128,
                     description:
                        'Optional exact UTF-8 Algorand transaction note. The runtime enforces a maximum of 128 UTF-8 bytes.',
                  },
               },
            },
            CreateWatchResponse: {
               type: 'object',
               additionalProperties: false,
               required: [
                  'watchId',
                  'workUnitBudget',
                  'eligibilityTtlMs',
                  'eligibility',
                  'expiresAt',
                  'message',
               ],
               properties: {
                  watchId: {
                     type: 'string',
                     format: 'uuid',
                  },
                  workUnitBudget: {
                     type: 'integer',
                     minimum: 1,
                     example: workUnitBudget,
                  },
                  eligibilityTtlMs: {
                     type: 'integer',
                     minimum: 1,
                     example: watchTtlMilliseconds,
                     description:
                        'Creation-based eligibility window in milliseconds, disclosed before purchase.',
                  },
                  eligibility: {
                     type: 'object',
                     additionalProperties: true,
                     example: eligibility,
                     description:
                        'Strict watch eligibility contract. confirmed-round must be > activationRound and round-time must be < expiresAt.',
                  },
                  expiresAt: {
                     type: 'string',
                     format: 'date-time',
                     description:
                        'Exact eligibility deadline persisted when the durable watch is prepared.',
                  },
                  message: {
                     type: 'string',
                  },
               },
            },
            Watch: {
               type: 'object',
               additionalProperties: false,
               required: [
                  'id',
                  'state',
                  'expectedSender',
                  'expectedReceiver',
                  'assetId',
                  'atomicAmount',
                  'createdAt',
                  'workUnitsUsed',
               ],
               properties: {
                  id: { type: 'string', format: 'uuid' },
                  state: {
                     type: 'string',
                     enum: [
                        'settlement_pending',
                        'active',
                        'matched',
                        'settlement_unknown',
                        'expired',
                        'indeterminate',
                     ],
                  },
                  expectedSender: {
                     type: 'string',
                     minLength: 58,
                     maxLength: 58,
                  },
                  expectedReceiver: {
                     type: 'string',
                     minLength: 58,
                     maxLength: 58,
                  },
                  assetId: {
                     type: 'integer',
                     example: networkConfig.usdcAssetIdNumber,
                  },
                  atomicAmount: {
                     type: 'string',
                  },
                  invoiceNote: {
                     type: 'string',
                  },
                  expectedServiceTransaction: {
                     type: 'string',
                  },
                  expectedServiceNetwork: {
                     type: 'string',
                  },
                  expectedServicePayer: {
                     type: 'string',
                  },
                  serviceTransaction: {
                     type: 'string',
                  },
                  serviceNetwork: {
                     type: 'string',
                  },
                  servicePayer: {
                     type: 'string',
                  },
                  activationRound: {
                     type: 'integer',
                     minimum: 0,
                  },
                  activatedAt: {
                     type: 'string',
                     format: 'date-time',
                  },
                  scanAfterRound: {
                     type: 'integer',
                     minimum: 0,
                  },
                  createdAt: {
                     type: 'string',
                     format: 'date-time',
                  },
                  expiresAt: {
                     type: 'string',
                     format: 'date-time',
                  },
                  matchedTransaction: {
                     type: 'string',
                  },
                  matchedRound: {
                     type: 'integer',
                     minimum: 0,
                  },
                  workUnitBudget: {
                     type: 'integer',
                     minimum: 1,
                  },
                  workUnitsUsed: {
                     type: 'integer',
                     minimum: 0,
                  },
                  settlementReconciliationTerminal: {
                     type: 'boolean',
                     description:
                        'True when settlement reconciliation has reached a final fail-closed outcome and will not retry.',
                  },
                  terminalReason: {
                     type: 'string',
                     enum: ['work_budget_exhausted'],
                  },
               },
            },
            ErrorResponse: {
               type: 'object',
               required: ['error'],
               properties: {
                  error: {
                     type: 'string',
                  },
                  code: {
                     type: 'string',
                  },
                  watchId: {
                     type: 'string',
                     format: 'uuid',
                  },
                  watch: {
                     $ref: '#/components/schemas/Watch',
                  },
               },
            },
         },
      },
   };
}

export function buildLlmsTxt(options: MachineReadableDocsOptions): string {
   const {
      networkConfig,
      publicBaseUrl,
      serviceReceiver,
      servicePriceUsd,
      serviceAtomicAmount,
      workUnitBudget,
      watchTtlMilliseconds,
      watchPath,
   } = options;
   const base = publicBaseUrl ?? '';

   return `# RoundWatch

> RoundWatch is a durable payment-monitoring API for one exact future Algorand USDC payment when no transaction ID exists yet.

RoundWatch lets a short-lived agent or service define an expected payment, pay once for a durable watch through x402, exit, and later retrieve verified on-chain evidence.

## Use RoundWatch when

- You need to detect one exact future Algorand USDC transfer.
- The future transfer does not have a transaction ID yet.
- The caller should be able to terminate instead of running its own polling worker.
- Restart recovery and persisted scan progress matter.

## Do not use RoundWatch when

- You already know the transaction ID and only need ordinary confirmation.
- You already operate durable Algorand Indexer ingestion or equivalent subscriber infrastructure.
- You require a push webhook callback. RoundWatch is not a webhook delivery service; clients retrieve durable state later.

## Production contract

- Network: ${networkConfig.name}
- CAIP-2: ${networkConfig.network}
- Watched asset: Algorand USDC ASA ${networkConfig.usdcAssetId}
- Create watch: POST ${watchPath}
- Read watch: GET ${watchPath}/{id}
- Service price: ${servicePriceUsd} USDC (${serviceAtomicAmount} atomic units)
- Service receiver: ${serviceReceiver}
- Eligibility window: ${watchTtlMilliseconds} ms from durable watch preparation; settlement time consumes part of this window
- Round boundary: transaction confirmed-round must be strictly greater than activationRound; the service-settlement round itself is ineligible
- Time boundary: transaction block round-time must be strictly earlier than expiresAt; a block timestamp exactly equal to expiresAt is ineligible
- Work budget: ${workUnitBudget} durable background turns per watch
- x402 version: 2
- x402 scheme: exact

The x402 payment buys the RoundWatch monitoring service. It is separate from the future USDC payment that RoundWatch watches.

## Machine-readable API

- OpenAPI: ${base}/openapi.json
- LLM instructions: ${base}/llms.txt
- MCP Streamable HTTP: ${base}/mcp
- Liveness: ${base}/health
- Readiness: ${base}/ready
- API root: ${base || '/'}
- GitHub: ${GITHUB_URL}

The MCP server exposes read-only discovery and status tools plus a preparation tool that validates and returns the exact x402 HTTP request. The MCP layer does not hold a wallet and does not sign or settle the x402 payment.

## Human documentation

- Product: ${PRODUCT_SITE}/
- Quickstart: ${QUICKSTART_URL}
- Technical guide: ${TECHNICAL_GUIDE_URL}

## Core behavior

A watch exact-matches sender, receiver, server-selected USDC ASA, atomic amount, and optional exact note for one top-level direct asset transfer. Inner transactions, clawback transfers, and asset close-out transfers are outside the current matching contract and do not count as payments. ${eligibilityBoundarySummary(watchTtlMilliseconds)} A successful create call returns a durable watch ID only after x402 settlement and durable activation are confirmed. Status retrieval is free and marked no-store. Terminal matched evidence includes the matching Algorand transaction ID and confirmed round. A terminal settlement-reconciliation outcome is explicitly surfaced on the watch record. Expiry is proof-based after complete indexed coverage; work-budget exhaustion returns indeterminate rather than claiming absence.
`;
}
