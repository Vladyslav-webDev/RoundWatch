import { isValidAlgorandAddress } from '@x402/avm';

import type { RoundWatchNetworkConfig } from './network-config.js';
import type { RoundWatchStore, WatchRecord } from './roundwatch-store.js';
import {
   buildWatchEligibilityContract,
   eligibilityBoundarySummary,
} from './roundwatch-contract.js';
import {
   MAX_MCP_REQUEST_BODY_BYTES,
   RequestBodyTooLargeError,
   readJsonBodyWithLimit,
} from './request-body.js';

export const MCP_MCP_MODERN_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSION = '2025-11-25';
const LEGACY_PROTOCOL_VERSIONS = new Set([
   '2025-11-25',
   '2025-06-18',
]);
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
   MCP_MODERN_PROTOCOL_VERSION,
   ...LEGACY_PROTOCOL_VERSIONS,
]);
const SERVER_NAME = 'roundwatch';
const SERVER_VERSION = '1.0.0';
const TOOL_LIST_TTL_MS = 300_000;
const MAX_SAFE_ATOMIC_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_SAFE_ATOMIC_AMOUNT_DIGITS = MAX_SAFE_ATOMIC_AMOUNT.toString().length;
const MAX_JSON_RPC_ID_BYTES = 128;
const MAX_MCP_METHOD_BYTES = 128;
const MAX_MCP_TOOL_NAME_BYTES = 128;
const MAX_MCP_WATCH_ID_BYTES = 128;

interface McpDependencies {
   store: RoundWatchStore;
   networkConfig: RoundWatchNetworkConfig;
   publicBaseUrl?: string;
   serviceReceiver: string;
   servicePriceUsd: string;
   serviceAtomicAmount: string;
   workUnitBudget: number;
   watchTtlMilliseconds: number;
   watchPath: string;
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
   jsonrpc?: unknown;
   id?: unknown;
   method?: unknown;
   params?: unknown;
}

const tools = [
   {
      name: 'roundwatch.service_info',
      title: 'RoundWatch Service Info',
      description:
         'Return the live RoundWatch network, x402 service contract, USDC asset, price, limits, and documentation links. Read-only and free.',
      inputSchema: {
         type: 'object',
         additionalProperties: false,
         properties: {},
      },
      annotations: {
         readOnlyHint: true,
         idempotentHint: true,
         destructiveHint: false,
         openWorldHint: false,
      },
      icons: [
         {
            src: 'https://roundwatch.observer/favicon.svg',
            mimeType: 'image/svg+xml',
            sizes: ['any'],
         },
      ],
   },
   {
      name: 'roundwatch.prepare_watch',
      title: 'Prepare RoundWatch Watch',
      description:
         'Validate one expected future Algorand USDC payment and return the exact RoundWatch HTTP/x402 request to create a durable watch. This tool does not settle the x402 payment and does not create the watch by itself.',
      inputSchema: {
         type: 'object',
         additionalProperties: false,
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
                  'Stable key that identifies this watch request and prevents duplicates.',
            },
            expectedSender: {
               type: 'string',
               minLength: 58,
               maxLength: 58,
               description:
                  'Checksum-valid Algorand address expected to send the future payment.',
            },
            expectedReceiver: {
               type: 'string',
               minLength: 58,
               maxLength: 58,
               description:
                  'Checksum-valid Algorand address expected to receive the future payment.',
            },
            atomicAmount: {
               type: 'string',
               pattern: '^[1-9]\\d*$',
               description:
                  'Exact watched USDC amount in atomic units. Algorand USDC uses 6 decimals.',
            },
            invoiceNote: {
               type: 'string',
               minLength: 1,
               maxLength: 128,
               description:
                  'Optional exact UTF-8 Algorand transaction note, maximum 128 UTF-8 bytes.',
            },
         },
      },
      annotations: {
         readOnlyHint: true,
         idempotentHint: true,
         destructiveHint: false,
         openWorldHint: false,
      },
      icons: [
         {
            src: 'https://roundwatch.observer/favicon.svg',
            mimeType: 'image/svg+xml',
            sizes: ['any'],
         },
      ],
   },
   {
      name: 'roundwatch.get_watch',
      title: 'Get RoundWatch Watch',
      description:
         'Read the durable state and any verified on-chain evidence for an existing RoundWatch watch ID. Read-only and free.',
      inputSchema: {
         type: 'object',
         additionalProperties: false,
         required: ['watchId'],
         properties: {
            watchId: {
               type: 'string',
               minLength: 1,
               description: 'Durable watch ID returned after successful activation.',
            },
         },
      },
      annotations: {
         readOnlyHint: true,
         idempotentHint: true,
         destructiveHint: false,
         openWorldHint: false,
      },
      icons: [
         {
            src: 'https://roundwatch.observer/favicon.svg',
            mimeType: 'image/svg+xml',
            sizes: ['any'],
         },
      ],
   },
] as const;

export async function handleMcpHttpRequest(
   request: Request,
   dependencies: McpDependencies,
): Promise<Response> {
   if (request.method !== 'POST') {
      return new Response('Method not allowed', {
         status: 405,
         headers: {
            allow: 'POST, OPTIONS',
            'content-type': 'text/plain; charset=utf-8',
         },
      });
   }

   let message: JsonRpcRequest;

   try {
      const parsed = await readJsonBodyWithLimit(
         request,
         MAX_MCP_REQUEST_BODY_BYTES,
      );
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
         return jsonRpcHttpError(null, -32600, 'Invalid Request', 400);
      }
      message = parsed as JsonRpcRequest;
   } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
         return jsonRpcHttpError(
            null,
            -32021,
            'MCP request body is too large',
            413,
         );
      }
      return jsonRpcHttpError(null, -32700, 'Parse error', 400);
   }

   if (
      message.jsonrpc !== '2.0' ||
      typeof message.method !== 'string' ||
      message.method.length === 0 ||
      utf8Bytes(message.method) > MAX_MCP_METHOD_BYTES
   ) {
      return jsonRpcHttpError(null, -32600, 'Invalid Request', 400);
   }

   const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
   if (hasId && !isValidRequestId(message.id)) {
      return jsonRpcHttpError(null, -32600, 'Invalid Request', 400);
   }

   const notification = !hasId;
   const id = notification ? null : (message.id as string | number);
   const method = message.method;
   const protocol = validateProtocolSignals(request, message);

   if (protocol.error) {
      return notification
         ? notificationHttpError(400)
         : jsonRpcHttpError(
              id,
              protocol.error.code,
              protocol.error.message,
              400,
              protocol.error.data,
           );
   }

   const modern = protocol.modern;

   if (modern) {
      const headerError = validateModernHeaders(request, message);
      if (headerError) {
         return notification
            ? notificationHttpError(400)
            : jsonRpcHttpError(id, -32020, headerError, 400);
      }
   }

   if (notification) {
      // JSON-RPC notifications never receive a JSON-RPC result/error body.
      // Validate protocol/routing first, then acknowledge receipt only.
      if (method === 'initialize' || method === 'server/discover') {
         return notificationHttpError(400);
      }
      return new Response(null, {
         status: 202,
         headers: { 'cache-control': 'no-store' },
      });
   }

   if (method === 'server/discover') {
      return jsonRpcSuccess(
         id,
         modernResult(
            {
               supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
               capabilities: { tools: {} },
               instructions:
                  'RoundWatch monitors one exact future Algorand USDC payment when no transaction ID exists yet. Use service_info to inspect the contract, prepare_watch to validate and prepare the paid HTTP request, and get_watch to retrieve durable status. prepare_watch never performs the x402 payment itself.',
               ttlMs: TOOL_LIST_TTL_MS,
               cacheScope: 'public',
            },
            true,
         ),
      );
   }

   if (method === 'initialize') {
      const params = asObject(message.params);
      const requested =
         params && typeof params.protocolVersion === 'string'
            ? params.protocolVersion
            : undefined;

      if (!requested || !LEGACY_PROTOCOL_VERSIONS.has(requested)) {
         return jsonRpcHttpError(
            id,
            -32602,
            `Unsupported initialize protocolVersion. Supported legacy versions: ${[...LEGACY_PROTOCOL_VERSIONS].join(', ')}`,
            400,
         );
      }

      return jsonRpcSuccess(id, {
         protocolVersion: requested,
         capabilities: { tools: {} },
         serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
         },
         instructions:
            'RoundWatch monitors one exact future Algorand USDC payment when no transaction ID exists yet.',
      });
   }

   if (method === 'ping') {
      return jsonRpcSuccess(id, modern ? modernResult({}, true) : {});
   }

   if (method === 'tools/list') {
      const result = {
         tools,
         ...(modern
            ? {
                 ttlMs: TOOL_LIST_TTL_MS,
                 cacheScope: 'public',
              }
            : {}),
      };

      return jsonRpcSuccess(
         id,
         modern ? modernResult(result, true) : result,
      );
   }

   if (method === 'tools/call') {
      const params = asObject(message.params);
      if (
         !params ||
         typeof params.name !== 'string' ||
         utf8Bytes(params.name) > MAX_MCP_TOOL_NAME_BYTES
      ) {
         return jsonRpcHttpError(id, -32602, 'Invalid tools/call params', 400);
      }

      let args: Record<string, unknown> = {};
      if (Object.prototype.hasOwnProperty.call(params, 'arguments')) {
         const parsedArguments = asObject(params.arguments);
         if (!parsedArguments) {
            return jsonRpcHttpError(
               id,
               -32602,
               'tools/call arguments must be an object',
               400,
            );
         }
         args = parsedArguments;
      }

      switch (params.name) {
         case 'roundwatch.service_info': {
            if (Object.keys(args).length > 0) {
               return jsonRpcHttpError(
                  id,
                  -32602,
                  'roundwatch.service_info does not accept arguments',
                  400,
               );
            }

            const structuredContent = serviceInfo(dependencies);
            return toolSuccess(id, structuredContent, modern);
         }

         case 'roundwatch.prepare_watch': {
            const validation = validatePrepareArguments(args);
            if ('error' in validation) {
               return toolError(id, validation.error, modern);
            }

            const structuredContent = {
               created: false,
               paymentSettled: false,
               purpose:
                  'Prepared request only. The caller must perform the x402 payment and retry the HTTP request directly.',
               request: {
                  method: 'POST',
                  url: absoluteUrl(
                     dependencies.publicBaseUrl,
                     dependencies.watchPath,
                  ),
                  headers: {
                     'Content-Type': 'application/json',
                  },
                  body: validation.value,
               },
               eligibility: buildWatchEligibilityContract(
                  dependencies.watchTtlMilliseconds,
               ),
               x402: {
                  version: 2,
                  scheme: 'exact',
                  network: dependencies.networkConfig.network,
                  asset: dependencies.networkConfig.usdcAssetId,
                  servicePriceUsd: dependencies.servicePriceUsd,
                  servicePriceAtomicAmount: dependencies.serviceAtomicAmount,
                  payTo: dependencies.serviceReceiver,
                  challengeHeader: 'PAYMENT-REQUIRED',
                  paymentHeader: 'PAYMENT-SIGNATURE',
                  settlementHeader: 'PAYMENT-RESPONSE',
               },
               nextSteps: [
                  'POST the request without PAYMENT-SIGNATURE and read the HTTP 402 PAYMENT-REQUIRED challenge.',
                  'Sign the exact advertised x402 service payment with an Algorand-capable x402 client.',
                  'Retry the same POST with PAYMENT-SIGNATURE.',
                  'Persist the returned watchId and later call roundwatch.get_watch or GET the status endpoint.',
               ],
            };

            return toolSuccess(id, structuredContent, modern);
         }

         case 'roundwatch.get_watch': {
            const argumentKeys = Object.keys(args);
            if (
               argumentKeys.length !== 1 ||
               argumentKeys[0] !== 'watchId'
            ) {
               return jsonRpcHttpError(
                  id,
                  -32602,
                  'roundwatch.get_watch accepts exactly one argument: watchId',
                  400,
               );
            }

            const watchId = args.watchId;
            if (
               typeof watchId !== 'string' ||
               watchId.length === 0 ||
               utf8Bytes(watchId) > MAX_MCP_WATCH_ID_BYTES
            ) {
               return jsonRpcHttpError(
                  id,
                  -32602,
                  `watchId must be a non-empty string no larger than ${MAX_MCP_WATCH_ID_BYTES} UTF-8 bytes`,
                  400,
               );
            }

            const watch = dependencies.store.getWatch(watchId);
            if (!watch) {
               return toolError(id, 'Watch not found', modern);
            }

            return toolSuccess(
               id,
               {
                  watch: toPublicWatch(watch),
                  statusUrl: absoluteUrl(
                     dependencies.publicBaseUrl,
                     `${dependencies.watchPath}/${encodeURIComponent(watchId)}`,
                  ),
               },
               modern,
            );
         }

         default:
            return jsonRpcHttpError(
               id,
               -32602,
               `Unknown tool: ${params.name}`,
               400,
            );
      }
   }

   return jsonRpcHttpError(id, -32601, `Method not found: ${method}`, 404);
}

function serviceInfo(dependencies: McpDependencies) {
   return {
      name: 'RoundWatch',
      description:
         'Durable monitoring for one exact future Algorand USDC payment when no transaction ID exists yet.',
      network: dependencies.networkConfig.name,
      caip2: dependencies.networkConfig.network,
      watchedAsset: {
         symbol: 'USDC',
         asaId: dependencies.networkConfig.usdcAssetId,
         decimals: 6,
      },
      createWatch: {
         method: 'POST',
         url: absoluteUrl(dependencies.publicBaseUrl, dependencies.watchPath),
         paid: true,
      },
      getWatch: {
         method: 'GET',
         urlTemplate: absoluteUrl(
            dependencies.publicBaseUrl,
            `${dependencies.watchPath}/{id}`,
         ),
         paid: false,
      },
      x402: {
         version: 2,
         scheme: 'exact',
         servicePriceUsd: dependencies.servicePriceUsd,
         servicePriceAtomicAmount: dependencies.serviceAtomicAmount,
         payTo: dependencies.serviceReceiver,
      },
      eligibility: buildWatchEligibilityContract(
         dependencies.watchTtlMilliseconds,
      ),
      workUnitBudget: dependencies.workUnitBudget,
      docs: {
         product: 'https://roundwatch.observer/',
         quickstart: 'https://roundwatch.observer/start',
         technicalGuide:
            'https://roundwatch.observer/algorand-payment-monitoring-api',
         openapi: absoluteUrl(dependencies.publicBaseUrl, '/openapi.json'),
         llms: absoluteUrl(dependencies.publicBaseUrl, '/llms.txt'),
         github: 'https://github.com/Vladyslav-webDev/RoundWatch',
      },
      limitations: [
         'RoundWatch is for future payments whose transaction ID does not exist yet.',
         'Only top-level direct Algorand USDC asset transfers are eligible matches; inner, clawback, and asset close-out transfers are excluded.',
         eligibilityBoundarySummary(
            dependencies.watchTtlMilliseconds,
         ),
         'RoundWatch is not a webhook delivery service.',
         'The MCP prepare tool does not sign or settle x402 payments.',
      ],
   };
}

function validatePrepareArguments(
   args: Record<string, unknown>,
):
   | {
        value: {
           idempotencyKey: string;
           expectedSender: string;
           expectedReceiver: string;
           atomicAmount: string;
           invoiceNote?: string;
        };
     }
   | { error: string } {
   const allowed = new Set([
      'idempotencyKey',
      'expectedSender',
      'expectedReceiver',
      'atomicAmount',
      'invoiceNote',
   ]);

   for (const key of Object.keys(args)) {
      if (!allowed.has(key)) {
         return { error: `Unknown argument: ${key}` };
      }
   }

   const idempotencyKey = args.idempotencyKey;
   const expectedSender = args.expectedSender;
   const expectedReceiver = args.expectedReceiver;
   const atomicAmount = args.atomicAmount;
   const invoiceNote = args.invoiceNote;

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

   if (
      typeof atomicAmount !== 'string' ||
      atomicAmount.length > MAX_SAFE_ATOMIC_AMOUNT_DIGITS ||
      !/^[1-9]\d*$/.test(atomicAmount)
   ) {
      return { error: 'atomicAmount must be a positive safe-integer string' };
   }

   if (BigInt(atomicAmount) > MAX_SAFE_ATOMIC_AMOUNT) {
      return {
         error: `atomicAmount must not exceed ${MAX_SAFE_ATOMIC_AMOUNT}`,
      };
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
      value: {
         idempotencyKey,
         expectedSender,
         expectedReceiver,
         atomicAmount,
         ...(typeof invoiceNote === 'string' ? { invoiceNote } : {}),
      },
   };
}

interface ProtocolValidationError {
   code: number;
   message: string;
   data?: Record<string, unknown>;
}

interface ProtocolValidationResult {
   modern: boolean;
   error?: ProtocolValidationError;
}

function validateProtocolSignals(
   request: Request,
   message: JsonRpcRequest,
): ProtocolValidationResult {
   const header = request.headers.get('mcp-protocol-version');
   const params =
      message.params === undefined ? undefined : asObject(message.params);

   if (message.params !== undefined && !params) {
      return protocolInvalidParams('MCP request params must be an object');
   }

   const hasMeta =
      params !== undefined &&
      Object.prototype.hasOwnProperty.call(params, '_meta');
   const meta = hasMeta ? asObject(params?._meta) : undefined;
   if (hasMeta && !meta) {
      return protocolInvalidParams('params._meta must be an object');
   }

   const protocolMetaKey =
      'io.modelcontextprotocol/protocolVersion';
   const hasMetaVersion =
      meta !== undefined &&
      Object.prototype.hasOwnProperty.call(meta, protocolMetaKey);
   const metaValue = hasMetaVersion
      ? meta?.[protocolMetaKey]
      : undefined;

   if (
      header !== null &&
      (header.length === 0 || !SUPPORTED_PROTOCOL_VERSIONS.has(header))
   ) {
      return unsupportedProtocolVersion(header);
   }

   if (hasMetaVersion) {
      if (
         typeof metaValue !== 'string' ||
         metaValue.length === 0
      ) {
         return protocolInvalidParams(
            'params._meta.io.modelcontextprotocol/protocolVersion must be a non-empty string',
         );
      }
      if (!SUPPORTED_PROTOCOL_VERSIONS.has(metaValue)) {
         return unsupportedProtocolVersion(metaValue);
      }
   }

   if (
      header !== null &&
      typeof metaValue === 'string' &&
      header !== metaValue
   ) {
      return protocolHeaderMismatch(
         'MCP protocol-version signals disagree',
      );
   }

   if (message.method === 'initialize') {
      if (!params) {
         return protocolInvalidParams(
            'initialize params must be an object',
         );
      }

      const requested = params.protocolVersion;
      if (
         typeof requested !== 'string' ||
         requested.length === 0
      ) {
         return protocolInvalidParams(
            'initialize protocolVersion must be a non-empty string',
         );
      }

      if (
         header !== null &&
         header !== requested
      ) {
         return protocolHeaderMismatch(
            'MCP-Protocol-Version must match initialize params.protocolVersion',
         );
      }
      if (
         typeof metaValue === 'string' &&
         metaValue !== requested
      ) {
         return protocolHeaderMismatch(
            'params._meta protocolVersion must match initialize params.protocolVersion',
         );
      }

      // The 2026-07-28 era has no initialize handshake.
      if (requested === MCP_MODERN_PROTOCOL_VERSION) {
         return protocolInvalidParams(
            'initialize is only valid for supported legacy protocol versions',
         );
      }

      if (!LEGACY_PROTOCOL_VERSIONS.has(requested)) {
         return {
            modern: false,
            error: {
               code: -32602,
               message:
                  `Unsupported initialize protocolVersion. Supported legacy versions: ${[...LEGACY_PROTOCOL_VERSIONS].join(', ')}`,
            },
         };
      }

      return { modern: false };
   }

   const modern =
      message.method === 'server/discover' ||
      header === MCP_MODERN_PROTOCOL_VERSION ||
      metaValue === MCP_MODERN_PROTOCOL_VERSION;

   if (
      modern &&
      ((header !== null && header !== MCP_MODERN_PROTOCOL_VERSION) ||
         (typeof metaValue === 'string' &&
            metaValue !== MCP_MODERN_PROTOCOL_VERSION))
   ) {
      return protocolHeaderMismatch(
         'Modern MCP requests must use one consistent modern protocol version',
      );
   }

   return { modern };
}

function unsupportedProtocolVersion(
   requested: string,
): ProtocolValidationResult {
   return {
      modern: false,
      error: {
         code: -32022,
         message: 'Unsupported protocol version',
         data: {
            supported: [...SUPPORTED_PROTOCOL_VERSIONS],
            requested,
         },
      },
   };
}

function protocolHeaderMismatch(
   message: string,
): ProtocolValidationResult {
   return {
      modern: false,
      error: {
         code: -32020,
         message,
      },
   };
}

function protocolInvalidParams(
   message: string,
): ProtocolValidationResult {
   return {
      modern: false,
      error: {
         code: -32602,
         message,
      },
   };
}

function validateModernHeaders(
   request: Request,
   message: JsonRpcRequest,
): string | undefined {
   const protocolVersion = request.headers.get('mcp-protocol-version');
   if (protocolVersion !== MCP_MODERN_PROTOCOL_VERSION) {
      return `MCP-Protocol-Version must be ${MCP_MODERN_PROTOCOL_VERSION}`;
   }

   const method = request.headers.get('mcp-method');
   if (method !== message.method) {
      return 'Mcp-Method header must match the JSON-RPC method';
   }

   const params = asObject(message.params);
   const meta = asObject(params?._meta);
   if (!params || !meta) {
      return 'Modern MCP requests require object params._meta';
   }
   if (
      meta['io.modelcontextprotocol/protocolVersion'] !==
      MCP_MODERN_PROTOCOL_VERSION
   ) {
      return `params._meta.io.modelcontextprotocol/protocolVersion must be ${MCP_MODERN_PROTOCOL_VERSION}`;
   }
   if (
      Object.prototype.hasOwnProperty.call(
         meta,
         'io.modelcontextprotocol/clientCapabilities',
      ) &&
      !asObject(meta['io.modelcontextprotocol/clientCapabilities'])
   ) {
      return 'params._meta.io.modelcontextprotocol/clientCapabilities must be an object';
   }

   if (message.method === 'tools/call') {
      const expectedName =
         params && typeof params.name === 'string' ? params.name : undefined;
      if (!expectedName || request.headers.get('mcp-name') !== expectedName) {
         return 'Mcp-Name header must match tools/call params.name';
      }
   }

   return undefined;
}

function modernResult(
   result: Record<string, unknown>,
   includeServerInfo: boolean,
): Record<string, unknown> {
   return {
      resultType: 'complete',
      ...result,
      ...(includeServerInfo
         ? {
              _meta: {
                 'io.modelcontextprotocol/serverInfo': {
                    name: SERVER_NAME,
                    version: SERVER_VERSION,
                 },
              },
           }
         : {}),
   };
}

function toolSuccess(
   id: JsonRpcId,
   structuredContent: Record<string, unknown>,
   modern: boolean,
): Response {
   const result = {
      content: [
         {
            type: 'text',
            text: JSON.stringify(structuredContent, null, 2),
         },
      ],
      structuredContent,
      isError: false,
   };

   return jsonRpcSuccess(id, modern ? modernResult(result, true) : result);
}

function toolError(
   id: JsonRpcId,
   message: string,
   modern: boolean,
): Response {
   const result = {
      content: [{ type: 'text', text: message }],
      isError: true,
   };

   return jsonRpcSuccess(id, modern ? modernResult(result, true) : result);
}

function jsonRpcSuccess(id: JsonRpcId, result: unknown): Response {
   return new Response(
      JSON.stringify({
         jsonrpc: '2.0',
         id,
         result,
      }),
      {
         status: 200,
         headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
         },
      },
   );
}

function jsonRpcHttpError(
   id: JsonRpcId,
   code: number,
   message: string,
   status: number,
   data?: Record<string, unknown>,
): Response {
   return new Response(
      JSON.stringify({
         jsonrpc: '2.0',
         id,
         error: {
            code,
            message,
            ...(data === undefined ? {} : { data }),
         },
      }),
      {
         status,
         headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
         },
      },
   );
}

function utf8Bytes(value: string): number {
   return Buffer.byteLength(value, 'utf8');
}

function notificationHttpError(status: number): Response {
   return new Response(null, {
      status,
      headers: { 'cache-control': 'no-store' },
   });
}

function isValidRequestId(value: unknown): value is string | number {
   if (typeof value === 'string') {
      return (
         value.length > 0 &&
         utf8Bytes(value) <= MAX_JSON_RPC_ID_BYTES
      );
   }

   return typeof value === 'number' && Number.isSafeInteger(value);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
   return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
}

function absoluteUrl(
   publicBaseUrl: string | undefined,
   path: string,
): string {
   return publicBaseUrl ? `${publicBaseUrl}${path}` : path;
}

function toPublicWatch(watch: WatchRecord): Record<string, unknown> {
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
