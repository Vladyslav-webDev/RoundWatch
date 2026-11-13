import { fileURLToPath } from 'node:url';
import { evidence, scenario, SOURCES } from './fixtures.ts';
import { Observer } from './observer.ts';

const filename = fileURLToPath(new URL('./cp1-demo.sqlite', import.meta.url));
const observer = new Observer(filename);
try {
  const { watch, blocks } = scenario();
  const fixtures = evidence(blocks);
  observer.arm(watch, SOURCES);
  let status = observer.status(watch.id);
  while (status.outcome === 'unresolved') {
    const previousHeight = status.cursor.height;
    status = observer.step(watch.id, fixtures);
    if (status.cursor.height === previousHeight) break;
  }
  console.log(JSON.stringify(status, null, 2));
  if (status.outcome !== 'matched') process.exitCode = 1;
} finally {
  observer.close();
}
