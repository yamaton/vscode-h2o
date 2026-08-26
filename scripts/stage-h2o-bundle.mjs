import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadH2oLock, verifyBinary } from './lib/h2o-release.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const lock = loadH2oLock(path.join(projectRoot, 'h2o.lock.json'));
const bundledAssets = {
  'x86_64-apple-darwin': 'bin/h2o-x86_64-apple-darwin',
  'x86_64-unknown-linux-musl': 'bin/h2o-x86_64-unknown-linux',
};

for (const [target, bundledPath] of Object.entries(bundledAssets)) {
  const source = path.join(projectRoot, 'artifacts', 'h2o', target, 'h2o');
  verifyBinary(source, target, lock.assets[target]);

  const destination = path.join(projectRoot, bundledPath);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
  verifyBinary(destination, target, lock.assets[target]);
  console.log(`Staged verified ${target} as ${bundledPath}.`);
}
