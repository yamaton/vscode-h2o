import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  loadGrammarLock,
  validateGrammarLock,
  verifyGrammarArtifact,
  verifyGrammarLanguageVersion,
  verifyGrammarRuntimeCompatibility,
} from './lib/tree-sitter-grammar.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const lockPath = path.join(projectRoot, 'tree-sitter-bash.lock.json');
const lock = loadGrammarLock(lockPath);
const wasm = readFileSync(path.join(projectRoot, lock.file));
const clonedLock = () => JSON.parse(JSON.stringify(lock));

verifyGrammarArtifact(wasm, lock);
await verifyGrammarRuntimeCompatibility(wasm, lock);

const invalidSchema = clonedLock();
invalidSchema.schemaVersion = 2;
assert.throws(() => validateGrammarLock(invalidSchema), /unsupported schemaVersion/);

const unexpectedField = clonedLock();
unexpectedField.typo = true;
assert.throws(() => validateGrammarLock(unexpectedField), /missing or unexpected fields/);

const invalidAbi = clonedLock();
invalidAbi.languageAbiVersion = 0;
assert.throws(() => validateGrammarLock(invalidAbi), /invalid language ABI/);

const invalidProvenance = clonedLock();
invalidProvenance.provenance.status = 'unknown';
assert.throws(() => validateGrammarLock(invalidProvenance), /unsupported provenance/);

const invalidCommit = clonedLock();
invalidCommit.provenance.introducedByCommit = '9b68c5d';
assert.throws(() => validateGrammarLock(invalidCommit), /invalid introducing commit/);

const truncated = wasm.subarray(0, wasm.length - 1);
assert.throws(() => verifyGrammarArtifact(truncated, lock), /unexpected size/);

const invalidHeader = Buffer.from(wasm);
invalidHeader[0] = 0xff;
assert.throws(() => verifyGrammarArtifact(invalidHeader, lock), /invalid WebAssembly header/);

const wrongDigest = Buffer.from(wasm);
wrongDigest[wrongDigest.length - 1] ^= 0xff;
assert.throws(() => verifyGrammarArtifact(wrongDigest, lock), /SHA-256 verification/);

assert.throws(
  () => verifyGrammarLanguageVersion({ version: lock.languageAbiVersion + 1 }, lock),
  /unexpected tree-sitter language ABI version/,
);

const runtimeEvents = [];
class ControlledParser {
  static Language = {
    load: async content => {
      assert.strictEqual(content, wasm);
      runtimeEvents.push('load');
      return { version: lock.languageAbiVersion };
    },
  };

  static async init() {
    runtimeEvents.push('init');
  }

  constructor() {
    runtimeEvents.push('construct');
  }

  setLanguage(language) {
    assert.strictEqual(language.version, lock.languageAbiVersion);
    runtimeEvents.push('set-language');
  }

  parse(source) {
    assert.strictEqual(source, 'echo vscode-h2o');
    runtimeEvents.push('parse');
    return {
      rootNode: {
        type: 'program',
        firstNamedChild: { type: 'command' },
      },
      delete: () => runtimeEvents.push('delete-tree'),
    };
  }

  delete() {
    runtimeEvents.push('delete-parser');
  }
}
await verifyGrammarRuntimeCompatibility(wasm, lock, lock.file, ControlledParser);
assert.deepStrictEqual(runtimeEvents, [
  'init',
  'load',
  'construct',
  'set-language',
  'parse',
  'delete-tree',
  'delete-parser',
]);

const incompatibleLanguage = new Error('controlled incompatible language');
class IncompatibleParser extends ControlledParser {
  setLanguage() {
    runtimeEvents.push('set-language');
    throw incompatibleLanguage;
  }
}
runtimeEvents.length = 0;
await assert.rejects(
  verifyGrammarRuntimeCompatibility(wasm, lock, lock.file, IncompatibleParser),
  error => error === incompatibleLanguage,
);
assert.deepStrictEqual(runtimeEvents, [
  'init',
  'load',
  'construct',
  'set-language',
  'delete-parser',
]);

const source = readFileSync(lockPath, 'utf8');
assert.strictEqual(
  `${JSON.stringify(JSON.parse(source), null, 2)}\n`,
  source,
  'tree-sitter-bash.lock.json must use canonical formatting',
);

console.log(`Tree-sitter grammar lock checks passed for ABI ${lock.languageAbiVersion}.`);
