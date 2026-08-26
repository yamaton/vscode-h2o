import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadH2oLock, verifyImmutableRelease } from './lib/h2o-release.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const lock = loadH2oLock(path.join(projectRoot, 'h2o.lock.json'));

verifyImmutableRelease(lock);
console.log(`Verified immutable ${lock.repository} ${lock.tag} at tag object ${lock.tagSha1}.`);
