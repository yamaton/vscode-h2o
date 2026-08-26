import assert from 'node:assert/strict';

const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const sha1Pattern = /^[0-9a-f]{40}$/;

export function verifyReleaseMetadata(tag, commitSha, manifest, lockfile) {
  assert.match(tag, versionPattern, 'release tag must be an unprefixed semantic version');
  assert.match(commitSha, sha1Pattern, 'release commit must be a full SHA-1');
  assert.strictEqual(tag, manifest.version, 'release tag differs from package.json version');
  assert.strictEqual(lockfile.name, manifest.name, 'package-lock.json has the wrong package name');
  assert.strictEqual(lockfile.version, manifest.version, 'package-lock.json top-level version is stale');
  assert.strictEqual(lockfile.packages?.['']?.name, manifest.name, 'package-lock.json root package name is stale');
  assert.strictEqual(lockfile.packages?.['']?.version, manifest.version, 'package-lock.json root version is stale');
}
