import * as assert from 'assert';
import { Node, Parser, Point } from 'web-tree-sitter';
import {
  CommandWord,
  getCommandArguments,
  getCommandInvocationToPosition,
  getCommandName,
} from '../../analyzer';
import {
  createBashParser,
  descendantsOfType,
  withFirstNamedNode,
  withParsedTree,
} from '../parserTestUtils';

interface CommandAnalysis {
  name: string | undefined;
  arguments: string[];
}

function wordTexts(words: readonly CommandWord[]): string[] {
  return words.map(word => word.text);
}

function invocationArgumentTexts(
  command: Node,
  position: Point,
  includeArgumentAtPosition: boolean,
): string[] {
  const invocation = getCommandInvocationToPosition(command, position, includeArgumentAtPosition);
  return wordTexts(invocation?.arguments ?? []);
}

suite('shell command analysis', () => {
  let parser: Parser;

  suiteSetup(async () => {
    parser = await createBashParser();
  });

  suiteTeardown(() => {
    parser?.delete();
  });

  function analyzeFirstCommand(source: string): CommandAnalysis {
    return withFirstNamedNode(parser, source, command => ({
      name: getCommandName(command),
      arguments: getCommandArguments(command),
    }));
  }

  function commandAnalyses(root: Node): CommandAnalysis[] {
    return descendantsOfType(root, 'command').map(command => ({
      name: getCommandName(command),
      arguments: getCommandArguments(command),
    }));
  }

  function assertCompleteCommandAnalyses(source: string, expected: CommandAnalysis[]): void {
    withParsedTree(parser, source, tree => {
      assert.strictEqual(tree.rootNode.hasError, false, source);
      assert.deepStrictEqual(commandAnalyses(tree.rootNode), expected, source);
    });
  }

  test('uses the command name field after leading environment assignments', () => {
    const analysis = analyzeFirstCommand('VAR=value git status --short');
    assert.strictEqual(analysis.name, 'git');
    assert.deepStrictEqual(analysis.arguments, ['status', '--short']);
    assert.strictEqual(analyzeFirstCommand('A=1 B=2 npm test').name, 'npm');
  });

  test('preserves transparent sudo and nohup wrappers', () => {
    assert.strictEqual(analyzeFirstCommand('sudo git status').name, 'git');
    assert.strictEqual(analyzeFirstCommand('VAR=value nohup npm test').name, 'npm');
  });

  test('uses an explicit separator to cross sudo options', () => {
    const analysis = analyzeFirstCommand('sudo -u root -- git status');
    assert.strictEqual(analysis.name, 'git');
    assert.deepStrictEqual(analysis.arguments, ['status']);
    assert.strictEqual(analyzeFirstCommand('sudo -- git status').name, 'git');
    assert.strictEqual(analyzeFirstCommand('nohup -- npm test').name, 'npm');
  });

  test('handles the common separated sudo user option', () => {
    const analysis = analyzeFirstCommand('sudo -u username git status');
    assert.strictEqual(analysis.name, 'git');
    assert.deepStrictEqual(analysis.arguments, ['status']);

    const userMatchingSubcommand = analyzeFirstCommand('sudo -u status git');
    assert.strictEqual(userMatchingSubcommand.name, 'git');
    assert.deepStrictEqual(userMatchingSubcommand.arguments, []);

    assert.strictEqual(analyzeFirstCommand('sudo -u username').name, undefined);
    assert.strictEqual(analyzeFirstCommand('sudo -u -- git').name, undefined);
  });

  test('resolves nested wrappers and sudo environment assignments', () => {
    assert.strictEqual(analyzeFirstCommand('sudo VAR=value git status').name, 'git');
    assert.strictEqual(analyzeFirstCommand('sudo nohup npm test').name, 'npm');
    const analysis = analyzeFirstCommand('VAR=value nohup sudo -u root -- npm test');
    assert.strictEqual(analysis.name, 'npm');
    assert.deepStrictEqual(analysis.arguments, ['test']);
  });

  test('does not guess the wrapped command across sudo options without a separator', () => {
    for (const source of [
      'sudo -uroot git status',
      'sudo --user root git status',
      'sudo -e /etc/hosts',
      'sudo --edit /etc/hosts',
      'sudo --version anything',
      'sudo -k anything',
    ]) {
      const analysis = analyzeFirstCommand(source);
      assert.strictEqual(analysis.name, undefined, source);
      assert.deepStrictEqual(analysis.arguments, [], source);
    }
  });

  test('does not treat wrapper options or assignments as commands when no command follows', () => {
    assert.strictEqual(analyzeFirstCommand('sudo VAR=value').name, undefined);
    assert.strictEqual(analyzeFirstCommand('nohup --help').name, undefined);
  });

  test('does not treat a standalone assignment as a command', () => {
    assert.strictEqual(analyzeFirstCommand('VAR=value').name, undefined);
  });

  test('preserves complete quoted, numeric, and assigned command arguments', () => {
    for (const { source, expected } of [
      {
        source: 'printf "%s value" plain 42',
        expected: [{ name: 'printf', arguments: ['"%s value"', 'plain', '42'] }],
      },
      {
        source: "A=1 B=two command 'two words' --flag=value",
        expected: [{ name: 'command', arguments: ["'two words'", '--flag=value'] }],
      },
    ]) {
      assertCompleteCommandAnalyses(source, expected);
    }
  });

  test('analyzes command nodes inside lists and pipelines', () => {
    assertCompleteCommandAnalyses(
      'git status; npm test | grep ok && echo done &',
      [
        { name: 'git', arguments: ['status'] },
        { name: 'npm', arguments: ['test'] },
        { name: 'grep', arguments: ['ok'] },
        { name: 'echo', arguments: ['done'] },
      ],
    );
  });

  test('analyzes commands nested in functions and control flow', () => {
    for (const { source, expected } of [
      {
        source: 'deploy() { git status; npm test; }',
        expected: [
          { name: 'git', arguments: ['status'] },
          { name: 'npm', arguments: ['test'] },
        ],
      },
      {
        source: 'if test -d .; then git status; else echo missing; fi',
        expected: [
          { name: 'test', arguments: ['-d', '.'] },
          { name: 'git', arguments: ['status'] },
          { name: 'echo', arguments: ['missing'] },
        ],
      },
      {
        source: 'while test -f lock; do sleep 1; done',
        expected: [
          { name: 'test', arguments: ['-f', 'lock'] },
          { name: 'sleep', arguments: ['1'] },
        ],
      },
      {
        source: 'for file in a b; do echo "$file"; done',
        expected: [{ name: 'echo', arguments: ['"$file"'] }],
      },
    ]) {
      assertCompleteCommandAnalyses(source, expected);
    }
  });

  test('analyzes substitutions and redirected command bodies', () => {
    for (const { source, expected } of [
      {
        source: 'echo $(git rev-parse HEAD)',
        expected: [
          { name: 'echo', arguments: ['$(git rev-parse HEAD)'] },
          { name: 'git', arguments: ['rev-parse', 'HEAD'] },
        ],
      },
      {
        source: 'diff <(git show HEAD) <(git show HEAD~1)',
        expected: [
          { name: 'diff', arguments: ['<(git show HEAD)', '<(git show HEAD~1)'] },
          { name: 'git', arguments: ['show', 'HEAD'] },
          { name: 'git', arguments: ['show', 'HEAD~1'] },
        ],
      },
      {
        source: 'cat input.txt > output.txt',
        expected: [{ name: 'cat', arguments: ['input.txt'] }],
      },
      {
        source: 'cat <<EOF\nhello\nEOF',
        expected: [{ name: 'cat', arguments: [] }],
      },
    ]) {
      assertCompleteCommandAnalyses(source, expected);
    }
  });

  test('preserves commands across line continuations and incomplete input', () => {
    const continued = analyzeFirstCommand('git \\\n  --flag');
    assert.strictEqual(continued.name, 'git');
    assert.deepStrictEqual(continued.arguments, ['--flag']);

    withParsedTree(parser, 'git "unterminated', incompleteTree => {
      assert.strictEqual(incompleteTree.rootNode.hasError, true);
      const incomplete = incompleteTree.rootNode.firstNamedChild;
      assert.ok(incomplete);
      assert.strictEqual(getCommandName(incomplete), 'git');
      assert.doesNotThrow(() => getCommandArguments(incomplete));
    });
  });

  test('limits command arguments to the cursor context', () => {
    withFirstNamedNode(parser, 'docker run build', command => {
      const insideRun = { row: 0, column: 8 };
      assert.deepStrictEqual(
        invocationArgumentTexts(command, insideRun, true),
        ['run'],
      );
      assert.deepStrictEqual(
        invocationArgumentTexts(command, { row: 0, column: 10 }, false),
        [],
      );
      assert.deepStrictEqual(
        invocationArgumentTexts(command, { row: 0, column: 10 }, true),
        ['run'],
      );
      assert.deepStrictEqual(
        invocationArgumentTexts(command, { row: 0, column: 15 }, true),
        ['run', 'build'],
      );
    });
  });

  test('uses wrapped-command arguments when limiting by position', () => {
    withFirstNamedNode(parser, 'sudo -- docker run build', command => {
      assert.deepStrictEqual(
        invocationArgumentTexts(command, { row: 0, column: 16 }, true),
        ['run'],
      );
    });
  });
});
