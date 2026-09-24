import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeExtensionResponsesHeader } from './bazaar-recatalog.js';

test('decodes Bazaar extension success from EXTENSION-RESPONSES', () => {
   const encoded = Buffer.from(
      JSON.stringify({ bazaar: { status: 'success' } }),
      'utf8',
   ).toString('base64url');

   assert.deepEqual(decodeExtensionResponsesHeader(encoded), {
      present: true,
      decoded: { bazaar: { status: 'success' } },
      status: 'success',
   });
});

test('preserves Bazaar rejection reason from EXTENSION-RESPONSES', () => {
   const encoded = Buffer.from(
      JSON.stringify({
         bazaar: {
            status: 'rejected',
            rejectedReason: 'info failed schema validation',
         },
      }),
      'utf8',
   ).toString('base64url');

   assert.deepEqual(decodeExtensionResponsesHeader(encoded), {
      present: true,
      decoded: {
         bazaar: {
            status: 'rejected',
            rejectedReason: 'info failed schema validation',
         },
      },
      status: 'rejected',
      rejectedReason: 'info failed schema validation',
   });
});

test('records missing and malformed extension response headers without guessing', () => {
   assert.deepEqual(decodeExtensionResponsesHeader(null), {
      present: false,
   });

   const malformed = decodeExtensionResponsesHeader('not-base64-json');
   assert.equal(malformed.present, true);
   assert.equal(typeof malformed.decodeError, 'string');
   assert.equal(malformed.status, undefined);
});
