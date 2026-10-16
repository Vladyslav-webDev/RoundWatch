import { AsyncLocalStorage } from 'node:async_hooks';
import type { FacilitatorClient } from '@x402/core/server';
import {
   FacilitatorResponseError, FacilitatorTimeoutError, VerifyError,
} from '@x402/core/types';

// Only these source-owned labels may cross the logging boundary. Remote text,
// payment material and request objects never enter request-local funnel state.
const definitions = {
   signed_request_received: ['ingress', ['header_present']],
   challenge_issued: ['payment_protocol', ['payment_required']],
   body_validation_rejected: ['body_validation', [
      'json_invalid', 'body_too_large', 'body_timeout', 'body_not_object',
      'idempotency_invalid', 'sender_invalid', 'receiver_invalid', 'amount_invalid',
      'note_invalid', 'zero_sender', 'example_key', 'example_note',
   ]],
   payment_header_rejected: ['payment_header', ['header_too_large', 'header_encoding_invalid']],
   signed_request_rate_limited: ['admission', [
      'body_rate', 'body_concurrency', 'verification_rate', 'verification_concurrency',
   ]],
   admission_unavailable: ['readiness', ['readiness_blocked', 'readiness_exception']],
   payment_protocol_rejected: ['payment_protocol', ['sdk_preverification_unknown']],
   payment_verification_rejected: ['verification', ['verification_invalid']],
   payment_verification_unavailable: ['verification', [
      'provider_timeout', 'provider_response_invalid', 'provider_error', 'unknown',
   ]],
   idempotency_replayed: ['preparation', ['same_spec']],
   idempotency_conflicted: ['preparation', ['different_spec', 'legacy_reservation']],
   capacity_rejected: ['preparation', ['global', 'payer']],
   durable_prepared: ['preparation', ['prepared']],
   internal_admission_failed: ['preparation', ['settlement_identity', 'prepare_failed', 'unknown']],
   settlement_confirmed: ['settlement', ['facilitator_confirmed']],
   settlement_ambiguous: ['settlement', ['timeout', 'provider_error', 'unconfirmed']],
   activation_confirmed: ['activation', ['activated']],
   activation_pending: ['activation', ['indexer_unavailable', 'lookup_absent', 'activation_write_failed', 'unknown']],
   activation_rejected: ['activation', ['evidence_mismatch']],
   purchase_completed: ['completion', ['completed']],
   purchase_failed_unknown: ['unknown', ['unknown']],
} as const;

export type AcceptanceEvent = keyof typeof definitions;
export type AcceptanceReason<E extends AcceptanceEvent = AcceptanceEvent> =
   (typeof definitions)[E][1][number];
export type AcceptanceStage = (typeof definitions)[AcceptanceEvent][0];
type ReadinessPhase = 'pre_challenge' | 'pre_prepare';
type TimingPhase = ReadinessPhase | 'verification' | 'settlement' | 'activation';
const readinessKeys = [
   'storage', 'poller', 'reconciler', 'backgroundWorkers', 'diskHeadroom',
   'capabilityEvidenceFresh', 'readinessCheck',
] as const;

export interface AcceptanceSnapshot {
   funnelVersion: 1;
   funnelEvent: AcceptanceEvent;
   reason: AcceptanceReason;
   stage: AcceptanceStage;
   verificationClientInvoked: boolean | null;
   verificationConfirmed: boolean | null;
   durablePrepared: boolean | null;
   settlementClientInvoked: boolean | null;
   settlementConfirmed: boolean | null;
   activationConfirmed: boolean | null;
   readinessPhase?: ReadinessPhase;
   readinessChecks?: Partial<Record<(typeof readinessKeys)[number], boolean>>;
   phaseDurationMs: Partial<Record<TimingPhase, number>>;
}

export interface AcceptanceLogEvent extends AcceptanceSnapshot {
   event: 'roundwatch_acceptance_milestone';
   requestId: string;
   paymentPresented: boolean;
}

interface AcceptanceContext {
   requestId: string;
   paymentPresented: boolean;
   snapshot: AcceptanceSnapshot;
   log?: (line: string) => void;
   closed: boolean;
   started: boolean;
}
const contexts = new AsyncLocalStorage<AcceptanceContext | undefined>();

export function unknownAcceptance(): AcceptanceSnapshot {
   return {
      funnelVersion: 1, funnelEvent: 'purchase_failed_unknown', reason: 'unknown', stage: 'unknown',
      verificationClientInvoked: null, verificationConfirmed: null, durablePrepared: null,
      settlementClientInvoked: null, settlementConfirmed: null, activationConfirmed: null,
      phaseDurationMs: {},
   };
}

export function createAcceptanceContext(
   requestId: string, paymentPresented: boolean, log: (line: string) => void,
): AcceptanceContext {
   return { requestId, paymentPresented, log, snapshot: unknownAcceptance(), closed: false, started: false };
}

export function runAcceptanceContext<T>(context: AcceptanceContext | undefined, work: () => T): T {
   return contexts.run(context, work);
}

/** All observation functions return void, never an SDK control directive. */
function observe(work: (context: AcceptanceContext) => void): void {
   try {
      const context = contexts.getStore();
      if (context && !context.closed) work(context);
   } catch {
      // Diagnostics must not participate in payment execution or gate ownership.
   }
}

export function beginAcceptance(): void {
   observe(context => {
      if (context.started) return;
      context.started = true;
      Object.assign(context.snapshot, {
         stage: 'ingress', verificationClientInvoked: false, verificationConfirmed: false,
         durablePrepared: false, settlementClientInvoked: false,
         settlementConfirmed: false, activationConfirmed: false,
      });
      if (context.paymentPresented) observeAcceptance('signed_request_received', 'header_present');
   });
}

export function observeAcceptance<E extends AcceptanceEvent>(event: E, reason: AcceptanceReason<E>): void {
   observe(context => {
      if (!Object.hasOwn(definitions, event)) return;
      const [stage, reasons] = definitions[event];
      if (!(reasons as readonly string[]).includes(reason)) return;
      const snapshot = context.snapshot;
      snapshot.funnelEvent = event;
      snapshot.stage = stage;
      snapshot.reason = reason;
      if (event === 'durable_prepared') snapshot.durablePrepared = true;
      if (event === 'settlement_confirmed') snapshot.settlementConfirmed = true;
      if (event === 'activation_confirmed') snapshot.activationConfirmed = true;
      if (event === 'signed_request_received' || event === 'durable_prepared' ||
          event === 'settlement_confirmed' || event === 'activation_confirmed') {
         context.log?.(JSON.stringify({
            event: 'roundwatch_acceptance_milestone', requestId: context.requestId,
            paymentPresented: context.paymentPresented, ...snapshot,
         } satisfies AcceptanceLogEvent));
      }
   });
}

export function observeAcceptanceStage(stage: AcceptanceStage): void {
   observe(context => {
      if (Object.values(definitions).some(definition => definition[0] === stage)) context.snapshot.stage = stage;
   });
}

export function observeReadinessFailure(
   phase: ReadinessPhase, exception: boolean, checks: Record<string, boolean>,
): void {
   observeAcceptance('admission_unavailable', exception ? 'readiness_exception' : 'readiness_blocked');
   observe(context => {
      context.snapshot.readinessPhase = phase;
      const safeChecks: AcceptanceSnapshot['readinessChecks'] = {};
      for (const key of readinessKeys) {
         if (typeof checks[key] === 'boolean') safeChecks[key] = checks[key];
      }
      context.snapshot.readinessChecks = safeChecks;
   });
}

export function startAcceptanceTiming(phase: TimingPhase): () => void {
   let started: number | undefined;
   observe(() => { started = performance.now(); });
   return () => observe(context => {
      if (started !== undefined) {
         context.snapshot.phaseDurationMs[phase] = Number(Math.max(0, performance.now() - started).toFixed(2));
      }
   });
}

/** One final outcome; milestones are separate records, not additional outcomes. */
export function finishAcceptance(context: AcceptanceContext, status: number): AcceptanceSnapshot {
   const snapshot = context.snapshot;
   try {
      if (snapshot.settlementConfirmed === true && snapshot.activationConfirmed !== true &&
          snapshot.funnelEvent !== 'activation_pending' && snapshot.funnelEvent !== 'activation_rejected') {
         Object.assign(snapshot, { funnelEvent: 'activation_pending', stage: 'activation', reason: 'unknown' });
      } else if (snapshot.settlementClientInvoked === true && snapshot.settlementConfirmed !== true) {
         if (snapshot.funnelEvent !== 'settlement_ambiguous') {
            Object.assign(snapshot, { funnelEvent: 'settlement_ambiguous', stage: 'settlement', reason: 'unconfirmed' });
         }
      } else if (snapshot.stage === 'payment_protocol' && status === 402 && context.paymentPresented &&
                 snapshot.verificationClientInvoked === false) {
         Object.assign(snapshot, { funnelEvent: 'payment_protocol_rejected', reason: 'sdk_preverification_unknown' });
      } else if (snapshot.funnelEvent === 'signed_request_received' || snapshot.funnelEvent === 'durable_prepared' ||
                 snapshot.funnelEvent === 'activation_confirmed' ||
                 (snapshot.funnelEvent === 'purchase_completed' &&
                  (status < 200 || status >= 300 || snapshot.settlementConfirmed !== true || snapshot.activationConfirmed !== true))) {
         snapshot.funnelEvent = 'purchase_failed_unknown';
         snapshot.reason = 'unknown';
      }
      return { ...snapshot, phaseDurationMs: { ...snapshot.phaseDurationMs } };
   } finally {
      context.closed = true;
      context.log = undefined;
   }
}

/** Observe the owned client's invocation boundary, not transport delivery. */
export function observeFacilitatorClient(client: FacilitatorClient): FacilitatorClient {
   function call<T>(operation: 'verify' | 'settle', invoke: () => Promise<T>): Promise<T> {
      const context = contexts.getStore();
      if (!context || context.closed) return invoke();
      const finish = startAcceptanceTiming(operation === 'verify' ? 'verification' : 'settlement');
      observe(current => {
         current.snapshot[operation === 'verify' ? 'verificationClientInvoked' : 'settlementClientInvoked'] = true;
         current.snapshot.stage = operation === 'verify' ? 'verification' : 'settlement';
      });
      const failure = (error: unknown) => {
         observe(() => {
            if (operation === 'settle') {
               observeAcceptance('settlement_ambiguous', error instanceof FacilitatorTimeoutError ? 'timeout' : 'provider_error');
            } else if (error instanceof VerifyError) {
               observeAcceptance('payment_verification_rejected', 'verification_invalid');
            } else {
               observeAcceptance('payment_verification_unavailable',
                  error instanceof FacilitatorTimeoutError ? 'provider_timeout' :
                  error instanceof FacilitatorResponseError ? 'provider_response_invalid' : 'provider_error');
            }
         });
         finish();
      };
      try {
         return invoke().then(result => {
            // Accessing even malformed provider results is isolated from forwarding.
            observe(current => {
               if (operation === 'verify') {
                  const valid = (result as { isValid?: unknown } | null)?.isValid;
                  if (valid === true) current.snapshot.verificationConfirmed = true;
                  else if (valid === false) observeAcceptance('payment_verification_rejected', 'verification_invalid');
                  else observeAcceptance('payment_verification_unavailable', 'provider_response_invalid');
               } else if ((result as { success?: unknown } | null)?.success === true) {
                  observeAcceptance('settlement_confirmed', 'facilitator_confirmed');
               } else {
                  observeAcceptance('settlement_ambiguous', 'unconfirmed');
               }
            });
            finish();
            return result;
         }, error => { failure(error); throw error; });
      } catch (error) {
         failure(error);
         throw error;
      }
   }
   return {
      getSupported: () => client.getSupported(),
      verify: (...args) => call('verify', () => client.verify(...args)),
      settle: (...args) => call('settle', () => client.settle(...args)),
   };
}
