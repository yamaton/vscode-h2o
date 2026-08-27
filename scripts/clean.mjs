import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const allowedDirectories = new Set(['out', 'coverage', 'artifacts']);
const requestedDirectories = process.argv.slice(2);

assert.ok(requestedDirectories.length > 0, 'Usage: node scripts/clean.mjs <out|coverage|artifacts> [...]');
assert.ok(
  requestedDirectories.every(directory => allowedDirectories.has(directory)),
  'clean targets must be one or more of: out, coverage, artifacts',
);

for (const directory of new Set(requestedDirectories)) {
  rmSync(path.join(projectRoot, directory), { recursive: true, force: true });
}

if (requestedDirectories.includes('artifacts')) {
  mkdirSync(path.join(projectRoot, 'artifacts'));
}
