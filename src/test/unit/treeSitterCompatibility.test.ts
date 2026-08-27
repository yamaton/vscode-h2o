import * as assert from 'assert';
import * as Parser from 'web-tree-sitter';
import {
  createBashParser,
  snapshotNode,
  withParsedTree,
  withTree,
} from '../parserTestUtils';

suite('web-tree-sitter compatibility', () => {
  let parser: Parser;

  suiteSetup(async () => {
    parser = await createBashParser();
  });

  suiteTeardown(() => {
    parser?.delete();
  });

  test('loads the bundled Bash grammar and exposes command relationships', () => {
    const source = 'VAR=value echo あ --flag';
    withParsedTree(parser, source, tree => {
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
    });
  });

  test('keeps incomplete and multiline input available to editor features', () => {
    withParsedTree(parser, 'git \\\n  --flag', multiline => {
      assert.strictEqual(multiline.rootNode.hasError(), false);
      assert.deepStrictEqual(multiline.rootNode.endPosition, { row: 1, column: 8 });
      assert.strictEqual(multiline.rootNode.firstNamedChild?.childForFieldName('name')?.text, 'git');
      assert.strictEqual(multiline.rootNode.firstNamedChild?.lastNamedChild?.text, '--flag');
    });

    withParsedTree(parser, 'git "unterminated', incomplete => {
      assert.strictEqual(incomplete.rootNode.hasError(), true);
      assert.strictEqual(incomplete.rootNode.firstNamedChild?.childForFieldName('name')?.text, 'git');
      assert.strictEqual(incomplete.rootNode.firstNamedChild?.lastNamedChild?.text, '"unterminated');
    });
  });

  test('incremental parsing matches a fresh parse after an edit', () => {
    const original = 'git status\necho ok';
    const updated = 'git log --oneline\necho ok';

    withParsedTree(parser, original, editedTree => {
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

      withTree(parser.parse(updated, editedTree), incremental => {
        withParsedTree(parser, updated, fresh => {
          assert.deepStrictEqual(snapshotNode(incremental.rootNode), snapshotNode(fresh.rootNode));
        });
      });
    });
  });
});
