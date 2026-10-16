import assert from 'node:assert/strict';
import test from 'node:test';
import type { FacilitatorClient } from '@x402/core/server';
import { FacilitatorResponseError, FacilitatorTimeoutError, VerifyError } from '@x402/core/types';
import {
   beginAcceptance, createAcceptanceContext, finishAcceptance, observeAcceptance,
   observeAcceptanceStage, observeFacilitatorClient, observeReadinessFailure,
   runAcceptanceContext, startAcceptanceTiming,
} from './acceptance-funnel.js';

function scope(log: (line: string) => void = () => {}, id = 'request') {
   return createAcceptanceContext(id, true, log);
}

test('acceptance observers are void, no-op without context, bounded and fail-isolated', () => {
   assert.equal(beginAcceptance(), undefined);
   assert.equal(observeAcceptance('durable_prepared', 'prepared'), undefined);
   assert.equal(startAcceptanceTiming('activation')(), undefined);
   const context = scope(() => { throw new Error('sink failure'); });
   runAcceptanceContext(context, () => {
      assert.equal(beginAcceptance(), undefined);
      assert.equal(observeAcceptance('durable_prepared', 'prepared'), undefined);
      observeAcceptance('body_validation_rejected', 'secret invoice' as never);
      observeAcceptance('secret event' as never, 'secret value' as never);
      observeAcceptanceStage('secret stage' as never);
      observeReadinessFailure('pre_prepare', false, {
         storage: true, diskHeadroom: false, private_invoice: false,
      });
   });
   const result = finishAcceptance(context, 503);
   assert.equal(result.durablePrepared, true);
   assert.equal(result.funnelEvent, 'admission_unavailable');
   assert.deepEqual(result.readinessChecks, { storage: true, diskHeadroom: false });
   assert.doesNotMatch(JSON.stringify(result), /secret|private_invoice/);
});

test('missing source instrumentation stays unknown and late async observers cannot log', async () => {
   const lines: string[] = [];
   const context = scope(line => lines.push(line));
   let release!: () => void;
   const late = runAcceptanceContext(context, async () => {
      await new Promise<void>(resolve => { release = resolve; });
      observeAcceptance('settlement_confirmed', 'facilitator_confirmed');
   });
   const result = finishAcceptance(context, 200);
   assert.equal(result.funnelEvent, 'purchase_failed_unknown');
   assert.equal(result.verificationClientInvoked, null);
   assert.equal(result.settlementConfirmed, null);
   release();
   await late;
   assert.equal(lines.length, 0);
   assert.equal(context.snapshot.settlementConfirmed, null);
});

test('facade forwards exact arguments, receiver, results and errors once without context', async () => {
   const payload = { secret: 'signed payment' } as never;
   const requirements = { secret: 'terms' } as never;
   const supported = { kinds: [], extensions: [], signers: {} };
   const valid = { isValid: true };
   const failure = new Error('private provider diagnostic');
   let calls = 0;
   const owned: FacilitatorClient = {
      getSupported() { assert.equal(this, owned); calls++; return Promise.resolve(supported); },
      verify(...args) {
         assert.equal(this, owned); calls++; assert.deepEqual(args, [payload, requirements]);
         return Promise.resolve(valid);
      },
      settle(...args) {
         assert.equal(this, owned); calls++; assert.deepEqual(args, [payload, requirements]);
         throw failure;
      },
   };
   const facade = observeFacilitatorClient(owned);
   assert.equal(await facade.getSupported(), supported);
   assert.equal(await facade.verify(payload, requirements), valid);
   assert.throws(() => facade.settle(payload, requirements), error => error === failure);
   assert.equal(calls, 3);
   assert.deepEqual(Object.keys(facade).sort(), ['getSupported', 'settle', 'verify']);
});

test('observed client verdicts and typed provider errors remain distinct and preserve error identity', async t => {
   const cases = [
      ['invalid', { isValid: false, invalidReason: 'private arbitrary text' }, undefined, 'payment_verification_rejected', 'verification_invalid'],
      ['typed invalid', undefined, new VerifyError(400, { isValid: false, invalidReason: 'private text' }), 'payment_verification_rejected', 'verification_invalid'],
      ['timeout', undefined, new FacilitatorTimeoutError('verify', 100), 'payment_verification_unavailable', 'provider_timeout'],
      ['malformed', undefined, new FacilitatorResponseError('private text'), 'payment_verification_unavailable', 'provider_response_invalid'],
      ['transport', undefined, new TypeError('private text'), 'payment_verification_unavailable', 'provider_error'],
      ['invalid result shape', {}, undefined, 'payment_verification_unavailable', 'provider_response_invalid'],
   ] as const;
   for (const [name, value, error, event, reason] of cases) await t.test(name, async () => {
      let calls = 0;
      const facade = observeFacilitatorClient({
         verify: async () => { calls++; if (error) throw error; return value; },
      } as unknown as FacilitatorClient);
      const context = scope();
      await runAcceptanceContext(context, async () => {
         beginAcceptance();
         if (error) await assert.rejects(facade.verify({} as never, {} as never), actual => actual === error);
         else assert.equal(await facade.verify({} as never, {} as never), value);
      });
      const result = finishAcceptance(context, 402);
      assert.equal(result.funnelEvent, event);
      assert.equal(result.reason, reason);
      assert.equal(result.verificationClientInvoked, true);
      assert.equal(result.verificationConfirmed, false);
      assert.equal(result.settlementClientInvoked, false);
      assert.equal(calls, 1);
      assert.doesNotMatch(JSON.stringify(result), /private/);
   });
});

test('facade observation cannot change provider results or failures when the sink or result getter throws', async () => {
   const failure = new Error('original payment error');
   const hostile = Object.defineProperty({}, 'isValid', { get() { throw failure; } });
   const facade = observeFacilitatorClient({
      verify: async () => hostile,
      settle: async () => { throw failure; },
   } as unknown as FacilitatorClient);
   const context = scope(() => { throw new Error('sink'); });
   await runAcceptanceContext(context, async () => {
      beginAcceptance();
      assert.equal(await facade.verify({} as never, {} as never), hostile);
      await assert.rejects(facade.settle({} as never, {} as never), error => error === failure);
   });
   const result = finishAcceptance(context, 502);
   assert.equal(result.funnelEvent, 'settlement_ambiguous');
   assert.equal(result.settlementConfirmed, false);
});

test('overlapping requests isolate flags, milestones and IDs; settlement is recorded before activation', async () => {
   const lines: string[] = [];
   const first = scope(line => lines.push(line), 'first');
   const second = scope(line => lines.push(line), 'second');
   let release!: () => void;
   const confirmed = { success: true, transaction: 'private transaction', network: 'private network' };
   const facade = observeFacilitatorClient({ settle: async () => confirmed } as unknown as FacilitatorClient);
   const held = runAcceptanceContext(first, async () => {
      beginAcceptance();
      observeAcceptance('durable_prepared', 'prepared');
      await new Promise<void>(resolve => { release = resolve; });
      assert.equal(await facade.settle({} as never, {} as never), confirmed);
      observeAcceptance('activation_confirmed', 'activated');
      observeAcceptance('purchase_completed', 'completed');
   });
   runAcceptanceContext(second, () => {
      beginAcceptance();
      observeAcceptance('body_validation_rejected', 'sender_invalid');
   });
   release();
   await held;
   assert.equal(finishAcceptance(first, 200).funnelEvent, 'purchase_completed');
   const rejected = finishAcceptance(second, 400);
   assert.equal(rejected.durablePrepared, false);
   assert.equal(rejected.settlementConfirmed, false);
   const firstLogs = lines.map(line => JSON.parse(line)).filter(event => event.requestId === 'first');
   assert.deepEqual(firstLogs.map(event => event.funnelEvent), [
      'signed_request_received', 'durable_prepared', 'settlement_confirmed', 'activation_confirmed',
   ]);
   assert.equal(firstLogs[2].activationConfirmed, false);
   assert.doesNotMatch(lines.join(''), /private/);
});

test('confirmed settlement cannot be classified as rejection even after a later SDK error', () => {
   const context = scope();
   runAcceptanceContext(context, () => {
      beginAcceptance();
      observeAcceptance('settlement_confirmed', 'facilitator_confirmed');
      observeAcceptance('payment_verification_rejected', 'verification_invalid');
   });
   const result = finishAcceptance(context, 402);
   assert.equal(result.funnelEvent, 'activation_pending');
   assert.equal(result.settlementConfirmed, true);
});
