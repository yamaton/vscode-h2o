import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadH2oLock } from './lib/h2o-release.mjs';
import { waitForMarketplaceTargets } from './lib/marketplace-release.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const [version] = process.argv.slice(2);
assert.ok(version, 'Usage: node scripts/confirm-marketplace-version.mjs <version>');

const manifest = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
assert.strictEqual(version, manifest.version, 'Marketplace version differs from package.json');
const extensionId = `${manifest.publisher}.${manifest.name}`;
const lock = loadH2oLock(path.join(projectRoot, 'h2o.lock.json'));
const expectedTargets = Object.keys(lock.vsixTargets).sort();

function inspectMarketplace() {
  const output = execFileSync(
    'npx',
    ['--no-install', 'vsce', 'show', extensionId, '--json'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return JSON.parse(output);
}

const result = await waitForMarketplaceTargets({
  inspect: inspectMarketplace,
  version,
  expectedTargets,
  timeoutMs: 10 * 60 * 1000,
  intervalMs: 10 * 1000,
  delay,
  onAttempt: ({ attempts, missingTargets, error }) => {
    if (error) {
      const description = error instanceof Error ? error.message : String(error);
      console.warn(`Marketplace query ${attempts} failed: ${description}`);
    } else if (missingTargets.length > 0) {
      console.log(`Marketplace query ${attempts}: waiting for ${missingTargets.join(', ')}.`);
    }
  },
});

console.log(
  `Confirmed ${extensionId} ${version} for ${expectedTargets.length} targets after ${result.attempts} query(s).`,
);
