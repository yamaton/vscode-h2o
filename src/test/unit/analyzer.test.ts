import * as assert from 'assert';
import * as Parser from 'web-tree-sitter';
import { getCommandArguments, getCommandName } from '../../analyzer';
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

  test('analyzes command nodes inside lists and pipelines', () => {
    withParsedTree(parser, 'git status; npm test | grep ok', tree => {
      const commands = descendantsOfType(tree.rootNode, 'command');

      assert.deepStrictEqual(commands.map(command => ({
        name: getCommandName(command),
        arguments: getCommandArguments(command),
      })), [
        { name: 'git', arguments: ['status'] },
        { name: 'npm', arguments: ['test'] },
        { name: 'grep', arguments: ['ok'] },
      ]);
    });
  });

  test('preserves commands across line continuations and incomplete input', () => {
    const continued = analyzeFirstCommand('git \\\n  --flag');
    assert.strictEqual(continued.name, 'git');
    assert.deepStrictEqual(continued.arguments, ['--flag']);

    withParsedTree(parser, 'git "unterminated', incompleteTree => {
      assert.strictEqual(incompleteTree.rootNode.hasError(), true);
      const incomplete = incompleteTree.rootNode.firstNamedChild;
      assert.ok(incomplete);
      assert.strictEqual(getCommandName(incomplete), 'git');
      assert.deepStrictEqual(getCommandArguments(incomplete), ['"unterminated']);
    });
  });
});
