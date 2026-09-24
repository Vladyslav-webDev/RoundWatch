import assert from 'node:assert/strict';
import test from 'node:test';

import {
   ALGORAND_MAINNET,
   CHALLENGE_TAG,
   EXPECTED_RECEIVER,
   SERVICE_ATOMIC_AMOUNT,
   USDC_MAINNET_ASA_ID,
} from './mainnet-safety.js';
import {
   classifyDiscoveryQualification,
   decodePaymentRequiredHeader,
   discoveryItems,
   discoveryResourceUrl,
   discoveryTotal,
   inspectCatalogPayment,
   findDiscoveryResource,
   inspectRoundWatchChallenge,
} from './discovery-qualification.js';

const RESOURCE = 'https://roundwatch-api.onrender.com/v1/watch';

function challenge() {
   return {
      x402Version: 2,
      resource: {
         url: RESOURCE,
         description: 'RoundWatch',
         mimeType: 'application/json',
         serviceName: 'RoundWatch',
         tags: [
            'algorand',
            'usdc',
            'payment-monitoring',
            'ai-agents',
            'x402',
         ],
         iconUrl: 'https://roundwatch.observer/favicon.svg',
      },
      accepts: [
         {
            scheme: 'exact',
            network: ALGORAND_MAINNET,
            amount: SERVICE_ATOMIC_AMOUNT,
            asset: String(USDC_MAINNET_ASA_ID),
            payTo: EXPECTED_RECEIVER,
            maxTimeoutSeconds: 60,
            extra: { tag: CHALLENGE_TAG },
         },
      ],
      extensions: {
         bazaar: {
            info: {
               input: {
                  type: 'http',
                  method: 'POST',
                  bodyType: 'json',
                  body: {
                     idempotencyKey: 'invoice-001',
                  },
               },
               output: {
                  type: 'json',
                  example: {
                     watchId: 'watch-001',
                  },
               },
            },
            schema: {
               type: 'object',
            },
         },
      },
   };
}

test('discovery parser accepts both current and legacy list envelopes', () => {
   const a = [{ resource: RESOURCE }];
   const b = [{ url: RESOURCE }];
   const c = [{ resource: { url: RESOURCE } }];

   assert.deepEqual(discoveryItems({ items: a }), a);
   assert.deepEqual(discoveryItems({ resources: b }), b);
   assert.deepEqual(discoveryItems({ data: { resources: c } }), c);
   assert.equal(discoveryTotal({ total: 3 }), 3);
   assert.equal(discoveryTotal({ pagination: { total: 4 } }), 4);
});

test('discovery resource URL extraction handles known facilitator shapes', () => {
   assert.equal(discoveryResourceUrl({ resourceUrl: RESOURCE }), RESOURCE);
   assert.equal(discoveryResourceUrl({ resource: RESOURCE }), RESOURCE);
   assert.equal(discoveryResourceUrl({ url: RESOURCE }), RESOURCE);
   assert.equal(
      discoveryResourceUrl({ resource: { url: RESOURCE } }),
      RESOURCE,
   );
   assert.equal(
      discoveryResourceUrl({ metadata: { resource: { url: RESOURCE } } }),
      RESOURCE,
   );
});

test('findDiscoveryResource requires the exact public resource URL', () => {
   const items = [
      { resource: 'https://other.example/api' },
      { resource: RESOURCE },
   ];

   assert.deepEqual(findDiscoveryResource(items, RESOURCE), {
      item: items[1],
      position: 1,
   });
   assert.equal(
      findDiscoveryResource(items, `${RESOURCE}/`),
      undefined,
   );
});


test('catalog payment inspection distinguishes stale and current Bazaar pricing', () => {
   const stale = inspectCatalogPayment({
      resourceUrl: RESOURCE,
      accepts: [
         {
            scheme: 'exact',
            network: ALGORAND_MAINNET,
            amount: '1000',
            asset: String(USDC_MAINNET_ASA_ID),
            payTo: EXPECTED_RECEIVER,
            extra: { tag: CHALLENGE_TAG },
         },
      ],
      settleCount: 3,
      firstSeen: '2026-09-16T10:26:05.997Z',
      lastSeen: '2026-09-24T12:07:27.130Z',
   });

   assert.equal(stale.current, false);
   assert.deepEqual(stale.observedAmounts, ['1000']);
   assert.deepEqual(stale.observedPayTos, [EXPECTED_RECEIVER]);
   assert.equal(stale.settleCount, 3);

   const current = inspectCatalogPayment({
      resourceUrl: RESOURCE,
      accepts: [
         {
            scheme: 'exact',
            network: ALGORAND_MAINNET,
            amount: SERVICE_ATOMIC_AMOUNT,
            asset: String(USDC_MAINNET_ASA_ID),
            payTo: EXPECTED_RECEIVER,
            extra: { tag: CHALLENGE_TAG },
         },
      ],
   });

   assert.equal(current.current, true);
   assert.deepEqual(current.observedAmounts, [SERVICE_ATOMIC_AMOUNT]);
});

test('PAYMENT-REQUIRED decoding and inspection validates the current discovery contract', () => {
   const raw = challenge();
   const encoded = Buffer.from(JSON.stringify(raw), 'utf8').toString(
      'base64url',
   );

   const decoded = decodePaymentRequiredHeader(encoded);
   const inspected = inspectRoundWatchChallenge(decoded, RESOURCE);

   assert.equal(inspected.valid, true);
   assert.deepEqual(inspected.errors, []);
   assert.equal(inspected.resourceUrl, RESOURCE);
   assert.equal(inspected.payment?.network, ALGORAND_MAINNET);
   assert.equal(inspected.payment?.amount, SERVICE_ATOMIC_AMOUNT);
   assert.equal(inspected.bazaar?.method, 'POST');
   assert.equal(inspected.bazaar?.bodyType, 'json');
});

test('challenge inspection fails closed on missing agent-discovery metadata', () => {
   const raw = challenge();
   raw.resource.tags = ['algorand'];
   const withoutBazaar = {
      ...raw,
      extensions: {},
   };

   const inspected = inspectRoundWatchChallenge(
      withoutBazaar,
      RESOURCE,
   );

   assert.equal(inspected.valid, false);
   assert.match(inspected.errors.join('\n'), /missing discovery tag: usdc/);
   assert.match(inspected.errors.join('\n'), /missing extensions\.bazaar/);
});


test('qualification verdict does not call a capped catalog scan an absence proof', () => {
   assert.equal(
      classifyDiscoveryQualification({
         challengeValid: true,
         catalogFound: false,
         catalogComplete: false,
         catalogCurrent: false,
         searchEndpointSupported: false,
         searchHits: 0,
      }),
      'inconclusive',
   );

   assert.equal(
      classifyDiscoveryQualification({
         challengeValid: true,
         catalogFound: false,
         catalogComplete: true,
         catalogCurrent: false,
         searchEndpointSupported: false,
         searchHits: 0,
      }),
      'fail',
   );

   assert.equal(
      classifyDiscoveryQualification({
         challengeValid: true,
         catalogFound: true,
         catalogComplete: true,
         catalogCurrent: false,
         searchEndpointSupported: false,
         searchHits: 0,
      }),
      'fail',
   );

   assert.equal(
      classifyDiscoveryQualification({
         challengeValid: true,
         catalogFound: true,
         catalogComplete: true,
         catalogCurrent: true,
         searchEndpointSupported: false,
         searchHits: 0,
      }),
      'partial',
   );
});
