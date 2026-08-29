import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { planRelease } from './lib/release-tag.mjs';

const sha1Pattern = /^[0-9a-f]{40}$/;
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const [previousManifestPath, commitSha] = process.argv.slice(2);

assert.ok(previousManifestPath, 'previous package.json path is required');
assert.match(commitSha, sha1Pattern, 'release commit must be a full SHA-1');

const previousManifest = JSON.parse(readFileSync(previousManifestPath, 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const lockfile = JSON.parse(readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
const plan = planRelease(previousManifest, manifest, lockfile);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `release=${plan.release}\nversion=${plan.version}\ncommit=${commitSha}\n`,
  );
}

console.log(
  plan.release
    ? `Detected release ${previousManifest.version} -> ${plan.version} at ${commitSha}.`
    : `Version remains ${plan.version}; Marketplace release is not required.`,
);
