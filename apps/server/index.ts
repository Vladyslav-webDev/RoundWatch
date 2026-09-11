import { config } from 'dotenv';

import { Hono } from 'hono';
import { serve } from '@hono/node-server';

import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { ResourceServerExtension } from '@x402/core/types';

import { ExactAvmScheme } from '@x402/avm/exact/server';
import { USDC_TESTNET_ASA_ID } from '@x402/avm';

import {
   declareDiscoveryExtension,
   bazaarResourceServerExtension,
} from '@x402-avm/extensions';

config();

const ALGORAND_TESTNET =
   'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=' as const;

const avmAddress = process.env.AVM_ADDRESS;
const facilitatorUrl = process.env.FACILITATOR_URL;

if (!avmAddress || !facilitatorUrl) {
   console.error(
      'Missing environment variables: AVM_ADDRESS or FACILITATOR_URL',
   );
   process.exit(1);
}

// Hosted GoPlausible facilitator
const facilitatorClient = new HTTPFacilitatorClient({
   url: facilitatorUrl,
});

// x402 resource server
const resourceServer = new x402ResourceServer(facilitatorClient);

// Algorand TestNet exact-payment scheme
resourceServer.register(
   ALGORAND_TESTNET,
   new ExactAvmScheme(),
);

// Bazaar discovery
resourceServer.registerExtension(
   bazaarResourceServerExtension as unknown as ResourceServerExtension,
);

const demoDiscovery = declareDiscoveryExtension({
   output: {
      example: {
         ok: true,
         message: 'x402 payment verified',
         timestamp: '2026-09-11T12:00:00.000Z',
      },
   },
});

const app = new Hono();

// Free health endpoint
app.get('/health', c => {
   return c.json({
      status: 'ok',
   });
});

// x402 middleware
app.use(
   paymentMiddleware(
      {
         'GET /demo': {
            accepts: [
               {
                  scheme: 'exact',
                  price: '$0.005',
                  network: ALGORAND_TESTNET,
                  payTo: avmAddress,
                  extra: {
                     asset: USDC_TESTNET_ASA_ID,
                     tag: 'x402-global-challenge',
                  },
               },
            ],
            description:
               'Test x402 endpoint returning proof of successful Algorand USDC payment',
            mimeType: 'application/json',
            extensions: demoDiscovery,
         },
      },
      resourceServer,
   ),
);

// Protected endpoint
app.get('/demo', c => {
   return c.json({
      ok: true,
      message: 'x402 payment verified',
      timestamp: new Date().toISOString(),
   });
});

const port = 4021;

const server = serve({
   fetch: app.fetch,
   port,
});

server.on('listening', () => {
   console.log(
      `x402 Resource Server listening at http://localhost:${port}`,
   );
});

server.on('close', () => {
   console.log('x402 Resource Server CLOSED');
});

server.on('error', error => {
   console.error('x402 Resource Server ERROR:', error);
});