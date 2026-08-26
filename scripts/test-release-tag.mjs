import assert from 'node:assert/strict';
import { verifyReleaseMetadata } from './lib/release-tag.mjs';

const manifest = { name: 'vscode-h2o', version: '0.2.16' };
const lockfile = {
  name: 'vscode-h2o',
  version: '0.2.16',
  packages: { '': { name: 'vscode-h2o', version: '0.2.16' } },
};
const commitSha = '1'.repeat(40);

verifyReleaseMetadata('0.2.16', commitSha, manifest, lockfile);
assert.throws(() => verifyReleaseMetadata('v0.2.16', commitSha, manifest, lockfile), /unprefixed semantic version/);
assert.throws(() => verifyReleaseMetadata('0.2.15', commitSha, manifest, lockfile), /differs from package.json/);
assert.throws(
  () => verifyReleaseMetadata('0.2.16', commitSha, manifest, { ...lockfile, version: '0.2.15' }),
  /top-level version is stale/,
);
assert.throws(
  () => verifyReleaseMetadata('0.2.16', commitSha, manifest, {
    ...lockfile,
    packages: { '': { name: 'another-extension', version: '0.2.16' } },
  }),
  /root package name is stale/,
);
assert.throws(
  () => verifyReleaseMetadata('0.2.16', commitSha, manifest, {
    ...lockfile,
    packages: { '': { name: 'vscode-h2o', version: '0.2.15' } },
  }),
  /root version is stale/,
);

console.log('Release tag checks passed.');
