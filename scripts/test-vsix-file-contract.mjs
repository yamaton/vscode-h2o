import assert from 'node:assert/strict';

import {
  compareExtensionFileContract,
  packagedExtensionFiles,
  sourceFileToExtensionPath,
} from './lib/vsix-file-contract.mjs';

assert.strictEqual(sourceFileToExtensionPath('README.md'), 'extension/readme.md');
assert.strictEqual(sourceFileToExtensionPath('LICENSE'), 'extension/LICENSE.txt');
assert.strictEqual(sourceFileToExtensionPath('out\\extension.js'), 'extension/out/extension.js');

assert.deepStrictEqual(
  packagedExtensionFiles(['out/extension.js', 'README.md']),
  [
    '[Content_Types].xml',
    'extension.vsixmanifest',
    'extension/bin/h2o',
    'extension/out/extension.js',
    'extension/readme.md',
  ],
);

const contractFiles = [
  'extension/out/extension.js',
  'extension/out/utils.js',
  'extension/readme.md',
];

assert.deepStrictEqual(
  compareExtensionFileContract([
    'extension/out/extension.js',
    'extension/out/utils.js',
    'extension/readme.md',
  ], contractFiles),
  {
    unlistedPackagedFiles: [],
    missingPackagedFiles: [],
  },
);

assert.deepStrictEqual(
  compareExtensionFileContract([
    'extension/out/extension.js',
    'extension/out/newRuntimeModule.js',
    'extension/readme.md',
  ], contractFiles),
  {
    unlistedPackagedFiles: ['extension/out/newRuntimeModule.js'],
    missingPackagedFiles: ['extension/out/utils.js'],
  },
);

console.log('VSIX file contract tests passed.');
