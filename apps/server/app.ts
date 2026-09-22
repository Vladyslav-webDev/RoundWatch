import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import type {
   FacilitatorClient,
   HTTPTransportContext,
} from '@x402/core/server';
import type { ResourceServerExtension } from '@x402/core/types';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { ExactAvmScheme } from '@x402/avm/exact/server';
import {
   USDC_DECIMALS,
   convertToTokenAmount,
   decodeSignedTransaction,
   getSenderFromTransaction,
   getTransactionId,
   isValidAlgorandAddress,
} from '@x402/avm';
import {
   bazaarResourceServerExtension,
   declareDiscoveryExtension,
} from '@x402-avm/extensions';

import {
   DEFAULT_SIGNED_PAYMENT_BURST,
   DEFAULT_SIGNED_PAYMENT_CONCURRENCY,
   DEFAULT_SIGNED_PAYMENT_REQUESTS_PER_SECOND,
   SignedPaymentGate,
   type SignedPaymentGateOptions,
} from './free-payment-gate.js';
import type { RoundWatchIndexer } from './roundwatch-indexer.js';
import type {
   FreeRequestCategory,
   RoundWatchEconomicsMetrics,
} from './roundwatch-metrics.js';
import {
   TESTNET_NETWORK_CONFIG,
   type RoundWatchNetworkConfig,
} from './network-config.js';
import type {
   RoundWatchStore,
   SettlementIntent,
   WatchRecord,
   WatchSpec,
} from './roundwatch-store.js';
import { WatchCapacityError } from './roundwatch-store.js';
import { merchantIdentityHtml } from './merchant-identity.js';
import { buildLlmsTxt, buildOpenApiDocument } from './api-docs.js';

export const ALGORAND_TESTNET = TESTNET_NETWORK_CONFIG.network;
export const TESTNET_USDC_ASSET_ID = TESTNET_NETWORK_CONFIG.usdcAssetIdNumber;
export const ROUNDWATCH_SERVICE_PRICE_USD = '0.02';
export const ROUNDWATCH_SERVICE_ATOMIC_AMOUNT = convertToTokenAmount(
   ROUNDWATCH_SERVICE_PRICE_USD,
   USDC_DECIMALS,
);

const ROUNDWATCH_ID_HEADER = 'x-roundwatch-id';
const MAX_SAFE_ATOMIC_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_PAYMENT_SIGNATURE_HEADER_BYTES = 16 * 1024;
const ROUNDWATCH_SERVICE_NAME = 'RoundWatch';
const ROUNDWATCH_ICON_URL = 'https://roundwatch.observer/favicon.svg';
const ROUNDWATCH_DISCOVERY_TAGS = [
   'algorand',
   'usdc',
   'payment-monitoring',
   'ai-agents',
   'x402',
] as const;

export interface AppDependencies {
   avmAddress: string;
   facilitatorClient: FacilitatorClient;
   store: RoundWatchStore;
   indexer: RoundWatchIndexer;
   networkConfig?: RoundWatchNetworkConfig;
   publicBaseUrl?: string;
   syncFacilitatorOnStart?: boolean;
   requireSettlementIntent?: boolean;
   economicsMetrics?: RoundWatchEconomicsMetrics;
   signedPaymentGateOptions?: SignedPaymentGateOptions;
}

const demoDiscovery = declareDiscoveryExtension({
   output: {
      example: {
         ok: true,
         message: 'x402 payment verified',
         timestamp: '2026-09-11T12:00:00.000Z',
      },
   },
});

function createWatchDiscovery(workUnitBudget: number) {
   return declareDiscoveryExtension({
      bodyType: 'json',
      input: {
         idempotencyKey: 'invoice-2026-09-15-001',
         expectedSender: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
         expectedReceiver: 'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI',
         atomicAmount: '1000000',
         invoiceNote: 'roundwatch:invoice-2026-09-15-001',
      },
      inputSchema: {
         properties: {
            idempotencyKey: {
               type: 'string',
               minLength: 8,
               maxLength: 128,
               description:
                  'Stable caller-supplied key used to prevent duplicate durable watches for the same payment intent',
            },
            expectedSender: {
               type: 'string',
               minLength: 58,
               maxLength: 58,
               description:
                  'Algorand address expected to send the future USDC payment',
            },
            expectedReceiver: {
               type: 'string',
               minLength: 58,
               maxLength: 58,
               description:
                  'Algorand address expected to receive the future USDC payment',
            },
            atomicAmount: {
               type: 'string',
               pattern: '^[1-9]\\d*$',
               description:
                  'Exact USDC amount in atomic units; Algorand USDC uses 6 decimals, so 1000000 means 1 USDC',
            },
            invoiceNote: {
               type: 'string',
               minLength: 1,
               maxLength: 128,
               description:
                  'Optional exact UTF-8 Algorand transaction note used to disambiguate the expected payment',
            },
         },
         required: [
            'idempotencyKey',
            'expectedSender',
            'expectedReceiver',
            'atomicAmount',
         ],
      },
      output: {
         example: {
            watchId: 'f5d2fb6f-b224-4aae-989c-87a5418fd2ae',
            workUnitBudget,
            message:
               'The watch is returned only if x402 settlement and durable activation succeed',
         },
         schema: {
            type: 'object',
            properties: {
               watchId: {
                  type: 'string',
                  description:
                     'Durable identifier used to retrieve the watch status and eventual on-chain evidence',
               },
               workUnitBudget: {
                  type: 'integer',
                  minimum: 1,
                  description:
                     'Maximum durable background work units allocated to this watch',
               },
               message: {
                  type: 'string',
                  description:
                     'Human-readable confirmation that durable activation succeeded',
               },
            },
            required: ['watchId', 'workUnitBudget', 'message'],
         },
      },
   });
}

export function createApp(dependencies: AppDependencies): Hono {
   const {
      avmAddress,
      facilitatorClient,
      store,
      indexer,
      networkConfig = TESTNET_NETWORK_CONFIG,
      publicBaseUrl,
      syncFacilitatorOnStart = true,
      requireSettlementIntent = networkConfig.name === 'mainnet',
      economicsMetrics,
      signedPaymentGateOptions,
   } = dependencies;

   const signedPaymentGate = new SignedPaymentGate(
      signedPaymentGateOptions ?? {
         requestsPerSecond:
            DEFAULT_SIGNED_PAYMENT_REQUESTS_PER_SECOND,
         burst: DEFAULT_SIGNED_PAYMENT_BURST,
         concurrency: DEFAULT_SIGNED_PAYMENT_CONCURRENCY,
      },
   );
   const workUnitBudget = store.configuredWorkUnitBudget();
   const watchDiscovery = createWatchDiscovery(workUnitBudget);
   const watchPath = networkConfig.name === 'mainnet' ? '/v1/watch' : '/spike/watch';
   const watchRouteKey = `POST ${watchPath}`;
   const publicDemoResource = publicBaseUrl ? `${publicBaseUrl}/demo` : undefined;
   const publicWatchResource = publicBaseUrl ? `${publicBaseUrl}${watchPath}` : undefined;
   const machineReadableDocsOptions = {
      networkConfig,
      publicBaseUrl,
      serviceReceiver: avmAddress,
      servicePriceUsd: ROUNDWATCH_SERVICE_PRICE_USD,
      serviceAtomicAmount: ROUNDWATCH_SERVICE_ATOMIC_AMOUNT,
      workUnitBudget,
      watchPath,
   };
   const openApiDocument = buildOpenApiDocument(machineReadableDocsOptions);
   const llmsTxt = buildLlmsTxt(machineReadableDocsOptions);
   const resourceServer = new x402ResourceServer(facilitatorClient);

   resourceServer.register(networkConfig.network, new ExactAvmScheme());
   resourceServer.registerExtension(
      bazaarResourceServerExtension as unknown as ResourceServerExtension,
   );

   resourceServer.onAfterSettle(async context => {
      const transport = context.transportContext as
         | HTTPTransportContext
         | undefined;

      if (
         context.phase !== 'after-handler' ||
         transport?.request.path !== watchPath ||
         transport.request.method !== 'POST'
      ) {
         return;
      }

      const watchId = getHeader(transport.responseHeaders, ROUNDWATCH_ID_HEADER);

      if (!watchId) {
         throw new Error('Settled RoundWatch response had no watch ID');
      }

      const settlementEvidence = {
         transaction: context.result.transaction,
         network: context.result.network,
         ...(context.result.payer ? { payer: context.result.payer } : {}),
      };

      store.recordSettlementCandidate(watchId, settlementEvidence);

      try {
         const transfer = await indexer.lookupAssetTransfer(
            settlementEvidence.transaction,
            'activation',
            watchId,
         );
         const watch = store.getWatch(watchId);
         if (!transfer || !watch) return;
         const matches =
            transfer.transaction === settlementEvidence.transaction &&
            transfer.sender === watch.expectedServicePayer &&
            transfer.receiver === watch.serviceReceiver &&
            transfer.assetId === watch.serviceAssetId &&
            transfer.atomicAmount === watch.serviceAtomicAmount &&
            transfer.round >= (watch.serviceFirstValid ?? Number.MAX_SAFE_INTEGER) &&
            transfer.round <= (watch.serviceLastValid ?? -1);
         if (!matches) {
            store.markSettlementInvalid(watchId);
            finishTerminalMetric(economicsMetrics, watch, 'settlement_unknown');
            return;
         }
         store.activateWatch(watchId, settlementEvidence, transfer.round);
      } catch (error) {
         console.warn(
            'RoundWatch could not confirm the service transaction activation round:',
            safeErrorMessage(error),
         );
         return;
      }
   });

   resourceServer.onSettleFailure(async context => {
      const transport = context.transportContext as
         | HTTPTransportContext
         | undefined;

      if (
         transport?.request.path !== watchPath ||
         transport.request.method !== 'POST'
      ) {
         return;
      }

      const watchId = getHeader(transport.responseHeaders, ROUNDWATCH_ID_HEADER);

      if (watchId) {
         store.markSettlementUnknown(watchId);
      }
   });

   const app = new Hono();

   app.use(
      '*',
      cors({
         origin: '*',
         allowMethods: ['GET', 'POST', 'OPTIONS'],
         allowHeaders: ['Content-Type', 'Payment-Signature'],
         exposeHeaders: [
            'Payment-Required',
            'Payment-Response',
            'X-RoundWatch-Id',
         ],
         maxAge: 86_400,
      }),
   );

   if (economicsMetrics) {
      app.use(async (c, next) => {
         const startedAt = performance.now();
         const requestBytes = declaredContentLength(
            c.req.header('content-length'),
         );

         await next();

         const wallTimeMs = Math.max(0, performance.now() - startedAt);
         const category = classifyFreeRequest(
            c.req.method,
            c.req.path,
            c.res.status,
            watchPath,
            c.req.header('payment-signature') !== undefined,
         );

         if (!category) return;

         const responseBytes = await responseByteLength(c.res);
         try {
            economicsMetrics.recordFreeRequest(category, {
               status: c.res.status,
               ...(requestBytes === undefined ? {} : { requestBytes }),
               responseBytes,
               wallTimeMs,
            });
         } catch (error) {
            console.warn(
               'RoundWatch economics free-request metric failed:',
               error instanceof Error ? error.message : 'Unknown metrics error',
            );
         }
      });
   }

   app.get('/', c => {
      c.header('cache-control', 'public, max-age=300');
      return c.html(merchantIdentityHtml());
   });

   app.get('/health', c => {
      return c.json({
         status: 'ok',
         network: networkConfig.name,
      });
   });

   app.get('/openapi.json', c => {
      c.header('cache-control', 'public, max-age=300');
      return c.json(openApiDocument);
   });

   app.get('/llms.txt', c => {
      c.header('cache-control', 'public, max-age=300');
      return c.text(llmsTxt);
   });

   // This resumes only after @x402/hono has finished settlement.
   app.use(watchPath, async (c, next) => {
      await next();

      if (c.req.method !== 'POST' || c.res.status >= 400) {
         return;
      }

      const watchId = c.res.headers.get(ROUNDWATCH_ID_HEADER);
      const watch = watchId ? store.getWatch(watchId) : undefined;

      if (!watch || (watch.state !== 'active' && watch.state !== 'matched')) {
         const headers = new Headers(c.res.headers);
         headers.set('content-type', 'application/json; charset=UTF-8');
         c.res = new Response(
            JSON.stringify({
               error:
                  'Service payment settled but durable watch activation was not confirmed',
               ...(watchId ? { watchId } : {}),
            }),
            { status: 500, headers },
         );
      }
   });

   app.use(watchPath, async (c, next) => {
      if (c.req.method !== 'POST') {
         await next();
         return;
      }

      const paymentHeader = c.req.header('payment-signature');
      if (!paymentHeader) {
         await next();
         return;
      }

      if (
         Buffer.byteLength(paymentHeader, 'utf8') >
         MAX_PAYMENT_SIGNATURE_HEADER_BYTES
      ) {
         return c.json(
            {
               error: 'PAYMENT-SIGNATURE header is too large',
               code: 'payment_signature_header_too_large',
            },
            400,
         );
      }

      try {
         decodePaymentSignatureHeader(paymentHeader);
      } catch {
         return c.json(
            {
               error: 'Invalid PAYMENT-SIGNATURE header',
               code: 'invalid_payment_signature_header',
            },
            400,
         );
      }

      const admission = signedPaymentGate.tryAcquire();
      if (!admission.allowed) {
         c.header('retry-after', '1');
         return c.json(
            {
               error: 'Payment verification capacity is temporarily exhausted',
               code: 'payment_verification_rate_limited',
            },
            429,
         );
      }

      try {
         await next();
      } finally {
         admission.release();
      }
   });

   app.use(
      paymentMiddleware(
         {
            'GET /demo': {
               accepts: [
                  {
                     scheme: 'exact',
                     price: '$0.005',
                     network: networkConfig.network,
                     payTo: avmAddress,
                     extra: {
                        asset: networkConfig.usdcAssetId,
                        tag: 'x402-global-challenge',
                     },
                  },
               ],
               ...(publicDemoResource ? { resource: publicDemoResource } : {}),
               description:
                  'x402 endpoint returning proof of successful Algorand USDC payment',
               mimeType: 'application/json',
               extensions: demoDiscovery,
            },
            [watchRouteKey]: {
               accepts: [
                  {
                     scheme: 'exact',
                     price: `$${ROUNDWATCH_SERVICE_PRICE_USD}`,
                     network: networkConfig.network,
                     payTo: avmAddress,
                     extra: {
                        asset: networkConfig.usdcAssetId,
                        tag: networkConfig.challengeTag,
                     },
                  },
               ],
               ...(publicWatchResource ? { resource: publicWatchResource } : {}),
               description:
                  `Monitor one exact future Algorand USDC payment on ${networkConfig.name} when no transaction ID exists yet. RoundWatch persists scan progress across restarts and returns a watch ID for later verified on-chain evidence; the watch has a ${workUnitBudget}-turn bounded background work budget.`,
               mimeType: 'application/json',
               serviceName: ROUNDWATCH_SERVICE_NAME,
               tags: [...ROUNDWATCH_DISCOVERY_TAGS],
               iconUrl: ROUNDWATCH_ICON_URL,
               extensions: watchDiscovery,
            },
         },
         resourceServer,
         undefined,
         undefined,
         syncFacilitatorOnStart,
      ),
   );

   // Known-good regression baseline when ROUNDWATCH_NETWORK is omitted/testnet.
   app.get('/demo', c => {
      return c.json({
         ok: true,
         message: 'x402 payment verified',
         timestamp: new Date().toISOString(),
      });
   });

   app.post(watchPath, async c => {
      let body: unknown;

      try {
         body = await c.req.json();
      } catch {
         return c.json({ error: 'Expected a JSON request body' }, 400);
      }

      const parsed = parseWatchSpec(body, networkConfig.usdcAssetIdNumber);

      if ('error' in parsed) {
         return c.json({ error: parsed.error }, 400);
      }

      let settlementIntent: SettlementIntent | undefined;
      const paymentHeader = c.req.header('payment-signature');

      if (paymentHeader) {
         try {
            settlementIntent = extractSettlementIntent(
               paymentHeader,
               networkConfig.network,
               avmAddress,
               networkConfig.usdcAssetIdNumber,
               ROUNDWATCH_SERVICE_ATOMIC_AMOUNT,
            );
         } catch (error) {
            if (requireSettlementIntent) {
               console.error(
                  'RoundWatch could not persist deterministic settlement identity:',
                  safeErrorMessage(error),
               );
               return c.json(
                  { error: 'Unable to prepare durable settlement reconciliation' },
                  500,
               );
            }
         }
      }

      if (requireSettlementIntent && !settlementIntent) {
         return c.json(
            { error: 'Durable settlement identity is required on MainNet' },
            500,
         );
      }

      let prepared;

      try {
         prepared = store.prepareWatch(parsed.spec, settlementIntent);
      } catch (error) {
         if (error instanceof WatchCapacityError) {
            console.warn(`RoundWatch admission rejected scope=${error.scope}`);
            return c.json(
               {
                  error: 'RoundWatch capacity is currently exhausted',
                  code:
                     error.scope === 'payer'
                        ? 'payer_watch_capacity_exhausted'
                        : 'global_watch_capacity_exhausted',
               },
               429,
            );
         }

         throw error;
      }

      if (!prepared.created) {
         return c.json(
            {
               error: 'Idempotency key already has a watch',
               watch: publicWatch(prepared.watch),
            },
            409,
         );
      }

      c.header(ROUNDWATCH_ID_HEADER, prepared.watch.id);

      return c.json({
         watchId: prepared.watch.id,
         workUnitBudget: prepared.watch.workUnitBudget,
         message:
            'The watch is returned only if x402 settlement and durable activation succeed',
      });
   });

   app.get(`${watchPath}/:id`, c => {
      const watch = store.getWatch(c.req.param('id'));

      if (!watch) {
         return c.json({ error: 'Watch not found' }, 404);
      }

      return c.json({ watch: publicWatch(watch) });
   });

   return app;
}

function extractSettlementIntent(
   paymentHeader: string,
   expectedNetwork: string,
   expectedReceiver: string,
   expectedAssetId: number,
   expectedAtomicAmount: string,
): SettlementIntent {
   const decoded = decodePaymentSignatureHeader(paymentHeader) as unknown as {
      accepted?: { network?: unknown };
      payload?: unknown;
   };

   if (
      decoded.accepted?.network !== undefined &&
      decoded.accepted.network !== expectedNetwork
   ) {
      throw new Error('Payment payload network does not match the configured network');
   }

   if (!decoded.payload || typeof decoded.payload !== 'object') {
      throw new Error('Payment payload is missing AVM transaction data');
   }

   const payload = decoded.payload as Record<string, unknown>;
   const paymentGroup = payload.paymentGroup;
   const paymentIndex = payload.paymentIndex;

   if (
      !Array.isArray(paymentGroup) ||
      !paymentGroup.every(item => typeof item === 'string') ||
      !Number.isSafeInteger(paymentIndex) ||
      (paymentIndex as number) < 0 ||
      (paymentIndex as number) >= paymentGroup.length
   ) {
      throw new Error('Payment payload has an invalid AVM payment group');
   }

   const encodedTransaction = paymentGroup[paymentIndex as number] as string;
   const transactionBytes = Buffer.from(encodedTransaction, 'base64');

   if (transactionBytes.length === 0) {
      throw new Error('Payment transaction is empty');
   }

   const expectedTransaction = getTransactionId(transactionBytes);
   const signed = decodeSignedTransaction(encodedTransaction);
   const transaction = signed.txn;
   const payer = getSenderFromTransaction(transactionBytes, true);
   const transfer = transaction.assetTransfer;
   const receiver = transfer?.receiver?.toString();
   const assetId = Number(transfer?.assetId);
   const atomicAmount = transfer?.amount?.toString();
   const firstValid = Number(transaction.firstValid);
   const lastValid = Number(transaction.lastValid);

   if (
      receiver !== expectedReceiver ||
      assetId !== expectedAssetId ||
      atomicAmount !== expectedAtomicAmount ||
      !Number.isSafeInteger(firstValid) || firstValid < 0 ||
      !Number.isSafeInteger(lastValid) || lastValid < firstValid
   ) {
      throw new Error('Signed service transaction terms do not match the accepted purchase');
   }

   return {
      expectedTransaction,
      network: expectedNetwork,
      payer,
      receiver,
      assetId,
      atomicAmount,
      firstValid,
      lastValid,
   };
}

function parseWatchSpec(
   body: unknown,
   usdcAssetId: number,
): { spec: WatchSpec } | { error: string } {
   if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { error: 'Request body must be an object' };
   }

   const input = body as Record<string, unknown>;
   const idempotencyKey = input.idempotencyKey;
   const expectedSender = input.expectedSender;
   const expectedReceiver = input.expectedReceiver;
   const atomicAmount = input.atomicAmount;
   const invoiceNote = input.invoiceNote;

   if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 128
   ) {
      return { error: 'idempotencyKey must be 8-128 characters' };
   }

   if (
      typeof expectedSender !== 'string' ||
      !isValidAlgorandAddress(expectedSender)
   ) {
      return { error: 'expectedSender must be a valid Algorand address' };
   }

   if (
      typeof expectedReceiver !== 'string' ||
      !isValidAlgorandAddress(expectedReceiver)
   ) {
      return { error: 'expectedReceiver must be a valid Algorand address' };
   }

   if (typeof atomicAmount !== 'string' || !/^[1-9]\d*$/.test(atomicAmount)) {
      return { error: 'atomicAmount must be a positive integer string' };
   }

   if (BigInt(atomicAmount) > MAX_SAFE_ATOMIC_AMOUNT) {
      return { error: `atomicAmount must not exceed ${MAX_SAFE_ATOMIC_AMOUNT}` };
   }

   if (
      invoiceNote !== undefined &&
      (typeof invoiceNote !== 'string' ||
         invoiceNote.length === 0 ||
         Buffer.byteLength(invoiceNote, 'utf8') > 128)
   ) {
      return { error: 'invoiceNote must be 1-128 UTF-8 bytes when supplied' };
   }

   return {
      spec: {
         idempotencyKey,
         expectedSender,
         expectedReceiver,
         assetId: usdcAssetId,
         atomicAmount,
         ...(typeof invoiceNote === 'string' ? { invoiceNote } : {}),
      },
   };
}

function classifyFreeRequest(
   method: string,
   path: string,
   status: number,
   watchPath: string,
   hasPaymentSignature: boolean,
): FreeRequestCategory | undefined {
   if (method === 'GET' && path === '/health') {
      return 'health';
   }

   if (
      method === 'GET' &&
      path.startsWith(`${watchPath}/`)
   ) {
      return 'watch-status';
   }

   if (
      method === 'POST' &&
      path === watchPath &&
      status >= 400 &&
      hasPaymentSignature
   ) {
      return 'watch-create-payment-rejected';
   }

   if (method === 'POST' && path === watchPath && status === 402) {
      return 'watch-create-402';
   }

   if (
      method === 'POST' &&
      path === watchPath &&
      status >= 400
   ) {
      return 'watch-create-rejected';
   }

   return undefined;
}

function declaredContentLength(value: string | undefined): number | undefined {
   if (!value) return undefined;
   const parsed = Number(value);
   return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function responseByteLength(response: Response): Promise<number> {
   const declared = declaredContentLength(
      response.headers.get('content-length') ?? undefined,
   );
   if (declared !== undefined) return declared;

   try {
      return (await response.clone().arrayBuffer()).byteLength;
   } catch {
      return 0;
   }
}

function finishTerminalMetric(
   economicsMetrics: RoundWatchEconomicsMetrics | undefined,
   watch: WatchRecord,
   finalState: WatchRecord['state'],
): void {
   if (!economicsMetrics) return;

   try {
      const createdAt = Date.parse(watch.createdAt);
      economicsMetrics.recordLifecycle(watch.id, {
         finalState,
         ...(Number.isFinite(createdAt)
            ? { timeToTerminalMs: Math.max(0, Date.now() - createdAt) }
            : {}),
      });
      const snapshot = economicsMetrics.finishWatch(watch.id);
      if (snapshot) {
         console.info(
            `RoundWatch economics watch-terminal ${JSON.stringify(snapshot)}`,
         );
      }
   } catch (error) {
      console.warn(
         'RoundWatch economics terminal metric failed:',
         error instanceof Error ? error.message : 'Unknown metrics error',
      );
   }
}

function publicWatch(watch: WatchRecord): Record<string, unknown> {
   const result: Record<string, unknown> = { ...watch };
   for (const internal of [
      'idempotencyKey',
      'evidenceVersion',
      'serviceReceiver',
      'serviceAssetId',
      'serviceAtomicAmount',
      'serviceFirstValid',
      'serviceLastValid',
      'reconciliationAttempts',
      'reconciliationNextAttemptAt',
      'closingRound',
   ]) {
      delete result[internal];
   }
   return result;
}

function getHeader(
   headers: Record<string, string> | undefined,
   name: string,
): string | undefined {
   const target = name.toLowerCase();

   return Object.entries(headers ?? {}).find(
      ([key]) => key.toLowerCase() === target,
   )?.[1];
}

function safeErrorMessage(error: unknown): string {
   return error instanceof Error ? error.message : 'Unknown activation-round error';
}
