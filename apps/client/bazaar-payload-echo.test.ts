import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectBazaarPayloadEcho } from './bazaar-payload-echo.js';

test('detects an exact Bazaar extension echo', () => {
   const bazaar = {
      info: {
         input: {
            type: 'http',
            method: 'POST',
            bodyType: 'json',
         },
         output: {
            type: 'json',
         },
      },
      schema: {
         type: 'object',
      },
   };

   const result = inspectBazaarPayloadEcho(
      {
         extensions: {
            bazaar,
            terms: { info: { format: 'uri' } },
         },
      },
      {
         extensions: {
            bazaar,
            terms: { info: { format: 'uri' } },
         },
      },
   );

   assert.equal(result.serverDeclared, true);
   assert.equal(result.payloadEchoed, true);
   assert.equal(result.sameJsonShape, true);
   assert.deepEqual(result.serverExtensionKeys, ['bazaar', 'terms']);
   assert.deepEqual(result.payloadExtensionKeys, ['bazaar', 'terms']);
   assert.equal(result.bazaarInputType, 'http');
   assert.equal(result.bazaarMethod, 'POST');
   assert.equal(result.bazaarBodyType, 'json');
   assert.equal(result.bazaarOutputType, 'json');
});

test('detects a server declaration dropped by the client payload', () => {
   const result = inspectBazaarPayloadEcho(
      {
         extensions: {
            bazaar: {
               info: {
                  input: { type: 'http', method: 'POST', bodyType: 'json' },
               },
            },
         },
      },
      {
         extensions: {},
      },
   );

   assert.equal(result.serverDeclared, true);
   assert.equal(result.payloadEchoed, false);
   assert.equal(result.sameJsonShape, false);
});

test('detects a mutated Bazaar payload echo without exposing payment data', () => {
   const result = inspectBazaarPayloadEcho(
      {
         extensions: {
            bazaar: {
               info: {
                  input: { type: 'http', method: 'POST', bodyType: 'json' },
               },
            },
         },
      },
      {
         extensions: {
            bazaar: {
               info: {
                  input: { type: 'http', method: 'PATCH', bodyType: 'json' },
               },
            },
         },
      },
   );

   assert.equal(result.serverDeclared, true);
   assert.equal(result.payloadEchoed, true);
   assert.equal(result.sameJsonShape, false);
   assert.equal(result.bazaarMethod, 'PATCH');
});
