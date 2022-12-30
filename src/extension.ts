import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { SyntaxNode } from 'web-tree-sitter';
import { CachingFetcher } from './cacheFetcher';
import { Option, Command } from './command';
import { CommandListProvider } from './commandExplorer';
import { formatTldr, isPrefixOf, getLabelString } from './utils';


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
  await fetcher.init();
  try {
    await fetcher.fetchAllCurated("general");
  } catch {
    console.warn("Failed in fetch.fetchAllCurated().");
  }


  const compprovider = vscode.languages.registerCompletionItemProvider(
    'shellscript',
    {
      async provideCompletionItems(document, position, token, context) {
        if (!parser) {
          console.error("[Completion] Parser is unavailable!");
          return Promise.reject("Parser unavailable!");
        }
        if (!trees[document.uri.toString()]) {
          console.log("[Completion] Creating tree");
          trees[document.uri.toString()] = parser.parse(document.getText());
        }
        const tree = trees[document.uri.toString()];
        const commandList = fetcher.getList();
        let compCommands: vscode.CompletionItem[] = [];
        if (!!commandList) {
          compCommands = commandList.map((s) => new vscode.CompletionItem(s));
        }

        // this is an ugly hack to get current Node
        const p = walkbackIfNeeded(document, tree.rootNode, position);
        const isCursorTouchingWord = (p === position);
        console.log(`[Completion] isCursorTouchingWord: ${isCursorTouchingWord}`);

        try {
          const cmdSeq = await getContextCmdSeq(tree.rootNode, p, fetcher);
          if (!!cmdSeq && cmdSeq.length) {
            const deepestCmd = cmdSeq[cmdSeq.length - 1];
            const compSubcommands = getCompletionsSubcommands(deepestCmd);
            let compOptions = getCompletionsOptions(document, tree.rootNode, p, cmdSeq);
            let compItems = [
              ...compSubcommands,
              ...compOptions,
            ];

            if (isCursorTouchingWord) {
              const currentNode = getCurrentNode(tree.rootNode, position);
              const currentWord = currentNode.text;
              compItems = compItems.filter(compItem => isPrefixOf(currentWord, getLabelString(compItem.label)));
              compItems.forEach(compItem => {
                compItem.range = range(currentNode);
              });
              console.info(`[Completion] currentWord: ${currentWord}`);
            }
            return compItems;
          } else {
            throw new Error("unknown command");
          }
        } catch (e) {
          const currentNode = getCurrentNode(tree.rootNode, position);
          const currentWord = currentNode.text;
          console.info(`[Completion] currentWord = ${currentWord}`);
          if (!!compCommands && p === position && currentWord.length >= 2) {
            console.info("[Completion] Only command completion is available (2)");
            let compItems = compCommands.filter(cmd => isPrefixOf(currentWord, getLabelString(cmd.label)));
            compItems.forEach(compItem => {
              compItem.range = range(currentNode);
            });
            return compItems;
          }
          console.warn("[Completion] No completion item is available (1)", e);
          return Promise.reject("Error: No completion item is available");
        }
      }
    },
    ' ',  // triggerCharacter
  );

  const hoverprovider = vscode.languages.registerHoverProvider('shellscript', {
    async provideHover(document, position, token) {

      if (!parser) {
        console.error("[Hover] Parser is unavailable!");
        return Promise.reject("Parser is unavailable!");
      }

      if (!trees[document.uri.toString()]) {
        console.log("[Hover] Creating tree");
        trees[document.uri.toString()] = parser.parse(document.getText());
      }
      const tree = trees[document.uri.toString()];

      const currentWord = getCurrentNode(tree.rootNode, position).text;
      try {
        const cmdSeq = await getContextCmdSeq(tree.rootNode, position, fetcher);
        if (!!cmdSeq && cmdSeq.length) {
          const name = cmdSeq[0].name;
          if (currentWord === name) {
            const clearCacheCommandUri = vscode.Uri.parse(`command:h2o.clearCache?${encodeURIComponent(JSON.stringify(name))}`);
            const thisCmd = cmdSeq.find((cmd) => cmd.name === currentWord)!;
            const tldrText = (!!thisCmd.tldr) ? "\n" + formatTldr(thisCmd.tldr) : "";
            const msg = new vscode.MarkdownString(`\`${name}\`` + tldrText + `\n\n[Reset](${clearCacheCommandUri})`);
            msg.isTrusted = true;
            return new vscode.Hover(msg);
          } else if (cmdSeq.length > 1 && cmdSeq.some((cmd) => cmd.name === currentWord)) {
            const thatCmd = cmdSeq.find((cmd) => cmd.name === currentWord)!;
            const nameSeq: string[] = [];
            for (const cmd of cmdSeq) {
              if (cmd.name !== currentWord) {
                nameSeq.push(cmd.name);
              } else {
                break;
              }
            }
            const cmdPrefixName = nameSeq.join(" ");
            const msg = `${cmdPrefixName} **${thatCmd.name}**\n\n ${thatCmd.description}`;
            return new vscode.Hover(new vscode.MarkdownString(msg));
          } else if (cmdSeq.length) {
            const opts = getMatchingOption(currentWord, name, cmdSeq);
            const msg = optsToMessage(opts);
            return new vscode.Hover(new vscode.MarkdownString(msg));
          } else {
            return Promise.reject(`No hover is available for ${currentWord}`);
          }
        }
      } catch (e) {
        console.log("[Hover] Error: ", e);
        return Promise.reject("No hover is available");
      }
    }
  });

  function updateTree(p: Parser, edit: vscode.TextDocumentChangeEvent) {
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
    const t = p.parse(edit.document.getText(), old);
    trees[edit.document.uri.toString()] = t;
  }

  function edit(edit: vscode.TextDocumentChangeEvent) {
    updateTree(parser, edit);
  }

  function close(document: vscode.TextDocument) {
    console.log("[Close] removing a tree");
    delete trees[document.uri.toString()];
  }


  // h2o.loadCommand: Download the command `name`
  const loadCommand = vscode.commands.registerCommand('h2o.loadCommand', async (name: string) => {
    let cmd = name;
    if (!name) {
      cmd = (await vscode.window.showInputBox({ placeHolder: 'which command?' }))!;
    }

    if (!cmd || !cmd.trim()) {
      console.info("[h2o.loadCommand] Cancelled operation.");
      return;
    }

    try {
      console.log(`[Command] Downloading ${cmd} data...`);
      await fetcher.downloadCommandToCache(cmd);
      const msg = `[Shell Completion] Added ${cmd}.`;
      vscode.window.showInformationMessage(msg);
    } catch (e) {
      console.error("Error: ", e);
      return Promise.reject(`[h2o.loadCommand] Failed to load ${cmd}`);
    }
  });


  // h2o.clearCache: Clear cache of the command `name`
  const clearCacheCommand = vscode.commands.registerCommand('h2o.clearCache', async (name: string) => {
    let cmd = name;
    if (!name) {
      cmd = (await vscode.window.showInputBox({ placeHolder: 'which command?' }))!;
    }

    if (!cmd || !cmd.trim()) {
      console.info("[h2o.clearCacheCommand] Cancelled operation.");
      return;
    }

    try {
      console.log(`[h2o.clearCacheCommand] Clearing cache for ${cmd}`);
      await fetcher.unset(cmd);
      const msg = `[Shell Completion] Cleared ${cmd}`;
      vscode.window.showInformationMessage(msg);
    } catch (e) {
      console.error("Error: ", e);
      return Promise.reject("[h2o.clearCacheCommand] Failed");
    }

  });

  // h2o.loadCommon: Download the package bundle "common"
  const invokeDownloadingCommon = vscode.commands.registerCommand('h2o.loadCommon', async () => {
    try {
      console.log('[h2o.loadCommon] Load common CLI data');
      const msg1 = `[Shell Completion] Loading common CLI data...`;
      vscode.window.showInformationMessage(msg1);

      await fetcher.fetchAllCurated('general', true);
    } catch (e) {
      console.error("[h2o.loadCommon] Error: ", e);
      const msg = `[Shell Completion] Error: Failed to load common CLI specs`;
      vscode.window.showInformationMessage(msg);
      return Promise.reject("[h2o.loadCommon] Error: ");
    }

    const msg = `[Shell Completion] Succssfully loaded common CLI specs`;
    vscode.window.showInformationMessage(msg);
  });


  // h2o.loadBio: Download the command bundle "bio"
  const invokeDownloadingBio = vscode.commands.registerCommand('h2o.loadBio', async () => {
    try {
      console.log('[h2o.loadBio] Load Bioinformatics CLI data');
      const msg1 = `[Shell Completion] Loading bioinformatics CLI specs...`;
      vscode.window.showInformationMessage(msg1);

      await fetcher.fetchAllCurated('bio', true);
    } catch (e) {
      console.error("[h2o.loadBio] Error: ", e);
      return Promise.reject("[h2o.loadBio] Failed to load the Bio package");
    }

    const msg = `[Shell Completion] Succssfully loaded bioinformatics CLI specs!`;
    vscode.window.showInformationMessage(msg);
  });


  // h2o.removeBio: Remove the command bundle "bio"
  const removeBio = vscode.commands.registerCommand('h2o.removeBio', async () => {
    try {
      console.log('[h2o.removeBio] Remove Bioinformatics CLI data');
      const msg1 = `[Shell Completion] Removing bioinformatics CLI specs...`;
      vscode.window.showInformationMessage(msg1);

      const names = await fetcher.fetchList('bio');
      names.forEach(async (name) => await fetcher.unset(name));
    } catch (e) {
      console.error("[h2o.removeBio] Error: ", e);
      return Promise.reject("[h2o.removeBio] Fetch Error: ");
    }

    const msg = `[Shell Completion] Succssfully removed bioinformatics CLI specs!`;
    vscode.window.showInformationMessage(msg);
  });


  // Command Explorer
  const commandListProvider = new CommandListProvider(fetcher);
  vscode.window.registerTreeDataProvider('registeredCommands', commandListProvider);
  vscode.commands.registerCommand('registeredCommands.refreshEntry', () =>
    commandListProvider.refresh()
  );

  vscode.commands.registerCommand('registeredCommands.removeEntry', async (item: vscode.TreeItem) => {
    if (!!item && !!item.label) {
      const name = item.label as string;
      console.log(`[registeredCommands.removeEntry] Remove ${name}`);
      await fetcher.unset(name);
      commandListProvider.refresh();
    }
  });


  context.subscriptions.push(clearCacheCommand);
  context.subscriptions.push(loadCommand);
  context.subscriptions.push(invokeDownloadingCommon);
  context.subscriptions.push(invokeDownloadingBio);
  context.subscriptions.push(removeBio);
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(edit));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(close));
  context.subscriptions.push(compprovider);
  context.subscriptions.push(hoverprovider);

}


// Convert: vscode.Position -> Parser.Point
function asPoint(p: vscode.Position): Parser.Point {
  return { row: p.line, column: p.character };
}

// Convert: option -> UI text (string)
function optsToMessage(opts: Option[]): string {
  if (opts.length === 1) {
    const opt = opts[0];
    const namestr = opt.names.map((s) => `\`${s}\``).join(', ');
    const argstr = (!!opt.argument) ? `\`${opt.argument}\`` : "";
    const msg = `${namestr} ${argstr}\n\n ${opt.description}`;
    return msg;

  } else {
    // deal with stacked option
    const namestrs = opts.map(opt => opt.names.map((s) => `\`${s}\``).join(', '));
    const messages = opts.map((opt, i) => `${namestrs[i]}\n\n ${opt.description}`);
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
// [FIXME] Do not rely on such an ugly hack
function walkbackIfNeeded(document: vscode.TextDocument, root: SyntaxNode, position: vscode.Position): vscode.Position {
  const thisNode = getCurrentNode(root, position);
  console.debug("[walkbackIfNeeded] thisNode.type: ", thisNode.type);
  if (thisNode.type === ';') {
    console.info("[walkbackIfNeeded] stop at semicolon.");
    return position;
  }

  if (position.character > 0 && thisNode.type !== 'word') {
    console.info("[walkbackIfNeeded] stepping back!");
    return walkbackIfNeeded(document, root, position.translate(0, -1));
  } else if (thisNode.type !== 'word' && position.character === 0 && position.line > 0) {
    const prevLineIndex = position.line - 1;
    const prevLine = document.lineAt(prevLineIndex);
    if (prevLine.text.trimEnd().endsWith('\\')) {
      const charIndex = prevLine.text.trimEnd().length - 1;
      return walkbackIfNeeded(document, root, new vscode.Position(prevLineIndex, charIndex));
    }
  }
  return position;
}


// Returns current word as an option if the tree-sitter says so
function getMatchingOption(currentWord: string, name: string, cmdSeq: Command[]): Option[] {
  const thisName = currentWord.split('=', 2)[0];
  if (thisName.startsWith('-')) {
    const options = getOptions(cmdSeq);
    const theOption = options.find((x) => x.names.includes(thisName));
    if (theOption) {
      return [theOption];
    } else if (isOldStyle(thisName)) {
      // deal with a stacked options like `-xvf`
      // or, a short option immediately followed by an argument, i.e. '-oArgument'
      const shortOptionNames = unstackOption(thisName);
      const shortOptions = shortOptionNames.map(short => options.find(opt => opt.names.includes(short))!).filter(opt => opt);
      if (shortOptionNames.length > 0 && shortOptionNames.length === shortOptions.length) {
        return shortOptions;        // i.e. -xvf
      } else if (shortOptions.length > 0) {
        return [shortOptions[0]];   // i.e. -oArgument
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
  const xs = name.substring(1).split('').map(c => c.padStart(2, '-'));
  return [...new Set(xs)];
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

// Get subcommand names NOT starting with `-`
// [FIXME] this catches option's argument; use database instead
function _getSubcommandCandidates(root: SyntaxNode, position: vscode.Position): string[] {
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
async function getContextCmdSeq(root: SyntaxNode, position: vscode.Position, fetcher: CachingFetcher): Promise<Command[]> {
  let name = getContextCommandName(root, position);
  if (!name) {
    return Promise.reject("[getContextCmdSeq] Command name not found.");
  }

  try {
    let command = await fetcher.fetch(name);
    const seq: Command[] = [command];
    if (!!command) {
      const words = _getSubcommandCandidates(root, position);
      let found = true;
      while (found && !!command.subcommands && command.subcommands.length) {
        found = false;
        const subcommands = getSubcommandsWithAliases(command);
        for (const word of words) {
          for (const subcmd of subcommands) {
            if (subcmd.name === word) {
              command = subcmd;
              seq.push(command);
              found = true;
            }
          }
        }
      }
    }
    return seq;
  } catch (e) {
    console.error("[getContextCmdSeq] Error: ", e);
    return Promise.reject("[getContextCmdSeq] unknown command!");
  }
}


// Get command arguments as string[]
function getContextCmdArgs(document: vscode.TextDocument, root: SyntaxNode, position: vscode.Position): string[] {
  const p = walkbackIfNeeded(document, root, position);
  let node = _getContextCommandNode(root, p)?.firstNamedChild;
  if (node?.text === 'sudo') {
    node = node.nextSibling;
  }
  const res: string[] = [];
  while (node?.nextSibling) {
    node = node.nextSibling;
    let text = node.text;
    // --option=arg
    if (text.startsWith('--') && text.includes('=')) {
      text = text.split('=', 2)[0];
    }
    res.push(text);
  }
  return res;
}


// Get subcommand completions
function getCompletionsSubcommands(deepestCmd: Command): vscode.CompletionItem[] {
  const subcommands = getSubcommandsWithAliases(deepestCmd);
  if (subcommands && subcommands.length) {
    const compitems = subcommands.map((sub, idx) => {
      const item = createCompletionItem(sub.name, sub.description);
      item.sortText = `33-${idx.toString().padStart(4)}`;
      return item;
    });
    return compitems;
  }
  return [];
}


// Get option completion
function getCompletionsOptions(document: vscode.TextDocument, root: SyntaxNode, position: vscode.Position, cmdSeq: Command[]): vscode.CompletionItem[] {
  const args = getContextCmdArgs(document, root, position);
  const compitems: vscode.CompletionItem[] = [];
  const options = getOptions(cmdSeq);
  options.forEach((opt, idx) => {
    // suppress already-used options
    if (opt.names.every(name => !args.includes(name))) {
      opt.names.forEach(name => {
        const item = createCompletionItem(name, opt.description);
        item.sortText = `55-${idx.toString().padStart(4)}`;
        if (opt.argument) {
          const snippet = `${name} \$\{1:${opt.argument}\}`;
          item.insertText = new vscode.SnippetString(snippet);
        }
        compitems.push(item);
      });
    }
  });
  return compitems;
}


function createCompletionItem(label: string, desc: string): vscode.CompletionItem {
  return new vscode.CompletionItem({ label: label, description: desc });
}


// Get options including inherited ones
function getOptions(cmdSeq: Command[]): Option[] {
  const inheritedOptionsArray = cmdSeq.map(x => (!!x.inheritedOptions) ? x.inheritedOptions : []);
  const deepestCmd = cmdSeq[cmdSeq.length - 1];
  const options = deepestCmd.options.concat(...inheritedOptionsArray);
  return options;
}


// Get subcommands including aliases of a subcommands
function getSubcommandsWithAliases(cmd: Command): Command[] {
  const subcommands = cmd.subcommands;
  if (!subcommands) {
    return [];
  }

  const res: Command[] = [];
  for (let subcmd of subcommands) {
    res.push(subcmd);
    if (!!subcmd.aliases) {
      for (const alias of subcmd.aliases) {
        const aliasCmd = { ...subcmd };
        aliasCmd.name = alias;
        aliasCmd.description = `(Alias of ${subcmd.name}) `.concat(aliasCmd.description);
        res.push(aliasCmd);
      }
    }
  }
  return res;
}

export function deactivate() { }
