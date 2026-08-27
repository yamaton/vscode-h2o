import * as assert from 'assert';
import * as Parser from 'web-tree-sitter';
import { createBashParser, withParsedTree } from '../parserTestUtils';

function trackDeletion(tree: Parser.Tree): () => number {
  let count = 0;
  const originalDelete = tree.delete.bind(tree);
  tree.delete = () => {
    count += 1;
    originalDelete();
  };
  return () => count;
}

suite('parser test utilities', () => {
  let parser: Parser;

  suiteSetup(async () => {
    parser = await createBashParser();
  });

  suiteTeardown(() => {
    parser?.delete();
  });

  test('deletes parsed trees after synchronous callbacks finish', () => {
    let successDeleteCount = () => 0;
    const text = withParsedTree(parser, 'echo ok', tree => {
      successDeleteCount = trackDeletion(tree);
      return tree.rootNode.text;
    });

    assert.strictEqual(text, 'echo ok');
    assert.strictEqual(successDeleteCount(), 1);

    const expectedError = new Error('expected callback failure');
    let failureDeleteCount = () => 0;
    assert.throws(
      () => withParsedTree(parser, 'echo failed', tree => {
        failureDeleteCount = trackDeletion(tree);
        throw expectedError;
      }),
      error => error === expectedError,
    );
    assert.strictEqual(failureDeleteCount(), 1);
  });

  test('deletes parsed trees after asynchronous callbacks settle', async () => {
    let successDeleteCount = () => 0;
    const textPromise: Promise<string> = withParsedTree(parser, 'echo ok', async tree => {
      successDeleteCount = trackDeletion(tree);
      await Promise.resolve();
      assert.strictEqual(successDeleteCount(), 0);
      return tree.rootNode.text;
    });

    assert.strictEqual(successDeleteCount(), 0);
    assert.strictEqual(await textPromise, 'echo ok');
    assert.strictEqual(successDeleteCount(), 1);

    const expectedError = new Error('expected async callback failure');
    let failureDeleteCount = () => 0;
    const failurePromise = withParsedTree(parser, 'echo failed', async tree => {
      failureDeleteCount = trackDeletion(tree);
      await Promise.resolve();
      assert.strictEqual(failureDeleteCount(), 0);
      throw expectedError;
    });

    await assert.rejects(failurePromise, error => error === expectedError);
    assert.strictEqual(failureDeleteCount(), 1);
  });

  test('deletes parsed trees if inspecting a thenable throws', () => {
    const expectedError = new Error('expected then getter failure');
    const throwingThenable = Object.defineProperty({}, 'then', {
      get: () => {
        throw expectedError;
      },
    });
    let deleteCount = () => 0;

    assert.throws(
      () => withParsedTree(parser, 'echo failed', tree => {
        deleteCount = trackDeletion(tree);
        return throwingThenable;
      }),
      error => error === expectedError,
    );
    assert.strictEqual(deleteCount(), 1);
  });

  test('keeps parsed trees alive until callable thenables settle', async () => {
    const callableThenable = Object.assign(
      () => undefined,
      { then: (resolve: (value: string) => unknown): unknown => resolve('echo callable') },
    ) as unknown as PromiseLike<string>;
    let deleteCount = () => 0;

    const textPromise: Promise<string> = withParsedTree(parser, 'echo callable', tree => {
      deleteCount = trackDeletion(tree);
      return callableThenable;
    });

    assert.strictEqual(deleteCount(), 0);
    assert.strictEqual(await textPromise, 'echo callable');
    assert.strictEqual(deleteCount(), 1);
  });
});
