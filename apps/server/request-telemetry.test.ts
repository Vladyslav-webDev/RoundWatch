import assert from 'node:assert/strict';
import test from 'node:test';

import type { FacilitatorClient } from '@x402/core/server';

import { createApp } from './app.js';
import {
   ALGORAND_MAINNET_CAIP2,
   MAINNET_NETWORK_CONFIG,
} from './network-config.js';
import { RoundWatchStore } from './roundwatch-store.js';
import {
   buildRequestTelemetryEvent,
   classifyUserAgent,
   normalizedRoute,
   type RequestTelemetryEvent,
} from './request-telemetry.js';

const PAYER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const RECEIVER =
   'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';

function facilitator(): FacilitatorClient {
   return {
      getSupported: async () => ({
         kinds: [
            {
               x402Version: 2,
               scheme: 'exact',
               network: ALGORAND_MAINNET_CAIP2,
            },
         ],
         extensions: [],
         signers: {},
      }),
   } as unknown as FacilitatorClient;
}

function telemetryCollector(lines: string[]) {
   let sequence = 0;

   return {
      hmacKey: 'roundwatch-request-telemetry-test-key',
      log: (line: string) => lines.push(line),
      now: () => new Date('2026-09-25T06:30:00.000Z'),
      requestId: () => `request-${++sequence}`,
   };
}

function parse(lines: string[]): RequestTelemetryEvent[] {
   return lines.map(line => JSON.parse(line) as RequestTelemetryEvent);
}

test('request telemetry classifies watch, status, and MCP traffic while suppressing routine readiness', async () => {
   const lines: string[] = [];
   const store = new RoundWatchStore(':memory:');

   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: facilitator(),
         store,
         indexer: {} as never,
         networkConfig: MAINNET_NETWORK_CONFIG,
         publicBaseUrl: 'https://roundwatch-api.onrender.com',
         requireSettlementIntent: false,
         syncFacilitatorOnStart: false,
         requestTelemetry: telemetryCollector(lines),
      });

      const commonHeaders = {
         'user-agent': 'python-httpx/0.28.1',
         'x-forwarded-for': '203.0.113.44',
      };

      const ready = await app.request(
         'https://roundwatch-api.onrender.com/ready',
         { headers: commonHeaders },
      );
      assert.equal(ready.status, 200);

      const challenge = await app.request(
         'https://roundwatch-api.onrender.com/v1/watch',
         {
            method: 'POST',
            headers: {
               ...commonHeaders,
               'content-type': 'application/json',
            },
            body: JSON.stringify({
               idempotencyKey: 'telemetry-unpaid-001',
               expectedSender: PAYER,
               expectedReceiver: RECEIVER,
               atomicAmount: '1',
            }),
         },
      );
      assert.equal(challenge.status, 402);

      const missingId = '00000000-0000-0000-0000-000000000000';
      const missing = await app.request(
         `https://roundwatch-api.onrender.com/v1/watch/${missingId}?token=must-not-log`,
         { headers: commonHeaders },
      );
      assert.equal(missing.status, 404);

      const mcp = await app.request(
         'https://roundwatch-api.onrender.com/mcp',
         {
            method: 'POST',
            headers: {
               ...commonHeaders,
               'content-type': 'application/json',
               'mcp-protocol-version': '2026-07-28',
               'mcp-method': 'notifications/initialized',
            },
            body: JSON.stringify({
               jsonrpc: '2.0',
               method: 'notifications/initialized',
               params: {
                  _meta: {
                     'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                     'io.modelcontextprotocol/clientCapabilities': {},
                  },
               },
            }),
         },
      );
      assert.equal(mcp.status, 202);

      const events = parse(lines);
      assert.equal(events.length, 3);

      assert.equal(events[0]?.classification, 'watch_create_challenge');
      assert.equal(events[0]?.route, '/v1/watch');
      assert.equal(events[0]?.statusCode, 402);
      assert.equal(events[0]?.paymentPresented, false);
      assert.equal(events[0]?.paymentOutcome, 'challenge');
      assert.equal(events[0]?.uaClass, 'python-httpx');
      assert.equal(events[0]?.host, 'roundwatch-api.onrender.com');

      assert.equal(events[1]?.classification, 'watch_status_not_found');
      assert.equal(events[1]?.route, '/v1/watch/:id');
      assert.equal(events[1]?.statusCode, 404);
      assert.ok(events[1]?.watchFingerprint);
      assert.equal(lines[1]?.includes(missingId), false);
      assert.equal(lines[1]?.includes('must-not-log'), false);

      assert.equal(events[2]?.classification, 'mcp');
      assert.equal(events[2]?.route, '/mcp');
      assert.equal(events[2]?.statusCode, 202);

      assert.ok(events[0]?.clientFingerprint);
      assert.equal(
         events[0]?.clientFingerprint,
         events[1]?.clientFingerprint,
      );
      assert.equal(
         events[1]?.clientFingerprint,
         events[2]?.clientFingerprint,
      );
      assert.equal(lines.join('\n').includes('203.0.113.44'), false);
   } finally {
      store.close();
   }
});

test('request telemetry never serializes sensitive headers, bodies, or payment material', async () => {
   const lines: string[] = [];
   const store = new RoundWatchStore(':memory:');

   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: facilitator(),
         store,
         indexer: {} as never,
         networkConfig: MAINNET_NETWORK_CONFIG,
         publicBaseUrl: 'https://roundwatch-api.onrender.com',
         requireSettlementIntent: false,
         syncFacilitatorOnStart: false,
         requestTelemetry: telemetryCollector(lines),
      });

      const secretNote = 'invoice-note-top-secret';
      const secretAuthorization = 'Bearer auth-secret-123';
      const secretCookie = 'session=cookie-secret-456';
      const secretPayment = 'payment-signature-secret-789';

      const response = await app.request(
         'https://roundwatch-api.onrender.com/v1/watch',
         {
            method: 'POST',
            headers: {
               'content-type': 'application/json',
               'user-agent': 'curl/8.12.0',
               'x-forwarded-for': '198.51.100.77',
               authorization: secretAuthorization,
               cookie: secretCookie,
               'payment-signature': secretPayment,
            },
            body: JSON.stringify({
               idempotencyKey: 'telemetry-secret-001',
               expectedSender: PAYER,
               expectedReceiver: RECEIVER,
               atomicAmount: '1',
               invoiceNote: secretNote,
            }),
         },
      );

      assert.equal(response.status, 400);
      assert.equal(lines.length, 1);

      const [event] = parse(lines);
      assert.equal(event?.classification, 'watch_create_payment_rejected');
      assert.equal(event?.paymentPresented, true);
      assert.equal(event?.paymentOutcome, 'rejected');
      assert.equal(event?.uaClass, 'curl');

      const serialized = lines[0] ?? '';
      for (const forbidden of [
         secretNote,
         secretAuthorization,
         secretCookie,
         secretPayment,
         '198.51.100.77',
         'authorization',
         'cookie',
         'payment-signature',
         'idempotencyKey',
         'invoiceNote',
      ]) {
         assert.equal(
            serialized.includes(forbidden),
            false,
            `telemetry leaked forbidden value: ${forbidden}`,
         );
      }
   } finally {
      store.close();
   }
});

test('routine readiness is silent but abnormal readiness remains visible', async () => {
   const lines: string[] = [];
   const store = new RoundWatchStore(':memory:');

   try {
      const app = createApp({
         avmAddress: RECEIVER,
         facilitatorClient: facilitator(),
         store,
         indexer: {} as never,
         networkConfig: MAINNET_NETWORK_CONFIG,
         requireSettlementIntent: false,
         syncFacilitatorOnStart: false,
         readinessCheck: () => ({
            ready: false,
            checks: { storage: true, backgroundWorkers: false },
         }),
         requestTelemetry: telemetryCollector(lines),
      });

      const response = await app.request('/ready');
      assert.equal(response.status, 503);
      assert.equal(lines.length, 1);

      const [event] = parse(lines);
      assert.equal(event?.classification, 'readiness');
      assert.equal(event?.route, '/ready');
      assert.equal(event?.statusCode, 503);
   } finally {
      store.close();
   }
});

test('telemetry helpers normalize dynamic routes and compact common user agents', () => {
   assert.equal(
      normalizedRoute(
         '/v1/watch/550e8400-e29b-41d4-a716-446655440000',
         '/v1/watch',
      ),
      '/v1/watch/:id',
   );
   assert.equal(
      normalizedRoute('/v1/watch/recover', '/v1/watch'),
      '/v1/watch/recover',
   );
   assert.equal(normalizedRoute('/scanner/random/path', '/v1/watch'), '/other');

   assert.equal(classifyUserAgent('python-requests/2.32.0'), 'python-requests');
   assert.equal(classifyUserAgent('undici'), 'undici');
   assert.equal(classifyUserAgent('ChatGPT-User/1.0'), 'openai-agent');

   const event = buildRequestTelemetryEvent(
      {
         method: 'GET',
         path: '/v1/watch/secret-watch-id',
         statusCode: 200,
         durationMs: 12.345,
         watchPath: '/v1/watch',
         paymentPresented: false,
         userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
         host: 'ROUNDWATCH-API.ONRENDER.COM',
         clientAddress: '192.0.2.9',
         requestId: 'request-fixed',
         timestamp: '2026-09-25T06:30:00.000Z',
      },
      'test-key',
   );

   assert.equal(event?.classification, 'watch_status_found');
   assert.equal(event?.route, '/v1/watch/:id');
   assert.equal(event?.durationMs, 12.35);
   assert.equal(event?.uaClass, 'browser-chromium');
   assert.equal(event?.host, 'roundwatch-api.onrender.com');
   assert.equal(JSON.stringify(event).includes('secret-watch-id'), false);
   assert.equal(JSON.stringify(event).includes('192.0.2.9'), false);
});
