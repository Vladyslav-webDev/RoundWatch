import { performance } from 'node:perf_hooks';

export type IndexerRequestPurpose =
   | 'activation'
   | 'reconciliation'
   | 'absence-proof'
   | 'scan-page'
   | 'checkpoint'
   | 'health';

export interface IndexerDispatcherOptions {
   requestsPerSecond?: number;
   burst?: number;
   concurrency?: number;
   now?: () => number;
}

export interface IndexerDispatcherSnapshot {
   queued: number;
   inFlight: number;
   requests: Record<string, number>;
   successes: number;
   failures: number;
   timeouts: number;
}

interface PendingRequest<T> {
   purpose: IndexerRequestPurpose;
   operation: () => Promise<T>;
   resolve: (value: T | PromiseLike<T>) => void;
   reject: (reason?: unknown) => void;
}

export const DEFAULT_INDEXER_REQUESTS_PER_SECOND = 4;
export const DEFAULT_INDEXER_BURST = 4;
export const DEFAULT_INDEXER_CONCURRENCY = 2;

/**
 * Process-local token bucket and FIFO concurrency gate shared by every Indexer
 * operation. Tokens are capped at `burst`, so delayed timers and restarts can
 * never create an unbounded catch-up burst.
 */
export class IndexerRequestDispatcher {
   private readonly requestsPerSecond: number;
   private readonly burst: number;
   private readonly concurrency: number;
   private readonly now: () => number;
   private readonly queue: Array<PendingRequest<unknown>> = [];
   private tokens: number;
   private lastRefill: number;
   private inFlight = 0;
   private timer: NodeJS.Timeout | undefined;
   private readonly requestCounts = new Map<string, number>();
   private successes = 0;
   private failures = 0;
   private timeouts = 0;

   constructor(options: IndexerDispatcherOptions = {}) {
      this.requestsPerSecond = positiveNumber(
         options.requestsPerSecond ?? DEFAULT_INDEXER_REQUESTS_PER_SECOND,
         'requestsPerSecond',
      );
      this.burst = positiveInteger(
         options.burst ?? DEFAULT_INDEXER_BURST,
         'burst',
      );
      this.concurrency = positiveInteger(
         options.concurrency ?? DEFAULT_INDEXER_CONCURRENCY,
         'concurrency',
      );
      this.now = options.now ?? (() => performance.now());
      this.tokens = this.burst;
      this.lastRefill = this.now();
      if (!Number.isFinite(this.lastRefill)) {
         throw new Error('dispatcher clock must return a finite number');
      }
   }

   dispatch<T>(purpose: IndexerRequestPurpose, operation: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
         this.queue.push({
            purpose,
            operation,
            resolve: resolve as PendingRequest<unknown>['resolve'],
            reject,
         });
         this.pump();
      });
   }

   snapshot(): IndexerDispatcherSnapshot {
      return {
         queued: this.queue.length,
         inFlight: this.inFlight,
         requests: Object.fromEntries(this.requestCounts),
         successes: this.successes,
         failures: this.failures,
         timeouts: this.timeouts,
      };
   }

   private pump(): void {
      if (this.timer) {
         clearTimeout(this.timer);
         this.timer = undefined;
      }

      this.refill();

      while (
         this.queue.length > 0 &&
         this.inFlight < this.concurrency &&
         this.tokens >= 1
      ) {
         const pending = this.queue.shift()!;
         this.tokens -= 1;
         this.inFlight += 1;
         this.requestCounts.set(
            pending.purpose,
            (this.requestCounts.get(pending.purpose) ?? 0) + 1,
         );

         void pending.operation().then(
            value => {
               this.successes += 1;
               this.logCompletion(pending.purpose, 'success');
               pending.resolve(value);
            },
            error => {
               this.failures += 1;
               let outcome = 'failure';
               if (isTimeout(error)) {
                  this.timeouts += 1;
                  outcome = 'timeout';
               }
               this.logCompletion(pending.purpose, outcome);
               pending.reject(error);
            },
         ).finally(() => {
            this.inFlight -= 1;
            this.pump();
         });
      }

      if (this.queue.length > 0 && this.inFlight < this.concurrency) {
         const missing = Math.max(0, 1 - this.tokens);
         const delay = Math.max(1, Math.ceil(missing * 1_000 / this.requestsPerSecond));
         this.timer = setTimeout(() => this.pump(), delay);
         this.timer.unref();
      }
   }

   private refill(): void {
      const current = this.now();
      if (!Number.isFinite(current) || current <= this.lastRefill) {
         return;
      }
      const elapsed = current - this.lastRefill;
      this.lastRefill = current;
      this.tokens = Math.min(
         this.burst,
         this.tokens + elapsed * this.requestsPerSecond / 1_000,
      );
   }

   private logCompletion(purpose: IndexerRequestPurpose, outcome: string): void {
      console.debug(
         `RoundWatch Indexer request purpose=${purpose} outcome=${outcome} inFlight=${this.inFlight} queued=${this.queue.length} successes=${this.successes} failures=${this.failures} timeouts=${this.timeouts}`,
      );
   }
}

function positiveInteger(value: number, name: string): number {
   if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a finite positive integer`);
   }
   return value;
}

function positiveNumber(value: number, name: string): number {
   if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a finite positive number`);
   }
   return value;
}

function isTimeout(error: unknown): boolean {
   return error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');
}
