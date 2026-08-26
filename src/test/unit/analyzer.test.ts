import * as assert from 'assert';
import * as path from 'path';
import * as Parser from 'web-tree-sitter';
import { SyntaxNode } from 'web-tree-sitter';
import { getCommandName } from '../../analyzer';

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
    assert.strictEqual(getCommandName(parseFirstNode('VAR=value git status --short')), 'git');
    assert.strictEqual(getCommandName(parseFirstNode('A=1 B=2 npm test')), 'npm');
  });

  test('preserves transparent sudo and nohup wrappers', () => {
    assert.strictEqual(getCommandName(parseFirstNode('sudo git status')), 'git');
    assert.strictEqual(getCommandName(parseFirstNode('VAR=value nohup npm test')), 'npm');
  });

  test('does not treat a standalone assignment as a command', () => {
    assert.strictEqual(getCommandName(parseFirstNode('VAR=value')), undefined);
  });
});
