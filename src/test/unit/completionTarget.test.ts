import * as assert from 'assert';
import { Node, Point } from 'web-tree-sitter';
import { getCompletionLookupTarget } from '../../completionTarget';
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
      getCompletionLookupTarget(command, position)
    );
  }

  test('suppresses completion in the middle of an effective command name', () => {
    assert.deepStrictEqual(target('mamb|x'), { kind: 'none' });
  });

  test('recognizes one-character, partial, and exact command names', () => {
    for (const markedSource of ['m|', 'mamb|', 'mamba|']) {
      assert.strictEqual(target(markedSource).kind, 'command-name', markedSource);
    }
    assert.deepStrictEqual(target('mamb|'), {
      kind: 'command-name',
      context: {
        atWordEnd: true,
        word: {
          text: 'mamb',
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 0, column: 4 },
        },
      },
    });
  });

  test('uses effective names behind assignments and transparent wrappers', () => {
    for (const markedSource of [
      'FOO=bar mamb|',
      'sudo mamb|',
      'sudo -u root mamb|',
      'sudo -- mamb|',
      'nohup sudo -u root -- mamb|',
    ]) {
      assert.strictEqual(target(markedSource).kind, 'command-name', markedSource);
    }
  });

  test('keeps an incomplete transparent wrapper available as a command name', () => {
    assert.strictEqual(target('sudo|').kind, 'command-name');
    assert.strictEqual(target('nohup|').kind, 'command-name');
  });

  test('suppresses lookup before an effective command name', () => {
    for (const markedSource of [
      'sudo| mamba',
      'sudo | mamba',
      'nohup| git',
      'FOO=bar sudo| mamba',
      'sudo nohup| mamba',
      'sudo -u ro|ot mamba',
    ]) {
      assert.deepStrictEqual(target(markedSource), { kind: 'none' }, markedSource);
    }
  });

  test('uses command-spec lookup for arguments and unresolved wrapper options', () => {
    assert.deepStrictEqual(target('mamba ar|g'), { kind: 'command-spec' });
    assert.deepStrictEqual(target('sudo -u ro|ot'), { kind: 'command-spec' });
    assert.deepStrictEqual(target('nohup --he|lp'), { kind: 'command-spec' });
  });
});
