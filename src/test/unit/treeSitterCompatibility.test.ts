import * as assert from 'assert';
import { Edit, Parser } from 'web-tree-sitter';
import {
  createBashParser,
  descendantsOfType,
  parseTree,
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

  test('reports JavaScript UTF-16 offsets for editor-facing node ranges', () => {
    const source = 'echo 😀あ\r\ngit --flag';
    withParsedTree(parser, source, tree => {
      const firstCommand = tree.rootNode.firstNamedChild;
      const unicodeArgument = firstCommand?.childForFieldName('name')?.nextNamedSibling;
      assert.ok(unicodeArgument);
      assert.strictEqual(unicodeArgument.text, '😀あ');
      assert.strictEqual(unicodeArgument.startIndex, 5);
      assert.strictEqual(unicodeArgument.endIndex, 8);
      assert.deepStrictEqual(unicodeArgument.startPosition, { row: 0, column: 5 });
      assert.deepStrictEqual(unicodeArgument.endPosition, { row: 0, column: 8 });

      const secondCommand = firstCommand?.nextNamedSibling;
      assert.ok(secondCommand);
      assert.strictEqual(secondCommand.childForFieldName('name')?.text, 'git');
      assert.strictEqual(secondCommand.startIndex, 10);
      assert.deepStrictEqual(secondCommand.startPosition, { row: 1, column: 0 });
      assert.strictEqual(tree.rootNode.endIndex, source.length);
      assert.deepStrictEqual(tree.rootNode.endPosition, { row: 1, column: 10 });
    });
  });

  test('keeps incomplete and multiline input available to editor features', () => {
    withParsedTree(parser, 'git \\\n  --flag', multiline => {
      assert.strictEqual(multiline.rootNode.hasError, false);
      assert.deepStrictEqual(multiline.rootNode.endPosition, { row: 1, column: 8 });
      assert.strictEqual(multiline.rootNode.firstNamedChild?.childForFieldName('name')?.text, 'git');
      assert.strictEqual(multiline.rootNode.firstNamedChild?.lastNamedChild?.text, '--flag');
    });

    withParsedTree(parser, 'git "unterminated', incomplete => {
      assert.strictEqual(incomplete.rootNode.hasError, true);
      assert.strictEqual(incomplete.rootNode.firstNamedChild?.childForFieldName('name')?.text, 'git');
      assert.strictEqual(incomplete.rootNode.lastNamedChild?.type, 'ERROR');
      assert.strictEqual(incomplete.rootNode.lastNamedChild?.text, '"unterminated');
    });
  });

  test('exposes executable substitutions inside redirect payloads', () => {
    for (const { source, redirectType, substitutionType } of [
      {
        source: 'cat > "$(git status)"',
        redirectType: 'file_redirect',
        substitutionType: 'command_substitution',
      },
      {
        source: 'cat <<< "$(git status)"',
        redirectType: 'herestring_redirect',
        substitutionType: 'command_substitution',
      },
      {
        source: 'cat > >(git status)',
        redirectType: 'file_redirect',
        substitutionType: 'process_substitution',
      },
    ]) {
      withParsedTree(parser, source, tree => {
        assert.strictEqual(tree.rootNode.hasError, false, source);
        const commands = descendantsOfType(tree.rootNode, 'command');
        assert.deepStrictEqual(commands.map(node => node.text), [
          source.startsWith('cat <<<') ? source : 'cat',
          'git status',
        ], source);

        const innerCommand = commands[1];
        assert.ok(innerCommand, source);
        assert.strictEqual(innerCommand.parent?.type, substitutionType, source);
        assert.strictEqual(innerCommand.parent?.parent?.type === redirectType
          || innerCommand.parent?.parent?.parent?.type === redirectType, true, source);
      });
    }
  });

  test('incremental parsing matches a fresh parse after an edit', () => {
    const original = 'git status\necho ok';
    const updated = 'git log --oneline\necho ok';

    withParsedTree(parser, original, editedTree => {
      editedTree.edit(new Edit({
        startIndex: 4,
        oldEndIndex: 10,
        newEndIndex: 17,
        startPosition: { row: 0, column: 4 },
        oldEndPosition: { row: 0, column: 10 },
        newEndPosition: { row: 0, column: 17 },
      }));

      assert.strictEqual(editedTree.rootNode.endIndex, updated.length);
      assert.deepStrictEqual(editedTree.rootNode.endPosition, { row: 1, column: 7 });

      withTree(parseTree(parser, updated, editedTree), incremental => {
        withParsedTree(parser, updated, fresh => {
          assert.deepStrictEqual(snapshotNode(incremental.rootNode), snapshotNode(fresh.rootNode));
        });
      });
    });
  });

  test('rebuilds heredoc scanner state when quoting the delimiter', () => {
    const original = 'cat <<EOF\n$(git status)\nEOF';
    const updated = 'cat <<"EOF"\n$(git status)\nEOF';

    withParsedTree(parser, original, editedTree => {
      assert.deepStrictEqual(
        descendantsOfType(editedTree.rootNode, 'command').map(node => node.text),
        ['cat', 'git status'],
      );
      editedTree.edit(new Edit({
        startIndex: 6,
        oldEndIndex: 9,
        newEndIndex: 11,
        startPosition: { row: 0, column: 6 },
        oldEndPosition: { row: 0, column: 9 },
        newEndPosition: { row: 0, column: 11 },
      }));

      withTree(parseTree(parser, updated, editedTree), incremental => {
        withParsedTree(parser, updated, fresh => {
          assert.deepStrictEqual(snapshotNode(incremental.rootNode), snapshotNode(fresh.rootNode));
          assert.deepStrictEqual(
            descendantsOfType(incremental.rootNode, 'command').map(node => node.text),
            ['cat'],
          );
        });
      });
    });
  });

  test('rebuilds pending heredoc state when renaming the delimiter', () => {
    const original = 'cat <<EOF\nbody\nEOF';
    const updated = 'cat <<TAG\nbody\nEOF\nTAG';

    withParsedTree(parser, original, editedTree => {
      editedTree.edit(new Edit({
        startIndex: 6,
        oldEndIndex: 9,
        newEndIndex: 9,
        startPosition: { row: 0, column: 6 },
        oldEndPosition: { row: 0, column: 9 },
        newEndPosition: { row: 0, column: 9 },
      }));
      editedTree.edit(new Edit({
        startIndex: 18,
        oldEndIndex: 18,
        newEndIndex: 22,
        startPosition: { row: 2, column: 3 },
        oldEndPosition: { row: 2, column: 3 },
        newEndPosition: { row: 3, column: 3 },
      }));
      assert.strictEqual(editedTree.rootNode.endIndex, updated.length);
      assert.deepStrictEqual(editedTree.rootNode.endPosition, { row: 3, column: 3 });

      withTree(parseTree(parser, updated, editedTree), incremental => {
        withParsedTree(parser, updated, fresh => {
          assert.strictEqual(incremental.rootNode.hasError, false);
          assert.deepStrictEqual(snapshotNode(incremental.rootNode), snapshotNode(fresh.rootNode));
          assert.deepStrictEqual(
            descendantsOfType(incremental.rootNode, 'command').map(node => node.text),
            ['cat'],
          );
        });
      });
    });
  });
});
