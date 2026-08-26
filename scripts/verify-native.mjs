import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const binaries = [
  {
    path: 'bin/h2o-x86_64-unknown-linux',
    platform: 'linux',
    magic: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  },
  {
    path: 'bin/h2o-x86_64-apple-darwin',
    platform: 'darwin',
    magic: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  },
];

function git(...args) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

for (const binary of binaries) {
  const attribute = git('check-attr', '--cached', 'filter', '--', binary.path).trim();
  assert.match(attribute, /: filter: lfs$/, `${binary.path} must remain managed by Git LFS`);

  const pointer = git('show', `:${binary.path}`);
  const oid = pointer.match(/^oid sha256:([0-9a-f]{64})$/m)?.[1];
  const expectedSize = Number(pointer.match(/^size ([0-9]+)$/m)?.[1]);
  assert.ok(oid, `${binary.path} must have a valid LFS SHA-256 pointer in the index`);
  assert.ok(Number.isSafeInteger(expectedSize), `${binary.path} must have a valid LFS size in the index`);

  const absolutePath = path.join(projectRoot, binary.path);
  const content = readFileSync(absolutePath);
  assert.strictEqual(content.length, expectedSize, `${binary.path} is an unexpanded or truncated LFS object`);
  assert.strictEqual(sha256(content), oid, `${binary.path} does not match its LFS pointer`);
  assert.deepStrictEqual(content.subarray(0, 4), binary.magic, `${binary.path} has the wrong executable format`);
  assert.notStrictEqual(statSync(absolutePath).mode & 0o111, 0, `${binary.path} must be executable`);
}

const wrapperPath = path.join(projectRoot, 'bin/wrap-h2o');
assert.notStrictEqual(statSync(wrapperPath).mode & 0o111, 0, 'bin/wrap-h2o must be executable');

const parserWasm = readFileSync(path.join(projectRoot, 'tree-sitter-bash.wasm'));
assert.ok(parserWasm.length > 100000, 'tree-sitter-bash.wasm appears truncated');
assert.deepStrictEqual(
  parserWasm.subarray(0, 8),
  Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  'tree-sitter-bash.wasm has an invalid WebAssembly header',
);

const runnable = binaries.find((binary) => binary.platform === process.platform);
if (runnable && process.arch === 'x64') {
  const executable = path.join(projectRoot, runnable.path);
  const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 });
  assert.strictEqual(version.status, 0, `${runnable.path} --version failed: ${version.stderr}`);
  assert.match(version.stdout, /^h2o [0-9]+\.[0-9]+\.[0-9]+/m, `${runnable.path} returned an invalid version`);

  const scan = spawnSync(executable, ['--command', 'git', '--format', 'json'], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.strictEqual(scan.status, 0, `${runnable.path} could not scan git: ${scan.stderr}`);
  const jsonLine = scan.stdout.split(/\r?\n/).findLast((line) => line.startsWith('{'));
  assert.ok(jsonLine, `${runnable.path} did not emit command JSON`);
  const command = JSON.parse(jsonLine);
  assert.strictEqual(command.name, 'git', `${runnable.path} scanned the wrong command`);
  assert.ok(Array.isArray(command.options) && command.options.length > 0, `${runnable.path} emitted no git options`);
} else {
  console.log(`Native execution skipped on ${process.platform}/${process.arch}; content checks still passed.`);
}

console.log('Git LFS, native executable, and WebAssembly checks passed.');
