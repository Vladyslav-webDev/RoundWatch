/** The deployment's 30-second allowance retains five seconds of termination headroom. */
export const DEFAULT_SHUTDOWN_DEADLINE_MS = 25_000;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export interface AdmissionShutdownOwner {
   stopAdmission(): void;
   drain(): Promise<void>;
}

export interface BackgroundShutdownOwner {
   stopScheduling(): void;
   drain(): Promise<void>;
}

export interface ShutdownTimers {
   setTimeout(callback: () => void, milliseconds: number): unknown;
   clearTimeout(handle: unknown): void;
}

export interface ShutdownCoordinatorDependencies {
   application: AdmissionShutdownOwner;
   facilitator: AdmissionShutdownOwner;
   poller: BackgroundShutdownOwner;
   reconciler: BackgroundShutdownOwner;
   healthProbe: BackgroundShutdownOwner;
   dispatcher: BackgroundShutdownOwner;
   runtimeSampler?: { stop(): void };
   closeServer(): Promise<void>;
   closeStore(): void;
   deadlineMs?: number;
   timers?: ShutdownTimers;
   terminate(exitCode: number): void;
   report?: (message: string, error?: unknown) => void;
}

export interface ShutdownResult {
   status: 'drained' | 'deadline-exceeded' | 'ownership-failed';
   exitCode: 0 | 1;
   errors: unknown[];
}

export interface ShutdownCoordinator {
   shutdown(reason?: string, error?: unknown): Promise<ShutdownResult>;
   isStopping(): boolean;
}

export function parseShutdownDeadline(value?: string): number {
   const deadline = value === undefined ? DEFAULT_SHUTDOWN_DEADLINE_MS : Number(value);
   return validateShutdownDeadline(deadline);
}

function validateShutdownDeadline(value: number): number {
   if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error('ROUNDWATCH_SHUTDOWN_DEADLINE_MS must be a positive safe integer');
   }
   if (value > MAX_NODE_TIMER_DELAY_MS) {
      throw new Error(`ROUNDWATCH_SHUTDOWN_DEADLINE_MS must not exceed ${MAX_NODE_TIMER_DELAY_MS} ms (Node timer limit)`);
   }
   return value;
}

/**
 * One terminal fence and one join for all production owners. An expired deadline
 * permanently forfeits SQLite closure, even if a fake termination boundary lets
 * previously owned operations finish later.
 */
export function createShutdownCoordinator(
   dependencies: ShutdownCoordinatorDependencies,
): ShutdownCoordinator {
   const deadlineMs = validateShutdownDeadline(
      dependencies.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS,
   );
   const timers = dependencies.timers ?? {
      setTimeout: (callback: () => void, milliseconds: number) =>
         setTimeout(callback, milliseconds),
      clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
   };
   const errors: unknown[] = [];
   let shutdownPromise: Promise<ShutdownResult> | undefined;
   let completed = false;

   function report(message: string, error?: unknown): void {
      try {
         if (dependencies.report) dependencies.report(message, error);
         else console.error(message);
      } catch (reportError) {
         // A diagnostic sink cannot release ownership or interrupt the fence.
         errors.push(reportError);
      }
   }

   function shutdown(reason?: string, error?: unknown): Promise<ShutdownResult> {
      const hasError = arguments.length > 1;
      if (shutdownPromise) {
         if (hasError && !completed) {
            errors.push(error);
            report(`RoundWatch shutdown received another failure${reason ? `: ${reason}` : ''}`, error);
         }
         return shutdownPromise;
      }

      let resolveShutdown!: (result: ShutdownResult) => void;
      // Publish the shared latch before any supplied callback can reenter shutdown.
      shutdownPromise = new Promise(resolve => { resolveShutdown = resolve; });
      if (hasError) errors.push(error);
      const pending = new Set([
         'server', 'application', 'facilitator', 'poller', 'reconciler',
         'health probe', 'dispatcher',
      ]);
      let ownershipUnproven = false;

      function fence(operation: () => void): void {
         try { operation(); }
         catch (fenceError) {
            // A failed fence cannot prove that subsequent ownership is bounded.
            ownershipUnproven = true;
            errors.push(fenceError);
         }
      }

      // Every admission fence is synchronous, before server close or any joins.
      fence(() => dependencies.application.stopAdmission());
      fence(() => dependencies.facilitator.stopAdmission());
      fence(() => dependencies.poller.stopScheduling());
      fence(() => dependencies.reconciler.stopScheduling());
      fence(() => dependencies.healthProbe.stopScheduling());
      fence(() => dependencies.dispatcher.stopScheduling());
      fence(() => dependencies.runtimeSampler?.stop());

      function own(name: string, operation: () => Promise<void>): Promise<void> {
         let lifetime: Promise<void>;
         try { lifetime = Promise.resolve(operation()); }
         catch (ownerError) {
            // Unlike a rejected lifetime promise, a throwing drain callback did
            // not hand us proof that the owner's admitted work has settled.
            ownershipUnproven = true;
            lifetime = Promise.reject(ownerError);
         }
         return lifetime.then(
            () => { pending.delete(name); },
            ownerError => {
               pending.delete(name);
               if (ownerError instanceof IncompleteServerClose) ownershipUnproven = true;
               errors.push(ownerError);
               throw ownerError;
            },
         );
      }

      // Calling close begins listener/socket shutdown synchronously. Its promise
      // owns actual completion rather than issuance of the close request.
      const serverClose = own('server', () => dependencies.closeServer());
      let deadline: unknown;
      let deadlineInstalled = false;
      let deadlineInstallationFailed = false;
      function terminate(status: 'deadline-exceeded' | 'ownership-failed', message: string): void {
         if (completed) return;
         completed = true;
         report(message);
         const result: ShutdownResult = {
            status, exitCode: 1, errors: [...errors],
         };
         resolveShutdown(result);
         // The timer deliberately remains referenced; production termination is
         // explicit so it can beat platform SIGKILL without closing live SQLite.
         try { dependencies.terminate(1); }
         catch (terminationError) { report('RoundWatch shutdown termination failed', terminationError); }
      }
      try {
         deadline = timers.setTimeout(() => {
            terminate('deadline-exceeded', `RoundWatch shutdown deadline exceeded after ${deadlineMs} ms; incomplete owners: ${[...pending].join(', ')}. SQLite remains open.`);
         }, deadlineMs);
         deadlineInstalled = true;
      } catch (timerError) {
         errors.push(timerError);
         deadlineInstallationFailed = true;
      }

      const joins = [
         serverClose,
         own('application', () => dependencies.application.drain()),
         own('facilitator', () => dependencies.facilitator.drain()),
         own('poller', () => dependencies.poller.drain()),
         own('reconciler', () => dependencies.reconciler.drain()),
         own('health probe', () => dependencies.healthProbe.drain()),
         own('dispatcher', () => dependencies.dispatcher.drain()),
      ];
      // Rejection is a settled lifetime. It cannot bypass another owner's join.
      void Promise.allSettled(joins).then(() => {
         if (completed) return;
         try { if (deadlineInstalled) timers.clearTimeout(deadline); }
         catch (timerError) { errors.push(timerError); }
         if (ownershipUnproven) {
            terminate('ownership-failed', 'RoundWatch shutdown cannot prove terminal admission or lifetime completion. SQLite remains open.');
            return;
         }
         try { dependencies.closeStore(); }
         catch (storeError) { errors.push(storeError); }
         completed = true;
         if (errors.length > 0) report('RoundWatch shutdown owners settled with errors', errors[0]);
         resolveShutdown({
            status: 'drained', exitCode: errors.length > 0 ? 1 : 0, errors: [...errors],
         });
      });
      if (deadlineInstallationFailed) {
         terminate('ownership-failed', 'RoundWatch shutdown deadline could not be installed. SQLite remains open.');
      }
      return shutdownPromise;
   }

   return { shutdown, isStopping: () => shutdownPromise !== undefined };
}

export interface NodeServerCloser {
   close(callback: (error?: Error) => void): unknown;
}

/** A throwing close invocation supplies no socket-completion boundary. */
export class IncompleteServerClose extends Error {
   constructor(cause: unknown) {
      super('Node server close failed before socket completion could be established', { cause });
      this.name = 'IncompleteServerClose';
   }
}

/** Node invokes this callback after socket shutdown, including already-closed servers. */
export function closeNodeServer(server: NodeServerCloser): Promise<void> {
   return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
         if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            reject(error);
         } else resolve();
      };
      try { server.close(finish); }
      catch (error) {
         if ((error as NodeJS.ErrnoException)?.code === 'ERR_SERVER_NOT_RUNNING') resolve();
         else reject(new IncompleteServerClose(error));
      }
   });
}
