import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeCatalogCandidate } from './bazaar-catalog-forensics.js';

test('summarizes an exact RoundWatch discovery item', () => {
   const item = {
      resource: 'https://roundwatch-api.onrender.com/v1/watch',
      accepts: [
         {
            amount: '20000',
            payTo: 'EQPLN32HPLPGBCNPOZUL6BL34CTNQGT3VAAMNAJWSIZGQ5CUNXOHB634XY',
            extra: {
               tag: 'x402-global-challenge',
            },
         },
      ],
      resourceInfo: {
         serviceName: 'RoundWatch',
      },
   };

   const result = summarizeCatalogCandidate(item, 7);

   assert.ok(result);
   assert.equal(result.position, 7);
   assert.equal(
      result.resourceUrl,
      'https://roundwatch-api.onrender.com/v1/watch',
   );
   assert.ok(result.signals.includes('exact_resource_url'));
   assert.ok(result.signals.includes('roundwatch_host'));
   assert.ok(result.signals.includes('service_name'));
   assert.ok(result.signals.includes('service_receiver'));
   assert.ok(result.signals.includes('challenge_tag'));
   assert.ok(result.signals.includes('roundwatch_text'));
   assert.deepEqual(result.amounts, ['20000']);
});

test('finds a mutated resource that still carries RoundWatch identity signals', () => {
   const item = {
      resource: 'https://roundwatch-api.onrender.com/watch',
      accepts: [
         {
            amount: '1000',
            payTo: 'EQPLN32HPLPGBCNPOZUL6BL34CTNQGT3VAAMNAJWSIZGQ5CUNXOHB634XY',
            extra: {
               tag: 'x402-global-challenge',
            },
         },
      ],
   };

   const result = summarizeCatalogCandidate(item, 10);

   assert.ok(result);
   assert.equal(result.signals.includes('exact_resource_url'), false);
   assert.equal(result.signals.includes('roundwatch_host'), true);
   assert.equal(result.signals.includes('service_receiver'), true);
   assert.equal(result.signals.includes('challenge_tag'), true);
   assert.deepEqual(result.amounts, ['1000']);
});

test('ignores unrelated discovery entries', () => {
   const item = {
      resource: 'https://example.com/api/weather',
      accepts: [
         {
            amount: '1000',
            payTo: 'SOMEOTHERADDRESS',
            extra: {
               tag: 'other',
            },
         },
      ],
      metadata: {
         description: 'weather data',
      },
   };

   assert.equal(summarizeCatalogCandidate(item, 1), undefined);
});
