import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { decodePaymentRequiredHeader } from '@x402/core/http';

const DEFAULT_BASE_URL = 'https://roundwatch-api.onrender.com';
const EVIDENCE_PATH = resolve('data/black-box-qualification.json');
const MODERN_MCP_VERSION = '2026-07-28';

type JsonRecord = Record<string, unknown>;

interface QualificationCheck {
   name: string;
   ok: boolean;
   detail: string;
}

interface ChallengeSummary {
   x402Version?: unknown;
   scheme?: unknown;
   network?: unknown;
   amount?: unknown;
   asset?: unknown;
   payTo?: unknown;
   resourceUrl?: unknown;
   bazaarDeclared: boolean;
}

function asRecord(value: unknown): JsonRecord | undefined {
   return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonRecord
      : undefined;
}

function asArray(value: unknown): unknown[] {
   return Array.isArray(value) ? value : [];
}

function absoluteUrl(baseUrl: string, value: string): string {
   return new URL(value, `${baseUrl}/`).toString();
}

function mustString(value: unknown, label: string): string {
   if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${label} is missing or not a non-empty string`);
   }
   return value;
}

function check(
   checks: QualificationCheck[],
   name: string,
   condition: boolean,
   detail: string,
): void {
   checks.push({ name, ok: condition, detail });
   if (!condition) {
      throw new Error(`${name}: ${detail}`);
   }
}

function extractHref(html: string, suffix: string): string {
   const hrefs = [...html.matchAll(/href=["']([^"'#?]+)["']/gi)]
      .map(match => match[1])
      .filter((value): value is string => typeof value === 'string');

   const found = hrefs.find(href => href.endsWith(suffix));
   if (!found) {
      throw new Error(`API root does not advertise ${suffix}`);
   }
   return found;
}

function extractLlmsUrl(llms: string, label: string): string {
   const escaped = label.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
   const match = llms.match(new RegExp(`^- ${escaped}: (\\S+)$`, 'm'));
   if (!match?.[1]) {
      throw new Error(`llms.txt does not expose ${label}`);
   }
   return match[1];
}

function getOpenApiOperation(
   document: JsonRecord,
   method: 'get' | 'post',
   operationId: string,
): { path: string; operation: JsonRecord } {
   const paths = asRecord(document.paths);
   if (!paths) throw new Error('OpenAPI paths object is missing');

   for (const [path, pathItemValue] of Object.entries(paths)) {
      const pathItem = asRecord(pathItemValue);
      const operation = asRecord(pathItem?.[method]);
      if (operation?.operationId === operationId) {
         return { path, operation };
      }
   }

   throw new Error(`OpenAPI operationId ${operationId} was not found`);
}

function getCreateExample(operation: JsonRecord): JsonRecord {
   const requestBody = asRecord(operation.requestBody);
   const content = asRecord(requestBody?.content);
   const json = asRecord(content?.['application/json']);
   const example = asRecord(json?.example);
   if (!example) {
      throw new Error('OpenAPI createWatch request example is missing');
   }

   const required = [
      'idempotencyKey',
      'expectedSender',
      'expectedReceiver',
      'atomicAmount',
   ];
   for (const field of required) {
      mustString(example[field], `OpenAPI createWatch example.${field}`);
   }

   return example;
}

function syntheticRequestFromExample(example: JsonRecord): JsonRecord {
   const nonce = randomUUID();

   return {
      idempotencyKey: `black-box-${nonce}`,
      expectedSender: mustString(
         example.expectedSender,
         'OpenAPI createWatch example.expectedSender',
      ),
      expectedReceiver: mustString(
         example.expectedReceiver,
         'OpenAPI createWatch example.expectedReceiver',
      ),
      atomicAmount: mustString(
         example.atomicAmount,
         'OpenAPI createWatch example.atomicAmount',
      ),
   };
}

function summarizeChallenge(decoded: unknown): ChallengeSummary {
   const root = asRecord(decoded);
   const accepts = asArray(root?.accepts);
   const accept = asRecord(accepts[0]);
   const resource = asRecord(root?.resource);
   const extensions = asRecord(root?.extensions);

   return {
      x402Version: root?.x402Version,
      scheme: accept?.scheme,
      network: accept?.network,
      amount: accept?.amount,
      asset: accept?.asset,
      payTo: accept?.payTo,
      resourceUrl: resource?.url,
      bazaarDeclared: asRecord(extensions?.bazaar) !== undefined,
   };
}

function safeMcpStructuredContent(payload: unknown): JsonRecord {
   const root = asRecord(payload);
   const result = asRecord(root?.result);
   const structured = asRecord(result?.structuredContent);
   if (!structured) {
      throw new Error('MCP response did not include structuredContent');
   }
   return structured;
}

async function mcpCall(
   url: string,
   id: number,
   method: string,
   params: JsonRecord,
   name?: string,
): Promise<{ status: number; body: unknown }> {
   const headers: Record<string, string> = {
      'content-type': 'application/json',
      'mcp-protocol-version': MODERN_MCP_VERSION,
      'mcp-method': method,
      'user-agent': 'roundwatch-black-box-qualification/1.0',
   };
   if (name) headers['mcp-name'] = name;

   const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
         jsonrpc: '2.0',
         id,
         method,
         params: {
            ...params,
            _meta: {
               'io.modelcontextprotocol/protocolVersion': MODERN_MCP_VERSION,
               'io.modelcontextprotocol/clientCapabilities': {},
            },
         },
      }),
   });

   let body: unknown;
   try {
      body = await response.json();
   } catch {
      body = undefined;
   }

   return { status: response.status, body };
}

async function main(): Promise<void> {
   const baseUrl = (
      process.env.ROUNDWATCH_BLACK_BOX_BASE_URL ?? DEFAULT_BASE_URL
   ).replace(/\/+$/, '');

   const checks: QualificationCheck[] = [];

   // The probe starts with only the public base URL. It does not import any
   // RoundWatch server/client implementation modules and never signs a payment.
   const rootResponse = await fetch(`${baseUrl}/`, {
      headers: { 'user-agent': 'roundwatch-black-box-qualification/1.0' },
   });
   const rootHtml = await rootResponse.text();
   check(checks, 'root_http_200', rootResponse.status === 200,
      `expected 200, received ${rootResponse.status}`);
   check(checks, 'root_is_unpaid',
      rootResponse.headers.get('payment-required') === null,
      'API root unexpectedly returned PAYMENT-REQUIRED');

   const openApiUrl = absoluteUrl(
      baseUrl,
      extractHref(rootHtml, '/openapi.json'),
   );
   const llmsUrl = absoluteUrl(baseUrl, extractHref(rootHtml, '/llms.txt'));

   const [openApiResponse, llmsResponse] = await Promise.all([
      fetch(openApiUrl, {
         headers: { 'user-agent': 'roundwatch-black-box-qualification/1.0' },
      }),
      fetch(llmsUrl, {
         headers: { 'user-agent': 'roundwatch-black-box-qualification/1.0' },
      }),
   ]);

   check(checks, 'openapi_http_200', openApiResponse.status === 200,
      `expected 200, received ${openApiResponse.status}`);
   check(checks, 'llms_http_200', llmsResponse.status === 200,
      `expected 200, received ${llmsResponse.status}`);

   const openApi = await openApiResponse.json() as JsonRecord;
   const llms = await llmsResponse.text();

   check(checks, 'openapi_version',
      openApi.openapi === '3.1.0',
      `expected OpenAPI 3.1.0, received ${String(openApi.openapi)}`);

   const create = getOpenApiOperation(openApi, 'post', 'createWatch');
   const getWatch = getOpenApiOperation(openApi, 'get', 'getWatch');
   const readiness = getOpenApiOperation(openApi, 'get', 'getReadiness');
   const serverUrl = mustString(
      asRecord(asArray(openApi.servers)[0])?.url,
      'OpenAPI servers[0].url',
   );

   check(checks, 'openapi_server_matches_entrypoint',
      serverUrl.replace(/\/+$/, '') === baseUrl,
      `OpenAPI server ${serverUrl} does not match entrypoint ${baseUrl}`);

   const createUrl = absoluteUrl(baseUrl, create.path);
   const readinessUrl = absoluteUrl(baseUrl, readiness.path);
   // Preserve the OpenAPI path placeholder literally in evidence. URL
   // construction would percent-encode {id}, which could make a false 404
   // qualification pass without actually substituting a synthetic watch ID.
   const statusTemplate = `${baseUrl}${getWatch.path}`;

   const llmsOpenApi = extractLlmsUrl(llms, 'OpenAPI');
   const llmsMcp = extractLlmsUrl(llms, 'MCP Streamable HTTP');
   const llmsReadiness = extractLlmsUrl(llms, 'Readiness');

   check(checks, 'llms_openapi_matches_root',
      llmsOpenApi === openApiUrl,
      `llms.txt advertises ${llmsOpenApi}; root advertises ${openApiUrl}`);
   check(checks, 'llms_readiness_matches_openapi',
      llmsReadiness === readinessUrl,
      `llms.txt advertises ${llmsReadiness}; OpenAPI says ${readinessUrl}`);

   const readyResponse = await fetch(readinessUrl, {
      headers: { 'user-agent': 'roundwatch-black-box-qualification/1.0' },
   });
   const readyBody = await readyResponse.json() as JsonRecord;
   check(checks, 'production_ready',
      readyResponse.status === 200 && readyBody.status === 'ready',
      `readiness HTTP ${readyResponse.status}; status=${String(readyBody.status)}`);

   const example = getCreateExample(create.operation);
   const syntheticRequest = syntheticRequestFromExample(example);

   const unpaid = await fetch(createUrl, {
      method: 'POST',
      headers: {
         accept: 'application/json',
         'content-type': 'application/json',
         'user-agent': 'roundwatch-black-box-qualification/1.0',
      },
      body: JSON.stringify(syntheticRequest),
   });

   check(checks, 'unpaid_create_returns_402',
      unpaid.status === 402,
      `expected 402, received ${unpaid.status}`);

   const paymentRequiredHeader = unpaid.headers.get('payment-required');
   check(checks, 'payment_required_header_present',
      paymentRequiredHeader !== null,
      'HTTP 402 did not expose PAYMENT-REQUIRED');

   const decoded = decodePaymentRequiredHeader(paymentRequiredHeader!);
   const challenge = summarizeChallenge(decoded);
   const x402 = asRecord(create.operation['x-x402']);
   const expectedPrice = mustString(
      x402?.servicePriceAtomicAmount,
      'OpenAPI createWatch x-x402.servicePriceAtomicAmount',
   );
   const expectedNetwork = mustString(
      x402?.network,
      'OpenAPI createWatch x-x402.network',
   );
   const expectedAsset = mustString(
      x402?.asset,
      'OpenAPI createWatch x-x402.asset',
   );
   const expectedPayTo = mustString(
      x402?.payTo,
      'OpenAPI createWatch x-x402.payTo',
   );

   check(checks, 'challenge_x402_v2',
      challenge.x402Version === 2,
      `challenge x402Version=${String(challenge.x402Version)}`);
   check(checks, 'challenge_exact_scheme',
      challenge.scheme === 'exact',
      `challenge scheme=${String(challenge.scheme)}`);
   check(checks, 'challenge_terms_match_openapi',
      challenge.amount === expectedPrice &&
      challenge.network === expectedNetwork &&
      challenge.asset === expectedAsset &&
      challenge.payTo === expectedPayTo,
      'live 402 terms disagree with the public OpenAPI x-x402 contract');
   check(checks, 'challenge_resource_matches_create_url',
      challenge.resourceUrl === createUrl,
      `challenge resource=${String(challenge.resourceUrl)}; expected ${createUrl}`);
   check(checks, 'challenge_declares_bazaar',
      challenge.bazaarDeclared,
      'live 402 challenge does not declare extensions.bazaar');

   const syntheticWatchId = randomUUID();
   const randomStatusUrl = absoluteUrl(
      baseUrl,
      getWatch.path.replace('{id}', syntheticWatchId),
   );
   const statusResponse = await fetch(randomStatusUrl, {
      headers: { 'user-agent': 'roundwatch-black-box-qualification/1.0' },
   });
   check(checks, 'unknown_watch_is_free_404',
      statusResponse.status === 404 &&
      statusResponse.headers.get('payment-required') === null,
      `status lookup returned HTTP ${statusResponse.status} or payment challenge`);

   const discover = await mcpCall(
      llmsMcp,
      1,
      'server/discover',
      {},
   );
   check(checks, 'mcp_discover_200', discover.status === 200,
      `MCP server/discover returned ${discover.status}`);

   const list = await mcpCall(llmsMcp, 2, 'tools/list', {});
   check(checks, 'mcp_tools_list_200', list.status === 200,
      `MCP tools/list returned ${list.status}`);

   const listRoot = asRecord(list.body);
   const listResult = asRecord(listRoot?.result);
   const tools = asArray(listResult?.tools).map(asRecord).filter(Boolean) as JsonRecord[];
   const toolNames = tools
      .map(tool => tool.name)
      .filter((name): name is string => typeof name === 'string');
   for (const expectedTool of [
      'roundwatch.service_info',
      'roundwatch.prepare_watch',
      'roundwatch.get_watch',
   ]) {
      check(checks, `mcp_tool_${expectedTool}`,
         toolNames.includes(expectedTool),
         `MCP tools/list is missing ${expectedTool}`);
   }

   const serviceInfoCall = await mcpCall(
      llmsMcp,
      3,
      'tools/call',
      { name: 'roundwatch.service_info', arguments: {} },
      'roundwatch.service_info',
   );
   check(checks, 'mcp_service_info_200', serviceInfoCall.status === 200,
      `MCP service_info returned ${serviceInfoCall.status}`);
   const serviceInfo = safeMcpStructuredContent(serviceInfoCall.body);
   const serviceCreate = asRecord(serviceInfo.createWatch);
   const serviceX402 = asRecord(serviceInfo.x402);

   check(checks, 'mcp_service_info_matches_openapi',
      serviceCreate?.url === createUrl &&
      serviceX402?.servicePriceAtomicAmount === expectedPrice &&
      serviceX402?.payTo === expectedPayTo,
      'MCP service_info disagrees with OpenAPI/live x402 contract');

   const prepareCall = await mcpCall(
      llmsMcp,
      4,
      'tools/call',
      {
         name: 'roundwatch.prepare_watch',
         arguments: syntheticRequest,
      },
      'roundwatch.prepare_watch',
   );
   check(checks, 'mcp_prepare_watch_200', prepareCall.status === 200,
      `MCP prepare_watch returned ${prepareCall.status}`);
   const prepared = safeMcpStructuredContent(prepareCall.body);
   const preparedRequest = asRecord(prepared.request);
   const preparedX402 = asRecord(prepared.x402);

   check(checks, 'mcp_prepare_is_non_spending',
      prepared.created === false && prepared.paymentSettled === false,
      'MCP prepare_watch claimed creation or settlement');
   check(checks, 'mcp_prepare_matches_live_contract',
      preparedRequest?.method === 'POST' &&
      preparedRequest?.url === createUrl &&
      preparedX402?.servicePriceAtomicAmount === expectedPrice &&
      preparedX402?.payTo === expectedPayTo,
      'MCP prepare_watch disagrees with OpenAPI/live challenge');

   const passed = checks.filter(item => item.ok).length;
   const evidence = {
      generatedAt: new Date().toISOString(),
      qualification: 'RoundWatch free black-box',
      startKnowledge: {
         baseUrlOnly: baseUrl,
         repositoryImplementationImported: false,
      },
      safety: {
         spendAuthorized: false,
         paymentSigned: false,
         paymentSubmitted: false,
         mainnetSpendAtomicUsdc: '0',
      },
      discovered: {
         openApiUrl,
         llmsUrl,
         mcpUrl: llmsMcp,
         readinessUrl,
         createUrl,
         statusTemplate,
      },
      liveContract: {
         network: expectedNetwork,
         asset: expectedAsset,
         servicePriceAtomicAmount: expectedPrice,
         payTo: expectedPayTo,
         challenge,
      },
      mcp: {
         tools: toolNames,
         serviceInfoConsistent: true,
         prepareWatchCreated: prepared.created,
         prepareWatchPaymentSettled: prepared.paymentSettled,
      },
      checks,
      result: {
         passed,
         total: checks.length,
         verdict: passed === checks.length ? 'pass' : 'fail',
      },
   };

   mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
   writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
   });

   console.log(JSON.stringify(evidence, null, 2));
   console.log(`Evidence written to ${EVIDENCE_PATH}`);
}

void main().catch(error => {
   console.error('ROUNDWATCH FREE BLACK-BOX QUALIFICATION FAILED');
   console.error(error instanceof Error ? error.message : error);
   process.exit(1);
});
