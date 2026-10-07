import type { ApplicationLifetime } from './roundwatch-application-lifetime.js';

interface ShutdownControl {
   isStopping(): boolean;
   shutdown(reason?: string, error?: unknown): Promise<{ exitCode: number }>;
}

interface StartupServer {
   on(event: 'listening', callback: () => void): unknown;
   on(event: 'error', callback: (error: Error) => void): unknown;
   listen(port: number): unknown;
}

/** Initialization, listener failures and signals all use the same shutdown owner. */
export async function startProductionRuntime(options: {
   application: ApplicationLifetime;
   coordinator: ShutdownControl;
   initializePayments: () => Promise<void>;
   createServer: () => StartupServer;
   port: number;
   startWorkers: () => void;
   onListening?: () => void;
   setExitCode: (code: number) => void;
}): Promise<void> {
   const shutdown = (reason: string, error: unknown) =>
      options.coordinator.shutdown(reason, error).then(result => {
         options.setExitCode(result.exitCode);
      });
   try {
      if (options.coordinator.isStopping()) return;
      await options.application.track(options.initializePayments);
      if (options.coordinator.isStopping()) return;
      const server = options.createServer();
      // Node server 'error' represents listener/server failure; individual request
      // and socket errors use separate events and Hono's request error handling.
      server.on('error', error => { void shutdown('server error', error); });
      server.on('listening', () => {
         if (options.coordinator.isStopping()) return;
         try {
            options.startWorkers();
            if (options.coordinator.isStopping()) return;
            options.onListening?.();
         } catch (error) {
            void shutdown('worker startup failed', error);
         }
      });
      if (!options.coordinator.isStopping()) server.listen(options.port);
   } catch (error) {
      await shutdown('startup/payment initialization failed', error);
   }
}

export function installShutdownSignals(
   source: {
      on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
      off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
   },
   coordinator: ShutdownControl,
   setExitCode: (code: number) => void,
): () => void {
   const listeners = (['SIGTERM', 'SIGINT'] as const).map(signal => {
      const listener = () => {
         void coordinator.shutdown(signal).then(result => setExitCode(result.exitCode));
      };
      // Keep handling repeated signals while the shared shutdown promise drains.
      source.on(signal, listener);
      return { signal, listener };
   });
   return () => {
      for (const { signal, listener } of listeners) source.off(signal, listener);
   };
}
