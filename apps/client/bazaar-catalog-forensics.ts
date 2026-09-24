import { pathToFileURL } from 'node:url';

import {
   DEFAULT_DISCOVERY_FACILITATOR_URL,
   DEFAULT_ROUNDWATCH_RESOURCE_URL,
   asRecord,
   discoveryItems,
   discoveryResourceUrl,
   discoveryTotal,
} from './discovery-qualification.js';
import {
   CHALLENGE_TAG,
   EXPECTED_RECEIVER,
   SERVICE_ATOMIC_AMOUNT,
} from './mainnet-safety.js';

const PAGE_LIMIT = 100;
const RESOURCE_CAP = 10_000;
const PAGE_CAP = Math.ceil(RESOURCE_CAP / PAGE_LIMIT);
const REQUEST_TIMEOUT_MS = 15_000;
const ROUNDWATCH_HOST = 'roundwatch-api.onrender.com';
const ROUNDWATCH_TEXT = 'roundwatch';

type JsonRecord = Record<string, unknown>;

export interface CatalogCandidate {
   position: number;
   resourceUrl?: string;
   signals: string[];
   serviceNames: string[];
   payTos: string[];
   amounts: string[];
   challengeTags: string[];
}

interface PagedResult {
   status: number;
   pagesRead: number;
   items: unknown[];
   complete: boolean;
   total?: number;
}

interface MerchantResult extends PagedResult {
   supported: boolean;
}

function collectKeyValues(
   value: unknown,
   targetKey: string,
   output: unknown[],
   depth = 0,
): void {
   if (depth > 12) return;

   if (Array.isArray(value)) {
      for (const item of value) {
         collectKeyValues(item, targetKey, output, depth + 1);
      }
      return;
   }

   const record = asRecord(value);
   if (!record) return;

   for (const [key, nested] of Object.entries(record)) {
      if (key === targetKey) output.push(nested);
      collectKeyValues(nested, targetKey, output, depth + 1);
   }
}

function stringsForKey(value: unknown, key: string): string[] {
   const values: unknown[] = [];
   collectKeyValues(value, key, values);

   const strings = new Set<string>();
   for (const item of values) {
      if (typeof item === 'string') {
         strings.add(item);
      } else if (typeof item === 'number' && Number.isFinite(item)) {
         strings.add(String(item));
      } else if (Array.isArray(item)) {
         for (const nested of item) {
            if (typeof nested === 'string') strings.add(nested);
         }
      }
   }

   return [...strings];
}

function jsonContains(value: unknown, needle: string): boolean {
   try {
      return JSON.stringify(value).toLowerCase().includes(needle.toLowerCase());
   } catch {
      return false;
   }
}

export function summarizeCatalogCandidate(
   item: unknown,
   position: number,
): CatalogCandidate | undefined {
   const resourceUrl = discoveryResourceUrl(item);
   const serviceNames = stringsForKey(item, 'serviceName');
   const payTos = stringsForKey(item, 'payTo');
   const amounts = stringsForKey(item, 'amount');
   const challengeTags = stringsForKey(item, 'tag');

   const signals: string[] = [];

   if (resourceUrl === DEFAULT_ROUNDWATCH_RESOURCE_URL) {
      signals.push('exact_resource_url');
   }

   if (
      resourceUrl &&
      (() => {
         try {
            return new URL(resourceUrl).host.toLowerCase() === ROUNDWATCH_HOST;
         } catch {
            return false;
         }
      })()
   ) {
      signals.push('roundwatch_host');
   }

   if (serviceNames.some(name => name.toLowerCase() === 'roundwatch')) {
      signals.push('service_name');
   }

   if (payTos.includes(EXPECTED_RECEIVER)) {
      signals.push('service_receiver');
   }

   if (challengeTags.includes(CHALLENGE_TAG)) {
      signals.push('challenge_tag');
   }

   if (jsonContains(item, ROUNDWATCH_TEXT)) {
      signals.push('roundwatch_text');
   }

   if (signals.length === 0) return undefined;

   return {
      position,
      ...(resourceUrl ? { resourceUrl } : {}),
      signals,
      serviceNames,
      payTos,
      amounts,
      challengeTags,
   };
}

function merchantItems(payload: unknown): unknown[] {
   const root = asRecord(payload);
   if (!root) return [];

   if (Array.isArray(root.items)) return root.items;
   if (Array.isArray(root.merchants)) return root.merchants;

   const data = asRecord(root.data);
   if (data) {
      if (Array.isArray(data.items)) return data.items;
      if (Array.isArray(data.merchants)) return data.merchants;
   }

   return [];
}

async function fetchWithTimeout(url: string): Promise<Response> {
   const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

   try {
      return await fetch(url, {
         headers: { accept: 'application/json' },
         signal: controller.signal,
      });
   } finally {
      clearTimeout(timer);
   }
}

async function readJson(response: Response): Promise<unknown> {
   const text = await response.text();
   if (!text) return undefined;
   return JSON.parse(text) as unknown;
}

async function readPagedResources(
   facilitatorUrl: string,
   options: { payTo?: string } = {},
): Promise<PagedResult> {
   const items: unknown[] = [];
   let status = 0;
   let pagesRead = 0;
   let lastTotal: number | undefined;
   let complete = false;

   for (let page = 0; page < PAGE_CAP; page += 1) {
      const url = new URL('/discovery/resources', facilitatorUrl);
      url.searchParams.set('type', 'http');
      url.searchParams.set('extensions', 'bazaar');
      url.searchParams.set('limit', String(PAGE_LIMIT));
      url.searchParams.set('offset', String(page * PAGE_LIMIT));
      if (options.payTo) {
         url.searchParams.set('payTo', options.payTo);
      }

      const response = await fetchWithTimeout(url.toString());
      status = response.status;
      pagesRead += 1;

      if (!response.ok) {
         throw new Error(
            `Bazaar resource request failed with HTTP ${response.status}`,
         );
      }

      const payload = await readJson(response);
      const pageItems = discoveryItems(payload);
      items.push(...pageItems);
      lastTotal = discoveryTotal(payload) ?? lastTotal;

      if (
         pageItems.length < PAGE_LIMIT ||
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

async function readMerchants(
   facilitatorUrl: string,
): Promise<MerchantResult> {
   const items: unknown[] = [];
   let status = 0;
   let pagesRead = 0;
   let lastTotal: number | undefined;
   let complete = false;

   for (let page = 0; page < PAGE_CAP; page += 1) {
      const url = new URL('/discovery/merchants', facilitatorUrl);
      url.searchParams.set('limit', String(PAGE_LIMIT));
      url.searchParams.set('offset', String(page * PAGE_LIMIT));

      const response = await fetchWithTimeout(url.toString());
      status = response.status;
      pagesRead += 1;

      if ([404, 405, 501].includes(response.status)) {
         return {
            supported: false,
            status: response.status,
            pagesRead,
            items: [],
            complete: false,
         };
      }

      if (!response.ok) {
         throw new Error(
            `Bazaar merchant request failed with HTTP ${response.status}`,
         );
      }

      const payload = await readJson(response);
      const pageItems = merchantItems(payload);
      items.push(...pageItems);
      lastTotal = discoveryTotal(payload) ?? lastTotal;

      if (
         pageItems.length < PAGE_LIMIT ||
         (lastTotal !== undefined && items.length >= lastTotal)
      ) {
         complete = true;
         break;
      }
   }

   return {
      supported: true,
      status,
      pagesRead,
      items,
      complete,
      ...(lastTotal === undefined ? {} : { total: lastTotal }),
   };
}

function signalCounts(candidates: CatalogCandidate[]): Record<string, number> {
   const counts: Record<string, number> = {};

   for (const candidate of candidates) {
      for (const signal of candidate.signals) {
         counts[signal] = (counts[signal] ?? 0) + 1;
      }
   }

   return counts;
}

function summarizeMerchant(item: unknown, position: number): {
   position: number;
   matchedReceiver: boolean;
   mentionsRoundWatch: boolean;
   addresses: string[];
} | undefined {
   const addresses = [
      ...stringsForKey(item, 'avm'),
      ...stringsForKey(item, 'address'),
      ...stringsForKey(item, 'payTo'),
   ];
   const matchedReceiver = addresses.includes(EXPECTED_RECEIVER);
   const mentionsRoundWatch = jsonContains(item, ROUNDWATCH_TEXT);

   if (!matchedReceiver && !mentionsRoundWatch) return undefined;

   return {
      position,
      matchedReceiver,
      mentionsRoundWatch,
      addresses: [...new Set(addresses)].slice(0, 20),
   };
}

export async function runBazaarCatalogForensics(options: {
   facilitatorUrl?: string;
} = {}): Promise<unknown> {
   const facilitatorUrl =
      options.facilitatorUrl ??
      process.env.ROUNDWATCH_DISCOVERY_FACILITATOR_URL?.trim() ??
      DEFAULT_DISCOVERY_FACILITATOR_URL;

   const [catalog, filteredCatalog, merchants] = await Promise.all([
      readPagedResources(facilitatorUrl),
      readPagedResources(facilitatorUrl, { payTo: EXPECTED_RECEIVER }),
      readMerchants(facilitatorUrl),
   ]);

   const candidates = catalog.items
      .map((item, index) => summarizeCatalogCandidate(item, index + 1))
      .filter((item): item is CatalogCandidate => item !== undefined);

   const filteredReceiverMatches = filteredCatalog.items.filter(item =>
      stringsForKey(item, 'payTo').includes(EXPECTED_RECEIVER),
   ).length;

   const merchantMatches = merchants.items
      .map((item, index) => summarizeMerchant(item, index + 1))
      .filter((item): item is NonNullable<typeof item> => item !== undefined);

   return {
      generatedAt: new Date().toISOString(),
      facilitatorUrl,
      expected: {
         resourceUrl: DEFAULT_ROUNDWATCH_RESOURCE_URL,
         receiver: EXPECTED_RECEIVER,
         serviceAtomicAmount: SERVICE_ATOMIC_AMOUNT,
         challengeTag: CHALLENGE_TAG,
      },
      catalog: {
         status: catalog.status,
         pagesRead: catalog.pagesRead,
         resultCount: catalog.items.length,
         complete: catalog.complete,
         ...(catalog.total === undefined ? {} : { total: catalog.total }),
      },
      payToFilter: {
         status: filteredCatalog.status,
         pagesRead: filteredCatalog.pagesRead,
         resultCount: filteredCatalog.items.length,
         complete: filteredCatalog.complete,
         ...(filteredCatalog.total === undefined
            ? {}
            : { total: filteredCatalog.total }),
         exactReceiverMatches: filteredReceiverMatches,
         narrowed:
            catalog.total !== undefined &&
            filteredCatalog.total !== undefined
               ? filteredCatalog.total < catalog.total
               : undefined,
      },
      candidateCount: candidates.length,
      signalCounts: signalCounts(candidates),
      candidates: candidates.slice(0, 50),
      merchants: {
         supported: merchants.supported,
         status: merchants.status,
         pagesRead: merchants.pagesRead,
         resultCount: merchants.items.length,
         complete: merchants.complete,
         ...(merchants.total === undefined ? {} : { total: merchants.total }),
         matches: merchantMatches.slice(0, 50),
      },
   };
}

async function main(): Promise<void> {
   const report = await runBazaarCatalogForensics();
   process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const invokedPath = process.argv[1];
if (
   invokedPath &&
   import.meta.url === pathToFileURL(invokedPath).href
) {
   void main().catch(error => {
      console.error('ROUNDWATCH BAZAAR CATALOG FORENSICS ERROR');
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
   });
}
