import { performance } from 'node:perf_hooks';
import { ShutdownInterrupted, isShutdownInterrupted } from './roundwatch-shutdown.js';

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

export type IndexerDispatchOutcome = 'success' | 'failure' | 'timeout';

export interface IndexerDispatchObservation {
   outcome: IndexerDispatchOutcome;
   queueWaitMs: number;
   wallTimeMs: number;
}

export type IndexerDispatchObserver = (
   observation: IndexerDispatchObservation,
) => void;

interface PendingRequest<T> {
   purpose: IndexerRequestPurpose;
   operation: () => Promise<T>;
   resolve: (value: T | PromiseLike<T>) => void;
   reject: (reason?: unknown) => void;
   enqueuedAt: number;
   observer?: IndexerDispatchObserver;
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
   private schedulingStopped = false;
   private drainPromise?: Promise<void>;
   private resolveDrain?: () => void;
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

   dispatch<T>(
      purpose: IndexerRequestPurpose,
      operation: () => Promise<T>,
      observer?: IndexerDispatchObserver,
   ): Promise<T> {
      if (this.schedulingStopped) {
         return Promise.reject(new ShutdownInterrupted());
      }
      const enqueuedAt = this.safeNow();
      if (this.schedulingStopped) {
         return Promise.reject(new ShutdownInterrupted());
      }
      return new Promise<T>((resolve, reject) => {
         this.queue.push({
            purpose,
            operation,
            resolve: resolve as PendingRequest<unknown>['resolve'],
            reject,
            enqueuedAt,
            observer,
         });
         this.pump();
      });
   }

   /** Terminal admission fence; requests already dispatched retain ownership. */
   stopScheduling(): void {
      if (this.schedulingStopped) return;
      this.schedulingStopped = true;
      if (this.timer) {
         clearTimeout(this.timer);
         this.timer = undefined;
      }
      for (const pending of this.queue.splice(0)) {
         pending.reject(new ShutdownInterrupted());
      }
      this.finishDrainIfIdle();
   }

   /** Establish the terminal fence and join dispatched completion continuations. */
   drain(): Promise<void> {
      this.stopScheduling();
      if (!this.drainPromise) {
         this.drainPromise = new Promise(resolve => { this.resolveDrain = resolve; });
         this.finishDrainIfIdle();
      }
      return this.drainPromise;
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
      if (this.schedulingStopped) return;
      if (this.timer) {
         clearTimeout(this.timer);
         this.timer = undefined;
      }

      this.refill();

      while (
         !this.schedulingStopped &&
         this.queue.length > 0 &&
         this.inFlight < this.concurrency &&
         this.tokens >= 1
      ) {
         // Keep the request queued while a supplied clock can synchronously stop admission.
         const startedAt = this.safeNow();
         if (this.schedulingStopped) return;
         const pending = this.queue.shift()!;
         const queueWaitMs = elapsedMilliseconds(
            pending.enqueuedAt,
            startedAt,
         );
         this.tokens -= 1;
         this.inFlight += 1;
         this.requestCounts.set(
            pending.purpose,
            (this.requestCounts.get(pending.purpose) ?? 0) + 1,
         );

         // Own synchronous operation failures through the same completion path.
         let operation: Promise<unknown>;
         try {
            operation = pending.operation();
         } catch (error) {
            operation = Promise.reject(error);
         }
         void operation.then(
            value => {
               this.successes += 1;
               const outcome: IndexerDispatchOutcome = 'success';
               this.logCompletion(pending.purpose, outcome);
               notifyObserver(pending.observer, {
                  outcome,
                  queueWaitMs,
                  wallTimeMs: elapsedMilliseconds(startedAt, this.safeNow()),
               });
               pending.resolve(value);
            },
            error => {
               if (isShutdownInterrupted(error)) {
                  pending.reject(error);
                  return;
               }
               this.failures += 1;
               let outcome: IndexerDispatchOutcome = 'failure';
               if (isTimeout(error)) {
                  this.timeouts += 1;
                  outcome = 'timeout';
               }
               this.logCompletion(pending.purpose, outcome);
               notifyObserver(pending.observer, {
                  outcome,
                  queueWaitMs,
                  wallTimeMs: elapsedMilliseconds(startedAt, this.safeNow()),
               });
               pending.reject(error);
            },
         ).finally(() => {
            this.inFlight -= 1;
            if (this.schedulingStopped) {
               this.finishDrainIfIdle();
            } else {
               this.pump();
            }
         });
      }

      if (!this.schedulingStopped && this.queue.length > 0 && this.inFlight < this.concurrency) {
         const missing = Math.max(0, 1 - this.tokens);
         const delay = Math.max(1, Math.ceil(missing * 1_000 / this.requestsPerSecond));
         this.timer = setTimeout(() => this.pump(), delay);
         this.timer.unref();
      }
   }

   private finishDrainIfIdle(): void {
      if (this.inFlight === 0 && this.queue.length === 0 && this.timer === undefined) {
         this.resolveDrain?.();
         this.resolveDrain = undefined;
      }
   }

   private refill(): void {
      const current = this.safeNow();
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

   private safeNow(): number {
      try {
         const value = this.now();
         return Number.isFinite(value) ? value : this.lastRefill;
      } catch {
         // Diagnostic timing must never prevent provider-result settlement.
         return this.lastRefill;
      }
   }

   private logCompletion(purpose: IndexerRequestPurpose, outcome: string): void {
      try {
         console.debug(
            `RoundWatch Indexer request purpose=${purpose} outcome=${outcome} inFlight=${this.inFlight} queued=${this.queue.length} successes=${this.successes} failures=${this.failures} timeouts=${this.timeouts}`,
         );
      } catch {
         // Diagnostics must not strand the request's original caller.
      }
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

function elapsedMilliseconds(start: number, end: number): number {
   if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return 0;
   }
   return end - start;
}

function notifyObserver(
   observer: IndexerDispatchObserver | undefined,
   observation: IndexerDispatchObservation,
): void {
   if (!observer) return;
   try {
      observer(observation);
   } catch (error) {
      try {
         console.warn(
            'RoundWatch Indexer instrumentation observer failed:',
            error instanceof Error ? error.message : 'Unknown observer error',
         );
      } catch {
         // A failed diagnostic sink must not escape completion ownership.
      }
   }
}
