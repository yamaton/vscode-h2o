import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadH2oLock, verifyBinaryHeader } from './lib/h2o-release.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const h2oLock = loadH2oLock(path.join(projectRoot, 'h2o.lock.json'));
const vsixPath = path.resolve(projectRoot, process.argv[2] || 'artifacts/vscode-h2o.vsix');
const maxVsixBytes = 12 * 1024 * 1024;

const requiredFiles = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/bin/h2o-x86_64-apple-darwin',
  'extension/bin/h2o-x86_64-unknown-linux',
  'extension/bin/profile.sb',
  'extension/bin/wrap-h2o',
  'extension/changelog.md',
  'extension/images/animal_chara_computer_penguin.png',
  'extension/images/demo-autocomplete.gif',
  'extension/images/demo-mouseover.gif',
  'extension/images/vscode-h2o-completion.gif',
  'extension/images/vscode-h2o-hover.gif',
  'extension/images/vscode-shell-command-explorer.png',
  'extension/LICENSE.txt',
  'extension/out/analyzer.js',
  'extension/out/cacheFetcher.js',
  'extension/out/command.js',
  'extension/out/commandExplorer.js',
  'extension/out/extension.js',
  'extension/out/utils.js',
  'extension/package.json',
  'extension/readme.md',
  'extension/tree-sitter-bash.wasm',
];
const requiredProductionFiles = [
  'extension/node_modules/node-fetch/LICENSE.md',
  'extension/node_modules/node-fetch/README.md',
  'extension/node_modules/node-fetch/browser.js',
  'extension/node_modules/node-fetch/lib/index.es.js',
  'extension/node_modules/node-fetch/lib/index.js',
  'extension/node_modules/node-fetch/lib/index.mjs',
  'extension/node_modules/node-fetch/package.json',
  'extension/node_modules/pako/LICENSE',
  'extension/node_modules/pako/README.md',
  'extension/node_modules/pako/dist/pako.es5.js',
  'extension/node_modules/pako/dist/pako.es5.min.js',
  'extension/node_modules/pako/dist/pako.esm.mjs',
  'extension/node_modules/pako/dist/pako.js',
  'extension/node_modules/pako/dist/pako.min.js',
  'extension/node_modules/pako/dist/pako_deflate.es5.js',
  'extension/node_modules/pako/dist/pako_deflate.es5.min.js',
  'extension/node_modules/pako/dist/pako_deflate.js',
  'extension/node_modules/pako/dist/pako_deflate.min.js',
  'extension/node_modules/pako/dist/pako_inflate.es5.js',
  'extension/node_modules/pako/dist/pako_inflate.es5.min.js',
  'extension/node_modules/pako/dist/pako_inflate.js',
  'extension/node_modules/pako/dist/pako_inflate.min.js',
  'extension/node_modules/pako/index.js',
  'extension/node_modules/pako/lib/deflate.js',
  'extension/node_modules/pako/lib/inflate.js',
  'extension/node_modules/pako/lib/utils/common.js',
  'extension/node_modules/pako/lib/utils/strings.js',
  'extension/node_modules/pako/lib/zlib/README',
  'extension/node_modules/pako/lib/zlib/adler32.js',
  'extension/node_modules/pako/lib/zlib/constants.js',
  'extension/node_modules/pako/lib/zlib/crc32.js',
  'extension/node_modules/pako/lib/zlib/deflate.js',
  'extension/node_modules/pako/lib/zlib/gzheader.js',
  'extension/node_modules/pako/lib/zlib/inffast.js',
  'extension/node_modules/pako/lib/zlib/inflate.js',
  'extension/node_modules/pako/lib/zlib/inftrees.js',
  'extension/node_modules/pako/lib/zlib/messages.js',
  'extension/node_modules/pako/lib/zlib/trees.js',
  'extension/node_modules/pako/lib/zlib/zstream.js',
  'extension/node_modules/pako/package.json',
  'extension/node_modules/tr46/.npmignore',
  'extension/node_modules/tr46/index.js',
  'extension/node_modules/tr46/lib/.gitkeep',
  'extension/node_modules/tr46/lib/mappingTable.json',
  'extension/node_modules/tr46/package.json',
  'extension/node_modules/web-tree-sitter/LICENSE',
  'extension/node_modules/web-tree-sitter/README.md',
  'extension/node_modules/web-tree-sitter/package.json',
  'extension/node_modules/web-tree-sitter/tree-sitter.js',
  'extension/node_modules/web-tree-sitter/tree-sitter.wasm',
  'extension/node_modules/webidl-conversions/LICENSE.md',
  'extension/node_modules/webidl-conversions/README.md',
  'extension/node_modules/webidl-conversions/lib/index.js',
  'extension/node_modules/webidl-conversions/package.json',
  'extension/node_modules/whatwg-url/LICENSE.txt',
  'extension/node_modules/whatwg-url/README.md',
  'extension/node_modules/whatwg-url/lib/URL-impl.js',
  'extension/node_modules/whatwg-url/lib/URL.js',
  'extension/node_modules/whatwg-url/lib/public-api.js',
  'extension/node_modules/whatwg-url/lib/url-state-machine.js',
  'extension/node_modules/whatwg-url/lib/utils.js',
  'extension/node_modules/whatwg-url/package.json',
];

function unzip(...args) {
  return execFileSync('unzip', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

function archivedFile(file) {
  return execFileSync('unzip', ['-p', vsixPath, file], { maxBuffer: 40 * 1024 * 1024 });
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

assert.ok(statSync(vsixPath).size <= maxVsixBytes, `VSIX exceeds the ${maxVsixBytes}-byte release budget`);
unzip('-t', vsixPath);
const entries = unzip('-Z1', vsixPath).trim().split(/\r?\n/);
assert.strictEqual(new Set(entries).size, entries.length, 'VSIX contains duplicate paths');

assert.deepStrictEqual(
  [...entries].sort(),
  [...requiredFiles, ...requiredProductionFiles].sort(),
  'VSIX contains missing or unexpected files',
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

for (const asset of [
  {
    file: 'bin/h2o-x86_64-apple-darwin',
    target: 'x86_64-apple-darwin',
  },
  {
    file: 'bin/h2o-x86_64-unknown-linux',
    target: 'x86_64-unknown-linux-musl',
  },
]) {
  const packagedAsset = archivedFile(`extension/${asset.file}`);
  const expected = h2oLock.assets[asset.target];
  assert.strictEqual(packagedAsset.length, expected.binarySize, `${asset.file} has an unexpected size`);
  assert.strictEqual(sha256(packagedAsset), expected.binarySha256, `${asset.file} differs from h2o.lock.json`);
  verifyBinaryHeader(packagedAsset, asset.target);
  assert.strictEqual(
    sha256(packagedAsset),
    sha256(readFileSync(path.join(projectRoot, asset.file))),
    `${asset.file} changed while packaging`,
  );
}

const packagedWasm = archivedFile('extension/tree-sitter-bash.wasm');
assert.ok(packagedWasm.length > 100000, 'tree-sitter-bash.wasm is truncated');
assert.deepStrictEqual(
  packagedWasm.subarray(0, 8),
  Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  'tree-sitter-bash.wasm has an invalid binary header',
);
assert.strictEqual(
  sha256(packagedWasm),
  sha256(readFileSync(path.join(projectRoot, 'tree-sitter-bash.wasm'))),
  'tree-sitter-bash.wasm changed while packaging',
);

const zipListing = execFileSync('zipinfo', ['-l', vsixPath], { encoding: 'utf8' });
for (const file of [
  'extension/bin/h2o-x86_64-apple-darwin',
  'extension/bin/h2o-x86_64-unknown-linux',
  'extension/bin/wrap-h2o',
]) {
  const listingLine = zipListing.split(/\r?\n/).find((line) => line.endsWith(file));
  assert.ok(listingLine?.startsWith('-rwx'), `${file} lost its executable mode in the VSIX`);
}

console.log(`VSIX contract checks passed for ${entries.length} files (${statSync(vsixPath).size} bytes).`);
