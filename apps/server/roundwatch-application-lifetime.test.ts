import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationLifetime, ownApplicationFetch } from './roundwatch-application-lifetime.js';
import { ShutdownInterrupted } from './roundwatch-shutdown.js';

function gate<T>() {
   let resolve!: (value: T) => void;
   let reject!: (error: unknown) => void;
   const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
   return { promise, resolve, reject };
}

test('application ownership exists before a callback reenters shutdown', async () => {
   const lifetime = new ApplicationLifetime();
   const held = gate<number>();
   let drained = false;
   const owned = lifetime.track(() => {
      void lifetime.drain().then(() => { drained = true; });
      return held.promise;
   });
   await Promise.resolve();
   assert.equal(drained, false);
   held.resolve(42);
   assert.equal(await owned, 42);
   await lifetime.drain();
   assert.equal(drained, true);
});

test('application rejection cannot release a second pending lifetime', async () => {
   const lifetime = new ApplicationLifetime();
   const held = gate<number>();
   const first = lifetime.track(() => { throw new Error('request failed'); });
   const second = lifetime.track(() => held.promise);
   const rejected = assert.rejects(first, /request failed/);
   let drained = false;
   const draining = lifetime.drain();
   void draining.then(() => { drained = true; });
   await rejected;
   assert.equal(drained, false);
   held.resolve(1);
   await second;
   await draining;
   assert.equal(drained, true);
});

test('application terminal admission and shared drain are idempotent', async () => {
   const lifetime = new ApplicationLifetime();
   lifetime.stopAdmission();
   lifetime.stopAdmission();
   const draining = lifetime.drain();
   assert.equal(lifetime.drain(), draining);
   let starts = 0;
   await assert.rejects(lifetime.track(() => { starts++; }), ShutdownInterrupted);
   await draining;
   assert.equal(starts, 0);
});

test('outer fetch preserves adapter arguments and ignores socket abortion for ownership', async () => {
   const lifetime = new ApplicationLifetime();
   const held = gate<Response>();
   const abort = new AbortController();
   const request = new Request('http://offline/held', { signal: abort.signal });
   const bindings = { incoming: {}, outgoing: {} };
   const context = {};
   const fetchOwned = ownApplicationFetch(lifetime, (received, env: typeof bindings, execution: typeof context) => {
      assert.equal(received, request);
      assert.equal(env, bindings);
      assert.equal(execution, context);
      return held.promise;
   });
   const requestCompletion = fetchOwned(request, bindings, context);
   abort.abort();
   let drained = false;
   const draining = lifetime.drain();
   void draining.then(() => { drained = true; });
   await Promise.resolve();
   assert.equal(drained, false);
   held.resolve(new Response('durable continuation complete'));
   assert.equal(await (await requestCompletion).text(), 'durable continuation complete');
   await draining;
});

test('outer stopped fetch returns bounded no-store 503 without invoking application', async () => {
   const lifetime = new ApplicationLifetime();
   let calls = 0;
   const fetchOwned = ownApplicationFetch(lifetime, () => { calls++; return new Response(); });
   lifetime.stopAdmission();
   const response = await fetchOwned(new Request('http://offline/ready'));
   assert.equal(response.status, 503);
   assert.equal(response.headers.get('cache-control'), 'no-store');
   assert.equal(calls, 0);
});
