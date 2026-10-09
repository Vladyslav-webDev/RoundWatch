import { createHash, timingSafeEqual } from 'node:crypto';
import type { HttpBindings, Http2Bindings } from '@hono/node-server';
import { ownApplicationFetch, type ApplicationLifetime } from './roundwatch-application-lifetime.js';
import type { ObservatoryRuntimeV01 } from './roundwatch-observatory-types.js';
import { serializeObservatoryRuntime } from './roundwatch-observatory-serialization.js';

export const OBSERVATORY_NAMESPACE = '/internal/observatory';
export const OBSERVATORY_RUNTIME_PATH = `${OBSERVATORY_NAMESPACE}/runtime`;
const MAX_AUTHORIZATION_CHARACTERS = 1_024;
const MAX_TARGET_CHARACTERS = 8_192;
const MAX_PATH_DECODE_PASSES = 4;

export interface ObservatoryTransportOptions {
   token: string | undefined;
   runtimeSnapshot: (() => ObservatoryRuntimeV01 | Promise<ObservatoryRuntimeV01>) | undefined;
}

type ObservatoryTransport = (request: Request, path: string) => Promise<Response>;

function failure(status: number, error: string): Response {
   return new Response(JSON.stringify({ error }), {
      status,
      headers: {
         'content-type': 'application/json; charset=utf-8',
         'cache-control': 'no-store',
         ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
         ...(status === 405 ? { allow: 'GET' } : {}),
      },
   });
}

/** Capture configuration once. 64 hex characters represent a 32-byte secret. */
export function createObservatoryTransport(options: ObservatoryTransportOptions): ObservatoryTransport | undefined {
   const { token, runtimeSnapshot } = options;
   if (typeof token !== 'string' || !/^[0-9a-fA-F]{64}$/.test(token) ||
      runtimeSnapshot === undefined) return undefined;
   const expectedDigest = digest(token);

   return async (request, path) => {
      if (path !== OBSERVATORY_RUNTIME_PATH) return failure(404, 'not_found');
      if (request.method !== 'GET') return failure(405, 'method_not_allowed');
      const authorization = request.headers.get('authorization');
      // This public size cap is independent of the configured credential length.
      if (authorization !== null && authorization.length > MAX_AUTHORIZATION_CHARACTERS) {
         return failure(401, 'unauthorized');
      }
      const match = /^Bearer ([0-9a-fA-F]+)$/i.exec(authorization ?? '');
      // Always compare equal-sized digests for bounded input, including missing,
      // malformed and differently sized credentials. Never compare raw lengths.
      const matches = timingSafeEqual(expectedDigest, digest(match?.[1] ?? ''));
      if (!match || !matches) return failure(401, 'unauthorized');

      const snapshot = await runtimeSnapshot();
      return new Response(serializeObservatoryRuntime(snapshot), {
         status: 200,
         headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
   };
}

function digest(value: string): Buffer {
   return createHash('sha256').update(value, 'utf8').digest();
}

/** Reserve aliases too, but serve only the exact canonical path. */
function classifyPath(path: string): 'normal' | 'reserved' | 'rejected' {
   if (path.length > MAX_TARGET_CHARACTERS) return 'rejected';
   const reserved = (value: string) => {
      const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
      return normalized === OBSERVATORY_NAMESPACE || normalized.startsWith(`${OBSERVATORY_NAMESPACE}/`);
   };
   // Decode individual escapes so a malformed suffix cannot hide a valid prefix.
   // At most four decodes and five classification rounds per capped path. Remaining or
   // malformed escapes fail closed, even when they could conceal an ordinary route.
   for (let pass = 0; pass <= MAX_PATH_DECODE_PASSES; pass += 1) {
      if (reserved(path)) return 'reserved';
      if (!path.includes('%')) return 'normal';
      if (pass === MAX_PATH_DECODE_PASSES) return 'rejected';
      const decoded = path.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      if (decoded === path) return 'rejected';
      path = decoded;
   }
   return 'rejected';
}

/** The production composition: one listener, one lifetime owner, no Hono on internal reads. */
export function createRoundWatchHttpFetch<Arguments extends [Request, ...unknown[]]>(
   lifetime: ApplicationLifetime,
   operationalFetch: (...args: Arguments) => Response | Promise<Response>,
   options: ObservatoryTransportOptions,
   initializeTransport: (options: ObservatoryTransportOptions) => ObservatoryTransport | undefined = createObservatoryTransport,
): (...args: Arguments) => Promise<Response> {
   let transport: ObservatoryTransport | undefined;
   try {
      transport = initializeTransport(options);
   } catch {
      // Optional initialization is silent and fail-closed; keep normal startup.
   }
   return ownApplicationFetch(lifetime, (...args: Arguments) => {
      // Fetch URL construction normalizes dot segments. Preserve the adapter's
      // original target too, so /internal/observatory/../ready cannot reach Hono.
      const rawTarget = (args[1] as Partial<HttpBindings | Http2Bindings> | undefined)?.incoming?.url;
      // Check complete targets (including authority/query) before parsing, stripping
      // or splitting them. No attacker-sized normalization work precedes this cap.
      const url = args[0].url;
      if (url.length > MAX_TARGET_CHARACTERS ||
         (rawTarget !== undefined && rawTarget.length > MAX_TARGET_CHARACTERS)) return failure(404, 'not_found');
      const path = new URL(url).pathname;
      const rawPath = rawTarget === undefined ? path : rawTarget
         .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/, '')
         .split(/[?#]/, 1)[0]!;
      const rawClassification = classifyPath(rawPath);
      if (rawClassification === 'rejected') return failure(404, 'not_found');
      const classification = classifyPath(path);
      if (classification === 'rejected') return failure(404, 'not_found');
      if (rawClassification === 'normal' && classification === 'normal') return operationalFetch(...args);
      if (transport === undefined) return failure(404, 'not_found');
      // Catch synchronous dispatch and asynchronous getter/serialization failures
      // here, without involving Hono's error handler or operational logging.
      return (async () => {
         try {
            // Only the exact original target and normalized canonical path serve data.
            if (rawPath !== OBSERVATORY_RUNTIME_PATH) return failure(404, 'not_found');
            return await transport(args[0], path);
         } catch {
            return failure(500, 'observatory_unavailable');
         }
      })();
   });
}
