import assert from 'node:assert/strict';
import test from 'node:test';

import { SignedPaymentGate } from './free-payment-gate.js';

test('signed-payment gate bounds burst, refill, concurrency, and backward clocks', () => {
   let now = 1_000;
   const gate = new SignedPaymentGate({
      requestsPerSecond: 2,
      burst: 2,
      concurrency: 1,
      nowMilliseconds: () => now,
   });

   const first = gate.tryAcquire();
   assert.equal(first.allowed, true);

   const concurrent = gate.tryAcquire();
   assert.deepEqual(concurrent, {
      allowed: false,
      reason: 'concurrency',
   });

   if (!first.allowed) throw new Error('first acquisition failed');
   first.release();

   const second = gate.tryAcquire();
   assert.equal(second.allowed, true);
   if (!second.allowed) throw new Error('second acquisition failed');
   second.release();

   assert.deepEqual(gate.tryAcquire(), {
      allowed: false,
      reason: 'rate',
   });

   now += 500;
   const refilled = gate.tryAcquire();
   assert.equal(refilled.allowed, true);
   if (!refilled.allowed) throw new Error('refilled acquisition failed');
   refilled.release();

   now -= 5_000;
   assert.deepEqual(gate.tryAcquire(), {
      allowed: false,
      reason: 'rate',
   });
});
