import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { ApplicationLifetime } from './roundwatch-application-lifetime.js';
import {
   closeNodeServer,
   createShutdownCoordinator,
   type ShutdownCoordinator,
   type ShutdownResult,
} from './roundwatch-shutdown-coordinator.js';
import { installShutdownSignals, startProductionRuntime } from './roundwatch-startup.js';
import { RoundWatchStore } from './roundwatch-store.js';

function gate<T>() {
   let resolve!: (value: T | PromiseLike<T>) => void;
   let reject!: (reason: unknown) => void;
   const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
   return { promise, resolve, reject };
}

class FakeServer extends EventEmitter {
   readonly listenPorts: number[] = [];
   closeCalls = 0;
   deferClose = false;
   listenError?: Error;
   private closeCallback?: (error?: Error) => void;

   listen(port: number): this {
      this.listenPorts.push(port);
      if (this.listenError) throw this.listenError;
      return this;
   }

   close(callback: (error?: Error) => void): this {
      this.closeCalls += 1;
      this.closeCallback = callback;
      if (!this.deferClose) this.finishClose();
      return this;
   }

   finishClose(): void {
      const callback = this.closeCallback;
      this.closeCallback = undefined;
      callback?.();
   }
}

function fixture() {
   const application = new ApplicationLifetime();
   const store = new RoundWatchStore(':memory:');
   const initialization = gate<void>();
   const initializationEntered = gate<void>();
   const shutdownStarted = gate<void>();
   const server = new FakeServer();
   const events: string[] = [];
   const exitCodes: number[] = [];
   const terminateCalls: number[] = [];
   const shutdownRequests: Array<Parameters<ShutdownCoordinator['shutdown']>> = [];
   const shutdownPromises: Array<Promise<ShutdownResult>> = [];
   let serverCreated = false;
   let creates = 0;
   let storeCloses = 0;
   let workersStarted = 0;
   let listeningNotifications = 0;
   let initializationCalls = 0;
   let initializationContinuations = 0;
   let createError: Error | undefined;
   const idleBackgroundOwner = (name: string) => ({
      stopScheduling() { events.push(`${name}:stop`); },
      drain() { events.push(`${name}:drain`); return Promise.resolve(); },
   });
   const coordinator = createShutdownCoordinator({
      application: {
         stopAdmission() { events.push('application:stop'); application.stopAdmission(); },
         drain() { events.push('application:drain'); return application.drain(); },
      },
      facilitator: {
         stopAdmission() { events.push('facilitator:stop'); },
         drain() { events.push('facilitator:drain'); return Promise.resolve(); },
      },
      poller: idleBackgroundOwner('poller'),
      reconciler: idleBackgroundOwner('reconciler'),
      healthProbe: idleBackgroundOwner('health'),
      dispatcher: idleBackgroundOwner('dispatcher'),
      runtimeSampler: { stop() { events.push('sampler:stop'); } },
      closeServer: () => {
         events.push('server:close');
         return serverCreated ? closeNodeServer(server) : Promise.resolve();
      },
      closeStore: () => {
         events.push('store:close');
         storeCloses += 1;
         store.close();
      },
      timers: {
         setTimeout: () => 'injected-deadline',
         clearTimeout: () => { events.push('deadline:clear'); },
      },
      terminate: code => { terminateCalls.push(code); },
      report() {},
   });
   const control: ShutdownCoordinator = {
      isStopping: () => coordinator.isStopping(),
      shutdown(...args) {
         const completion = coordinator.shutdown(...args);
         shutdownRequests.push(args);
         shutdownPromises.push(completion);
         shutdownStarted.resolve();
         return completion;
      },
   };
   const options: Parameters<typeof startProductionRuntime>[0] = {
      application,
      coordinator: control,
      initializePayments: async () => {
         initializationCalls += 1;
         events.push('initialization:begin');
         initializationEntered.resolve();
         await initialization.promise;
         assert.equal(store.readinessCheck(), true, 'owned initialization continuation must run before SQLite closes');
         initializationContinuations += 1;
         events.push('initialization:complete');
      },
      createServer: () => {
         creates += 1;
         if (createError) throw createError;
         serverCreated = true;
         events.push('server:create');
         return server;
      },
      port: 4_002,
      startWorkers: () => { workersStarted += 1; events.push('workers:start'); },
      onListening: () => { listeningNotifications += 1; },
      setExitCode: code => { exitCodes.push(code); },
   };
   return {
      application, store, initialization, initializationEntered, shutdownStarted,
      server, coordinator, control, options, events, exitCodes, terminateCalls,
      shutdownRequests, shutdownPromises,
      setCreateError: (error: Error) => { createError = error; },
      counts: () => ({
         creates, storeCloses, workersStarted, listeningNotifications,
         initializationCalls, initializationContinuations,
      }),
      async cleanup(startup?: Promise<void>) {
         initialization.resolve();
         server.deferClose = false;
         server.finishClose();
         if (startup) await startup;
         await coordinator.shutdown('test cleanup');
      },
   };
}

test('S2 startup owns payment initialization and does not create/listen/start workers before it completes', async () => {
   const state = fixture();
   const startup = startProductionRuntime(state.options);
   try {
      await state.initializationEntered.promise;
      assert.equal(state.counts().initializationCalls, 1);
      assert.equal(state.counts().creates, 0);
      assert.deepEqual(state.server.listenPorts, []);
      assert.equal(state.counts().workersStarted, 0);
      state.initialization.resolve();
      await startup;
      assert.equal(state.counts().initializationContinuations, 1);
      assert.equal(state.counts().creates, 1);
      assert.deepEqual(state.server.listenPorts, [4_002]);
      assert.equal(state.counts().workersStarted, 0, 'listen issuance is not a listening event');
      state.server.emit('listening');
      assert.equal(state.counts().workersStarted, 1);
      assert.equal(state.counts().listeningNotifications, 1);
      assert.ok(state.events.indexOf('initialization:complete') < state.events.indexOf('server:create'));
      assert.equal(state.counts().storeCloses, 0);
   } finally { await state.cleanup(startup); }
});

test('S2 shutdown during payment initialization drains its continuation and prevents listener and worker creation', async () => {
   const state = fixture();
   const startup = startProductionRuntime(state.options);
   try {
      await state.initializationEntered.promise;
      const shutdown = state.control.shutdown('SIGTERM');
      let drained = false;
      void shutdown.then(() => { drained = true; });
      await Promise.resolve();
      assert.equal(drained, false);
      assert.equal(state.counts().storeCloses, 0);
      assert.equal(state.store.readinessCheck(), true);
      assert.equal(state.counts().creates, 0);
      state.initialization.resolve();
      await startup;
      assert.deepEqual(await shutdown, { status: 'drained', exitCode: 0, errors: [] });
      assert.equal(state.counts().initializationContinuations, 1);
      assert.equal(state.counts().creates, 0);
      assert.deepEqual(state.server.listenPorts, []);
      assert.equal(state.counts().workersStarted, 0);
      assert.equal(state.counts().storeCloses, 1);
      assert.ok(state.events.indexOf('initialization:complete') < state.events.indexOf('store:close'));
   } finally { await state.cleanup(startup); }
});

test('S2 payment initialization rejection coordinates nonzero shutdown and still joins another admitted application owner', async () => {
   const state = fixture();
   const otherApplication = gate<void>();
   const otherCompletion = state.application.track(() => otherApplication.promise);
   const startup = startProductionRuntime(state.options);
   const failure = new Error('offline payment initialization failed');
   try {
      await state.initializationEntered.promise;
      state.initialization.reject(failure);
      await state.shutdownStarted.promise;
      assert.equal(state.coordinator.isStopping(), true);
      assert.equal(state.counts().storeCloses, 0);
      assert.equal(state.counts().creates, 0);
      assert.deepEqual(state.exitCodes, []);
      otherApplication.resolve();
      await otherCompletion;
      await startup;
      assert.deepEqual(await state.shutdownPromises[0], { status: 'drained', exitCode: 1, errors: [failure] });
      assert.deepEqual(state.exitCodes, [1]);
      assert.equal(state.counts().storeCloses, 1);
      assert.equal(state.counts().workersStarted, 0);
      assert.equal(state.counts().initializationContinuations, 0);
      assert.deepEqual(state.terminateCalls, []);
   } finally {
      otherApplication.resolve();
      await otherCompletion;
      await state.cleanup(startup);
   }
});

for (const source of ['create', 'listen'] as const) {
   test(`S2 synchronous server ${source} failure converges on coordinated shutdown after resources exist`, async () => {
      const state = fixture();
      const failure = new Error(`offline ${source} failure`);
      if (source === 'create') state.setCreateError(failure);
      else state.server.listenError = failure;
      state.initialization.resolve();
      const startup = startProductionRuntime(state.options);
      try {
         await startup;
         assert.equal(state.shutdownPromises.length, 1);
         assert.deepEqual(await state.shutdownPromises[0], { status: 'drained', exitCode: 1, errors: [failure] });
         assert.deepEqual(state.exitCodes, [1]);
         assert.equal(state.counts().creates, 1);
         assert.equal(state.counts().storeCloses, 1);
         assert.equal(state.counts().workersStarted, 0);
         assert.equal(state.server.closeCalls, source === 'listen' ? 1 : 0);
      } finally { await state.cleanup(startup); }
   });
}

test('S2 asynchronous listener/server error waits for actual server close and sets nonzero exit through the coordinator', async () => {
   const state = fixture();
   state.server.deferClose = true;
   state.initialization.resolve();
   const startup = startProductionRuntime(state.options);
   const failure = new Error('offline EADDRINUSE');
   try {
      await startup;
      state.server.emit('error', failure);
      assert.equal(state.coordinator.isStopping(), true);
      assert.equal(state.server.closeCalls, 1);
      assert.equal(state.counts().storeCloses, 0);
      assert.deepEqual(state.exitCodes, []);
      state.server.finishClose();
      assert.deepEqual(await state.shutdownPromises[0], { status: 'drained', exitCode: 1, errors: [failure] });
      assert.deepEqual(state.exitCodes, [1]);
      assert.equal(state.counts().storeCloses, 1);
      assert.equal(state.counts().workersStarted, 0);
   } finally { await state.cleanup(startup); }
});

test('S2 installed SIGTERM and SIGINT handlers share one closure and drain across repeated signals', async () => {
   const state = fixture();
   const signals = new EventEmitter();
   const removeSignals = installShutdownSignals(signals, state.control, state.options.setExitCode);
   state.server.deferClose = true;
   state.initialization.resolve();
   const startup = startProductionRuntime(state.options);
   try {
      await startup;
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGTERM', 'SIGINT']) signals.emit(signal);
      assert.equal(state.shutdownPromises.length, 4);
      assert.ok(state.shutdownPromises.every(completion => completion === state.shutdownPromises[0]));
      assert.equal(state.server.closeCalls, 1);
      assert.equal(state.counts().storeCloses, 0);
      assert.deepEqual(state.exitCodes, []);
      assert.equal(state.events.filter(event => event.endsWith(':stop')).length, 7);
      assert.equal(state.events.filter(event => event.endsWith(':drain')).length, 6);
      state.server.finishClose();
      assert.equal((await state.shutdownPromises[0])?.exitCode, 0);
      assert.equal(state.counts().storeCloses, 1);
      assert.deepEqual(state.exitCodes, [0, 0, 0, 0]);
      removeSignals();
      assert.equal(signals.listenerCount('SIGTERM'), 0);
      assert.equal(signals.listenerCount('SIGINT'), 0);
      signals.emit('SIGTERM');
      assert.equal(state.shutdownPromises.length, 4);
   } finally { removeSignals(); await state.cleanup(startup); }
});

test('S2 late listening after shutdown cannot restart workers or publish startup readiness', async () => {
   const state = fixture();
   state.server.deferClose = true;
   state.initialization.resolve();
   const startup = startProductionRuntime(state.options);
   try {
      await startup;
      const shutdown = state.control.shutdown('SIGTERM');
      state.server.emit('listening');
      assert.equal(state.counts().workersStarted, 0);
      assert.equal(state.counts().listeningNotifications, 0);
      assert.equal(state.counts().storeCloses, 0);
      state.server.finishClose();
      await shutdown;
      state.server.emit('listening');
      assert.equal(state.counts().workersStarted, 0);
      assert.equal(state.counts().listeningNotifications, 0);
      assert.equal(state.counts().storeCloses, 1);
   } finally { await state.cleanup(startup); }
});

test('S2 clientError and individual request errors do not initiate server shutdown', async () => {
   const state = fixture();
   state.initialization.resolve();
   const startup = startProductionRuntime(state.options);
   try {
      await startup;
      state.server.emit('listening');
      assert.equal(state.server.listenerCount('clientError'), 0);
      assert.equal(state.server.listenerCount('request'), 0);
      state.server.emit('clientError', new Error('offline malformed client request'), {});
      const request = new EventEmitter();
      let requestErrorHandled = false;
      request.on('error', () => { requestErrorHandled = true; });
      state.server.emit('request', request, {});
      request.emit('error', new Error('offline disconnected request'));
      assert.equal(requestErrorHandled, true);
      assert.equal(state.coordinator.isStopping(), false);
      assert.equal(state.shutdownPromises.length, 0);
      assert.equal(state.server.closeCalls, 0);
      assert.equal(state.counts().storeCloses, 0);
      assert.equal(state.counts().workersStarted, 1);
   } finally { await state.cleanup(startup); }
});

test('S2 worker startup failure on listening is contained by the same coordinator', async () => {
   const state = fixture();
   const failure = new Error('offline worker startup failed');
   state.options.startWorkers = () => { throw failure; };
   state.initialization.resolve();
   const startup = startProductionRuntime(state.options);
   try {
      await startup;
      assert.doesNotThrow(() => state.server.emit('listening'));
      assert.equal(state.coordinator.isStopping(), true);
      assert.deepEqual(await state.shutdownPromises[0], { status: 'drained', exitCode: 1, errors: [failure] });
      assert.deepEqual(state.exitCodes, [1]);
      assert.equal(state.counts().listeningNotifications, 0);
      assert.equal(state.counts().storeCloses, 1);
   } finally { await state.cleanup(startup); }
});

test('S2 shutdown reentered during synchronous worker startup prevents listening notification', async () => {
   const state = fixture();
   const startWorkers = state.options.startWorkers;
   state.options.startWorkers = () => {
      startWorkers();
      void state.control.shutdown('SIGTERM');
   };
   state.initialization.resolve();
   const startup = startProductionRuntime(state.options);
   try {
      await startup;
      state.server.emit('listening');
      assert.equal(state.coordinator.isStopping(), true);
      assert.equal(state.counts().workersStarted, 1);
      assert.equal(state.counts().listeningNotifications, 0);
      assert.equal(state.server.closeCalls, 1);
      assert.equal((await state.shutdownPromises[0])?.exitCode, 0);
      assert.equal(state.counts().storeCloses, 1);
      state.server.emit('listening');
      assert.equal(state.counts().workersStarted, 1);
      assert.equal(state.counts().listeningNotifications, 0);
   } finally { await state.cleanup(startup); }
});

test('S2 startup after terminal shutdown does not begin payment initialization or create a listener', async () => {
   const state = fixture();
   try {
      await state.control.shutdown('SIGTERM');
      await startProductionRuntime(state.options);
      assert.equal(state.counts().initializationCalls, 0);
      assert.equal(state.counts().creates, 0);
      assert.deepEqual(state.server.listenPorts, []);
      assert.equal(state.counts().workersStarted, 0);
      assert.equal(state.counts().storeCloses, 1);
   } finally { await state.cleanup(); }
});
