import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const generatedDirectories = ['out', 'coverage', 'artifacts'];

for (const directory of generatedDirectories) {
  rmSync(path.join(projectRoot, directory), { recursive: true, force: true });
}

mkdirSync(path.join(projectRoot, 'artifacts'));
