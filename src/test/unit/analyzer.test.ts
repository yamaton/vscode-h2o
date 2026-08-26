import * as assert from 'assert';
import * as path from 'path';
import * as Parser from 'web-tree-sitter';
import { SyntaxNode } from 'web-tree-sitter';
import { getCommandArguments, getCommandName } from '../../analyzer';

suite('shell command analysis', () => {
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

  function parseFirstNode(source: string): SyntaxNode {
    const node = parser.parse(source).rootNode.firstNamedChild;
    assert.ok(node, `Expected a syntax node for: ${source}`);
    return node;
  }

  test('uses the command name field after leading environment assignments', () => {
    const command = parseFirstNode('VAR=value git status --short');
    assert.strictEqual(getCommandName(command), 'git');
    assert.deepStrictEqual(getCommandArguments(command), ['status', '--short']);
    assert.strictEqual(getCommandName(parseFirstNode('A=1 B=2 npm test')), 'npm');
  });

  test('preserves transparent sudo and nohup wrappers', () => {
    assert.strictEqual(getCommandName(parseFirstNode('sudo git status')), 'git');
    assert.strictEqual(getCommandName(parseFirstNode('VAR=value nohup npm test')), 'npm');
  });

  test('uses an explicit separator to cross sudo options', () => {
    const command = parseFirstNode('sudo -u root -- git status');
    assert.strictEqual(getCommandName(command), 'git');
    assert.deepStrictEqual(getCommandArguments(command), ['status']);
    assert.strictEqual(getCommandName(parseFirstNode('sudo -- git status')), 'git');
    assert.strictEqual(getCommandName(parseFirstNode('nohup -- npm test')), 'npm');
  });

  test('handles the common separated sudo user option', () => {
    const command = parseFirstNode('sudo -u username git status');
    assert.strictEqual(getCommandName(command), 'git');
    assert.deepStrictEqual(getCommandArguments(command), ['status']);

    const userMatchingSubcommand = parseFirstNode('sudo -u status git');
    assert.strictEqual(getCommandName(userMatchingSubcommand), 'git');
    assert.deepStrictEqual(getCommandArguments(userMatchingSubcommand), []);

    assert.strictEqual(getCommandName(parseFirstNode('sudo -u username')), undefined);
    assert.strictEqual(getCommandName(parseFirstNode('sudo -u -- git')), undefined);
  });

  test('resolves nested wrappers and sudo environment assignments', () => {
    assert.strictEqual(getCommandName(parseFirstNode('sudo VAR=value git status')), 'git');
    assert.strictEqual(getCommandName(parseFirstNode('sudo nohup npm test')), 'npm');
    const command = parseFirstNode('VAR=value nohup sudo -u root -- npm test');
    assert.strictEqual(getCommandName(command), 'npm');
    assert.deepStrictEqual(getCommandArguments(command), ['test']);
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
      const command = parseFirstNode(source);
      assert.strictEqual(getCommandName(command), undefined, source);
      assert.deepStrictEqual(getCommandArguments(command), [], source);
    }
  });

  test('does not treat wrapper options or assignments as commands when no command follows', () => {
    assert.strictEqual(getCommandName(parseFirstNode('sudo VAR=value')), undefined);
    assert.strictEqual(getCommandName(parseFirstNode('nohup --help')), undefined);
  });

  test('does not treat a standalone assignment as a command', () => {
    assert.strictEqual(getCommandName(parseFirstNode('VAR=value')), undefined);
  });
});
