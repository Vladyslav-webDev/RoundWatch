import { importSnapshot } from './import.js';

function argument(flag: string): string {
   const index = process.argv.indexOf(flag);
   if (index < 0 || index + 1 >= process.argv.length || process.argv[index + 1].startsWith('--')) {
      throw new Error(`required argument: ${flag} PATH`);
   }
   return process.argv[index + 1];
}

async function main(): Promise<void> {
   if (process.argv.length !== 6 || process.argv[2] !== '--input' || process.argv[4] !== '--output') {
      throw new Error('usage: pnpm -C apps/observatory import --input LOCAL_JSON --output NEW_RUN_DIRECTORY');
   }
   const result = await importSnapshot(argument('--input'), argument('--output'));
   process.stdout.write(`${result.report.diagnostic}: ${result.runDirectory}\n`);
   if (result.report.diagnostic === 'unsupported_envelope' || result.report.diagnostic === 'malformed_payload') {
      process.exitCode = 2;
   }
}

main().catch(error => {
   process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
   process.exitCode = 1;
});
