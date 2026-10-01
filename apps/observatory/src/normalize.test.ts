import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { importSnapshot } from './import.js';
import { normalizeSnapshot } from './normalize.js';

const fixture = (name: string) => resolve('fixtures', name);

function locate(root: unknown, locator: string): unknown {
   return locator.split('/').slice(1).reduce<unknown>((value, segment) => {
      const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
      if (Array.isArray(value)) return value[Number(key)];
      if (value !== null && typeof value === 'object') return (value as Record<string, unknown>)[key];
      return undefined;
   }, root);
}

test('known envelopes and empty catalog have distinct diagnostics', async () => {
   for (const [name, expected, locator] of [
      ['known-items.json', 'valid_non_empty', '/items'],
      ['known-data-resources.json', 'valid_non_empty', '/data/resources'],
      ['empty.json', 'valid_empty', '/resources'],
      ['edge-cases.json', 'valid_non_empty', '/result/data/items'],
   ]) {
      const report = normalizeSnapshot(await readFile(fixture(name)));
      assert.equal(report.diagnostic, expected);
      assert.equal(report.envelopeLocator, locator);
   }
   assert.equal(normalizeSnapshot(await readFile(fixture('malformed.json'))).diagnostic, 'malformed_payload');
   assert.equal(normalizeSnapshot(await readFile(fixture('unsupported.json'))).diagnostic, 'unsupported_envelope');
   assert.equal(normalizeSnapshot(Buffer.from('{"items": {}}')).diagnostic, 'malformed_payload');
   assert.equal(normalizeSnapshot(Buffer.from('{"items": [], "resources": []}')).diagnostic, 'malformed_payload');
   assert.equal(normalizeSnapshot(Buffer.from('{"items": [false]}')).diagnostic, 'malformed_payload');
   assert.equal(normalizeSnapshot(Buffer.from([0xff])).diagnostic, 'malformed_payload');
});

test('offers stay intact; unknown and missing fields are not synthesized', async () => {
   const report = normalizeSnapshot(await readFile(fixture('edge-cases.json')));
   const item = report.records[0];
   assert.equal(item.sourceRecordId, 'conflicting-source');
   assert.equal(item.httpMethod, null);
   assert.equal(item.mcpTool, null);
   assert.deepEqual(item.resourceIdentifiers.map(x => x.value), [
      'https://example.invalid/pay/c', 'https://example.invalid/pay/d',
   ]);
   assert.deepEqual(item.sourceTimestamps.map(x => x.value), [
      '2026-09-24T12:07:27.130Z', '2026-09-16T10:26:05.997Z',
   ]);
   assert.equal(item.paymentOffers.length, 2);
   assert.deepEqual(item.paymentOffers.map(x => [x.scheme, x.rawNetwork, x.interpretedNetwork, x.asset, x.atomicAmount, x.payee]), [
      ['exact', 'mystery:123', null, 'asset-a', '900719925474099312345678901234567890', 'PAYEE_A'],
      ['other', 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=', 'algorand-testnet', 'asset-b', '2', 'PAYEE_B'],
   ]);
   assert.ok(item.paymentOffers[0].unknownFields.includes(`${item.paymentOffers[0].locator}/opaqueTerm`));
   const missing = normalizeSnapshot(Buffer.from('{"items":[{"resource":"one","accepts":[{"amount":9007199254740993},{}]}]}')).records[0];
   assert.equal(missing.httpMethod, null);
   assert.equal(missing.sourceRecordId, null);
   assert.equal(missing.paymentOffers[0].atomicAmount, null);
   assert.equal(missing.paymentOffers[1].atomicAmount, null);
   assert.equal(missing.paymentOffers[1].payee, null);
   const nestedAsset = normalizeSnapshot(Buffer.from('{"items":[{"accepts":[{"amount":"4","extra":{"asset":"31566704"}}]}]}')).records[0].paymentOffers[0];
   assert.equal(nestedAsset.asset, '31566704');
   assert.equal(nestedAsset.assetLocator, '/items/0/accepts/0/extra/asset');
});

test('every normalized value locator resolves against retained source bytes', async () => {
   for (const name of ['known-items.json', 'known-data-resources.json', 'edge-cases.json']) {
      const bytes = await readFile(fixture(name));
      const source = JSON.parse(bytes.toString('utf8')) as unknown;
      const report = normalizeSnapshot(bytes);
      for (const item of report.records) {
         assert.ok(locate(source, item.locator));
         assert.equal(item.artifactId, report.sourceArtifact.artifactId);
         for (const value of [...item.resourceIdentifiers, ...item.sourceTimestamps]) {
            assert.equal(locate(source, value.locator), value.value);
         }
         for (const value of item.descriptions) {
            assert.equal((locate(source, value.locator) as string).slice(0, 500), value.value);
         }
         for (const offer of item.paymentOffers) {
            assert.ok(locate(source, offer.locator));
            if (offer.assetLocator) assert.equal(locate(source, offer.assetLocator), offer.asset);
            for (const [field, normalized] of [
               ['scheme', offer.scheme], ['network', offer.rawNetwork], ['asset', offer.asset],
               ['amount', offer.atomicAmount], ['payTo', offer.payee],
            ] as const) {
               if (normalized !== null) assert.equal(locate(source, `${offer.locator}/${field}`), normalized);
            }
         }
      }
   }
});

test('report is byte deterministic and run bundle is immutable', async () => {
   const bytes = await readFile(fixture('known-items.json'));
   assert.deepEqual(normalizeSnapshot(bytes), normalizeSnapshot(bytes));
   const temporary = await mkdtemp(join(tmpdir(), 'observatory-test-'));
   try {
      const run = join(temporary, 'run');
      const imported = await importSnapshot(fixture('known-items.json'), run);
      const raw = await readFile(join(run, 'raw', `${imported.report.sourceArtifact.artifactId}.json`));
      assert.deepEqual(raw, bytes);
      const report = JSON.parse(await readFile(join(run, 'observatory.json'), 'utf8')) as unknown;
      assert.deepEqual(report, normalizeSnapshot(bytes));
      const manifest = JSON.parse(await readFile(join(run, 'manifest.json'), 'utf8')) as { status: string; localImportTime: string };
      assert.equal(manifest.status, 'complete');
      assert.ok(manifest.localImportTime);
      await assert.rejects(importSnapshot(fixture('known-items.json'), run), { code: 'EEXIST' });
      assert.deepEqual(await readFile(join(run, 'raw', `${imported.report.sourceArtifact.artifactId}.json`)), bytes);
      const rejected = join(temporary, 'rejected');
      await importSnapshot(fixture('unsupported.json'), rejected);
      assert.equal((JSON.parse(await readFile(join(rejected, 'manifest.json'), 'utf8')) as { status: string }).status, 'rejected');
      assert.ok((await stat(join(rejected, 'raw'))).isDirectory());
   } finally {
      await rm(temporary, { recursive: true, force: true });
   }
});
