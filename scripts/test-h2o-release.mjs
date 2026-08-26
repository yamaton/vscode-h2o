import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  loadH2oLock,
  h2oTargetForVsix,
  validateH2oLock,
  validateArchiveEntries,
  verifyBinaryHeader,
  verifyExtractedBinary,
  verifyReleaseStatement,
  verifyStaticElf,
} from './lib/h2o-release.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const lock = loadH2oLock(path.join(projectRoot, 'h2o.lock.json'));

const subjects = [
  {
    uri: `pkg:github/${lock.repository}@${lock.tag}`,
    digest: { sha1: lock.tagSha1 },
  },
  ...Object.values(lock.assets).map((asset) => ({
    name: asset.archive,
    digest: { sha256: asset.archiveSha256 },
  })),
];
const statement = {
  predicateType: 'https://in-toto.io/attestation/release/v0.2',
  predicate: { repository: lock.repository, tag: lock.tag },
  subject: subjects,
};

verifyReleaseStatement(lock, statement);
assert.strictEqual(h2oTargetForVsix(lock, 'linux-x64'), 'x86_64-unknown-linux-musl');
assert.strictEqual(h2oTargetForVsix(lock, 'alpine-x64'), 'x86_64-unknown-linux-musl');
assert.throws(() => h2oTargetForVsix(lock, 'alpine-arm64'), /unsupported VSIX target/);

const clonedLock = () => JSON.parse(JSON.stringify(lock));
const wrongTag = clonedLock();
wrongTag.tagSha1 = '0'.repeat(40);
assert.throws(() => verifyReleaseStatement(wrongTag, statement), /unexpected tag object/);

const firstTarget = Object.keys(lock.assets)[0];
const wrongDigest = clonedLock();
wrongDigest.assets[firstTarget].archiveSha256 = '0'.repeat(64);
assert.throws(() => verifyReleaseStatement(wrongDigest, statement), /digest differs/);

const unsafeArchive = clonedLock();
unsafeArchive.assets[firstTarget].archive = '../escape.tar.gz';
assert.throws(() => validateH2oLock(unsafeArchive), /invalid archive name/);

const unsafeTarget = clonedLock();
unsafeTarget.assets['..'] = unsafeTarget.assets[firstTarget];
delete unsafeTarget.assets[firstTarget];
assert.throws(() => validateH2oLock(unsafeTarget), /invalid H2O target/);

const unknownVsixAsset = clonedLock();
unknownVsixAsset.vsixTargets['linux-riscv64'] = 'riscv64-unknown-linux-gnu';
assert.throws(() => validateH2oLock(unknownVsixAsset), /unknown H2O target/);

const dynamicAlpine = clonedLock();
delete dynamicAlpine.assets[dynamicAlpine.vsixTargets['alpine-x64']].static;
assert.throws(() => validateH2oLock(dynamicAlpine), /requires a static H2O asset/);

const x64ElfHeader = Buffer.alloc(120);
Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(x64ElfHeader);
x64ElfHeader[4] = 2;
x64ElfHeader[5] = 1;
Buffer.from([0x3e, 0x00]).copy(x64ElfHeader, 18);
verifyBinaryHeader(x64ElfHeader, 'x86_64-unknown-linux-musl');
assert.throws(() => verifyBinaryHeader(x64ElfHeader, 'aarch64-unknown-linux-gnu'), /wrong CPU architecture/);
assert.throws(() => verifyBinaryHeader(x64ElfHeader, 'x86_64-apple-darwin'), /wrong executable format/);

x64ElfHeader.writeBigUInt64LE(64n, 32);
x64ElfHeader.writeUInt16LE(56, 54);
x64ElfHeader.writeUInt16LE(1, 56);
x64ElfHeader.writeUInt32LE(1, 64);
verifyStaticElf(x64ElfHeader, 'x86_64-unknown-linux-musl');
x64ElfHeader.writeUInt32LE(3, 64);
assert.throws(() => verifyStaticElf(x64ElfHeader, 'x86_64-unknown-linux-musl'), /PT_INTERP/);

const expectedBinary = lock.assets[firstTarget].binary;
validateArchiveEntries([expectedBinary], expectedBinary);
assert.throws(() => validateArchiveEntries([expectedBinary, expectedBinary], expectedBinary), /must contain only/);
assert.throws(() => validateArchiveEntries(['../escape'], expectedBinary), /must contain only/);

const archiveFixture = mkdtempSync(path.join(tmpdir(), 'vscode-h2o-archive-test-'));
try {
  const symlinkPath = path.join(archiveFixture, expectedBinary);
  symlinkSync('/dev/null', symlinkPath);
  assert.throws(
    () => verifyExtractedBinary(symlinkPath, firstTarget, lock.assets[firstTarget]),
    /not a regular file/,
  );
  rmSync(symlinkPath);
  mkdirSync(symlinkPath);
  assert.throws(
    () => verifyExtractedBinary(symlinkPath, firstTarget, lock.assets[firstTarget]),
    /not a regular file/,
  );
} finally {
  rmSync(archiveFixture, { recursive: true, force: true });
}

const source = readFileSync(path.join(projectRoot, 'h2o.lock.json'), 'utf8');
assert.strictEqual(`${JSON.stringify(JSON.parse(source), null, 2)}\n`, source, 'h2o.lock.json must use canonical formatting');

console.log(`H2O release lock checks passed for ${Object.keys(lock.assets).length} assets.`);
