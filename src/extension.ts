import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { SyntaxNode } from 'web-tree-sitter';
import { CachingFetcher, runH2o } from './cacheFetcher';
import { Option, Command } from './command';

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

        const tree = parser.parse(document.getText());
        const compSubcommands = getCompSubcommands(tree.rootNode, position, fetcher);
        const cmdNodeEnd = _getCommandNode(tree.rootNode, position)?.endPosition;
        console.log('position: ', position);
        console.log('cmdNodeEnd: ', cmdNodeEnd);

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

        const res = [
          simpleCompletion,
          simpleOldTypeCompletion,
          snippetCompletion
        ];
        const items = getCompSubcommands(tree.rootNode, position, fetcher);
        res.push(...items);
        return res;
      }
    },
    ' ',  // triggerCharacter
  );

  const hoverprovider = vscode.languages.registerHoverProvider('shellscript', {
    provideHover(document, position, token) {

      const content = document.getText();
      const tree = parser.parse(content);
      const thisName = findNode(tree.rootNode, position).text!;
      console.log("findNode(tree.rootNode, position): ", findNode(tree.rootNode, position));
      const cmd = getMatchingCommand(tree.rootNode, position, fetcher);
      const subcmd = getMatchingSubcommand(tree.rootNode, position, fetcher);
      const opt = getMatchingOption(tree.rootNode, position, fetcher);
      if (cmd) {
        return new vscode.Hover(new vscode.MarkdownString(cmd.description!));
      } else if (subcmd) {
        const cmdName = getCommandName(tree.rootNode, position)!;
        const msg = `${cmdName} **${subcmd.name}**: ${subcmd.description}`;
        return new vscode.Hover(new vscode.MarkdownString(msg));
      } else if (opt) {
        const msg = `${thisName}: ${opt.description}`;
        return new vscode.Hover(new vscode.MarkdownString(msg));
      }
    }
  });

  context.subscriptions.push(compprovider);
  context.subscriptions.push(hoverprovider);
}


function getMatchingCommand(root: SyntaxNode, position: vscode.Position, fetcher: CachingFetcher): undefined | Command {
  const cmdName = getCommandName(root, position);
  const thisName = findNode(root, position)?.text;
  console.log('cmdName: ', cmdName);
  console.log('thisName: ', thisName);
  if (cmdName === thisName) {
    const command = fetcher.fetch(cmdName)!;
    return command;
  }
}

function getMatchingSubcommand(root: SyntaxNode, position: vscode.Position, fetcher: CachingFetcher): undefined | Command {
  const cmdName = getCommandName(root, position)!;
  const subName = getSubcommand(root, position, fetcher)!;
  const thisName = findNode(root, position)?.text;
  console.log('cmdName: ', cmdName);
  console.log('subName: ', subName);
  console.log('thisName: ', thisName);
  if (subName === thisName) {
    const command = fetcher.fetch(cmdName)!;
    const subcmd = command?.subcommands?.find((x) => x.name === subName)!;
    return subcmd;
  }
}

function getMatchingOption(root: SyntaxNode, position: vscode.Position, fetcher: CachingFetcher): undefined | Option {
  const thisName = findNode(root, position).text!;
  if (thisName.startsWith('-')) {
    const cmdName = getCommandName(root, position)!;
    const command = fetcher.fetch(cmdName)!;
    const subName = getSubcommand(root, position, fetcher);
    let options: Option[];
    if (subName) {
      options = command?.subcommands?.find((x) => x.name === subName)?.options!;
    } else {
      options = command?.options!;
    }
    const theOption = options.find((x) => x.names.includes(thisName))!;
    return theOption;
  }
}

// Borrow from bash-language-server
async function initializeParser(): Promise<Parser> {
  await Parser.init();
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
  const commandNode = _getCommandNode(root, position);
  let name = commandNode?.firstNamedChild?.text!;
  if (name === 'sudo') {
    name = commandNode?.firstNamedChild?.nextSibling?.text!;
  }
  return name;
}

// Get subcommand name if applicable
// [FIXME] this catches option's argument; use database instead
function* _getSubcommandCandidates(root: SyntaxNode, position: vscode.Position) {
  let commandNode = _getCommandNode(root, position)!;
  if (commandNode) {
    let n = commandNode?.firstNamedChild;
    while (n?.nextSibling) {
      n = n?.nextSibling;
      if (!n.text.startsWith('-')) {
        yield n.text;
      }
    }
  }
}

function getSubcommand(root: SyntaxNode, position: vscode.Position, fetcher: CachingFetcher) {
  let name = getCommandName(root, position);
  if (name) {
    let command = fetcher.fetch(name);
    let subnames = command?.subcommands?.map((x) => x.name);
    if (subnames) {
      let gen = _getSubcommandCandidates(root, position);
      for (let candidate of gen) {
        if (candidate && subnames.includes(candidate)) {
          return candidate;
        }
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


//
function _getSubcommands(name: string, fetcher: CachingFetcher): Command[] {
  const subcommands = fetcher.fetch(name)?.subcommands;
  if (subcommands) {
    return subcommands;
  }
  return [];
}

// Get subcommand completions
function getCompSubcommands(root: SyntaxNode, position: vscode.Position, fetcher: CachingFetcher): vscode.CompletionItem[] {
  const cmd = getCommandName(root, position);
  if (cmd) {
    const subname = getSubcommand(root, position, fetcher);
    if (subname === undefined) {
      const subcommands = _getSubcommands(cmd, fetcher);
      if (subcommands && subcommands.length) {
        const compitems = subcommands.map((sub) => {
          const item = new vscode.CompletionItem(sub.name);
          item.documentation = new vscode.MarkdownString(sub.description);
          return item;
        });
        return compitems;
      }
    }
  }
  return [];
}


export function deactivate() { }
