import { ShutdownInterrupted } from './roundwatch-shutdown.js';

/** Own promises, including work that continues after its HTTP socket disappears. */
export class ApplicationLifetime {
   private stopped = false;
   private pending = 0;
   private drainPromise?: Promise<void>;
   private resolveDrain?: () => void;

   stopAdmission(): void { this.stopped = true; }

   isStopped(): boolean { return this.stopped; }

   track<T>(operation: () => T | PromiseLike<T>): Promise<T> {
      if (this.stopped) return Promise.reject(new ShutdownInterrupted());
      // Register ownership before invoking any user code (which can reenter shutdown).
      this.pending += 1;
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (error: unknown) => void;
      const completion = new Promise<T>((accept, fail) => {
         resolve = accept;
         reject = fail;
      });
      const owned = completion.then(
         value => { this.release(); return value; },
         error => { this.release(); throw error; },
      );
      try { resolve(operation()); } catch (error) { reject(error); }
      return owned;
   }

   drain(): Promise<void> {
      this.stopAdmission();
      this.drainPromise ??= new Promise(resolve => { this.resolveDrain = resolve; });
      if (this.pending === 0) this.resolveDrain?.();
      return this.drainPromise;
   }

   private release(): void {
      this.pending -= 1;
      if (this.pending === 0) this.resolveDrain?.();
   }
}

/** Preserve all adapter arguments; terminal admission bypasses Hono entirely. */
export function ownApplicationFetch<Arguments extends [Request, ...unknown[]]>(
   lifetime: ApplicationLifetime,
   fetchApplication: (...args: Arguments) => Response | Promise<Response>,
): (...args: Arguments) => Promise<Response> {
   return (...args) => {
      if (lifetime.isStopped()) {
         return Promise.resolve(new Response('Service is shutting down', {
            status: 503,
            headers: { 'cache-control': 'no-store' },
         }));
      }
      return lifetime.track(() => fetchApplication(...args));
   };
}
