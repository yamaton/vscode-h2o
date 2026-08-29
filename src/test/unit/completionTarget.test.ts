import * as assert from 'assert';
import { Node, Point } from 'web-tree-sitter';
import { getCommandNameCompletionContext } from '../../completionTarget';
import { createBashParser, withFirstNamedNode } from '../parserTestUtils';

suite('command-name completion targets', () => {
  let parser: Awaited<ReturnType<typeof createBashParser>>;

  suiteSetup(async () => {
    parser = await createBashParser();
  });

  suiteTeardown(() => {
    parser.delete();
  });

  function target(markedSource: string) {
    const caretOffset = markedSource.indexOf('|');
    assert.ok(caretOffset >= 0, markedSource);
    const source = markedSource.slice(0, caretOffset) + markedSource.slice(caretOffset + 1);
    const position: Point = { row: 0, column: caretOffset };
    return withFirstNamedNode(parser, source, (command: Node) =>
      getCommandNameCompletionContext(command, position)
    );
  }

  test('recognizes a mid-word caret but does not mark it as a completion target', () => {
    const completion = target('mamb|x');
    assert.deepStrictEqual(completion, {
      atWordEnd: false,
      word: {
        text: 'mambx',
        startPosition: { row: 0, column: 0 },
        endPosition: { row: 0, column: 5 },
      },
    });
  });

  test('recognizes one-character, partial, and exact command names', () => {
    assert.strictEqual(target('m|')?.atWordEnd, true);
    assert.strictEqual(target('mamb|')?.atWordEnd, true);
    assert.strictEqual(target('mamba|')?.atWordEnd, true);
  });

  test('uses effective names behind assignments and transparent wrappers', () => {
    for (const markedSource of [
      'FOO=bar mamb|',
      'sudo mamb|',
      'sudo -u root mamb|',
      'sudo -- mamb|',
      'nohup sudo -u root -- mamb|',
    ]) {
      assert.strictEqual(target(markedSource)?.atWordEnd, true, markedSource);
    }
  });

  test('keeps an incomplete transparent wrapper available as a command name', () => {
    assert.strictEqual(target('sudo|')?.atWordEnd, true);
    assert.strictEqual(target('nohup|')?.atWordEnd, true);
  });

  test('does not treat command arguments or wrapper options as command names', () => {
    assert.strictEqual(target('mamba ar|g'), undefined);
    assert.strictEqual(target('sudo -u ro|ot'), undefined);
    assert.strictEqual(target('nohup --he|lp'), undefined);
  });
});
