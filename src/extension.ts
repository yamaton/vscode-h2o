import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { SyntaxNode } from 'web-tree-sitter';
import { CachingFetcher } from './cacheFetcher';
import { Option, Command } from './command';


async function initializeParser(): Promise<Parser> {
  await Parser.init();
  const parser = new Parser;
  const path = `${__dirname}/../tree-sitter-bash.wasm`;
  const lang = await Parser.Language.load(path);
  parser.setLanguage(lang);
  return parser;
}

export async function activate(context: vscode.ExtensionContext) {
  const parser = await initializeParser();
  const trees: { [uri: string]: Parser.Tree } = {};
  const fetcher = new CachingFetcher(context.globalState);

  const compprovider = vscode.languages.registerCompletionItemProvider(
    'shellscript',
    {
      provideCompletionItems(document, position, token, context) {
        if (!parser) {
          console.error("[Completion] Parser is unavailable!");
          return;
        }
        if (!trees[document.uri.toString()]) {
          console.log("[Completion] Creating tree");
          trees[document.uri.toString()] = parser.parse(document.getText());
        }
        const tree = trees[document.uri.toString()];

        // this is a trick to get current Node
        const p = walkbackIfNeeded(tree.rootNode, position);
        const compSubcommands = getCompletionsSubcommands(tree.rootNode, p, fetcher);
        const compOptions = getCompletionsOptions(tree.rootNode, p, fetcher);
        return [
          ...compSubcommands,
          ...compOptions
        ];
      }
    },
    ' ',  // triggerCharacter
  );

  const hoverprovider = vscode.languages.registerHoverProvider('shellscript', {
    provideHover(document, position, token) {

      if (!parser) {
        console.error("[Hover] Parser is unavailable!");
        return;
      }
      if (!trees[document.uri.toString()]) {
        console.log("[Hover] Creating tree");
        trees[document.uri.toString()] = parser.parse(document.getText());
      }
      const tree = trees[document.uri.toString()];

      const cmd = getMachingCommand(tree.rootNode, position, fetcher);
      const subcmd = getMatchingSubcommand(tree.rootNode, position, fetcher);
      const opts = getMatchingOption(tree.rootNode, position, fetcher);
      if (cmd) {
        return new vscode.Hover(new vscode.MarkdownString(cmd.description!));
      } else if (subcmd) {
        const cmdName = getContextCommandName(tree.rootNode, position)!;
        const msg = `${cmdName} **${subcmd.name}**\n\n ${subcmd.description}`;
        return new vscode.Hover(new vscode.MarkdownString(msg));
      } else if (opts) {
        const thisName = getCurrentNode(tree.rootNode, position).text!;
        const msg = optsToMessage(thisName, opts);
        return new vscode.Hover(new vscode.MarkdownString(msg));
      }
    }
  });

  function updateTree(parser: Parser, edit: vscode.TextDocumentChangeEvent) {
    if (edit.contentChanges.length === 0) { return; }

    const old = trees[edit.document.uri.toString()];
    for (const e of edit.contentChanges) {
      const startIndex = e.rangeOffset;
      const oldEndIndex = e.rangeOffset + e.rangeLength;
      const newEndIndex = e.rangeOffset + e.text.length;
      const indices = [startIndex, oldEndIndex, newEndIndex];
      const [startPosition, oldEndPosition, newEndPosition] = indices.map(i => asPoint(edit.document.positionAt(i)));
      const delta = { startIndex, oldEndIndex, newEndIndex, startPosition, oldEndPosition, newEndPosition };
      old.edit(delta);
    }
    const t = parser.parse(edit.document.getText(), old);
    trees[edit.document.uri.toString()] = t;
  }

  function edit(edit: vscode.TextDocumentChangeEvent) {
    updateTree(parser, edit);
  }

  function close(document: vscode.TextDocument) {
    console.log("[Close] removing a tree");
    delete trees[document.uri.toString()];
  }

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(edit));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(close));
  context.subscriptions.push(compprovider);
  context.subscriptions.push(hoverprovider);
}


function asPoint(p: vscode.Position): Parser.Point {
  return { row: p.line, column: p.character };
}

function optsToMessage(name: string, opts: Option[]): string {
  if (opts.length === 1) {
    const opt = opts[0];
    const msg = `\`${name}\`\n\n ${opt.description}`;
    return msg;

  } else {
    // deal with stacked option
    const shorts = unstackOption(name);
    const messages = opts.map((opt, i) => `\`${shorts[i]}\`\n\n ${opt.description}`);
    const joined = messages.join("\n\n");
    return joined;
  }
}

// --------------- Helper ----------------------


function range(n: SyntaxNode): vscode.Range {
  return new vscode.Range(
    n.startPosition.row,
    n.startPosition.column,
    n.endPosition.row,
    n.endPosition.column,
  );
}


// --------------- For Hovers and Completions ----------------------

// Find the deepest node that contains the position in its range.
function getCurrentNode(n: SyntaxNode, position: vscode.Position): SyntaxNode {
  if (!(range(n).contains(position))) {
    console.error("Out of range!");
  }
  for (const child of n.children) {
    const r = range(child);
    if (r.contains(position)) {
      return getCurrentNode(child, position);
    }
  }
  return n;
}


// Moves the position left by one character IF position is contained only in the root-node range.
// This is just a workround as you cannot reach command node if you start from
// the position, say, after 'echo '
function walkbackIfNeeded(n: SyntaxNode, position: vscode.Position): vscode.Position {
  for (const child of n.children) {
    const r = range(child);
    if (r.contains(position)) {
      return position;
    }
  }
  // move the position back if you cannot go deeper from the root node
  if (n.type === 'program' && position.character > 0) {
    return position.translate(0, -1);
  }
  return position;
}


// Returns current word as a command if the tree-sitter says it's command
function getMachingCommand(root: SyntaxNode, position: vscode.Position, fetcher: CachingFetcher): undefined | Command {
  const cmdName = getContextCommandName(root, position);
  const thisName = getCurrentNode(root, position)?.text;
  console.log('cmdName: ', cmdName);
  console.log('thisName: ', thisName);
  if (cmdName === thisName) {
    const command = fetcher.fetch(cmdName)!;
    return command;
  }
}


// Returns current word as a subcommand if the tree-sitter says so
function getMatchingSubcommand(root: SyntaxNode, position: vscode.Position, fetcher: CachingFetcher): undefined | Command {
  const [cmd, subcmd] = getContextCmdSubcmdPair(root, position, fetcher);
  const currentNodeText = getCurrentNode(root, position)?.text;
  console.log('cmdName: ', cmd?.name);
  console.log('subName: ', subcmd?.name);
  console.log('currentNodeText: ', currentNodeText);
  if (cmd && subcmd && subcmd.name === currentNodeText) {
    return subcmd;
  }
}


// Returns current word as an option if the tree-sitter says so
function getMatchingOption(root: SyntaxNode, position: vscode.Position, fetcher: CachingFetcher): Option[] {
  const thisName = getCurrentNode(root, position).text!;
  if (thisName.startsWith('-')) {
    const [cmd, subcmd] = getContextCmdSubcmdPair(root, position, fetcher);
    if (cmd) {
      let options: Option[];
      if (subcmd) {
        options = subcmd.options;
      } else {
        options = cmd?.options;
      }

      // If current word is NOT old-style option, or command option database
      // contains an old-option entry, just return the option with matching name.
      if (isNotOldStyle(thisName) || options.some(opt => {
        opt.names.some(isOldStyle);
      })) {
        const theOption = options.find((x) => x.names.includes(thisName))!;
        return [theOption];
      } else {
        // Otherwise, deal with a stacked option like `tar -xvf`
        const shortOptionNames = unstackOption(thisName);
        const shortOptions = shortOptionNames.map(short => options.find(opt => opt.names.includes(short))!).filter(opt => opt);
        if (shortOptionNames.length > 0 && shortOptionNames.length === shortOptions.length) {
          return shortOptions;
        }
      }
    }
  }
  return [];
}


function isNotOldStyle(name: string): boolean {
  return name.startsWith('--') || name.length === 2;
}

function isOldStyle(name: string): boolean {
  return !isNotOldStyle(name);
}

function unstackOption(name: string): string[] {
  return name.substring(1).split('').map(c => c.padStart(2, '-'));
}


// Get command name covering the position if exists
function getContextCommandName(root: SyntaxNode, position: vscode.Position): string | undefined {
  // if you are at a command, a named node, the currentNode becomes one-layer deeper than other nameless nodes.
  const commandNode = _getContextCommandNode(root, position);
  let name = commandNode?.firstNamedChild?.text!;
  if (name === 'sudo') {
    name = commandNode?.firstNamedChild?.nextSibling?.text!;
  }
  return name;
}

// Get subcommand name if applicable
// [FIXME] this catches option's argument; use database instead
function _getSubcommandCandidates(root: SyntaxNode, position: vscode.Position) {
  const candidates: string[] = [];
  let commandNode = _getContextCommandNode(root, position)!;
  if (commandNode) {
    let n = commandNode?.firstNamedChild;
    while (n?.nextSibling) {
      n = n?.nextSibling;
      if (!n.text.startsWith('-')) {
        candidates.push(n.text);
      }
    }
  }
  return candidates;
}


// Get command and subcommand inferred from the current position
function getContextCmdSubcmdPair(root: SyntaxNode, position: vscode.Position, fetcher: CachingFetcher): [Command | undefined, Command | undefined] {
  let name = getContextCommandName(root, position);
  if (!name) {
    return [undefined, undefined];
  }

  let command = fetcher.fetch(name);
  let subcommands = command?.subcommands;
  if (subcommands && subcommands.length) {
    let words = _getSubcommandCandidates(root, position);
    for (let word of words) {
      for (const subcmd of subcommands) {
        if (subcmd.name === word) {
          return [command, subcmd];
        }
      }
    }
  }
  return [command, undefined];
}


// Get command arguments as string[]
function getContextCmdArgs(root: SyntaxNode, position: vscode.Position): string[] {
  const p = walkbackIfNeeded(root, position);
  let node = _getContextCommandNode(root, p)?.firstNamedChild;
  if (node?.text === 'sudo') {
    node = node.nextSibling;
  }
  const res: string[] = [];
  while (node?.nextSibling) {
    node = node.nextSibling;
    res.push(node.text);
  }
  return res;
}


// Get command node inferred from the current position
function _getContextCommandNode(root: SyntaxNode, position: vscode.Position): SyntaxNode | undefined {
  let currentNode = getCurrentNode(root, position);
  if (currentNode.parent?.type === 'command_name') {
    currentNode = currentNode.parent;
  }
  if (currentNode.parent?.type === 'command') {
    return currentNode.parent;
  }
}


// Get subcommand completions
function getCompletionsSubcommands(root: SyntaxNode, position: vscode.Position, fetcher: CachingFetcher): vscode.CompletionItem[] {
  const [cmd, subcmd] = getContextCmdSubcmdPair(root, position, fetcher);
  if (cmd && subcmd === undefined) {
    const subcommands = cmd.subcommands;
    if (subcommands && subcommands.length) {
      const compitems = subcommands.map((sub) => {
        const item = new vscode.CompletionItem(sub.name);
        item.detail = sub.description;
        return item;
      });
      return compitems;
    }
  }
  return [];
}


// Get option completion
function getCompletionsOptions(root: SyntaxNode, position: vscode.Position, fetcher: CachingFetcher): vscode.CompletionItem[] {
  const [cmd, subcmd] = getContextCmdSubcmdPair(root, position, fetcher);
  const args = getContextCmdArgs(root, position);
  const compitems: vscode.CompletionItem[] = [];
  if (cmd) {
    let options: Option[];
    if (subcmd) {
      options = subcmd.options;
    } else {
      options = cmd?.options;
    }
    options.forEach(opt => {
      // suppress already-used options
      if (opt.names.every(name => !args.includes(name))) {
        opt.names.forEach(name => {
          const item = new vscode.CompletionItem(name);
          item.detail = opt.description;
          if (opt.argument) {
            const snippet = `${name} \$\{1:${opt.argument}\}`;
            item.insertText = new vscode.SnippetString(snippet);
          }
          compitems.push(item);
        });
      }
    });
  }
  return compitems;
}


export function deactivate() { }
