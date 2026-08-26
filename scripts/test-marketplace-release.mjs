import assert from 'node:assert/strict';
import { marketplacePublishArguments } from './lib/marketplace-release.mjs';

const packages = [
  '/release/vscode-h2o-alpine-x64.vsix',
  '/release/vscode-h2o-linux-x64.vsix',
];

assert.deepStrictEqual(
  marketplacePublishArguments(packages),
  [
    '--no-install',
    'vsce',
    'publish',
    '--skip-duplicate',
    '--packagePath',
    ...packages,
  ],
);
assert.throws(() => marketplacePublishArguments([]), /at least one VSIX package/);

console.log('Marketplace release checks passed.');
