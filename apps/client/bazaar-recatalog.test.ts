import assert from 'node:assert/strict';
import test from 'node:test';

import { observeBuyerExtensionSidechannel } from './bazaar-recatalog.js';

test('buyer correctly does not receive facilitator EXTENSION-RESPONSES', () => {
   assert.deepEqual(observeBuyerExtensionSidechannel(null), {
      present: false,
      expectedPresent: false,
   });
});

test('buyer flags an unexpected leaked EXTENSION-RESPONSES header', () => {
   assert.deepEqual(
      observeBuyerExtensionSidechannel('unexpected'),
      {
         present: true,
         expectedPresent: false,
      },
   );
});
