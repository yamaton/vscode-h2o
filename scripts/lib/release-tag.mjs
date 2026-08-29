import assert from 'node:assert/strict';

const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const sha1Pattern = /^[0-9a-f]{40}$/;

function verifyManifestLock(manifest, lockfile) {
  assert.match(manifest.version, versionPattern, 'package.json version must be an unprefixed semantic version');
  assert.strictEqual(lockfile.name, manifest.name, 'package-lock.json has the wrong package name');
  assert.strictEqual(lockfile.version, manifest.version, 'package-lock.json top-level version is stale');
  assert.strictEqual(lockfile.packages?.['']?.name, manifest.name, 'package-lock.json root package name is stale');
  assert.strictEqual(lockfile.packages?.['']?.version, manifest.version, 'package-lock.json root version is stale');
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map(BigInt);
  const rightParts = right.split('.').map(BigInt);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
}

export function planRelease(previousManifest, manifest, lockfile) {
  assert.strictEqual(previousManifest.name, manifest.name, 'package name changed across the release');
  assert.match(
    previousManifest.version,
    versionPattern,
    'previous package.json version must be an unprefixed semantic version',
  );
  verifyManifestLock(manifest, lockfile);

  if (previousManifest.version === manifest.version) {
    return { release: false, version: manifest.version };
  }

  assert.ok(
    compareVersions(manifest.version, previousManifest.version) > 0,
    `package.json version must increase from ${previousManifest.version} to ${manifest.version}`,
  );
  return { release: true, version: manifest.version };
}

export function releaseTagAction(tag, commitSha, reference) {
  assert.match(tag, versionPattern, 'release tag must be an unprefixed semantic version');
  assert.match(commitSha, sha1Pattern, 'release commit must be a full SHA-1');

  if (reference === null) {
    return 'create';
  }

  assert.strictEqual(reference.ref, `refs/tags/${tag}`, 'GitHub returned an unexpected release tag');
  assert.strictEqual(reference.object?.type, 'commit', 'release tag must point directly to a commit');
  assert.strictEqual(reference.object.sha, commitSha, 'release tag already points to another commit');
  return 'exists';
}

export function verifyReleaseMetadata(tag, commitSha, manifest, lockfile) {
  assert.match(tag, versionPattern, 'release tag must be an unprefixed semantic version');
  assert.match(commitSha, sha1Pattern, 'release commit must be a full SHA-1');
  assert.strictEqual(tag, manifest.version, 'release tag differs from package.json version');
  verifyManifestLock(manifest, lockfile);
}
