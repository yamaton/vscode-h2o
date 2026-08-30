import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { h2oTargetForVsix, loadH2oLock, verifyBinaryHeader, verifyStaticElf } from './lib/h2o-release.mjs';
import {
  loadGrammarLock,
  verifyGrammarArtifact,
  verifyGrammarRuntimeCompatibility,
} from './lib/tree-sitter-grammar.mjs';
import { requiredExtensionFiles } from './lib/vsix-file-contract.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const h2oLock = loadH2oLock(path.join(projectRoot, 'h2o.lock.json'));
const grammarLock = loadGrammarLock(path.join(projectRoot, 'tree-sitter-bash.lock.json'));
const packageLock = JSON.parse(readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
const vsixPath = path.resolve(projectRoot, process.argv[2] || 'artifacts/vscode-h2o-linux-x64.vsix');
const vsixTarget = process.argv[3] || 'linux-x64';
const h2oTarget = h2oTargetForVsix(h2oLock, vsixTarget);
const maxVsixBytes = 12 * 1024 * 1024;

const productionPackages = Object.entries(packageLock.packages)
  .filter(([packagePath, metadata]) => packagePath.startsWith('node_modules/') && metadata.dev !== true)
  .map(([packagePath, metadata]) => ({
    archivePath: `extension/${packagePath}`,
    version: metadata.version,
  }))
  .sort((left, right) => left.archivePath.localeCompare(right.archivePath));

function unzip(...args) {
  return execFileSync('unzip', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

function archivedFile(file) {
  return execFileSync('unzip', ['-p', vsixPath, file], { maxBuffer: 64 * 1024 * 1024 });
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

assert.ok(statSync(vsixPath).size <= maxVsixBytes, `VSIX exceeds the ${maxVsixBytes}-byte release budget`);
unzip('-t', vsixPath);
const entries = unzip('-Z1', vsixPath).trim().split(/\r?\n/);
assert.strictEqual(new Set(entries).size, entries.length, 'VSIX contains duplicate paths');

const dependencyEntries = entries.filter(entry => entry.startsWith('extension/node_modules/'));
const extensionEntries = entries.filter(entry => !entry.startsWith('extension/node_modules/'));
assert.deepStrictEqual(
  [...extensionEntries].sort(),
  [...requiredExtensionFiles].sort(),
  'VSIX contains missing or unexpected extension files',
);

const expectedPackageManifests = productionPackages.map(package_ => `${package_.archivePath}/package.json`);
const actualPackageManifests = dependencyEntries.filter(entry => entry.endsWith('/package.json'));
assert.deepStrictEqual(
  [...actualPackageManifests].sort(),
  [...expectedPackageManifests].sort(),
  'VSIX production package set differs from package-lock.json',
);
for (const package_ of productionPackages) {
  const manifest = JSON.parse(archivedFile(`${package_.archivePath}/package.json`).toString('utf8'));
  assert.strictEqual(manifest.version, package_.version, `${package_.archivePath} differs from package-lock.json`);
}
assert.ok(
  dependencyEntries.every(entry => productionPackages.some(package_ => entry.startsWith(`${package_.archivePath}/`))),
  'VSIX contains files outside locked production packages',
);
assert.ok(
  entries.every(entry => !entry.startsWith('extension/node_modules/web-tree-sitter/debug/')),
  'VSIX contains the unused web-tree-sitter debug runtime',
);
assert.ok(entries.every((entry) => !/\.(?:map|ts)$/i.test(entry)), 'VSIX must not contain TypeScript or source maps');
assert.ok(entries.every((entry) => !/(?:^|\/)(?:test|tests|coverage|artifacts|scripts)(?:\/|$)/i.test(entry)), 'VSIX contains test or build-only files');
assert.ok(entries.every((entry) => !/(?:^|\/).*copy(?:\.[^/]*)?$/i.test(entry)), 'VSIX contains a stale copy artifact');

const sourceManifest = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const packagedManifest = JSON.parse(archivedFile('extension/package.json').toString('utf8'));
for (const key of ['name', 'publisher', 'version', 'main']) {
  assert.strictEqual(packagedManifest[key], sourceManifest[key], `packaged ${key} differs from package.json`);
}
assert.deepStrictEqual(packagedManifest.engines, sourceManifest.engines, 'packaged engine range differs from package.json');

const vsixManifest = archivedFile('extension.vsixmanifest').toString('utf8');
assert.ok(vsixManifest.includes(`Id="${sourceManifest.name}"`), 'VSIX manifest has the wrong extension ID');
assert.ok(vsixManifest.includes(`Publisher="${sourceManifest.publisher}"`), 'VSIX manifest has the wrong publisher');
assert.ok(vsixManifest.includes(`Version="${sourceManifest.version}"`), 'VSIX manifest has the wrong version');
assert.ok(vsixManifest.includes(`TargetPlatform="${vsixTarget}"`), 'VSIX manifest has the wrong target platform');

const packagedH2o = archivedFile('extension/bin/h2o');
const expectedH2o = h2oLock.assets[h2oTarget];
assert.strictEqual(packagedH2o.length, expectedH2o.binarySize, 'bin/h2o has an unexpected size');
assert.strictEqual(sha256(packagedH2o), expectedH2o.binarySha256, 'bin/h2o differs from h2o.lock.json');
verifyBinaryHeader(packagedH2o, h2oTarget);
if (expectedH2o.static) {
  verifyStaticElf(packagedH2o, h2oTarget);
}

const packagedWasm = archivedFile(`extension/${grammarLock.file}`);
verifyGrammarArtifact(packagedWasm, grammarLock, `extension/${grammarLock.file}`);
await verifyGrammarRuntimeCompatibility(packagedWasm, grammarLock, `extension/${grammarLock.file}`);

const zipListing = execFileSync('zipinfo', ['-l', vsixPath], { encoding: 'utf8' });
for (const file of [
  'extension/bin/h2o',
  'extension/bin/wrap-h2o',
]) {
  const listingLine = zipListing.split(/\r?\n/).find((line) => line.endsWith(file));
  assert.ok(listingLine?.startsWith('-rwx'), `${file} lost its executable mode in the VSIX`);
}

console.log(`VSIX contract checks passed for ${entries.length} files (${statSync(vsixPath).size} bytes).`);
