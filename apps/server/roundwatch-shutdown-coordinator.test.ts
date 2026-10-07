import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import {
   closeNodeServer,
   createShutdownCoordinator,
   DEFAULT_SHUTDOWN_DEADLINE_MS,
   IncompleteServerClose,
   parseShutdownDeadline,
   type ShutdownCoordinatorDependencies,
   type ShutdownTimers,
} from './roundwatch-shutdown-coordinator.js';
import { AlgorandIndexerClient } from './roundwatch-indexer.js';
import { IndexerHealthProbe } from './roundwatch-health-probe.js';
import { IndexerRequestDispatcher } from './roundwatch-scheduler.js';
import { isShutdownInterrupted } from './roundwatch-shutdown.js';

function gate<T>() {
   let resolve!: (value: T) => void;
   let reject!: (reason: unknown) => void;
   const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
   return { promise, resolve, reject };
}

function fixture() {
   const events: string[] = [];
   const terminations: number[] = [];
   const reports: string[] = [];
   const deadlineHandle = { unref() { throw new Error('deadline must remain referenced'); } };
   let fireDeadline!: () => void;
   let configuredDeadline = 0;
   let timerClears = 0;
   let storeCloses = 0;
   const timers: ShutdownTimers = {
      setTimeout(callback, milliseconds) {
         events.push('deadline:start');
         fireDeadline = callback;
         configuredDeadline = milliseconds;
         return deadlineHandle;
      },
      clearTimeout(handle) {
         assert.equal(handle, deadlineHandle);
         timerClears += 1;
         events.push('deadline:clear');
      },
   };
   const admissionOwner = (name: string) => ({
      stopAdmission() { events.push(`${name}:stop`); },
      drain() { events.push(`${name}:drain`); return Promise.resolve(); },
   });
   const backgroundOwner = (name: string) => ({
      stopScheduling() { events.push(`${name}:stop`); },
      drain() { events.push(`${name}:drain`); return Promise.resolve(); },
   });
   const dependencies: ShutdownCoordinatorDependencies = {
      application: admissionOwner('application'),
      facilitator: admissionOwner('facilitator'),
      poller: backgroundOwner('poller'),
      reconciler: backgroundOwner('reconciler'),
      healthProbe: backgroundOwner('healthProbe'),
      dispatcher: backgroundOwner('dispatcher'),
      runtimeSampler: { stop() { events.push('sampler:stop'); } },
      closeServer() { events.push('server:close'); return Promise.resolve(); },
      closeStore() { events.push('store:close'); storeCloses += 1; },
      timers,
      terminate(code) { terminations.push(code); },
      report(message) { reports.push(message); },
   };
   return {
      events, terminations, reports, dependencies,
      fireDeadline: () => fireDeadline(),
      configuredDeadline: () => configuredDeadline,
      timerClears: () => timerClears,
      storeCloses: () => storeCloses,
   };
}

test('S2 idle coordinator synchronously fences every owner and joins before one SQLite close', async () => {
   const state = fixture();
   const coordinator = createShutdownCoordinator(state.dependencies);
   assert.equal(coordinator.isStopping(), false);
   const stopped = coordinator.shutdown('SIGTERM');
   assert.equal(coordinator.isStopping(), true);
   assert.deepEqual(state.events, [
      'application:stop', 'facilitator:stop', 'poller:stop', 'reconciler:stop',
      'healthProbe:stop', 'dispatcher:stop', 'sampler:stop', 'server:close',
      'deadline:start', 'application:drain', 'facilitator:drain', 'poller:drain',
      'reconciler:drain', 'healthProbe:drain', 'dispatcher:drain',
   ]);
   assert.equal(state.storeCloses(), 0);
   assert.equal(state.configuredDeadline(), DEFAULT_SHUTDOWN_DEADLINE_MS);
   assert.deepEqual(await stopped, { status: 'drained', exitCode: 0, errors: [] });
   assert.equal(state.storeCloses(), 1);
   assert.equal(state.timerClears(), 1);
   assert.deepEqual(state.terminations, []);
});

test('S2 SIGTERM, SIGINT and repeated initiators share one shutdown promise', async () => {
   const state = fixture();
   const coordinator = createShutdownCoordinator(state.dependencies);
   const sigterm = () => coordinator.shutdown('SIGTERM');
   const sigint = () => coordinator.shutdown('SIGINT');
   const stopped = sigterm();
   assert.equal(sigint(), stopped);
   assert.equal(coordinator.shutdown('server failure'), stopped);
   await stopped;
   assert.equal(sigterm(), stopped);
   assert.equal(state.storeCloses(), 1);
   assert.equal(state.events.filter(value => value.endsWith(':stop')).length, 7);
   assert.equal(state.events.filter(value => value.endsWith(':drain')).length, 6);
   assert.equal(state.events.filter(value => value === 'server:close').length, 1);
});

test('S2 coordinator publishes its promise before a synchronous fence can reenter', async () => {
   const state = fixture();
   let reentered: Promise<unknown> | undefined;
   state.dependencies.application.stopAdmission = () => {
      state.events.push('application:stop');
      assert.equal(coordinator.isStopping(), true);
      reentered = coordinator.shutdown('SIGINT');
   };
   const coordinator = createShutdownCoordinator(state.dependencies);
   const stopped = coordinator.shutdown('SIGTERM');
   assert.equal(reentered, stopped);
   await stopped;
   assert.equal(state.storeCloses(), 1);
});

for (const owner of [
   'application', 'facilitator', 'poller', 'reconciler', 'healthProbe', 'dispatcher', 'server',
] as const) {
   test(`S2 SQLite remains open while ${owner} completion is held`, async () => {
      const state = fixture();
      const held = gate<void>();
      if (owner === 'server') state.dependencies.closeServer = () => held.promise;
      else state.dependencies[owner].drain = () => held.promise;
      const coordinator = createShutdownCoordinator(state.dependencies);
      const stopped = coordinator.shutdown();
      let shutdownFinished = false;
      void stopped.then(() => { shutdownFinished = true; });
      await Promise.resolve();
      assert.equal(shutdownFinished, false);
      assert.equal(state.storeCloses(), 0);
      assert.equal(state.timerClears(), 0);
      held.resolve();
      assert.equal((await stopped).exitCode, 0);
      assert.equal(state.storeCloses(), 1);
      assert.equal(state.timerClears(), 1);
   });
}

test('S2 a rejected owner cannot release SQLite while another owner remains pending', async () => {
   const state = fixture();
   const rejectedOwner = gate<void>();
   const pendingOwner = gate<void>();
   const failure = new Error('offline drain failure');
   state.dependencies.poller.drain = () => rejectedOwner.promise;
   state.dependencies.reconciler.drain = () => pendingOwner.promise;
   const coordinator = createShutdownCoordinator(state.dependencies);
   const stopped = coordinator.shutdown();
   rejectedOwner.reject(failure);
   await Promise.resolve();
   await Promise.resolve();
   assert.equal(state.storeCloses(), 0);
   assert.equal(state.timerClears(), 0);
   pendingOwner.resolve();
   assert.deepEqual(await stopped, { status: 'drained', exitCode: 1, errors: [failure] });
   assert.equal(state.storeCloses(), 1);
});

test('S2 a synchronous drain error joins remaining known owners and forbids unproven SQLite closure', async () => {
   const state = fixture();
   const held = gate<void>();
   const failure = new Error('drain callback threw');
   state.dependencies.poller.drain = () => { throw failure; };
   state.dependencies.application.drain = () => held.promise;
   const stopped = createShutdownCoordinator(state.dependencies).shutdown();
   await Promise.resolve();
   assert.equal(state.storeCloses(), 0);
   assert.deepEqual(state.terminations, []);
   held.resolve();
   assert.deepEqual(await stopped, { status: 'ownership-failed', exitCode: 1, errors: [failure] });
   assert.equal(state.storeCloses(), 0);
   assert.deepEqual(state.terminations, [1]);
});

test('S2 a failed admission fence still fences every other owner and permanently forbids SQLite closure', async () => {
   const state = fixture();
   const held = gate<void>();
   const failure = new Error('application fence threw');
   state.dependencies.application.stopAdmission = () => {
      state.events.push('application:stop');
      throw failure;
   };
   state.dependencies.poller.drain = () => held.promise;
   const stopped = createShutdownCoordinator(state.dependencies).shutdown();
   assert.deepEqual(state.events.slice(0, 8), [
      'application:stop', 'facilitator:stop', 'poller:stop', 'reconciler:stop',
      'healthProbe:stop', 'dispatcher:stop', 'sampler:stop', 'server:close',
   ]);
   await Promise.resolve();
   assert.equal(state.storeCloses(), 0);
   assert.deepEqual(state.terminations, []);
   held.resolve();
   assert.deepEqual(await stopped, { status: 'ownership-failed', exitCode: 1, errors: [failure] });
   assert.equal(state.storeCloses(), 0);
   assert.deepEqual(state.terminations, [1]);
   assert.equal(state.timerClears(), 1);
});

test('S2 synchronous server close failure cannot prove socket completion or permit SQLite closure', async () => {
   const state = fixture();
   const failure = new Error('server close invocation failed');
   state.dependencies.closeServer = () => { throw failure; };
   const result = await createShutdownCoordinator(state.dependencies).shutdown();
   assert.deepEqual(result, { status: 'ownership-failed', exitCode: 1, errors: [failure] });
   assert.equal(state.storeCloses(), 0);
   assert.deepEqual(state.terminations, [1]);
});

test('S2 Node close helper failure preserves unproven socket ownership at the coordinator boundary', async () => {
   const state = fixture();
   const failure = new Error('server close invocation failed');
   state.dependencies.closeServer = () => closeNodeServer({ close() { throw failure; } });
   const result = await createShutdownCoordinator(state.dependencies).shutdown();
   assert.equal(result.status, 'ownership-failed');
   assert.equal(result.exitCode, 1);
   assert.equal(result.errors.length, 1);
   assert.ok(result.errors[0] instanceof IncompleteServerClose);
   assert.equal(result.errors[0].cause, failure);
   assert.equal(state.storeCloses(), 0);
   assert.deepEqual(state.terminations, [1]);
});

test('S2 coordinator fences actual queued and future Indexer transports before joining the dispatched owner', async () => {
   const state = fixture();
   const held = gate<void>();
   const dispatcher = new IndexerRequestDispatcher({ burst: 10, concurrency: 1 });
   const client = new AlgorandIndexerClient('https://indexer.invalid', dispatcher, async () => {
      transportCalls += 1;
      await held.promise;
      return Response.json({ round: 101 });
   });
   let transportCalls = 0;
   const first = client.getCurrentRound();
   const queued = client.getCurrentRound();
   const rejectedQueued = assert.rejects(queued, isShutdownInterrupted);
   state.dependencies.dispatcher = dispatcher;
   const stopped = createShutdownCoordinator(state.dependencies).shutdown();
   await rejectedQueued;
   await assert.rejects(client.getCurrentRound(), isShutdownInterrupted);
   assert.equal(transportCalls, 1);
   assert.equal(state.storeCloses(), 0);
   held.resolve();
   assert.equal(await first, 101);
   assert.equal((await stopped).exitCode, 0);
   assert.equal(transportCalls, 1);
   assert.equal(state.storeCloses(), 1);
   assert.equal(dispatcher.snapshot().queued, 0);
   assert.equal(dispatcher.snapshot().inFlight, 0);
});

test('S2 coordinator fences the health probe and dispatcher before a capability continuation can acquire again', async () => {
   const state = fixture();
   const reached = gate<void>();
   const held = gate<void>();
   const calls: string[] = [];
   const dispatcher = new IndexerRequestDispatcher({ burst: 10, concurrency: 1 });
   const client = new AlgorandIndexerClient('https://indexer.invalid', dispatcher, async input => {
      calls.push(new URL(String(input)).pathname);
      reached.resolve();
      await held.promise;
      return Response.json({ round: 101 });
   });
   const probe = new IndexerHealthProbe(client, 10458941, () => 1_000);
   const pending = probe.runIfDue();
   const interrupted = assert.rejects(pending, isShutdownInterrupted);
   await reached.promise;
   state.dependencies.healthProbe = probe;
   state.dependencies.dispatcher = dispatcher;
   const stopped = createShutdownCoordinator(state.dependencies).shutdown();
   await assert.rejects(probe.runIfDue(), isShutdownInterrupted);
   assert.equal(state.storeCloses(), 0);
   held.resolve();
   await interrupted;
   assert.equal((await stopped).exitCode, 0);
   assert.deepEqual(calls, ['/health']);
   assert.equal(probe.currentFailureEpoch(), 0);
   assert.equal(probe.currentSample(), undefined);
   assert.equal(state.storeCloses(), 1);
});

test('S2 failure to install the deadline terminates without closing a pending SQLite owner', async () => {
   const state = fixture();
   const held = gate<void>();
   const failure = new Error('timer creation failed');
   state.dependencies.application.drain = () => held.promise;
   state.dependencies.timers!.setTimeout = () => { throw failure; };
   const result = await createShutdownCoordinator(state.dependencies).shutdown();
   assert.deepEqual(result, { status: 'ownership-failed', exitCode: 1, errors: [failure] });
   assert.equal(state.storeCloses(), 0);
   assert.deepEqual(state.terminations, [1]);
   held.resolve();
   await held.promise;
   await Promise.resolve();
   await Promise.resolve();
   assert.equal(state.storeCloses(), 0);
});

test('S2 startup/init error is retained while its existing owner finishes', async () => {
   const state = fixture();
   const initialization = gate<void>();
   const failure = new Error('payment initialization failed');
   state.dependencies.application.drain = () => initialization.promise;
   const stopped = createShutdownCoordinator(state.dependencies).shutdown('payment initialization', failure);
   await Promise.resolve();
   assert.equal(state.storeCloses(), 0);
   initialization.resolve();
   assert.deepEqual(await stopped, { status: 'drained', exitCode: 1, errors: [failure] });
});

test('S2 a new failure during an existing graceful shutdown preserves the shared lifecycle and nonzero status', async () => {
   const state = fixture();
   const held = gate<void>();
   state.dependencies.application.drain = () => held.promise;
   const coordinator = createShutdownCoordinator(state.dependencies);
   const stopped = coordinator.shutdown('SIGTERM');
   assert.equal(coordinator.shutdown('server failure', 'non-Error failure'), stopped);
   held.resolve();
   assert.deepEqual(await stopped, {
      status: 'drained', exitCode: 1, errors: ['non-Error failure'],
   });
});

test('S2 an explicitly supplied undefined failure still causes nonzero shutdown', async () => {
   const state = fixture();
   const result = await createShutdownCoordinator(state.dependencies).shutdown('initialization', undefined);
   assert.equal(result.exitCode, 1);
   assert.deepEqual(result.errors, [undefined]);
});

test('S2 deadline reports unresolved ownership, terminates nonzero and permanently forbids SQLite close', async () => {
   const state = fixture();
   const held = gate<void>();
   state.dependencies.application.drain = () => held.promise;
   state.dependencies.deadlineMs = 1234;
   const coordinator = createShutdownCoordinator(state.dependencies);
   const stopped = coordinator.shutdown('SIGTERM');
   await Promise.resolve();
   state.fireDeadline();
   assert.deepEqual(await stopped, { status: 'deadline-exceeded', exitCode: 1, errors: [] });
   assert.deepEqual(state.terminations, [1]);
   assert.equal(state.configuredDeadline(), 1234);
   assert.equal(state.storeCloses(), 0);
   assert.equal(state.timerClears(), 0);
   assert.match(state.reports[0]!, /incomplete owners: application\. SQLite remains open/);
   assert.equal(coordinator.shutdown('SIGINT'), stopped);
   // Fake termination returns. Even subsequent owner completion cannot close SQLite.
   held.resolve();
   await held.promise;
   await Promise.resolve();
   await Promise.resolve();
   assert.equal(state.storeCloses(), 0);
   state.fireDeadline();
   assert.deepEqual(state.terminations, [1]);
});

test('S2 successful drainage clears the deadline and prevents later fake expiry', async () => {
   const state = fixture();
   const stopped = createShutdownCoordinator(state.dependencies).shutdown();
   await stopped;
   assert.equal(state.timerClears(), 1);
   state.fireDeadline();
   assert.equal(state.storeCloses(), 1);
   assert.deepEqual(state.terminations, []);
});

test('S2 store close failure is reported once after every owner has settled', async () => {
   const state = fixture();
   const failure = new Error('SQLite close failed');
   let attempts = 0;
   state.dependencies.closeStore = () => { attempts += 1; throw failure; };
   const coordinator = createShutdownCoordinator(state.dependencies);
   const stopped = coordinator.shutdown();
   assert.deepEqual(await stopped, { status: 'drained', exitCode: 1, errors: [failure] });
   assert.equal(coordinator.shutdown(), stopped);
   assert.equal(attempts, 1);
});

test('S2 rejected joins are observed without an unhandled rejection', async t => {
   const unhandled: unknown[] = [];
   const observe = (error: unknown) => { unhandled.push(error); };
   process.on('unhandledRejection', observe);
   t.after(() => { process.off('unhandledRejection', observe); });
   const state = fixture();
   const failure = new Error('offline rejection');
   state.dependencies.closeServer = () => Promise.reject(failure);
   state.dependencies.application.drain = () => Promise.reject(failure);
   state.dependencies.facilitator.drain = () => Promise.reject(failure);
   const result = await createShutdownCoordinator(state.dependencies).shutdown();
   assert.equal(result.errors.length, 3);
   await new Promise<void>(resolve => setImmediate(resolve));
   assert.deepEqual(unhandled, []);
});

test('S2 deadline configuration requires a positive safe integer', () => {
   assert.equal(parseShutdownDeadline(), 25_000);
   assert.equal(parseShutdownDeadline('1'), 1);
   assert.equal(parseShutdownDeadline('25000'), 25_000);
   assert.equal(parseShutdownDeadline('2147483647'), 2_147_483_647);
   assert.throws(() => parseShutdownDeadline('2147483648'), /must not exceed 2147483647 ms/);
   assert.throws(() => parseShutdownDeadline(String(Number.MAX_SAFE_INTEGER)), /Node timer limit/);
   for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
      assert.throws(() => parseShutdownDeadline(value), /positive safe integer/);
   }
   for (const deadlineMs of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const state = fixture();
      state.dependencies.deadlineMs = deadlineMs;
      assert.throws(() => createShutdownCoordinator(state.dependencies), /positive safe integer/);
      assert.deepEqual(state.events, []);
   }
   const state = fixture();
   state.dependencies.deadlineMs = 2_147_483_648;
   assert.throws(() => createShutdownCoordinator(state.dependencies), /Node timer limit/);
   assert.deepEqual(state.events, []);
});

test('S2 Node close helper waits for actual callback even when listening is already false', async () => {
   let closed!: (error?: Error) => void;
   let issued = 0;
   const server = {
      listening: false,
      close(callback: (error?: Error) => void) { issued += 1; closed = callback; },
   };
   const completion = closeNodeServer(server);
   let completed = false;
   void completion.then(() => { completed = true; });
   assert.equal(issued, 1);
   await Promise.resolve();
   assert.equal(completed, false);
   closed();
   await completion;
   assert.equal(completed, true);
});

test('S2 Node close helper accepts ERR_SERVER_NOT_RUNNING only after its callback', async () => {
   let closed!: (error?: Error) => void;
   const completion = closeNodeServer({ close(callback) { closed = callback; } });
   const error = Object.assign(new Error('not running after listen failure'), {
      code: 'ERR_SERVER_NOT_RUNNING',
   });
   closed(error);
   await completion;
});

test('S2 Node close helper handles a real never-listened and already-closed HTTP server offline', async () => {
   const server = createServer();
   await closeNodeServer(server);
   await closeNodeServer(server);
   assert.equal(server.listening, false);
});

test('S2 Node close helper retains callback errors and marks synchronous close errors as incomplete ownership', async () => {
   const failure = new Error('close failed');
   await assert.rejects(closeNodeServer({ close(callback) { callback(failure); } }), error => error === failure);
   await assert.rejects(closeNodeServer({ close() { throw failure; } }), error =>
      error instanceof IncompleteServerClose && error.cause === failure);
   await closeNodeServer({ close() {
      throw Object.assign(new Error('already stopped'), { code: 'ERR_SERVER_NOT_RUNNING' });
   } });
});
