import * as assert from 'assert';
import * as path from 'path';
import * as Parser from 'web-tree-sitter';
import { SyntaxNode } from 'web-tree-sitter';

interface NodeSnapshot {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: Parser.Point;
  endPosition: Parser.Point;
  hasError: boolean;
  children: NodeSnapshot[];
}

function snapshot(node: SyntaxNode): NodeSnapshot {
  return {
    type: node.type,
    text: node.text,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    startPosition: node.startPosition,
    endPosition: node.endPosition,
    hasError: node.hasError(),
    children: node.children.map(snapshot),
  };
}

suite('web-tree-sitter compatibility', () => {
  let parser: Parser;

  suiteSetup(async () => {
    await Parser.init();
    parser = new Parser();
    const wasmPath = path.resolve(__dirname, '../../../tree-sitter-bash.wasm');
    parser.setLanguage(await Parser.Language.load(wasmPath));
  });

  suiteTeardown(() => {
    parser.delete();
  });

  test('loads the bundled Bash grammar and exposes command relationships', () => {
    const source = 'VAR=value echo あ --flag';
    const tree = parser.parse(source);
    const command = tree.rootNode.firstNamedChild;
    assert.ok(command);
    assert.strictEqual(command.type, 'command');
    assert.strictEqual(command.parent?.type, 'program');

    const name = command.childForFieldName('name');
    assert.ok(name);
    assert.strictEqual(name.type, 'command_name');
    assert.strictEqual(name.text, 'echo');
    assert.strictEqual(name.parent?.type, 'command');
    assert.strictEqual(name.firstNamedChild?.text, 'echo');

    const unicodeArgument = name.nextNamedSibling;
    assert.strictEqual(unicodeArgument?.text, 'あ');
    assert.deepStrictEqual(unicodeArgument?.startPosition, { row: 0, column: 15 });
    assert.deepStrictEqual(unicodeArgument?.endPosition, { row: 0, column: 16 });
    assert.strictEqual(unicodeArgument?.nextNamedSibling?.text, '--flag');
    assert.strictEqual(tree.rootNode.endIndex, source.length);
    tree.delete();
  });

  test('keeps incomplete and multiline input available to editor features', () => {
    const multiline = parser.parse('git \\\n  --flag');
    assert.strictEqual(multiline.rootNode.hasError(), false);
    assert.deepStrictEqual(multiline.rootNode.endPosition, { row: 1, column: 8 });
    assert.strictEqual(multiline.rootNode.firstNamedChild?.childForFieldName('name')?.text, 'git');
    assert.strictEqual(multiline.rootNode.firstNamedChild?.lastNamedChild?.text, '--flag');
    multiline.delete();

    const incomplete = parser.parse('git "unterminated');
    assert.strictEqual(incomplete.rootNode.hasError(), true);
    assert.strictEqual(incomplete.rootNode.firstNamedChild?.childForFieldName('name')?.text, 'git');
    assert.strictEqual(incomplete.rootNode.firstNamedChild?.lastNamedChild?.text, '"unterminated');
    incomplete.delete();
  });

  test('incremental parsing matches a fresh parse after an edit', () => {
    const original = 'git status\necho ok';
    const updated = 'git log --oneline\necho ok';
    const editedTree = parser.parse(original);

    editedTree.edit({
      startIndex: 4,
      oldEndIndex: 10,
      newEndIndex: 17,
      startPosition: { row: 0, column: 4 },
      oldEndPosition: { row: 0, column: 10 },
      newEndPosition: { row: 0, column: 17 },
    });

    assert.strictEqual(editedTree.rootNode.endIndex, updated.length);
    assert.deepStrictEqual(editedTree.rootNode.endPosition, { row: 1, column: 7 });

    const incremental = parser.parse(updated, editedTree);
    const fresh = parser.parse(updated);
    assert.deepStrictEqual(snapshot(incremental.rootNode), snapshot(fresh.rootNode));

    incremental.delete();
    fresh.delete();
    editedTree.delete();
  });
});
