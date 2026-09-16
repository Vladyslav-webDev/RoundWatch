import { Hono } from 'hono';

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
   getSenderFromTransaction,
   getTransactionId,
   isValidAlgorandAddress,
} from '@x402/avm';
import {
   bazaarResourceServerExtension,
   declareDiscoveryExtension,
} from '@x402-avm/extensions';

import type { RoundWatchIndexer } from './roundwatch-indexer.js';
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

export const ALGORAND_TESTNET = TESTNET_NETWORK_CONFIG.network;
export const TESTNET_USDC_ASSET_ID = TESTNET_NETWORK_CONFIG.usdcAssetIdNumber;
export const ROUNDWATCH_SERVICE_PRICE_USD = '0.001';
export const ROUNDWATCH_SERVICE_ATOMIC_AMOUNT = convertToTokenAmount(
   ROUNDWATCH_SERVICE_PRICE_USD,
   USDC_DECIMALS,
);

const ROUNDWATCH_ID_HEADER = 'x-roundwatch-id';
const MAX_SAFE_ATOMIC_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);

export interface AppDependencies {
   avmAddress: string;
   facilitatorClient: FacilitatorClient;
   store: RoundWatchStore;
   indexer: RoundWatchIndexer;
   networkConfig?: RoundWatchNetworkConfig;
   publicBaseUrl?: string;
   syncFacilitatorOnStart?: boolean;
   requireSettlementIntent?: boolean;
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

const watchDiscovery = declareDiscoveryExtension({
   bodyType: 'json',
   input: {
      idempotencyKey: 'invoice-2026-09-15-001',
      expectedSender: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
      expectedReceiver: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBAR7CWY',
      atomicAmount: '1000',
      invoiceNote: 'roundwatch:invoice-2026-09-15-001',
   },
   inputSchema: {
      properties: {
         idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
         expectedSender: { type: 'string', minLength: 58, maxLength: 58 },
         expectedReceiver: { type: 'string', minLength: 58, maxLength: 58 },
         atomicAmount: { type: 'string', pattern: '^[1-9]\\d*$' },
         invoiceNote: { type: 'string', minLength: 1, maxLength: 128 },
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
         message: 'Durable watch activated after confirmed x402 settlement',
      },
   },
});

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
   } = dependencies;

   const watchPath = networkConfig.name === 'mainnet' ? '/v1/watch' : '/spike/watch';
   const watchRouteKey = `POST ${watchPath}`;
   const publicDemoResource = publicBaseUrl ? `${publicBaseUrl}/demo` : undefined;
   const publicWatchResource = publicBaseUrl ? `${publicBaseUrl}${watchPath}` : undefined;
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

      let activationRound: number | undefined;
      const settlementEvidence = {
         transaction: context.result.transaction,
         network: context.result.network,
         ...(context.result.payer ? { payer: context.result.payer } : {}),
      };

      store.recordSettlementCandidate(watchId, settlementEvidence);

      try {
         activationRound = await indexer.getCurrentRound();
      } catch (error) {
         console.warn(
            'RoundWatch could not capture an activation round:',
            safeErrorMessage(error),
         );
         return;
      }

      store.activateWatch(
         watchId,
         settlementEvidence,
         activationRound,
      );
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

   app.get('/health', c => {
      return c.json({
         status: 'ok',
         network: networkConfig.name,
      });
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
               description: `Create one durable RoundWatch ${networkConfig.name} watch`,
               mimeType: 'application/json',
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
   const payer = getSenderFromTransaction(transactionBytes, true);

   return {
      expectedTransaction,
      network: expectedNetwork,
      payer,
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

function publicWatch(watch: WatchRecord): Omit<WatchRecord, 'idempotencyKey'> {
   const { idempotencyKey: _, ...result } = watch;
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
