import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Parser from 'web-tree-sitter';

const sha1Pattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const wasmHeader = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function assertExactKeys(value, expected, description) {
  assert.deepStrictEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${description} has missing or unexpected fields`,
  );
}

export function loadGrammarLock(lockPath) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  validateGrammarLock(lock);
  return lock;
}

export function validateGrammarLock(lock) {
  assert.ok(lock && typeof lock === 'object' && !Array.isArray(lock), 'grammar lock must be an object');
  assertExactKeys(lock, [
    'schemaVersion',
    'language',
    'file',
    'languageAbiVersion',
    'wasmSize',
    'wasmSha256',
    'provenance',
  ], 'grammar lock');
  assert.strictEqual(lock.schemaVersion, 1, 'grammar lock has an unsupported schemaVersion');
  assert.strictEqual(lock.language, 'bash', 'grammar lock has an unexpected language');
  assert.strictEqual(lock.file, 'tree-sitter-bash.wasm', 'grammar lock has an unexpected file');
  assert.ok(
    Number.isSafeInteger(lock.languageAbiVersion) && lock.languageAbiVersion > 0,
    'grammar lock has an invalid language ABI version',
  );
  assert.ok(Number.isSafeInteger(lock.wasmSize) && lock.wasmSize > 0, 'grammar lock has an invalid WASM size');
  assert.match(lock.wasmSha256, sha256Pattern, 'grammar lock has an invalid WASM SHA-256');
  assert.ok(
    lock.provenance && typeof lock.provenance === 'object' && !Array.isArray(lock.provenance),
    'grammar lock has invalid provenance',
  );

  if (lock.provenance.status === 'legacy-unresolved') {
    assertExactKeys(lock.provenance, ['status', 'introducedByCommit'], 'legacy grammar provenance');
    assert.match(
      lock.provenance.introducedByCommit,
      sha1Pattern,
      'legacy grammar provenance has an invalid introducing commit',
    );
    return;
  }

  assert.strictEqual(lock.provenance.status, 'pinned-upstream', 'grammar lock has unsupported provenance');
  assertExactKeys(lock.provenance, ['status', 'repository', 'revision'], 'upstream grammar provenance');
  assert.match(
    lock.provenance.repository,
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    'upstream grammar provenance has an invalid repository',
  );
  assert.match(lock.provenance.revision, sha1Pattern, 'upstream grammar provenance has an invalid revision');
}

export function verifyGrammarArtifact(content, lock, description = lock.file) {
  assert.ok(Buffer.isBuffer(content) || content instanceof Uint8Array, `${description} must be binary data`);
  assert.strictEqual(content.length, lock.wasmSize, `${description} has an unexpected size`);
  assert.deepStrictEqual(
    Buffer.from(content.subarray(0, wasmHeader.length)),
    wasmHeader,
    `${description} has an invalid WebAssembly header`,
  );
  assert.strictEqual(
    createHash('sha256').update(content).digest('hex'),
    lock.wasmSha256,
    `${description} failed SHA-256 verification`,
  );
}

export function verifyGrammarLanguageVersion(language, lock, description = lock.file) {
  assert.strictEqual(
    language.version,
    lock.languageAbiVersion,
    `${description} has an unexpected tree-sitter language ABI version`,
  );
}

export async function verifyGrammarRuntimeCompatibility(
  content,
  lock,
  description = lock.file,
  parserRuntime = Parser,
) {
  await parserRuntime.init();
  const language = await parserRuntime.Language.load(content);
  verifyGrammarLanguageVersion(language, lock, description);

  const parser = new parserRuntime();
  let tree;
  try {
    parser.setLanguage(language);
    tree = parser.parse('echo vscode-h2o');
    assert.ok(tree, `${description} could not parse the compatibility fixture`);
    assert.strictEqual(tree.rootNode.type, 'program', `${description} produced an unexpected root node`);
    assert.strictEqual(
      tree.rootNode.firstNamedChild?.type,
      'command',
      `${description} did not parse the compatibility fixture as a Bash command`,
    );
  } finally {
    try {
      tree?.delete();
    } finally {
      parser.delete();
    }
  }
}
