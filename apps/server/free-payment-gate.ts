export const DEFAULT_SIGNED_PAYMENT_REQUESTS_PER_SECOND = 10;
export const DEFAULT_SIGNED_PAYMENT_BURST = 20;
export const DEFAULT_SIGNED_PAYMENT_CONCURRENCY = 4;

export interface SignedPaymentGateOptions {
   requestsPerSecond: number;
   burst: number;
   concurrency: number;
   nowMilliseconds?: () => number;
}

export type SignedPaymentGateDecision =
   | { allowed: true; release: () => void }
   | { allowed: false; reason: 'rate' | 'concurrency' };

export class SignedPaymentGate {
   private tokens: number;
   private lastRefillMilliseconds: number;
   private inFlight = 0;
   private readonly nowMilliseconds: () => number;

   constructor(private readonly options: SignedPaymentGateOptions) {
      assertPositiveFinite(options.requestsPerSecond, 'requestsPerSecond');
      assertPositiveInteger(options.burst, 'burst');
      assertPositiveInteger(options.concurrency, 'concurrency');

      this.nowMilliseconds =
         options.nowMilliseconds ?? (() => performance.now());
      this.tokens = options.burst;
      this.lastRefillMilliseconds = this.nowMilliseconds();
   }

   tryAcquire(): SignedPaymentGateDecision {
      this.refill();

      if (this.inFlight >= this.options.concurrency) {
         return { allowed: false, reason: 'concurrency' };
      }

      if (this.tokens < 1) {
         return { allowed: false, reason: 'rate' };
      }

      this.tokens -= 1;
      this.inFlight += 1;
      let released = false;

      return {
         allowed: true,
         release: () => {
            if (released) return;
            released = true;
            this.inFlight = Math.max(0, this.inFlight - 1);
         },
      };
   }

   snapshot(): { tokens: number; inFlight: number } {
      this.refill();
      return {
         tokens: this.tokens,
         inFlight: this.inFlight,
      };
   }

   private refill(): void {
      const now = this.nowMilliseconds();
      const elapsedMilliseconds = Math.max(
         0,
         now - this.lastRefillMilliseconds,
      );
      this.lastRefillMilliseconds = Math.max(
         this.lastRefillMilliseconds,
         now,
      );

      if (elapsedMilliseconds === 0) return;

      this.tokens = Math.min(
         this.options.burst,
         this.tokens +
            (elapsedMilliseconds / 1_000) *
               this.options.requestsPerSecond,
      );
   }
}

function assertPositiveInteger(value: number, name: string): void {
   if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
   }
}

function assertPositiveFinite(value: number, name: string): void {
   if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive finite number`);
   }
}
