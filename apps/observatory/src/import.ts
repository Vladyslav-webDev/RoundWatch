import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeSnapshot } from './normalize.js';
import type { ObservatoryReportV1 } from './schema.js';

export interface ImportResult {
   runDirectory: string;
   report: ObservatoryReportV1;
}

/** The caller supplies both paths. The output directory must not already exist. */
export async function importSnapshot(inputPath: string, runDirectory: string): Promise<ImportResult> {
   const bytes = await readFile(inputPath);
   const report = normalizeSnapshot(bytes);
   await mkdir(runDirectory);
   await mkdir(join(runDirectory, 'raw'));
   const rawName = `${report.sourceArtifact.artifactId}.json`;
   await writeFile(join(runDirectory, 'raw', rawName), bytes, { flag: 'wx' });
   await writeFile(join(runDirectory, 'observatory.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
   const manifest = {
      schemaVersion: 1,
      parserVersion: report.parserVersion,
      status: report.diagnostic === 'valid_empty' || report.diagnostic === 'valid_non_empty' ? 'complete' : 'rejected',
      diagnostic: report.diagnostic,
      localImportTime: new Date().toISOString(),
      sourceArtifact: report.sourceArtifact,
      rawFile: `raw/${rawName}`,
      reportFile: 'observatory.json',
   };
   const temporary = join(runDirectory, 'manifest.json.tmp');
   await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
   await rename(temporary, join(runDirectory, 'manifest.json'));
   return { runDirectory, report };
}
