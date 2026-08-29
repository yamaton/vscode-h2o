import * as assert from 'assert';
import { Parser, Tree } from 'web-tree-sitter';
import {
  DocumentTreeCache,
  TreeCache,
  TreeDocumentChangeLike,
} from '../../treeCache';
import { createBashParser, snapshotNode, withParsedTree } from '../parserTestUtils';

interface TestPosition {
  line: number;
  character: number;
}

class TestDocument {
  public readonly uri: { toString(): string };
  public readonly languageId = 'shellscript';
  public version = 1;
  public isClosed = false;
  public getTextCalls = 0;

  public constructor(
    uri: string,
    private content: string,
  ) {
    this.uri = { toString: () => uri };
  }

  public getText(): string {
    this.getTextCalls += 1;
    return this.content;
  }

  public replace(replacements: Array<{ offset: number; length: number; text: string }>): TreeDocumentChangeLike {
    const original = this.content;
    const contentChanges = replacements.map(replacement => ({
      range: {
        start: this.positionAt(original, replacement.offset),
        end: this.positionAt(original, replacement.offset + replacement.length),
      },
      rangeOffset: replacement.offset,
      rangeLength: replacement.length,
      text: replacement.text,
    }));
    for (const replacement of [...replacements].sort((left, right) => right.offset - left.offset)) {
      this.content = this.content.slice(0, replacement.offset)
        + replacement.text
        + this.content.slice(replacement.offset + replacement.length);
    }
    this.version += 1;
    return { document: this, contentChanges };
  }

  public setContent(content: string): void {
    this.content = content;
    this.version += 1;
  }

  private positionAt(content: string, offset: number): TestPosition {
    let line = 0;
    let character = 0;
    for (let index = 0; index < offset; index += 1) {
      if (content.charCodeAt(index) === 10) {
        line += 1;
        character = 0;
      } else {
        character += 1;
      }
    }
    return { line, character };
  }
}

class ManualScheduler {
  private readonly callbacks = new Map<NodeJS.Timeout, () => void>();

  public readonly schedule = (callback: () => void): NodeJS.Timeout => {
    const handle = {} as NodeJS.Timeout;
    this.callbacks.set(handle, callback);
    return handle;
  };

  public readonly cancel = (handle: NodeJS.Timeout): void => {
    this.callbacks.delete(handle);
  };

  public runAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) {
      callback();
    }
  }

  public get size(): number {
    return this.callbacks.size;
  }
}

function trackDeletion(tree: Tree): () => number {
  let count = 0;
  const originalDelete = tree.delete.bind(tree);
  tree.delete = () => {
    count += 1;
    originalDelete();
  };
  return () => count;
}

function disposeTrees(trees: TreeCache): void {
  for (const key of Object.keys(trees)) {
    trees[key].delete();
    delete trees[key];
  }
}

suite('document tree cache', () => {
  let parser: Parser;

  suiteSetup(async () => {
    parser = await createBashParser();
  });

  suiteTeardown(() => {
    parser?.delete();
  });

  test('keeps edited documents lazy until a parser-backed feature requests them', async () => {
    const trees: TreeCache = {};
    const scheduler = new ManualScheduler();
    const cache = new DocumentTreeCache(parser, trees, {
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    });
    const document = new TestDocument('test:laziness', 'git status');
    const event = document.replace([{ offset: 3, length: 0, text: ' log' }]);

    assert.strictEqual(cache.update(event), false);
    assert.strictEqual(document.getTextCalls, 0);
    assert.strictEqual(scheduler.size, 0);
    assert.deepStrictEqual(Object.keys(trees), []);

    const tree = await cache.get(document);
    assert.ok(tree);
    assert.strictEqual(tree.rootNode.text, document.getText());
    assert.strictEqual(scheduler.size, 0);

    cache.dispose();
    disposeTrees(trees);
  });

  test('reports only synchronous parser time for initial and incremental access', async () => {
    const trees: TreeCache = {};
    const scheduler = new ManualScheduler();
    const readings = [10, 14, 20, 26];
    const cache = new DocumentTreeCache(parser, trees, {
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
      now: () => readings.shift()!,
    });
    const document = new TestDocument('test:timing', 'git status');

    const initial = await cache.getWithTiming(document);
    assert.ok(initial.tree);
    assert.strictEqual(initial.parseMs, 4);

    const cached = await cache.getWithTiming(document);
    assert.strictEqual(cached.tree, initial.tree);
    assert.strictEqual(cached.parseMs, 0);

    assert.strictEqual(cache.update(document.replace([
      { offset: 4, length: 6, text: 'log --oneline' },
    ])), true);
    const pending = cache.getWithTiming(document);
    scheduler.runAll();
    const incremental = await pending;
    assert.ok(incremental.tree);
    assert.strictEqual(incremental.parseMs, 6);
    assert.deepStrictEqual(readings, []);

    cache.dispose();
    disposeTrees(trees);
  });

  test('coalesces sequential edits into one pending incremental parse', async () => {
    const trees: TreeCache = {};
    const scheduler = new ManualScheduler();
    const cache = new DocumentTreeCache(parser, trees, {
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    });
    const document = new TestDocument('test:coalescing', 'git status\necho 😀\n');
    const initialTree = await cache.get(document);
    assert.ok(initialTree);
    const initialDeleteCount = trackDeletion(initialTree);
    const getTextCallsBeforeEdits = document.getTextCalls;

    assert.strictEqual(cache.update(document.replace([
      { offset: 4, length: 6, text: 'log --oneline' },
    ])), true);
    const unicodeOffset = document.getText().indexOf('😀');
    assert.strictEqual(cache.update(document.replace([
      { offset: unicodeOffset, length: 2, text: '🎉い' },
      { offset: document.getText().length, length: 0, text: 'npm test\n' },
    ])), true);

    assert.strictEqual(trees[document.uri.toString()], initialTree);
    assert.strictEqual(initialDeleteCount(), 0);
    assert.strictEqual(scheduler.size, 1);
    assert.strictEqual(document.getTextCalls, getTextCallsBeforeEdits + 2);

    let requestSettled = false;
    const pendingTree = cache.get(document).then(tree => {
      requestSettled = true;
      return tree;
    });
    await Promise.resolve();
    assert.strictEqual(requestSettled, false);

    scheduler.runAll();
    const parsedTree = await pendingTree;
    assert.ok(parsedTree);
    assert.notStrictEqual(parsedTree, initialTree);
    assert.strictEqual(initialDeleteCount(), 1);
    assert.strictEqual(scheduler.size, 0);
    withParsedTree(parser, document.getText(), fresh => {
      assert.deepStrictEqual(snapshotNode(parsedTree.rootNode), snapshotNode(fresh.rootNode));
    });

    cache.dispose();
    disposeTrees(trees);
  });

  test('limits oversized documents without repeatedly reporting the same document', async () => {
    const trees: TreeCache = {};
    const limited: Array<{ characters: number; maximum: number }> = [];
    const cache = new DocumentTreeCache(parser, trees, {
      maximumDocumentCharacters: () => 10,
      onDocumentLimited: (_document, characters, maximum) => limited.push({ characters, maximum }),
    });
    const document = new TestDocument('test:limited', 'echo oversized');

    assert.strictEqual(await cache.get(document), undefined);
    assert.strictEqual(await cache.get(document), undefined);
    assert.strictEqual(document.getTextCalls, 1);
    assert.deepStrictEqual(limited, [{ characters: 14, maximum: 10 }]);
    assert.deepStrictEqual(Object.keys(trees), []);

    document.setContent('echo still oversized');
    assert.strictEqual(await cache.get(document), undefined);
    assert.strictEqual(document.getTextCalls, 2);
    assert.deepStrictEqual(limited, [{ characters: 14, maximum: 10 }]);

    document.setContent('echo ok');
    const tree = await cache.get(document);
    assert.ok(tree);
    assert.strictEqual(tree.rootNode.text, 'echo ok');
    assert.strictEqual(document.getTextCalls, 3);

    cache.dispose();
    disposeTrees(trees);
  });

  test('rechecks a limited document when its configured maximum increases', async () => {
    const trees: TreeCache = {};
    let maximum = 10;
    const cache = new DocumentTreeCache(parser, trees, {
      maximumDocumentCharacters: () => maximum,
    });
    const document = new TestDocument('test:raised-limit', 'echo oversized');

    assert.strictEqual(await cache.get(document), undefined);
    assert.strictEqual(document.getTextCalls, 1);

    maximum = 20;
    const tree = await cache.get(document);
    assert.ok(tree);
    assert.strictEqual(tree.rootNode.text, 'echo oversized');
    assert.strictEqual(document.getTextCalls, 2);

    cache.dispose();
    disposeTrees(trees);
  });

  test('cancels a pending parse when an edit grows a cached document over the limit', async () => {
    const trees: TreeCache = {};
    const scheduler = new ManualScheduler();
    const cache = new DocumentTreeCache(parser, trees, {
      maximumDocumentCharacters: () => 10,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    });
    const document = new TestDocument('test:growing-over-limit', 'echo ok');
    const tree = await cache.get(document);
    assert.ok(tree);
    const deleteCount = trackDeletion(tree);
    const getTextCallsBeforeEdit = document.getTextCalls;

    assert.strictEqual(cache.update(document.replace([{
      offset: 7,
      length: 0,
      text: ' oversized',
    }])), true);
    assert.strictEqual(scheduler.size, 1);

    assert.strictEqual(await cache.get(document), undefined);
    assert.strictEqual(scheduler.size, 0);
    assert.strictEqual(document.getTextCalls, getTextCallsBeforeEdit);
    assert.strictEqual(deleteCount(), 1);
    assert.deepStrictEqual(Object.keys(trees), []);

    cache.dispose();
  });

  test('cancels pending work and deletes the cached tree when a document closes', async () => {
    const trees: TreeCache = {};
    const scheduler = new ManualScheduler();
    const cache = new DocumentTreeCache(parser, trees, {
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    });
    const document = new TestDocument('test:close', 'git status');
    const tree = await cache.get(document);
    assert.ok(tree);
    const deleteCount = trackDeletion(tree);
    cache.update(document.replace([{ offset: 10, length: 0, text: '\n' }]));
    const pendingTree = cache.get(document);

    document.isClosed = true;
    cache.close(document);
    assert.strictEqual(await pendingTree, undefined);
    assert.strictEqual(deleteCount(), 1);
    assert.strictEqual(scheduler.size, 0);
    assert.deepStrictEqual(Object.keys(trees), []);

    cache.dispose();
  });
});
