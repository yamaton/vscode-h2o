import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { h2oTargetForVsix, loadH2oLock, verifyBinary } from './lib/h2o-release.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const lock = loadH2oLock(path.join(projectRoot, 'h2o.lock.json'));
const [vsixTarget] = process.argv.slice(2);
const h2oTarget = h2oTargetForVsix(lock, vsixTarget);
const asset = lock.assets[h2oTarget];

const source = path.join(projectRoot, 'artifacts', 'h2o', h2oTarget, 'h2o');
verifyBinary(source, h2oTarget, asset);

const bundledPath = 'bin/h2o';
const destination = path.join(projectRoot, bundledPath);
mkdirSync(path.dirname(destination), { recursive: true });
copyFileSync(source, destination);
chmodSync(destination, 0o755);
verifyBinary(destination, h2oTarget, asset);
console.log(`Staged verified ${h2oTarget} as ${bundledPath} for ${vsixTarget}.`);
