import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadH2oLock } from './lib/h2o-release.mjs';
import { waitForMarketplaceTargets } from './lib/marketplace-release.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
assert.ok(
  args.length === 1 || args.length === 2,
  'Usage: node scripts/confirm-marketplace-version.mjs <version> [artifacts-directory]',
);
const [version, artifactsArgument] = args;
const artifactsDirectory = artifactsArgument
  ? path.resolve(process.cwd(), artifactsArgument)
  : path.join(projectRoot, 'artifacts');

const manifest = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
assert.strictEqual(version, manifest.version, 'Marketplace version differs from package.json');
const extensionId = `${manifest.publisher}.${manifest.name}`;
const lock = loadH2oLock(path.join(projectRoot, 'h2o.lock.json'));
const expectedPackages = Object.keys(lock.vsixTargets).sort().map(target => {
  const packagePath = path.join(artifactsDirectory, `vscode-h2o-${target}.vsix`);
  assert.ok(lstatSync(packagePath).isFile(), `Marketplace package is not a regular file: ${packagePath}`);
  return {
    target,
    sha256: createHash('sha256').update(readFileSync(packagePath)).digest('hex'),
  };
});

function inspectMarketplace({ timeoutMs }) {
  const output = execFileSync(
    'npx',
    ['--no-install', 'vsce', 'show', extensionId, '--json'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: Math.min(30_000, timeoutMs),
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return JSON.parse(output);
}

const result = await waitForMarketplaceTargets({
  inspect: inspectMarketplace,
  version,
  expectedPackages,
  timeoutMs: 10 * 60 * 1000,
  intervalMs: 10 * 1000,
  delay,
  onAttempt: ({ attempts, mismatches, error }) => {
    if (error) {
      const description = error instanceof Error ? error.message : String(error);
      console.warn(`Marketplace query ${attempts} failed: ${description}`);
    } else if (mismatches.length > 0) {
      const pending = mismatches.map(mismatch => (
        mismatch.reason === 'missing' ? `${mismatch.target} (missing)` : `${mismatch.target} (SHA-256 mismatch)`
      ));
      console.log(`Marketplace query ${attempts}: waiting for ${pending.join(', ')}.`);
    }
  },
});

console.log(
  `Confirmed ${extensionId} ${version} for ${expectedPackages.length} exact packages after ${result.attempts} query(s).`,
);
