import { createHash } from 'node:crypto';
import {
   OBSERVED_SERVICE_VERSION, PARSER_VERSION, REPORT_VERSION,
   SOURCE_ARTIFACT_VERSION,
   type LocatedValue, type ObservatoryReportV1, type ObservedServiceV1,
   type PaymentOfferV1,
} from './schema.js';

type JsonRecord = Record<string, unknown>;
const MAINNET = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
const TESTNET = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=';
const DESCRIPTION_LIMIT = 500;

function record(value: unknown): JsonRecord | null {
   return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonRecord : null;
}

function pointer(base: string, key: string | number): string {
   return `${base}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function stringAt(value: unknown, locator: string): LocatedValue | null {
   return typeof value === 'string' ? { locator, value } : null;
}

function fields(value: JsonRecord, base: string, keys: readonly string[]): LocatedValue[] {
   return keys.flatMap(key => {
      const found = stringAt(value[key], pointer(base, key));
      return found ? [found] : [];
   });
}

function unknownFields(value: JsonRecord, base: string, known: readonly string[]): string[] {
   return Object.keys(value).filter(key => !known.includes(key)).sort()
      .map(key => pointer(base, key));
}

function boundedDescription(value: unknown, locator: string, warnings: string[]): LocatedValue | null {
   if (typeof value !== 'string') return null;
   if (value.length > DESCRIPTION_LIMIT) warnings.push(`${locator}: description truncated to ${DESCRIPTION_LIMIT} characters`);
   return { locator, value: value.slice(0, DESCRIPTION_LIMIT) };
}

function offer(value: unknown, locator: string): PaymentOfferV1 {
   const entry = record(value);
   const warnings: string[] = [];
   if (!entry) warnings.push(`${locator}: offer is not an object`);
   const scheme = typeof entry?.scheme === 'string' ? entry.scheme : null;
   const rawNetwork = typeof entry?.network === 'string' ? entry.network : null;
   const extra = record(entry?.extra);
   const directAsset = typeof entry?.asset === 'string' ? entry.asset : null;
   const extraAsset = typeof extra?.asset === 'string' ? extra.asset : null;
   const asset = directAsset ?? extraAsset;
   const assetLocator = directAsset !== null ? pointer(locator, 'asset')
      : extraAsset !== null ? pointer(pointer(locator, 'extra'), 'asset') : null;
   if (directAsset !== null && extraAsset !== null && directAsset !== extraAsset) warnings.push(`${locator}: conflicting asset fields preserved in source artifact`);
   const payee = typeof entry?.payTo === 'string' ? entry.payTo : null;
   const amount = entry?.amount;
   const atomicAmount = typeof amount === 'string' && /^(0|[1-9][0-9]*)$/.test(amount)
      ? amount : null;
   if (amount !== undefined && atomicAmount === null) warnings.push(`${pointer(locator, 'amount')}: expected a non-negative integer string; numeric JSON is not accepted`);
   if (rawNetwork !== null && rawNetwork !== MAINNET && rawNetwork !== TESTNET) warnings.push(`${pointer(locator, 'network')}: unrecognized network`);
   for (const key of ['scheme', 'network', 'asset', 'payTo'] as const) {
      if (entry?.[key] !== undefined && typeof entry[key] !== 'string') warnings.push(`${pointer(locator, key)}: expected string`);
   }
   return {
      locator, scheme, rawNetwork,
      interpretedNetwork: rawNetwork === MAINNET ? 'algorand-mainnet' : rawNetwork === TESTNET ? 'algorand-testnet' : null,
      asset, assetLocator, atomicAmount, payee, warnings,
      unknownFields: entry ? [
         ...unknownFields(entry, locator, ['scheme', 'network', 'asset', 'amount', 'payTo', 'extra']),
         ...(extra ? unknownFields(extra, pointer(locator, 'extra'), ['asset']) : []),
      ] : [],
   };
}

function normalizeItem(value: unknown, locator: string, artifactId: string): ObservedServiceV1 {
   const item = record(value);
   const warnings: string[] = [];
   if (!item) warnings.push(`${locator}: discovery item is not an object`);
   const resource = record(item?.resource);
   const metadata = record(item?.metadata);
   const metadataResource = record(metadata?.resource);
   const identifiers = item ? fields(item, locator, ['resourceUrl', 'resource', 'url']) : [];
   if (resource) identifiers.push(...fields(resource, pointer(locator, 'resource'), ['url']));
   if (metadata) {
      identifiers.push(...fields(metadata, pointer(locator, 'metadata'), ['resource', 'url']));
      if (metadataResource) identifiers.push(...fields(metadataResource, pointer(pointer(locator, 'metadata'), 'resource'), ['url']));
   }
   if (new Set(identifiers.map(x => x.value)).size > 1) warnings.push(`${locator}: conflicting resource identifiers preserved separately`);

   const descriptions: LocatedValue[] = [];
   for (const [holder, base] of [[item, locator], [resource, pointer(locator, 'resource')], [metadata, pointer(locator, 'metadata')]] as const) {
      if (holder) {
         const description = boundedDescription(holder.description, pointer(base, 'description'), warnings);
         if (description) descriptions.push(description);
      }
   }
   const resourceInfo = record(item?.resourceInfo);
   if (resourceInfo) {
      const description = boundedDescription(resourceInfo.description, pointer(pointer(locator, 'resourceInfo'), 'description'), warnings);
      if (description) descriptions.push(description);
   }
   const extensions = record(item?.extensions);
   const bazaar = record(extensions?.bazaar);
   const info = record(bazaar?.info);
   const input = record(info?.input);
   const method = typeof input?.method === 'string' ? input.method : typeof item?.method === 'string' ? item.method : null;
   if (input?.method !== undefined && item?.method !== undefined && input.method !== item.method) warnings.push(`${locator}: conflicting HTTP methods preserved in source artifact`);
   const mcp = record(item?.mcp);
   const mcpTool = typeof mcp?.tool === 'string' ? mcp.tool : null;
   const accepts = item?.accepts;
   if (accepts !== undefined && !Array.isArray(accepts)) warnings.push(`${pointer(locator, 'accepts')}: expected an array`);
   const paymentOffers = Array.isArray(accepts) ? accepts.map((entry, index) => offer(entry, pointer(pointer(locator, 'accepts'), index))) : [];
   const sourceTimestamps = item ? fields(item, locator, ['firstSeen', 'lastSeen', 'createdAt', 'updatedAt', 'observedAt']) : [];
   if (sourceTimestamps.length > 1) warnings.push(`${locator}: source timestamps preserved without reconciliation`);
   return {
      schemaVersion: OBSERVED_SERVICE_VERSION, artifactId, locator,
      sourceRecordId: typeof item?.id === 'string' ? item.id : null,
      resourceIdentifiers: identifiers, httpMethod: method, mcpTool,
      descriptions, sourceTimestamps, paymentOffers, warnings,
      unknownFields: item ? unknownFields(item, locator, [
         'id', 'resourceUrl', 'resource', 'url', 'metadata', 'resourceInfo',
         'description', 'method', 'mcp', 'extensions', 'accepts', 'firstSeen',
         'lastSeen', 'createdAt', 'updatedAt', 'observedAt',
      ]) : [],
   };
}

function envelope(payload: unknown): { items: unknown[]; locator: string } | 'unsupported' | 'malformed' {
   const root = record(payload);
   if (!root) return 'unsupported';
   const candidates: { value: unknown; locator: string; present: boolean }[] = [];
   function add(holder: JsonRecord | null, base: string): void {
      if (!holder) return;
      for (const key of ['resources', 'items']) candidates.push({ value: holder[key], locator: pointer(base, key), present: key in holder });
   }
   add(root, '');
   const data = record(root.data);
   add(data, '/data');
   const result = record(root.result);
   add(result, '/result');
   add(record(result?.data), '/result/data');
   const present = candidates.filter(candidate => candidate.present);
   if (present.length === 0) return 'unsupported';
   if (present.some(candidate => !Array.isArray(candidate.value))) return 'malformed';
   // Ambiguous envelopes are rejected rather than silently choosing one catalog.
   if (present.length !== 1) return 'malformed';
   return { items: present[0].value as unknown[], locator: present[0].locator };
}

export function normalizeSnapshot(bytes: Buffer): ObservatoryReportV1 {
   const sha256 = createHash('sha256').update(bytes).digest('hex');
   const artifactId = `sha256-${sha256}`;
   let payload: unknown;
   let diagnostic: ObservatoryReportV1['diagnostic'];
   let found: { items: unknown[]; locator: string } | null = null;
   const warnings: string[] = [];
   try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      const parsed = envelope(payload);
      if (parsed === 'unsupported') diagnostic = 'unsupported_envelope';
      else if (parsed === 'malformed') diagnostic = 'malformed_payload';
      else {
         const invalidIndex = parsed.items.findIndex(item => !record(item));
         if (invalidIndex >= 0) {
            diagnostic = 'malformed_payload';
            warnings.push(`${pointer(parsed.locator, invalidIndex)}: discovery item is not an object`);
         } else {
            found = parsed;
            diagnostic = parsed.items.length === 0 ? 'valid_empty' : 'valid_non_empty';
         }
      }
   } catch {
      payload = null;
      diagnostic = 'malformed_payload';
      warnings.push('invalid JSON');
   }
   const root = record(payload);
   const source = record(root?.source);
   const captureTimestamp = typeof root?.capturedAt === 'string' ? root.capturedAt : typeof source?.capturedAt === 'string' ? source.capturedAt : null;
   const rawDescription = typeof root?.sourceDescription === 'string' ? root.sourceDescription : typeof source?.description === 'string' ? source.description : null;
   const sourceDescription = rawDescription?.slice(0, DESCRIPTION_LIMIT) ?? null;
   if (rawDescription !== null && rawDescription.length > DESCRIPTION_LIMIT) warnings.push(`source description truncated to ${DESCRIPTION_LIMIT} characters`);
   const sourceUrl = typeof root?.sourceUrl === 'string' ? root.sourceUrl : typeof source?.url === 'string' ? source.url : null;
   return {
      schemaVersion: REPORT_VERSION, parserVersion: PARSER_VERSION, diagnostic,
      sourceArtifact: { schemaVersion: SOURCE_ARTIFACT_VERSION, artifactId, sha256, captureTimestamp, sourceDescription, sourceUrl, warnings: [...warnings] },
      envelopeLocator: found?.locator ?? null,
      records: found?.items.map((item, index) => normalizeItem(item, pointer(found.locator, index), artifactId)) ?? [],
      warnings,
   };
}
