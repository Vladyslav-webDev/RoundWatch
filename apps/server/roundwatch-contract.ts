export interface WatchEligibilityContract {
   ttlMs: number;
   startsAt: 'durable_watch_preparation_before_x402_settlement';
   settlementTimeConsumesEligibilityWindow: true;
   roundBoundary: {
      field: 'confirmed-round';
      operator: '>';
      reference: 'activationRound';
      sameActivationRoundEligible: false;
      example: string;
   };
   timeBoundary: {
      field: 'round-time';
      operator: '<';
      reference: 'expiresAt';
      exactDeadlineEligible: false;
      timestampPrecision: 'seconds';
      example: string;
   };
}

export function buildWatchEligibilityContract(
   ttlMs: number,
): WatchEligibilityContract {
   if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('ttlMs must be a positive safe integer');
   }

   return {
      ttlMs,
      startsAt: 'durable_watch_preparation_before_x402_settlement',
      settlementTimeConsumesEligibilityWindow: true,
      roundBoundary: {
         field: 'confirmed-round',
         operator: '>',
         reference: 'activationRound',
         sameActivationRoundEligible: false,
         example:
            'If activationRound is 100, confirmed round 100 is ineligible and round 101 is the first eligible round.',
      },
      timeBoundary: {
         field: 'round-time',
         operator: '<',
         reference: 'expiresAt',
         exactDeadlineEligible: false,
         timestampPrecision: 'seconds',
         example:
            'A transaction whose block timestamp equals expiresAt is ineligible; the block timestamp must be strictly earlier.',
      },
   };
}

export function eligibilityBoundarySummary(ttlMs: number): string {
   const contract = buildWatchEligibilityContract(ttlMs);

   return (
      `Eligibility lasts ${contract.ttlMs} ms from durable watch preparation before x402 settlement completes, so settlement time consumes the window. ` +
      'The watched payment must confirm in a round strictly greater than activationRound; a same-round payment is ineligible. ' +
      'Its Algorand block round-time must be strictly earlier than expiresAt; a payment exactly at the deadline is ineligible.'
   );
}
