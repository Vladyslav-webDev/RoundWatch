import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import type { MiddlewareHandler } from 'hono';

export type RequestClassification =
   | 'health'
   | 'readiness'
   | 'watch_create_challenge'
   | 'watch_create_malformed'
   | 'watch_create_payment_rejected'
   | 'watch_create_rate_limited'
   | 'watch_create_unavailable'
   | 'watch_create_success'
   | 'watch_create_failed'
   | 'watch_status_found'
   | 'watch_status_not_found'
   | 'watch_recovery'
   | 'mcp'
   | 'discovery'
   | 'other';

export type PaymentTelemetryOutcome =
   | 'not_present'
   | 'challenge'
   | 'rejected'
   | 'settled';

export interface RequestTelemetryEvent {
   event: 'roundwatch_http_request';
   timestamp: string;
   requestId: string;
   method: string;
   route: string;
   statusCode: number;
   durationMs: number;
   classification: RequestClassification;
   uaClass: string;
   host: string;
   paymentPresented: boolean;
   paymentOutcome: PaymentTelemetryOutcome;
   clientFingerprint?: string;
   watchFingerprint?: string;
}

export interface RequestTelemetryOptions {
   hmacKey?: string | Buffer;
   log?: (line: string) => void;
   now?: () => Date;
   monotonicNow?: () => number;
   requestId?: () => string;
}

interface TelemetryContext {
   method: string;
   path: string;
   statusCode: number;
   durationMs: number;
   watchPath: string;
   paymentPresented: boolean;
   userAgent?: string;
   host?: string;
   clientAddress?: string;
   requestId: string;
   timestamp: string;
}

export function createRequestTelemetryMiddleware(
   watchPath: string,
   options: RequestTelemetryOptions = {},
): MiddlewareHandler {
   const hmacKey = options.hmacKey ?? randomBytes(32);
   const log = options.log ?? (line => console.info(line));
   const now = options.now ?? (() => new Date());
   const monotonicNow = options.monotonicNow ?? (() => performance.now());
   const nextRequestId = options.requestId ?? randomUUID;

   return async (c, next) => {
      const startedAt = monotonicNow();
      const requestId = nextRequestId();
      let failed = false;

      try {
         await next();
      } catch (error) {
         failed = true;
         throw error;
      } finally {
         const statusCode = failed ? 500 : c.res.status;
         const event = buildRequestTelemetryEvent(
            {
               method: c.req.method,
               path: c.req.path,
               statusCode,
               durationMs: Math.max(0, monotonicNow() - startedAt),
               watchPath,
               paymentPresented:
                  c.req.header('payment-signature') !== undefined,
               userAgent: c.req.header('user-agent'),
               host: safeHost(c.req.url, c.req.header('host')),
               clientAddress: requestClientAddress(
                  c.req.header('cf-connecting-ip'),
                  c.req.header('x-real-ip'),
                  c.req.header('x-forwarded-for'),
               ),
               requestId,
               timestamp: now().toISOString(),
            },
            hmacKey,
         );

         if (event) {
            log(JSON.stringify(event));
         }
      }
   };
}

export function buildRequestTelemetryEvent(
   context: TelemetryContext,
   hmacKey: string | Buffer,
): RequestTelemetryEvent | undefined {
   const route = normalizedRoute(context.path, context.watchPath);
   const classification = classifyRequest(
      context.method,
      route,
      context.statusCode,
      context.paymentPresented,
      context.watchPath,
   );

   if (
      (classification === 'health' || classification === 'readiness') &&
      context.statusCode < 400
   ) {
      return undefined;
   }

   const event: RequestTelemetryEvent = {
      event: 'roundwatch_http_request',
      timestamp: context.timestamp,
      requestId: context.requestId,
      method: context.method.toUpperCase(),
      route,
      statusCode: context.statusCode,
      durationMs: Number(context.durationMs.toFixed(2)),
      classification,
      uaClass: classifyUserAgent(context.userAgent),
      host: sanitizeHost(context.host),
      paymentPresented: context.paymentPresented,
      paymentOutcome: paymentOutcome(
         classification,
         context.paymentPresented,
      ),
   };

   if (context.clientAddress) {
      event.clientFingerprint = fingerprint(
         hmacKey,
         `client:${context.clientAddress}`,
         16,
      );
   }

   const watchId = dynamicWatchId(context.path, context.watchPath);
   if (watchId) {
      event.watchFingerprint = fingerprint(
         hmacKey,
         `watch:${watchId}`,
         12,
      );
   }

   return event;
}

export function classifyUserAgent(userAgent: string | undefined): string {
   if (!userAgent) return 'unknown';

   const ua = userAgent.toLowerCase();

   if (ua.includes('openai') || ua.includes('chatgpt')) return 'openai-agent';
   if (ua.includes('anthropic') || ua.includes('claude')) return 'anthropic-agent';
   if (ua.includes('github-actions')) return 'github-actions';
   if (ua.includes('python-httpx')) return 'python-httpx';
   if (ua.includes('python-requests')) return 'python-requests';
   if (ua.includes('node-fetch')) return 'node-fetch';
   if (ua.includes('undici')) return 'undici';
   if (ua.includes('axios')) return 'axios';
   if (ua.includes('curl')) return 'curl';
   if (ua.includes('wget')) return 'wget';
   if (ua.includes('postmanruntime')) return 'postman';
   if (ua.includes('insomnia')) return 'insomnia';
   if (ua.includes('go-http-client')) return 'go-http-client';
   if (ua.includes('bot') || ua.includes('crawler') || ua.includes('spider')) {
      return 'bot';
   }
   if (ua.includes('firefox/')) return 'browser-firefox';
   if (ua.includes('chrome/') || ua.includes('chromium/')) {
      return 'browser-chromium';
   }
   if (ua.includes('safari/')) return 'browser-safari';

   return 'other';
}

export function normalizedRoute(path: string, watchPath: string): string {
   if (path === '/') return '/';
   if (path === '/health') return '/health';
   if (path === '/ready') return '/ready';
   if (path === '/openapi.json') return '/openapi.json';
   if (path === '/llms.txt') return '/llms.txt';
   if (path === '/mcp') return '/mcp';
   if (path === '/demo') return '/demo';
   if (path === watchPath) return watchPath;
   if (path === `${watchPath}/recover`) return `${watchPath}/recover`;
   if (dynamicWatchId(path, watchPath)) return `${watchPath}/:id`;

   return '/other';
}

function classifyRequest(
   method: string,
   route: string,
   statusCode: number,
   paymentPresented: boolean,
   watchPath: string,
): RequestClassification {
   const upperMethod = method.toUpperCase();

   if (route === '/health') return 'health';
   if (route === '/ready') return 'readiness';
   if (route === '/mcp') return 'mcp';
   if (route === '/' || route === '/openapi.json' || route === '/llms.txt') {
      return 'discovery';
   }
   if (route === `${watchPath}/recover`) return 'watch_recovery';

   if (upperMethod === 'GET' && route === `${watchPath}/:id`) {
      if (statusCode === 200) return 'watch_status_found';
      if (statusCode === 404) return 'watch_status_not_found';
      return 'other';
   }

   if (upperMethod === 'POST' && route === watchPath) {
      if (statusCode === 402 && !paymentPresented) {
         return 'watch_create_challenge';
      }
      if (statusCode === 400 && !paymentPresented) {
         return 'watch_create_malformed';
      }
      if (paymentPresented && statusCode >= 400) {
         return 'watch_create_payment_rejected';
      }
      if (statusCode === 429) return 'watch_create_rate_limited';
      if (statusCode === 503) return 'watch_create_unavailable';
      if (statusCode >= 200 && statusCode < 300 && paymentPresented) {
         return 'watch_create_success';
      }
      if (statusCode >= 500) return 'watch_create_failed';
      if (statusCode >= 400) return 'watch_create_malformed';
   }

   return 'other';
}

function paymentOutcome(
   classification: RequestClassification,
   paymentPresented: boolean,
): PaymentTelemetryOutcome {
   if (classification === 'watch_create_challenge') return 'challenge';
   if (classification === 'watch_create_success') return 'settled';
   if (paymentPresented && classification === 'watch_create_payment_rejected') {
      return 'rejected';
   }
   return paymentPresented ? 'rejected' : 'not_present';
}

function dynamicWatchId(path: string, watchPath: string): string | undefined {
   if (!path.startsWith(`${watchPath}/`)) return undefined;

   const suffix = path.slice(watchPath.length + 1);
   if (!suffix || suffix === 'recover' || suffix.includes('/')) return undefined;

   return suffix;
}

function requestClientAddress(
   cfConnectingIp: string | undefined,
   realIp: string | undefined,
   forwardedFor: string | undefined,
): string | undefined {
   const candidate =
      cleanAddress(cfConnectingIp) ??
      cleanAddress(realIp) ??
      cleanAddress(forwardedFor?.split(',')[0]);

   return candidate;
}

function cleanAddress(value: string | undefined): string | undefined {
   const trimmed = value?.trim();
   if (!trimmed || trimmed.length > 128) return undefined;
   if (/[ -]/.test(trimmed)) return undefined;
   return trimmed;
}

function safeHost(url: string, headerHost: string | undefined): string {
   try {
      return new URL(url).host;
   } catch {
      return headerHost ?? 'unknown';
   }
}

function sanitizeHost(value: string | undefined): string {
   const host = (value ?? 'unknown')
      .replace(/[ -]/g, '')
      .slice(0, 255)
      .toLowerCase();

   return host || 'unknown';
}

function fingerprint(
   key: string | Buffer,
   value: string,
   hexCharacters: number,
): string {
   return createHmac('sha256', key)
      .update(value)
      .digest('hex')
      .slice(0, hexCharacters);
}
