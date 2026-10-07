import {
   HTTPFacilitatorClient,
   type FacilitatorClient,
   type FacilitatorConfig,
} from '@x402/core/server';
import {
   FacilitatorResponseError,
   FacilitatorTimeoutError,
   SettleError,
   VerifyError,
   type PaymentPayload,
   type PaymentRequirements,
   type SettleResponse,
   type SupportedResponse,
   type VerifyResponse,
} from '@x402/core/types';
import { ApplicationLifetime } from './roundwatch-application-lifetime.js';
import { ShutdownInterrupted } from './roundwatch-shutdown.js';

type Operation = 'verify' | 'settle' | 'supported';
type Timer = ReturnType<typeof setTimeout>;

export interface RoundWatchFacilitatorOptions extends FacilitatorConfig {
   fetch?: typeof fetch;
   now?: () => number;
   setTimer?: (callback: () => void, delayMs: number) => Timer;
   clearTimer?: (timer: Timer) => void;
   timeoutSignal?: (timeoutMs: number) => AbortSignal;
}

/**
 * @x402/core 2.25.0 has no transport hook. Implement its public FacilitatorClient
 * boundary locally so every HTTP attempt (including redirects/retries) is fenced.
 * Already-dispatched response/body work stays owned and is never aborted by stop.
 */
export class RoundWatchFacilitatorClient implements FacilitatorClient {
   readonly url: string;
   readonly timeoutMs: number;
   private readonly auth: HTTPFacilitatorClient;
   private readonly lifetime = new ApplicationLifetime();
   private stopped = false;
   private readonly transport: typeof fetch;
   private readonly now: () => number;
   private readonly setTimer: (callback: () => void, delayMs: number) => Timer;
   private readonly clearTimer: (timer: Timer) => void;
   private readonly timeoutSignal: (timeoutMs: number) => AbortSignal;
   private readonly retryWaits = new Set<() => void>();

   constructor(options: RoundWatchFacilitatorOptions = {}) {
      // Reuse only documented public configuration/auth APIs; never its transport.
      this.auth = new HTTPFacilitatorClient(options);
      this.url = this.auth.url;
      this.timeoutMs = this.auth.timeoutMs;
      this.transport = options.fetch ?? fetch;
      this.now = options.now ?? Date.now;
      this.setTimer = options.setTimer ?? setTimeout;
      this.clearTimer = options.clearTimer ?? clearTimeout;
      this.timeoutSignal = options.timeoutSignal ?? AbortSignal.timeout;
   }

   stopAdmission(): void {
      this.stopped = true;
      this.lifetime.stopAdmission();
      for (const cancel of this.retryWaits) cancel();
   }

   drain(): Promise<void> {
      this.stopAdmission();
      return this.lifetime.drain();
   }

   verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
      return this.lifetime.track(() => this.payment('verify', payload, requirements));
   }

   settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
      return this.lifetime.track(() => this.payment('settle', payload, requirements));
   }

   getSupported(): Promise<SupportedResponse> {
      return this.lifetime.track(async () => {
         const headers = await this.headers('supported');
         for (let attempt = 0; attempt < 3; attempt++) {
            const outcome = await this.attempt('supported', async signal => {
               const response = await this.fetchFollowingRedirects(`${this.url}/supported`, {
                  method: 'GET', headers, signal,
               });
               if (response.ok) return { value: await successResponse(response, 'supported') };
               const text = await response.text().catch(error => {
                  if (isAbortOrTimeout(error)) throw error;
                  return response.statusText;
               });
               return {
                  status: response.status,
                  retryAfter: response.headers.get('retry-after'),
                  error: new Error(`Facilitator getSupported failed (${response.status}): ${excerpt(text)}`),
               };
            });
            if ('value' in outcome) return outcome.value as SupportedResponse;
            if (outcome.status !== 429 || attempt === 2) throw outcome.error;
            this.assertAdmission();
            const delay = retryDelay(outcome.retryAfter, attempt, this.now);
            await this.waitToRetry(delay);
         }
         throw new Error('Facilitator getSupported failed after retries');
      });
   }

   private async headers(operation: Operation): Promise<Record<string, string>> {
      this.assertAdmission();
      const { headers } = await this.auth.createAuthHeaders(operation);
      return { 'Content-Type': 'application/json', ...headers };
   }

   private payment(operation: 'verify', payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
   private payment(operation: 'settle', payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
   private async payment(
      operation: 'verify' | 'settle',
      paymentPayload: PaymentPayload,
      paymentRequirements: PaymentRequirements,
   ): Promise<VerifyResponse | SettleResponse> {
      const headers = await this.headers(operation);
      // Match the installed client's BigInt conversion and wire shape.
      const body = JSON.stringify(
         { x402Version: paymentPayload.x402Version, paymentPayload, paymentRequirements },
         (_key, value) => typeof value === 'bigint' ? value.toString() : value,
      );
      return this.attempt(operation, async signal => {
         const response = await this.fetchFollowingRedirects(`${this.url}/${operation}`, {
            method: 'POST', headers, body, signal,
         });
         if (!response.ok) {
            const text = await response.text();
            let data: unknown;
            try { data = JSON.parse(text); } catch {
               throw new Error(`Facilitator ${operation} failed (${response.status}): ${excerpt(text)}`);
            }
            if (isRecord(data) && operation === 'verify' && 'isValid' in data) {
               throw new VerifyError(response.status, data as VerifyResponse);
            }
            if (isRecord(data) && operation === 'settle' && 'success' in data) {
               throw new SettleError(response.status, data as SettleResponse);
            }
            throw new Error(`Facilitator ${operation} failed (${response.status}): ${excerpt(JSON.stringify(data))}`);
         }
         const result = await successResponse(response, operation);
         attachExtensionResponse(result, response);
         return result as VerifyResponse | SettleResponse;
      });
   }

   private async attempt<T>(operation: Operation, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
      this.assertAdmission();
      const signal = this.timeoutSignal(this.timeoutMs);
      try {
         return await run(signal);
      } catch (error) {
         if (signal.aborted && isAbortOrTimeout(error)) {
            throw new FacilitatorTimeoutError(operation, this.timeoutMs);
         }
         throw error;
      }
   }

   private async fetchFollowingRedirects(url: string, init: RequestInit): Promise<Response> {
      for (let redirects = 0; ; redirects++) {
         // All headers, body serialization, clocks and injected signal callbacks
         // have completed before this final synchronous transport fence.
         this.assertAdmission();
         const response = await this.transport(url, { ...init, redirect: 'manual' });
         if (![301, 302, 303, 307, 308].includes(response.status)) return response;
         const location = response.headers.get('location');
         if (!location) return response;
         await response.body?.cancel();
         if (redirects >= 20) throw new TypeError('Facilitator redirect count exceeded');
         const next = new URL(location, url);
         if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password) {
            throw new TypeError('Facilitator returned an unsupported redirect URL');
         }
         const headers = new Headers(init.headers);
         if (next.origin !== new URL(url).origin) {
            for (const key of ['authorization', 'proxy-authorization', 'cookie', 'cookie2']) headers.delete(key);
         }
         if ((response.status === 303 && init.method !== 'HEAD') ||
             ((response.status === 301 || response.status === 302) && init.method === 'POST')) {
            init = { ...init, method: 'GET', body: undefined };
            for (const key of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(key);
         }
         init = { ...init, headers };
         url = next.href;
      }
   }

   private waitToRetry(delayMs: number): Promise<void> {
      this.assertAdmission();
      return new Promise((resolve, reject) => {
         let timer: Timer | undefined;
         let completed = false;
         const finish = (interrupted: boolean) => {
            if (completed) return;
            completed = true;
            if (timer !== undefined) this.clearTimer(timer);
            this.retryWaits.delete(cancel);
            if (interrupted) reject(new ShutdownInterrupted());
            else resolve();
         };
         const cancel = () => finish(true);
         this.retryWaits.add(cancel);
         timer = this.setTimer(() => finish(false), delayMs);
         // Timer injection can synchronously reenter stopAdmission.
         if (completed) this.clearTimer(timer);
         else if (this.stopped) cancel();
      });
   }

   private assertAdmission(): void {
      if (this.stopped) throw new ShutdownInterrupted();
   }
}

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Zod's record merge omits this key without traversing its unknown values.
function schemaRecord(value: Record<string, unknown>): Record<string, unknown> {
   return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '__proto__'));
}

/** Match the success validation/normalization in the installed HTTP client. */
async function successResponse(response: Response, operation: Operation): Promise<Record<string, unknown>> {
   const text = await response.text();
   let value: unknown;
   try { value = JSON.parse(text); } catch {
      throw new FacilitatorResponseError(`Facilitator ${operation} returned invalid JSON: ${excerpt(text)}`);
   }
   const invalid = () => new FacilitatorResponseError(`Facilitator ${operation} returned invalid data: ${excerpt(text)}`);
   if (!isRecord(value)) throw invalid();
   const result: Record<string, unknown> = {};
   const optional = (key: string, kind: 'string' | 'record') => {
      const field = (value as Record<string, unknown>)[key];
      if (field != null && (kind === 'string' ? typeof field !== 'string' : !isRecord(field))) throw invalid();
      result[key] = field == null ? undefined : kind === 'record' ? schemaRecord(field as Record<string, unknown>) : field;
   };
   if (operation === 'supported') {
      if (!Array.isArray(value.kinds)) throw invalid();
      result.kinds = value.kinds.map(kind => {
         if (!isRecord(kind) || typeof kind.x402Version !== 'number' || typeof kind.scheme !== 'string' ||
             typeof kind.network !== 'string' || (kind.extra != null && !isRecord(kind.extra))) throw invalid();
         return {
            x402Version: kind.x402Version, scheme: kind.scheme, network: kind.network,
            extra: kind.extra == null ? undefined : schemaRecord(kind.extra as Record<string, unknown>),
         };
      });
      const extensions = value.extensions === undefined ? [] : value.extensions;
      const signers = value.signers === undefined ? {} : value.signers;
      if (!Array.isArray(extensions) || !extensions.every(item => typeof item === 'string') ||
          !isRecord(signers) || !Object.values(signers).every(items => Array.isArray(items) && items.every(item => typeof item === 'string'))) throw invalid();
      result.extensions = extensions;
      result.signers = schemaRecord(signers);
   } else {
      const flag = operation === 'verify' ? 'isValid' : 'success';
      if (typeof value[flag] !== 'boolean') throw invalid();
      result[flag] = value[flag];
      for (const key of operation === 'verify' ? ['invalidReason', 'invalidMessage', 'payer'] : ['errorReason', 'errorMessage', 'payer', 'amount']) optional(key, 'string');
      for (const key of ['extensions', 'extra']) optional(key, 'record');
      if (operation === 'settle') {
         for (const key of ['transaction', 'network']) {
            if (typeof value[key] !== 'string') throw invalid();
            result[key] = value[key];
         }
      }
   }
   return result;
}

function attachExtensionResponse(result: Record<string, unknown>, response: Response): void {
   const header = response.headers.get('EXTENSION-RESPONSES');
   if (!header) return;
   try {
      const bytes = Uint8Array.from(atob(header), character => character.charCodeAt(0));
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!isRecord(value)) return;
      result.extensionResponses = value;
      // Preserve the installed client's allowlisted sidechannel diagnostic.
      const sanitized: Record<string, unknown> = {};
      for (const [extension, response] of Object.entries(value)) {
         const fields: Record<string, unknown> = {};
         if (isRecord(response)) {
            for (const key of ['status', 'rejectedReason', 'reason', 'code']) {
               if (response[key] !== undefined) fields[key] = response[key];
            }
         }
         sanitized[extension] = fields;
      }
      console.log(`[x402] extension responses: ${JSON.stringify(sanitized)}`);
   } catch { /* Optional facilitator sidechannel; same tolerance as installed client. */ }
}

function isAbortOrTimeout(error: unknown): boolean {
   let current = error;
   for (let depth = 0; depth < 10 && isRecord(current); depth++) {
      if (current.name === 'AbortError' || current.name === 'TimeoutError') return true;
      current = current.cause;
   }
   return false;
}

function excerpt(text: string): string {
   const compact = text.trim().replace(/\s+/g, ' ');
   return compact ? compact.length <= 200 ? compact : `${compact.slice(0, 197)}...` : '<empty response>';
}

function retryDelay(retryAfter: string | null, attempt: number, now: () => number): number {
   let delay: number | undefined;
   if (retryAfter !== null) {
      const trimmed = retryAfter.trim();
      if (/^\d+$/.test(trimmed)) delay = Number(trimmed) * 1_000;
      else {
         const date = Date.parse(retryAfter);
         if (!Number.isNaN(date)) delay = date - now();
      }
   }
   if (delay === undefined || delay <= 0) delay = 1_000 * 2 ** attempt;
   return Math.min(delay, 30_000);
}
