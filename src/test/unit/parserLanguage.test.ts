import * as assert from 'assert';
import * as path from 'path';
import * as Parser from 'web-tree-sitter';
import { createCachedLanguageLoader } from '../../parserLanguage';

suite('parser language loading', () => {
  test('coalesces equivalent sequential and concurrent paths', async () => {
    const loadedPaths: string[] = [];
    const languages: Parser.Language[] = [];
    const loadLanguage = createCachedLanguageLoader(async wasmPath => {
      loadedPaths.push(wasmPath);
      const language = {} as Parser.Language;
      languages.push(language);
      return language;
    });
    const canonicalPath = path.resolve('grammars', 'tree-sitter-bash.wasm');
    const equivalentPath = path.join(
      process.cwd(),
      'grammars',
      'nested',
      '..',
      'tree-sitter-bash.wasm',
    );

    const [first, second] = await Promise.all([
      loadLanguage(canonicalPath),
      loadLanguage(equivalentPath),
    ]);
    const third = await loadLanguage(canonicalPath);
    const other = await loadLanguage(path.resolve('grammars', 'tree-sitter-zsh.wasm'));

    assert.strictEqual(first, second);
    assert.strictEqual(second, third);
    assert.notStrictEqual(third, other);
    assert.deepStrictEqual(loadedPaths, [
      canonicalPath,
      path.resolve('grammars', 'tree-sitter-zsh.wasm'),
    ]);
    assert.strictEqual(languages.length, 2);
  });

  test('retains synchronous loader failures', async () => {
    const expectedError = new Error('controlled synchronous load failure');
    let loadCount = 0;
    const loadLanguage = createCachedLanguageLoader(() => {
      loadCount += 1;
      throw expectedError;
    });

    const first = loadLanguage('tree-sitter-bash.wasm');
    const second = loadLanguage('./tree-sitter-bash.wasm');

    assert.strictEqual(first, second);
    await assert.rejects(first, error => error === expectedError);
    await assert.rejects(
      loadLanguage('tree-sitter-bash.wasm'),
      error => error === expectedError,
    );
    assert.strictEqual(loadCount, 1);
  });

  test('retains asynchronous loader failures', async () => {
    const expectedError = new Error('controlled asynchronous load failure');
    let loadCount = 0;
    const loadLanguage = createCachedLanguageLoader(async () => {
      loadCount += 1;
      await Promise.resolve();
      throw expectedError;
    });

    const results = await Promise.allSettled([
      loadLanguage('tree-sitter-bash.wasm'),
      loadLanguage('./tree-sitter-bash.wasm'),
    ]);

    assert.strictEqual(results.length, 2);
    for (const result of results) {
      assert.strictEqual(result.status, 'rejected');
      if (result.status === 'rejected') {
        assert.strictEqual(result.reason, expectedError);
      }
    }
    await assert.rejects(
      loadLanguage('tree-sitter-bash.wasm'),
      error => error === expectedError,
    );
    assert.strictEqual(loadCount, 1);
  });
});
