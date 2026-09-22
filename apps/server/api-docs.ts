import type { RoundWatchNetworkConfig } from './network-config.js';

interface MachineReadableDocsOptions {
   networkConfig: RoundWatchNetworkConfig;
   publicBaseUrl?: string;
   serviceReceiver: string;
   servicePriceUsd: string;
   serviceAtomicAmount: string;
   workUnitBudget: number;
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
      watchPath,
   } = options;

   const watchStatusPath = `${watchPath}/{id}`;
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
   };

   return {
      openapi: '3.1.0',
      info: {
         title: 'RoundWatch API',
         version: '1.0.0',
         summary: 'Durable Algorand USDC payment monitoring for autonomous workflows',
         description:
            'RoundWatch creates one durable watch for an exact future Algorand USDC payment when no transaction ID exists yet. The create operation is paid through x402; status retrieval is free.',
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
               summary: 'Check RoundWatch service health',
               responses: {
                  '200': {
                     description: 'Service is healthy.',
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
         [watchPath]: {
            post: {
               tags: ['RoundWatch'],
               operationId: 'createWatch',
               summary: 'Create a durable watch for one exact future USDC payment',
               description:
                  'Submit the expected sender, receiver, atomic amount, and optional exact note. An unpaid request receives HTTP 402 with a PAYMENT-REQUIRED x402 v2 challenge. After a valid PAYMENT-SIGNATURE is settled and durable activation is confirmed, the same request returns a watch ID. The watched asset is selected by the server and is not supplied by the caller.',
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
               required: ['status', 'network'],
               properties: {
                  status: {
                     type: 'string',
                     const: 'ok',
                  },
                  network: {
                     type: 'string',
                     enum: ['mainnet', 'testnet'],
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
               required: ['watchId', 'workUnitBudget', 'message'],
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
- Work budget: ${workUnitBudget} durable background turns per watch
- x402 version: 2
- x402 scheme: exact

The x402 payment buys the RoundWatch monitoring service. It is separate from the future USDC payment that RoundWatch watches.

## Machine-readable API

- OpenAPI: ${base}/openapi.json
- Health: ${base}/health
- API root: ${base || '/'}
- GitHub: ${GITHUB_URL}

## Human documentation

- Product: ${PRODUCT_SITE}/
- Quickstart: ${QUICKSTART_URL}
- Technical guide: ${TECHNICAL_GUIDE_URL}

## Core behavior

A watch exact-matches sender, receiver, server-selected USDC ASA, atomic amount, and optional exact note. A successful create call returns a durable watch ID only after x402 settlement and durable activation are confirmed. Status retrieval is free. Terminal matched evidence includes the matching Algorand transaction ID and confirmed round. Expiry is proof-based after complete indexed coverage; work-budget exhaustion returns indeterminate rather than claiming absence.
`;
}
