import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadH2oLock } from './lib/h2o-release.mjs';
import { marketplacePublishArguments } from './lib/marketplace-release.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const lock = loadH2oLock(path.join(projectRoot, 'h2o.lock.json'));
const arguments_ = process.argv.slice(2);
assert.ok(
  arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === '--verify-only'),
  'Usage: node scripts/publish-marketplace.mjs [--verify-only]',
);
const verifyOnly = arguments_[0] === '--verify-only';
const packages = Object.keys(lock.vsixTargets).sort().map((target) => ({
  target,
  file: path.join(projectRoot, 'artifacts', `vscode-h2o-${target}.vsix`),
}));

for (const package_ of packages) {
  assert.ok(lstatSync(package_.file).isFile(), `${package_.file} is not a regular file`);
  execFileSync(
    process.execPath,
    [path.join(projectRoot, 'scripts/verify-vsix.mjs'), package_.file, package_.target],
    { cwd: projectRoot, stdio: 'inherit' },
  );
}

if (verifyOnly) {
  console.log(`Verified ${packages.length} Marketplace packages.`);
} else {
  assert.ok(process.env.VSCE_PAT, 'VSCE_PAT is required to publish Marketplace packages');
  execFileSync(
    'npx',
    marketplacePublishArguments(packages.map((package_) => package_.file)),
    { cwd: projectRoot, stdio: 'inherit' },
  );
}
