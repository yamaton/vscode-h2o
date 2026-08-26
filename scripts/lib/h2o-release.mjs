import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const sha1Pattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const safeNamePattern = /^[A-Za-z0-9._-]+$/;
const binaryHeaders = {
  'aarch64-apple-darwin': {
    magic: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    machineOffset: 4,
    machine: Buffer.from([0x0c, 0x00, 0x00, 0x01]),
  },
  'aarch64-unknown-linux-gnu': {
    magic: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    machineOffset: 18,
    machine: Buffer.from([0xb7, 0x00]),
  },
  'x86_64-apple-darwin': {
    magic: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    machineOffset: 4,
    machine: Buffer.from([0x07, 0x00, 0x00, 0x01]),
  },
  'x86_64-unknown-linux-gnu': {
    magic: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    machineOffset: 18,
    machine: Buffer.from([0x3e, 0x00]),
  },
  'x86_64-unknown-linux-musl': {
    magic: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    machineOffset: 18,
    machine: Buffer.from([0x3e, 0x00]),
  },
};

function assertSafeName(name, description) {
  assert.match(name, safeNamePattern, `invalid ${description}: ${name}`);
  assert.ok(name !== '.' && name !== '..', `invalid ${description}: ${name}`);
}

export function loadH2oLock(lockPath) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  validateH2oLock(lock);
  return lock;
}

export function validateH2oLock(lock) {
  assert.strictEqual(lock?.schemaVersion, 1, 'h2o.lock.json has an unsupported schemaVersion');
  assert.match(lock.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'invalid H2O repository');
  assert.match(lock.tag, /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/, 'invalid H2O release tag');
  assert.match(lock.tagSha1, sha1Pattern, 'invalid H2O release tag SHA-1');
  assert.ok(lock.assets && Object.keys(lock.assets).length > 0, 'H2O lock has no assets');
  assert.ok(lock.vsixTargets && Object.keys(lock.vsixTargets).length > 0, 'H2O lock has no VSIX targets');

  const archiveNames = new Set();
  const binaryNames = new Set();
  for (const [target, asset] of Object.entries(lock.assets)) {
    assertSafeName(target, 'H2O target');
    assert.ok(binaryHeaders[target], `unsupported H2O target: ${target}`);
    assertSafeName(asset.archive, `archive name for ${target}`);
    assertSafeName(asset.binary, `binary name for ${target}`);
    assert.strictEqual(asset.binary, `h2o-${target}`, `unexpected binary name for ${target}`);
    assert.strictEqual(asset.archive, `${asset.binary}.tar.gz`, `unexpected archive name for ${target}`);
    assert.match(asset.archiveSha256, sha256Pattern, `invalid archive SHA-256 for ${target}`);
    assert.match(asset.binarySha256, sha256Pattern, `invalid binary SHA-256 for ${target}`);
    assert.ok(Number.isSafeInteger(asset.archiveSize) && asset.archiveSize > 0, `invalid archive size for ${target}`);
    assert.ok(Number.isSafeInteger(asset.binarySize) && asset.binarySize > 0, `invalid binary size for ${target}`);
    assert.ok(asset.static === undefined || typeof asset.static === 'boolean', `invalid static flag for ${target}`);
    assert.ok(!asset.static || target.includes('-linux-'), `static flag is only supported for ELF targets: ${target}`);
    assert.ok(!archiveNames.has(asset.archive), `duplicate archive in H2O lock: ${asset.archive}`);
    assert.ok(!binaryNames.has(asset.binary), `duplicate binary in H2O lock: ${asset.binary}`);
    archiveNames.add(asset.archive);
    binaryNames.add(asset.binary);
  }

  for (const [vsixTarget, h2oTarget] of Object.entries(lock.vsixTargets)) {
    assertSafeName(vsixTarget, 'VSIX target');
    assert.ok(lock.assets[h2oTarget], `VSIX target ${vsixTarget} refers to an unknown H2O target: ${h2oTarget}`);
    if (vsixTarget.startsWith('alpine-')) {
      assert.strictEqual(lock.assets[h2oTarget].static, true, `${vsixTarget} requires a static H2O asset`);
    }
  }
}

export function h2oTargetForVsix(lock, vsixTarget) {
  const h2oTarget = lock.vsixTargets[vsixTarget];
  assert.ok(h2oTarget, `unsupported VSIX target: ${vsixTarget}`);
  return h2oTarget;
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function verifyFile(filePath, expectedSize, expectedSha256, description = path.basename(filePath)) {
  assert.strictEqual(statSync(filePath).size, expectedSize, `${description} has an unexpected size`);
  assert.strictEqual(sha256File(filePath), expectedSha256, `${description} failed SHA-256 verification`);
}

export function verifyBinaryHeader(content, target) {
  const expected = binaryHeaders[target];
  assert.ok(expected, `unsupported H2O target: ${target}`);
  assert.deepStrictEqual(
    content.subarray(0, expected.magic.length),
    expected.magic,
    `${target} has the wrong executable format`,
  );
  assert.deepStrictEqual(
    content.subarray(expected.machineOffset, expected.machineOffset + expected.machine.length),
    expected.machine,
    `${target} has the wrong CPU architecture`,
  );
}

export function verifyStaticElf(content, target) {
  assert.strictEqual(content[4], 2, `${target} must use the ELF64 class`);
  assert.strictEqual(content[5], 1, `${target} must use little-endian ELF encoding`);
  const programHeaderOffset = Number(content.readBigUInt64LE(32));
  const programHeaderSize = content.readUInt16LE(54);
  const programHeaderCount = content.readUInt16LE(56);
  assert.ok(Number.isSafeInteger(programHeaderOffset), `${target} has an invalid ELF program header offset`);
  assert.ok(programHeaderSize >= 56, `${target} has an invalid ELF program header size`);
  assert.ok(
    programHeaderOffset + (programHeaderSize * programHeaderCount) <= content.length,
    `${target} has truncated ELF program headers`,
  );
  for (let index = 0; index < programHeaderCount; index += 1) {
    const offset = programHeaderOffset + (index * programHeaderSize);
    assert.notStrictEqual(content.readUInt32LE(offset), 3, `${target} must not contain a PT_INTERP segment`);
  }
}

export function verifyBinary(filePath, target, asset) {
  verifyFile(filePath, asset.binarySize, asset.binarySha256, asset.binary);
  const content = readFileSync(filePath);
  verifyBinaryHeader(content, target);
  if (asset.static) {
    verifyStaticElf(content, target);
  }
}

export function validateArchiveEntries(entries, expectedBinary) {
  assert.deepStrictEqual(entries, [expectedBinary], `archive must contain only ${expectedBinary}`);
}

export function verifyExtractedBinary(filePath, target, asset) {
  assert.ok(lstatSync(filePath).isFile(), `${asset.binary} is not a regular file`);
  verifyBinary(filePath, target, asset);
}

export function verifyImmutableRelease(lock, options = {}) {
  const run = options.execFileSync ?? execFileSync;
  const output = run(
    'gh',
    ['release', 'verify', lock.tag, '--repo', lock.repository, '--format', 'json'],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  const verification = JSON.parse(output);
  verifyReleaseStatement(lock, verification.verificationResult?.statement);
  return verification;
}

export function verifyReleaseStatement(lock, statement) {
  assert.ok(statement, 'GitHub returned no verified release statement');
  assert.strictEqual(
    statement.predicateType,
    'https://in-toto.io/attestation/release/v0.2',
    'GitHub returned an unexpected release attestation type',
  );
  assert.strictEqual(statement.predicate?.repository, lock.repository, 'release attestation has the wrong repository');
  assert.strictEqual(statement.predicate?.tag, lock.tag, 'release attestation has the wrong tag');

  const expectedReleaseUri = `pkg:github/${lock.repository}@${lock.tag}`;
  const release = statement.subject?.find((subject) => subject.uri === expectedReleaseUri);
  assert.ok(release, `release attestation has no subject for ${expectedReleaseUri}`);
  assert.strictEqual(release.digest?.sha1, lock.tagSha1, 'release resolves to an unexpected tag object');

  const subjects = new Map(
    statement.subject
      .filter((subject) => typeof subject.name === 'string')
      .map((subject) => [subject.name, subject.digest?.sha256]),
  );
  for (const [target, asset] of Object.entries(lock.assets)) {
    assert.strictEqual(
      subjects.get(asset.archive),
      asset.archiveSha256,
      `release attestation digest differs from the lock for ${target}`,
    );
  }
}
