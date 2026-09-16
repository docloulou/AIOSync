import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error('Node.js 24 or newer is required to check native TypeScript files.');
  process.exit(1);
}

async function filesIn(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesIn(location));
    else if (/\.(?:[cm]?js|[cm]?ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) output.push(location);
  }
  return output;
}

let failed = false;
let checked = 0;
for (const folder of ['src', 'test', 'public', 'scripts']) {
  for (const file of await filesIn(path.join(root, folder))) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
    checked++;
    if (result.error || result.status !== 0) {
      failed = true;
      console.error(path.relative(root, file));
      console.error(result.error?.message ?? result.stderr ?? `Exit code: ${result.status}`);
    }
  }
}
console.log(`${checked} file(s) checked: ${failed ? 'failed' : 'valid syntax'}.`);
console.log('Syntax checking does not replace static type checking.');
process.exitCode = failed ? 1 : 0;
