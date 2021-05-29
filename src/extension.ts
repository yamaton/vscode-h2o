// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { SyntaxNode } from 'web-tree-sitter';
import { CachingFetcher, runH2o } from './cacheFetcher';
import { Analyzer } from './analyzer';


// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

  const parser = await initializeParser();
  const fetcher = new CachingFetcher(context.globalState);

  const compprovider = vscode.languages.registerCompletionItemProvider(
    'shellscript',
    {
      provideCompletionItems(document, position, token, context) {

        const simpleOldTypeCompletion = new vscode.CompletionItem('-oldtype');
        simpleOldTypeCompletion.documentation = new vscode.MarkdownString('I hate this old style');
        simpleOldTypeCompletion.detail = 'show me a detail!';

        const simpleCompletion = new vscode.CompletionItem('--help');
        simpleCompletion.documentation = new vscode.MarkdownString('here comes help!');

        const snippetCompletion = new vscode.CompletionItem('--option-with-arg');
        snippetCompletion.insertText = new vscode.SnippetString('--option-with-arg ${1:<arg>}');
        snippetCompletion.documentation = new vscode.MarkdownString('An option with argument.');

        //   const result: vscode.CompletionItem[] = [];

        //   const currentRange = document.getWordRangeAtPosition(position);
        //   if (currentRange !== undefined) {
        //     const rangeWithPrefix = new vscode.Range(
        //       currentRange?.start.translate(0, -2),
        //       currentRange?.end
        //     );
        //     const tokenWithPrefix = document.getText(rangeWithPrefix);
        //     if (tokenWithPrefix.slice(0, 2) === ' -') {
        //       result.push(simpleCompletion);
        //       result.push(snippetCompletion);
        //       result.push(simpleOldTypeCompletion);
        //     } else if (tokenWithPrefix.slice(0, 2) === '--') {
        //       result.push(simpleCompletion);
        //       result.push(snippetCompletion);
        //     }
        //   }
        //   return result;
        // }

        return [
          simpleCompletion,
          simpleOldTypeCompletion,
          snippetCompletion
        ];
      }
    },
    // '-',  // triggerCharacter
  );

  const hoverprovider = vscode.languages.registerHoverProvider('shellscript', {
    provideHover(document, position, token) {

      const content = document.getText();
      const tree = parser.parse(content);
      const cmdName = getCommandName(tree.rootNode, position);
      if (cmdName) {
        const command = fetcher.fetch(cmdName);
        if (command) {
          return new vscode.Hover(new vscode.MarkdownString(command.description));
        }
      }
    }
  });

  context.subscriptions.push(compprovider);
  context.subscriptions.push(hoverprovider);

}


// Borrow from bash-language-server
async function initializeParser(): Promise<Parser> {
  const parser = new Parser;
  const path = `${__dirname}/../tree-sitter-bash.wasm`;
  const lang = await Parser.Language.load(path);
  parser.setLanguage(lang);
  return parser;
}

function range(n: SyntaxNode): vscode.Range {
  return new vscode.Range(
    n.startPosition.row,
    n.startPosition.column,
    n.endPosition.row,
    n.endPosition.column,
  );
}

// Get command name if applicable
function getCommandName(root: SyntaxNode, position: vscode.Position): string | undefined {
  // if you are at a command, a named node, the currentNode becomes one-layer deeper than other nameless nodes.
  let commandNode = _getCommandNode(root, position);
  return commandNode?.firstNamedChild?.text;
}

// Get subcommand name if applicable
// [FIXME] this catches option's argument; use database instead
function getSubcommandCandidate(root: SyntaxNode, position: vscode.Position): string | undefined {
  let commandNode = _getCommandNode(root, position);
  if (commandNode) {
    let n = commandNode?.firstNamedChild;
    while (n?.nextSibling) {
      n = n?.nextSibling;
      if (!n.text.startsWith('-')) {
        return n.text;
      }
    }
  }
}

function _getCommandNode(root: SyntaxNode, position: vscode.Position): SyntaxNode | undefined {
  let currentNode = findNode(root, position);
  if (currentNode.parent?.type === 'command_name') {
    currentNode = currentNode.parent;
  }
  if (currentNode.parent?.type === 'command') {
    return currentNode.parent;
  }
}


// Find the deepest node in which that the position in contained.
function findNode(n: SyntaxNode, position: vscode.Position): SyntaxNode {
  if (!(range(n).contains(position))) {
    console.error("Out of range!");
  }
  for (const child of n.children) {
    const r = range(child);
    if (r.contains(position)) {
      return findNode(child, position);
    }
  }
  return n;
}



export function deactivate() { }

