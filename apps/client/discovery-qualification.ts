import { pathToFileURL } from 'node:url';

import {
   ALGORAND_MAINNET,
   CHALLENGE_TAG,
   DEFAULT_SERVER_URL,
   EXPECTED_RECEIVER,
   SERVICE_ATOMIC_AMOUNT,
   USDC_MAINNET_ASA_ID,
} from './mainnet-safety.js';

export const DEFAULT_DISCOVERY_FACILITATOR_URL =
   'https://facilitator.goplausible.xyz';
export const DEFAULT_ROUNDWATCH_RESOURCE_URL =
   `${DEFAULT_SERVER_URL}/v1/watch`;

export const DISCOVERY_SEARCH_QUERIES = [
   'monitor an exact future Algorand USDC payment and return on-chain evidence',
   'watch an Algorand invoice payment',
   'durable payment monitoring for autonomous agents',
   'verify whether a future USDC transfer happened on Algorand',
] as const;

const EXPECTED_SERVICE_TAGS = [
   'algorand',
   'usdc',
   'payment-monitoring',
   'ai-agents',
   'x402',
] as const;

const DISCOVERY_PAGE_LIMIT = 100;
const DISCOVERY_RESOURCE_CAP = 10_000;
const DISCOVERY_PAGE_CAP = Math.ceil(
   DISCOVERY_RESOURCE_CAP / DISCOVERY_PAGE_LIMIT,
);
const REQUEST_TIMEOUT_MS = 15_000;

type JsonRecord = Record<string, unknown>;

export interface ChallengeInspection {
   valid: boolean;
   errors: string[];
   x402Version?: number;
   resourceUrl?: string;
   serviceName?: string;
   tags: string[];
   payment?: {
      scheme?: string;
      network?: string;
      amount?: string;
      asset?: string;
      payTo?: string;
      challengeTag?: string;
   };
   bazaar?: {
      inputType?: string;
      method?: string;
      bodyType?: string;
      outputType?: string;
   };
}

export interface CatalogPaymentInspection {
   current: boolean;
   observedAmounts: string[];
   observedPayTos: string[];
   settleCount?: number;
   firstSeen?: string;
   lastSeen?: string;
}

export interface SearchObservation {
   query: string;
   supported: boolean;
   status: number;
   found: boolean;
   position?: number;
   resultCount: number;
   error?: string;
}

export interface DiscoveryQualificationReport {
   generatedAt: string;
   facilitatorUrl: string;
   resourceUrl: string;
   challenge: ChallengeInspection & { status: number };
   catalog: {
      status: number;
      pagesRead: number;
      resultCount: number;
      found: boolean;
      complete: boolean;
      total?: number;
      resourceCap: number;
      position?: number;
      currentTerms?: boolean;
      payment?: CatalogPaymentInspection;
      item?: unknown;
   };
   searches: SearchObservation[];
   searchEndpointSupported: boolean;
   searchHits: number;
   overall: 'pass' | 'partial' | 'inconclusive' | 'fail';
}

export function classifyDiscoveryQualification(input: {
   challengeValid: boolean;
   catalogFound: boolean;
   catalogComplete: boolean;
   catalogCurrent: boolean;
   searchEndpointSupported: boolean;
   searchHits: number;
}): DiscoveryQualificationReport['overall'] {
   if (!input.challengeValid) return 'fail';
   if (!input.catalogFound && !input.catalogComplete) return 'inconclusive';
   if (!input.catalogFound) return 'fail';
   if (!input.catalogCurrent) return 'fail';
   if (input.searchEndpointSupported && input.searchHits === 0) return 'fail';
   if (input.searchEndpointSupported) return 'pass';
   return 'partial';
}

export function asRecord(value: unknown): JsonRecord | undefined {
   return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonRecord
      : undefined;
}

export function discoveryItems(payload: unknown): unknown[] {
   const root = asRecord(payload);
   if (!root) return [];

   if (Array.isArray(root.resources)) return root.resources;
   if (Array.isArray(root.items)) return root.items;

   const data = asRecord(root.data);
   if (data) {
      if (Array.isArray(data.resources)) return data.resources;
      if (Array.isArray(data.items)) return data.items;
   }

   return [];
}

export function discoveryTotal(payload: unknown): number | undefined {
   const root = asRecord(payload);
   if (!root) return undefined;

   if (typeof root.total === 'number' && Number.isFinite(root.total)) {
      return root.total;
   }

   const pagination = asRecord(root.pagination);
   if (
      pagination &&
      typeof pagination.total === 'number' &&
      Number.isFinite(pagination.total)
   ) {
      return pagination.total;
   }

   return undefined;
}

export function discoveryResourceUrl(item: unknown): string | undefined {
   const record = asRecord(item);
   if (!record) return undefined;

   if (typeof record.resourceUrl === 'string') return record.resourceUrl;
   if (typeof record.resource === 'string') return record.resource;
   if (typeof record.url === 'string') return record.url;

   const resource = asRecord(record.resource);
   if (resource && typeof resource.url === 'string') return resource.url;

   const metadata = asRecord(record.metadata);
   if (metadata) {
      if (typeof metadata.resource === 'string') return metadata.resource;
      if (typeof metadata.url === 'string') return metadata.url;
      const metadataResource = asRecord(metadata.resource);
      if (
         metadataResource &&
         typeof metadataResource.url === 'string'
      ) {
         return metadataResource.url;
      }
   }

   return undefined;
}

export function findDiscoveryResource(
   items: unknown[],
   resourceUrl: string,
): { item: unknown; position: number } | undefined {
   const position = items.findIndex(
      item => discoveryResourceUrl(item) === resourceUrl,
   );

   if (position < 0) return undefined;
   return { item: items[position], position };
}


export function inspectCatalogPayment(
   item: unknown,
): CatalogPaymentInspection {
   const root = asRecord(item);
   const accepts = root && Array.isArray(root.accepts)
      ? root.accepts
           .map(asRecord)
           .filter((entry): entry is JsonRecord => entry !== undefined)
      : [];

   const observedAmounts = [
      ...new Set(
         accepts
            .map(entry => entry.amount)
            .filter((amount): amount is string => typeof amount === 'string'),
      ),
   ];
   const observedPayTos = [
      ...new Set(
         accepts
            .map(entry => entry.payTo)
            .filter((payTo): payTo is string => typeof payTo === 'string'),
      ),
   ];

   const current = accepts.some(requirement => {
      const extra = asRecord(requirement.extra);
      return (
         requirement.scheme === 'exact' &&
         requirement.network === ALGORAND_MAINNET &&
         requirement.amount === SERVICE_ATOMIC_AMOUNT &&
         String(requirement.asset ?? extra?.asset ?? '') ===
            String(USDC_MAINNET_ASA_ID) &&
         requirement.payTo === EXPECTED_RECEIVER &&
         extra?.tag === CHALLENGE_TAG
      );
   });

   return {
      current,
      observedAmounts,
      observedPayTos,
      ...(root && typeof root.settleCount === 'number'
         ? { settleCount: root.settleCount }
         : {}),
      ...(root && typeof root.firstSeen === 'string'
         ? { firstSeen: root.firstSeen }
         : {}),
      ...(root && typeof root.lastSeen === 'string'
         ? { lastSeen: root.lastSeen }
         : {}),
   };
}

export function decodePaymentRequiredHeader(header: string): unknown {
   const normalized = header
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(header.length / 4) * 4, '=');
   const decoded = Buffer.from(normalized, 'base64').toString('utf8');
   return JSON.parse(decoded) as unknown;
}

export function inspectRoundWatchChallenge(
   value: unknown,
   expectedResourceUrl = DEFAULT_ROUNDWATCH_RESOURCE_URL,
): ChallengeInspection {
   const errors: string[] = [];
   const root = asRecord(value);

   if (!root) {
      return {
         valid: false,
         errors: ['PAYMENT-REQUIRED did not decode to an object'],
         tags: [],
      };
   }

   const x402Version =
      typeof root.x402Version === 'number' ? root.x402Version : undefined;
   if (x402Version !== 2) {
      errors.push(`expected x402Version=2, received ${String(root.x402Version)}`);
   }

   const resource = asRecord(root.resource);
   const resourceUrl =
      resource && typeof resource.url === 'string' ? resource.url : undefined;
   const serviceName =
      resource && typeof resource.serviceName === 'string'
         ? resource.serviceName
         : undefined;
   const tags =
      resource && Array.isArray(resource.tags)
         ? resource.tags.filter((tag): tag is string => typeof tag === 'string')
         : [];

   if (resourceUrl !== expectedResourceUrl) {
      errors.push(
         `resource URL mismatch: expected ${expectedResourceUrl}, received ${resourceUrl ?? 'missing'}`,
      );
   }
   if (serviceName !== 'RoundWatch') {
      errors.push(
         `serviceName mismatch: expected RoundWatch, received ${serviceName ?? 'missing'}`,
      );
   }
   for (const tag of EXPECTED_SERVICE_TAGS) {
      if (!tags.includes(tag)) errors.push(`missing discovery tag: ${tag}`);
   }

   const accepts = Array.isArray(root.accepts)
      ? root.accepts.map(asRecord).filter((item): item is JsonRecord => !!item)
      : [];
   const approved = accepts.find(requirement => {
      const extra = asRecord(requirement.extra);
      return (
         requirement.scheme === 'exact' &&
         requirement.network === ALGORAND_MAINNET &&
         requirement.amount === SERVICE_ATOMIC_AMOUNT &&
         String(requirement.asset ?? extra?.asset ?? '') ===
            String(USDC_MAINNET_ASA_ID) &&
         requirement.payTo === EXPECTED_RECEIVER &&
         extra?.tag === CHALLENGE_TAG
      );
   });

   if (!approved) {
      errors.push('no approved RoundWatch MainNet payment requirement found');
   }

   const approvedExtra = approved ? asRecord(approved.extra) : undefined;

   const extensions = asRecord(root.extensions);
   const bazaar = extensions ? asRecord(extensions.bazaar) : undefined;
   const bazaarInfo = bazaar ? asRecord(bazaar.info) : undefined;
   const input = bazaarInfo ? asRecord(bazaarInfo.input) : undefined;
   const output = bazaarInfo ? asRecord(bazaarInfo.output) : undefined;

   const inputType =
      input && typeof input.type === 'string' ? input.type : undefined;
   const method =
      input && typeof input.method === 'string' ? input.method : undefined;
   const bodyType =
      input && typeof input.bodyType === 'string' ? input.bodyType : undefined;
   const outputType =
      output && typeof output.type === 'string' ? output.type : undefined;

   if (!bazaar) errors.push('missing extensions.bazaar');
   if (inputType !== 'http') errors.push('bazaar input.type must be http');
   if (method !== 'POST') errors.push('bazaar input.method must be POST');
   if (bodyType !== 'json') errors.push('bazaar input.bodyType must be json');
   if (outputType !== 'json') errors.push('bazaar output.type must be json');

   return {
      valid: errors.length === 0,
      errors,
      x402Version,
      resourceUrl,
      serviceName,
      tags,
      payment: approved
         ? {
              scheme:
                 typeof approved.scheme === 'string'
                    ? approved.scheme
                    : undefined,
              network:
                 typeof approved.network === 'string'
                    ? approved.network
                    : undefined,
              amount:
                 typeof approved.amount === 'string'
                    ? approved.amount
                    : undefined,
              asset: String(approved.asset ?? approvedExtra?.asset ?? ''),
              payTo:
                 typeof approved.payTo === 'string'
                    ? approved.payTo
                    : undefined,
              challengeTag:
                 typeof approvedExtra?.tag === 'string'
                    ? approvedExtra.tag
                    : undefined,
           }
         : undefined,
      bazaar: {
         inputType,
         method,
         bodyType,
         outputType,
      },
   };
}

async function fetchWithTimeout(
   input: string,
   init: RequestInit = {},
): Promise<Response> {
   const controller = new AbortController();
   const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

   try {
      return await fetch(input, {
         ...init,
         signal: controller.signal,
      });
   } finally {
      clearTimeout(timeout);
   }
}

async function readJsonResponse(response: Response): Promise<unknown> {
   const text = await response.text();
   if (!text) return undefined;

   try {
      return JSON.parse(text) as unknown;
   } catch {
      throw new Error(
         `Expected JSON from ${response.url || 'remote endpoint'}, received: ${text.slice(0, 200)}`,
      );
   }
}

async function readCatalog(
   facilitatorUrl: string,
   payTo: string,
): Promise<{
   status: number;
   pagesRead: number;
   items: unknown[];
   complete: boolean;
   total?: number;
}> {
   const items: unknown[] = [];
   let status = 0;
   let pagesRead = 0;
   let lastTotal: number | undefined;
   let complete = false;

   for (let page = 0; page < DISCOVERY_PAGE_CAP; page += 1) {
      const url = new URL('/discovery/resources', facilitatorUrl);
      url.searchParams.set('type', 'http');
      url.searchParams.set('extensions', 'bazaar');
      url.searchParams.set('payTo', payTo);
      url.searchParams.set('limit', String(DISCOVERY_PAGE_LIMIT));
      url.searchParams.set(
         'offset',
         String(page * DISCOVERY_PAGE_LIMIT),
      );

      const response = await fetchWithTimeout(url.toString(), {
         headers: { accept: 'application/json' },
      });
      status = response.status;
      pagesRead += 1;

      if (!response.ok) {
         throw new Error(
            `Bazaar list request failed with HTTP ${response.status}`,
         );
      }

      const payload = await readJsonResponse(response);
      const pageItems = discoveryItems(payload);
      items.push(...pageItems);

      lastTotal = discoveryTotal(payload) ?? lastTotal;
      if (
         pageItems.length < DISCOVERY_PAGE_LIMIT ||
         (lastTotal !== undefined && items.length >= lastTotal)
      ) {
         complete = true;
         break;
      }
   }

   return {
      status,
      pagesRead,
      items,
      complete,
      ...(lastTotal === undefined ? {} : { total: lastTotal }),
   };
}

async function runSearch(
   facilitatorUrl: string,
   resourceUrl: string,
   query: string,
): Promise<SearchObservation> {
   const url = new URL('/discovery/search', facilitatorUrl);
   url.searchParams.set('query', query);
   url.searchParams.set('type', 'http');
   url.searchParams.set('extensions', 'bazaar');
   url.searchParams.set('limit', '20');

   const response = await fetchWithTimeout(url.toString(), {
      headers: { accept: 'application/json' },
   });

   if ([404, 405, 501].includes(response.status)) {
      return {
         query,
         supported: false,
         status: response.status,
         found: false,
         resultCount: 0,
      };
   }

   if (!response.ok) {
      return {
         query,
         supported: true,
         status: response.status,
         found: false,
         resultCount: 0,
         error: `HTTP ${response.status}`,
      };
   }

   const payload = await readJsonResponse(response);
   const items = discoveryItems(payload);
   const match = findDiscoveryResource(items, resourceUrl);

   return {
      query,
      supported: true,
      status: response.status,
      found: match !== undefined,
      ...(match ? { position: match.position + 1 } : {}),
      resultCount: items.length,
   };
}

async function readLiveChallenge(
   resourceUrl: string,
): Promise<{ status: number; inspection: ChallengeInspection }> {
   const response = await fetchWithTimeout(resourceUrl, {
      method: 'POST',
      headers: {
         accept: 'application/json',
         'content-type': 'application/json',
      },
      body: JSON.stringify({
         idempotencyKey: 'roundwatch-discovery-probe-0001',
         expectedSender:
            'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
         expectedReceiver:
            'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI',
         atomicAmount: '1',
         invoiceNote: 'roundwatch:discovery-probe',
      }),
   });

   const header = response.headers.get('payment-required');

   if (response.status !== 402 || !header) {
      return {
         status: response.status,
         inspection: {
            valid: false,
            errors: [
               `expected unpaid HTTP 402 with PAYMENT-REQUIRED, received HTTP ${response.status}`,
            ],
            tags: [],
         },
      };
   }

   try {
      return {
         status: response.status,
         inspection: inspectRoundWatchChallenge(
            decodePaymentRequiredHeader(header),
            resourceUrl,
         ),
      };
   } catch (error) {
      return {
         status: response.status,
         inspection: {
            valid: false,
            errors: [
               error instanceof Error
                  ? `failed to decode PAYMENT-REQUIRED: ${error.message}`
                  : 'failed to decode PAYMENT-REQUIRED',
            ],
            tags: [],
         },
      };
   }
}

export async function qualifyRoundWatchDiscovery(options: {
   facilitatorUrl?: string;
   resourceUrl?: string;
} = {}): Promise<DiscoveryQualificationReport> {
   const facilitatorUrl =
      options.facilitatorUrl ??
      process.env.ROUNDWATCH_DISCOVERY_FACILITATOR_URL?.trim() ??
      DEFAULT_DISCOVERY_FACILITATOR_URL;
   const resourceUrl =
      options.resourceUrl ??
      process.env.ROUNDWATCH_DISCOVERY_RESOURCE_URL?.trim() ??
      DEFAULT_ROUNDWATCH_RESOURCE_URL;

   const challengeResult = await readLiveChallenge(resourceUrl);
   const catalogResult = await readCatalog(
      facilitatorUrl,
      EXPECTED_RECEIVER,
   );
   const catalogMatch = findDiscoveryResource(
      catalogResult.items,
      resourceUrl,
   );
   const catalogPayment = catalogMatch
      ? inspectCatalogPayment(catalogMatch.item)
      : undefined;

   const searches: SearchObservation[] = [];
   for (const query of DISCOVERY_SEARCH_QUERIES) {
      searches.push(
         await runSearch(facilitatorUrl, resourceUrl, query),
      );
   }

   const supportedSearches = searches.filter(search => search.supported);
   const searchHits = supportedSearches.filter(search => search.found).length;
   const searchEndpointSupported = supportedSearches.length > 0;

   const overall = classifyDiscoveryQualification({
      challengeValid: challengeResult.inspection.valid,
      catalogFound: catalogMatch !== undefined,
      catalogComplete: catalogResult.complete,
      catalogCurrent: catalogPayment?.current ?? false,
      searchEndpointSupported,
      searchHits,
   });

   return {
      generatedAt: new Date().toISOString(),
      facilitatorUrl,
      resourceUrl,
      challenge: {
         status: challengeResult.status,
         ...challengeResult.inspection,
      },
      catalog: {
         status: catalogResult.status,
         pagesRead: catalogResult.pagesRead,
         resultCount: catalogResult.items.length,
         found: catalogMatch !== undefined,
         complete: catalogResult.complete,
         ...(catalogResult.total === undefined
            ? {}
            : { total: catalogResult.total }),
         resourceCap: DISCOVERY_RESOURCE_CAP,
         ...(catalogMatch
            ? {
                 position: catalogMatch.position + 1,
                 currentTerms: catalogPayment?.current ?? false,
                 ...(catalogPayment ? { payment: catalogPayment } : {}),
                 item: catalogMatch.item,
              }
            : {}),
      },
      searches,
      searchEndpointSupported,
      searchHits,
      overall,
   };
}

async function main(): Promise<void> {
   const report = await qualifyRoundWatchDiscovery();
   process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

   if (
      report.overall === 'fail' ||
      report.overall === 'inconclusive'
   ) {
      process.exitCode = 1;
   }
}

const invokedPath = process.argv[1];
if (
   invokedPath &&
   import.meta.url === pathToFileURL(invokedPath).href
) {
   void main().catch(error => {
      console.error(
         error instanceof Error ? error.stack ?? error.message : error,
      );
      process.exitCode = 1;
   });
}
