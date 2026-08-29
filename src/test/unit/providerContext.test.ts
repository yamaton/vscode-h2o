import * as assert from 'assert';
import { Parser, Point } from 'web-tree-sitter';

import {
  getCompletionCommandNodeAtPoint,
  getProviderSuppressionReasonsAtPoint,
  resolveCompletionAnchor,
} from '../../providerContext';
import { createBashParser, withParsedTree } from '../parserTestUtils';

const caretMarker = '<caret>';

function markedSource(marked: string): { source: string; point: Point } {
  const offset = marked.indexOf(caretMarker);
  assert.notStrictEqual(offset, -1, marked);
  const source = marked.slice(0, offset) + marked.slice(offset + caretMarker.length);
  const lines = source.slice(0, offset).split('\n');
  return {
    source,
    point: { row: lines.length - 1, column: lines[lines.length - 1].length },
  };
}

function lineProvider(source: string): { lineAt(line: number): { text: string } } {
  const lines = source.split('\n');
  return { lineAt: line => ({ text: lines[line] ?? '' }) };
}

suite('provider syntax context', () => {
  let parser: Parser;

  suiteSetup(async () => {
    parser = await createBashParser();
  });

  suiteTeardown(() => {
    parser?.delete();
  });

  test('classifies executable redirect payload boundaries', () => {
    for (const { marked, expected } of [
      { marked: `cat > "$(git --x${caretMarker})"`, expected: [] },
      { marked: `cat > "$(git --x)${caretMarker}"`, expected: ['file_redirect'] },
      { marked: `cat > >(git --x${caretMarker}`, expected: [] },
      { marked: `cat > $(git --x${caretMarker}`, expected: [] },
      { marked: `cat > "$(git --x${caretMarker}`, expected: ['ERROR'] },
      { marked: `cat > "$(git > ou${caretMarker}t)"`, expected: ['file_redirect'] },
      {
        marked: `cat <<EOF\n$(git --x${caretMarker})\nEOF`,
        expected: ['heredoc_redirect'],
      },
    ]) {
      const { source, point } = markedSource(marked);
      withParsedTree(parser, source, tree => {
        assert.deepStrictEqual(
          new Set(getProviderSuppressionReasonsAtPoint(tree.rootNode, point)),
          new Set(expected),
          marked,
        );
      });
    }
  });

  test('assigns a closed nested substitution boundary to its enclosing command', () => {
    for (const { marked, expected } of [
      { marked: `cat > "$(git --x${caretMarker})"`, expected: 'git --x' },
      { marked: `cat > "$(echo $(git)${caretMarker})"`, expected: 'echo $(git)' },
      { marked: `cat > "$(echo <(git)${caretMarker})"`, expected: 'echo <(git)' },
    ]) {
      const { source, point } = markedSource(marked);
      withParsedTree(parser, source, tree => {
        assert.strictEqual(
          getCompletionCommandNodeAtPoint(tree.rootNode, point)?.text,
          expected,
          marked,
        );
      });
    }
  });

  test('resolves completion anchors without crossing active scope delimiters', () => {
    for (const { marked, expectedCommand, expectedMoved, expectedTouching } of [
      {
        marked: `cat > "$(echo $(git) ${caretMarker})"`,
        expectedCommand: 'echo $(git)',
        expectedMoved: true,
        expectedTouching: false,
      },
      {
        marked: `cat > >(git --x${caretMarker}`,
        expectedCommand: 'git --x',
        expectedMoved: false,
        expectedTouching: true,
      },
      {
        marked: `echo   ${caretMarker}`,
        expectedCommand: 'echo',
        expectedMoved: true,
        expectedTouching: false,
      },
      {
        marked: `git status;  ${caretMarker}`,
        expectedCommand: undefined,
        expectedMoved: true,
        expectedTouching: false,
      },
      {
        marked: `cat <<< "$${caretMarker}(git --x)"`,
        expectedCommand: undefined,
        expectedMoved: false,
        expectedTouching: false,
      },
      {
        marked: `cat <<< "$(${caretMarker}git --x)"`,
        expectedCommand: undefined,
        expectedMoved: false,
        expectedTouching: false,
      },
    ]) {
      const { source, point } = markedSource(marked);
      withParsedTree(parser, source, tree => {
        const resolution = resolveCompletionAnchor(lineProvider(source), tree.rootNode, point);
        assert.strictEqual(resolution.commandNode?.text, expectedCommand, marked);
        assert.strictEqual(resolution.moved, expectedMoved, marked);
        assert.strictEqual(resolution.touchingCommandToken, expectedTouching, marked);
      });
    }
  });
});
