import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { Edit, Language, Node, Parser, Point, Tree } from 'web-tree-sitter';
import { CachingFetcher } from './cacheFetcher';
import { GzipCommandCacheStorage } from './cacheStorage';
import { Option, Command } from './command';
import {
  CommandPathResolution,
  getDirectSubcommandLabels,
  resolveCommandPath,
} from './commandResolver';
import { CommandListProvider } from './commandExplorer';
import {
  CommandInvocation,
  CommandWord,
  getCommandInvocationToPosition,
  getCommandName,
} from './analyzer';
import { loadLanguageOnce } from './parserLanguage';
import { formatTldr, isPrefixOf, getLabelString, formatUsage, formatDescription } from './utils';


const supportedLanguages = ['shellscript', 'bitbake'];
const nestedCommandScopeBoundaries = new Set(['command_substitution', 'process_substitution', 'subshell']);

export type TreeCache = { [uri: string]: Tree };

function parseTree(parser: Parser, source: string, oldTree?: Tree): Tree {
  const tree = parser.parse(source, oldTree);
  if (!tree) {
    throw new Error('[Parser] Parsing was cancelled.');
  }
  return tree;
}

export interface ParserInitializationDependencies {
  init(): Promise<void>;
  createParser(): Parser;
  loadLanguage(wasmPath: string): Promise<Language>;
}

const defaultParserInitializationDependencies: ParserInitializationDependencies = {
  init: () => Parser.init(),
  createParser: () => new Parser(),
  loadLanguage: loadLanguageOnce,
};

export async function initializeParser(
  dependencies: ParserInitializationDependencies = defaultParserInitializationDependencies,
): Promise<Parser> {
  await dependencies.init();
  const parser = dependencies.createParser();
  const path = `${__dirname}/../tree-sitter-bash.wasm`;

  try {
    const lang = await dependencies.loadLanguage(path);
    parser.setLanguage(lang);
    return parser;
  } catch (error) {
    try {
      parser.delete();
    } catch (cleanupError) {
      console.error('[Parser] Failed to delete the parser after initialization failed:', cleanupError);
    }
    throw error;
  }
}

async function withTreeCopy<T>(tree: Tree, operation: (copy: Tree) => Promise<T>): Promise<T> {
  const copy = tree.copy();
  try {
    return await operation(copy);
  } finally {
    copy.delete();
  }
}

interface ResolvedCommandContext {
  invocation: CommandInvocation;
  resolution: CommandPathResolution<CommandWord>;
}

export interface ActivationDependencies {
  initializeParser(): Promise<Parser>;
}

const defaultActivationDependencies: ActivationDependencies = {
  initializeParser: () => initializeParser(),
};

function disposeActivationRegistrations(disposables: vscode.Disposable[]): void {
  for (let index = disposables.length - 1; index >= 0; index -= 1) {
    try {
      disposables[index].dispose();
    } catch (error) {
      console.error('[Activation] Failed to roll back a registration:', error);
    }
  }
}

async function registerExtension(
  context: vscode.ExtensionContext,
  parser: Parser,
  trees: TreeCache,
  activationRegistrations: vscode.Disposable[],
): Promise<void> {
  const cacheDirectory = context.globalStorageUri;
  const cacheStorage = new GzipCommandCacheStorage(vscode.workspace.fs, {
    directory: cacheDirectory,
    snapshot: vscode.Uri.joinPath(cacheDirectory, 'commands-v1.json.gz'),
    temporary: () => vscode.Uri.joinPath(
      cacheDirectory,
      `commands-v1.${process.pid}.${randomUUID()}.json.gz.tmp`,
    ),
  });
  const fetcher = new CachingFetcher(context.globalState, { cacheStorage });
  await fetcher.init();
  const initialCuratedFetch = fetcher.startInitialCuratedFetch("general");
  void initialCuratedFetch.catch(() => {
    console.warn("Failed in fetch.fetchAllCurated().");
  });


  const compprovider = vscode.languages.registerCompletionItemProvider(
    supportedLanguages,
    {
      async provideCompletionItems(document, position, token, context) {
        if (!parser) {
          console.error("[Completion] Parser is unavailable!");
          return Promise.reject("Parser unavailable!");
        }
        if (!trees[document.uri.toString()]) {
          console.log("[Completion] Creating tree");
          trees[document.uri.toString()] = parseTree(parser, document.getText());
        }
        const tree = trees[document.uri.toString()];
        return withTreeCopy(tree, async requestTree => {
          // this is an ugly hack to get current Node
          const p = walkbackIfNeeded(document, requestTree.rootNode, position);
          const isCursorTouchingWord = (p === position);
          console.log(`[Completion] isCursorTouchingWord: ${isCursorTouchingWord}`);

          try {
            const includeCurrentArgument = !isCursorTouchingWord;
            const commandContext = await getContextCommandResolution(
              requestTree.rootNode,
              p,
              fetcher,
              includeCurrentArgument,
            );
            const cmdSeq = commandContext.resolution.path;
            if (!!cmdSeq && cmdSeq.length) {
              const deepestCmd = cmdSeq[cmdSeq.length - 1];
              const compSubcommands = commandContext.resolution.stopReason === undefined
                ? getCompletionsSubcommands(deepestCmd)
                : [];
              let compOptions = commandContext.resolution.stopReason === 'end-of-options'
                ? []
                : getCompletionsOptions(
                  requestTree.rootNode,
                  p,
                  cmdSeq,
                  includeCurrentArgument,
                );
              let compItems = [
                ...compSubcommands,
                ...compOptions,
              ];

              if (isCursorTouchingWord) {
                const currentNode = getCurrentNode(requestTree.rootNode, position);
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
            const currentNode = getCurrentNode(requestTree.rootNode, position);
            const currentWord = currentNode.text;
            const compCommands = fetcher.getList().map(name => new vscode.CompletionItem(name));
            console.info(`[Completion] currentWord = ${currentWord}`);
            if (p === position && currentWord.length >= 2) {
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
        });
      }
    },
    ' ',  // triggerCharacter
  );
  activationRegistrations.push(compprovider);

  const hoverprovider = vscode.languages.registerHoverProvider(supportedLanguages, {
    async provideHover(document, position, token) {

      if (!parser) {
        console.error("[Hover] Parser is unavailable!");
        return Promise.reject("Parser is unavailable!");
      }

      if (!trees[document.uri.toString()]) {
        console.log("[Hover] Creating tree");
        trees[document.uri.toString()] = parseTree(parser, document.getText());
      }
      const tree = trees[document.uri.toString()];
      return withTreeCopy(tree, async requestTree => {
        const currentWord = getCurrentNode(requestTree.rootNode, position).text;
        try {
          const commandContext = await getContextCommandResolution(requestTree.rootNode, position, fetcher);
          const cmdSeq = commandContext.resolution.path;
          if (!!cmdSeq && cmdSeq.length) {
            const name = cmdSeq[0].name;
            const subcommandStepIndex = commandContext.resolution.steps.findIndex(
              step => rangeOfWord(step.source).contains(position),
            );
            const subcommandStep = commandContext.resolution.steps[subcommandStepIndex];
            if (rangeOfWord(commandContext.invocation.name).contains(position)) {
              // Display root-level command
              const clearCacheCommandUri = vscode.Uri.parse(`command:h2o.clearCache?${encodeURIComponent(JSON.stringify(name))}`);
              const thisCmd = cmdSeq[0];
              const tldrText = formatTldr(thisCmd.tldr);
              const usageText = formatUsage(thisCmd.usage);
              const descText = (thisCmd.description !== thisCmd.name && !tldrText) ? formatDescription(thisCmd.description) : "";
              const msg = new vscode.MarkdownString(`\`${name}\`${descText}${usageText}${tldrText}\n\n[Reset](${clearCacheCommandUri})`);
              msg.isTrusted = {
                enabledCommands: ['h2o.clearCache'],
              };
              return new vscode.Hover(msg);
            } else if (subcommandStep) {
              // Display a subcommand
              const thatCmd = subcommandStep.command;
              const cmdPrefixName = cmdSeq
                .slice(0, subcommandStepIndex + 1)
                .map(command => command.name)
                .join(" ");
              const description = subcommandStep.matchedBy === 'alias'
                ? `(Alias of ${thatCmd.name}) ${thatCmd.description}`
                : thatCmd.description;
              const usageText = formatUsage(thatCmd.usage);
              const msg = `${cmdPrefixName} **${subcommandStep.source.text}**\n\n${description}${usageText}`;
              return new vscode.Hover(new vscode.MarkdownString(msg));
            } else if (cmdSeq.length
              && commandContext.resolution.stopReason !== 'end-of-options') {
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
        return undefined;
      });
    }
  });
  activationRegistrations.push(hoverprovider);

  function edit(edit: vscode.TextDocumentChangeEvent) {
    updateTree(parser, trees, edit);
  }

  function close(document: vscode.TextDocument) {
    console.log("[Close] removing a tree");
    const t = trees[document.uri.toString()];
    if (t) {
      t.delete();
      delete trees[document.uri.toString()];
    }
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
      void vscode.window.showInformationMessage(msg);
    } catch (e) {
      console.error("Error: ", e);
      return Promise.reject(`[h2o.loadCommand] Failed to load ${cmd}`);
    }
    return;
  });
  activationRegistrations.push(loadCommand);


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
      void vscode.window.showInformationMessage(msg);
    } catch (e) {
      console.error("Error: ", e);
      return Promise.reject("[h2o.clearCacheCommand] Failed");
    }
    return;
  });
  activationRegistrations.push(clearCacheCommand);

  // h2o.loadCommon: Download the package bundle "common"
  const invokeDownloadingCommon = vscode.commands.registerCommand('h2o.loadCommon', async () => {
    try {
      console.log('[h2o.loadCommon] Load common CLI data');
      const msg1 = `[Shell Completion] Loading common CLI data...`;
      void vscode.window.showInformationMessage(msg1);

      await fetcher.fetchAllCurated('general', true);
    } catch (e) {
      console.error("[h2o.loadCommon] Error: ", e);
      const msg = `[Shell Completion] Error: Failed to load common CLI specs`;
      void vscode.window.showInformationMessage(msg);
      return Promise.reject("[h2o.loadCommon] Error: ");
    }

    const msg = `[Shell Completion] Succssfully loaded common CLI specs`;
    void vscode.window.showInformationMessage(msg);
    return;
  });
  activationRegistrations.push(invokeDownloadingCommon);


  // h2o.loadBio: Download the command bundle "bio"
  const invokeDownloadingBio = vscode.commands.registerCommand('h2o.loadBio', async () => {
    try {
      console.log('[h2o.loadBio] Load Bioinformatics CLI data');
      const msg1 = `[Shell Completion] Loading bioinformatics CLI specs...`;
      void vscode.window.showInformationMessage(msg1);

      await fetcher.fetchAllCurated('bio', true);
    } catch (e) {
      console.error("[h2o.loadBio] Error: ", e);
      return Promise.reject("[h2o.loadBio] Failed to load the Bio package");
    }

    const msg = `[Shell Completion] Succssfully loaded bioinformatics CLI specs!`;
    void vscode.window.showInformationMessage(msg);
    return;
  });
  activationRegistrations.push(invokeDownloadingBio);


  // h2o.removeBio: Remove the command bundle "bio"
  const removeBio = vscode.commands.registerCommand('h2o.removeBio', async () => {
    try {
      console.log('[h2o.removeBio] Remove Bioinformatics CLI data');
      const msg1 = `[Shell Completion] Removing bioinformatics CLI specs...`;
      void vscode.window.showInformationMessage(msg1);

      const names = await fetcher.fetchList('bio');
      await fetcher.unsetAll(names);
    } catch (e) {
      console.error("[h2o.removeBio] Error: ", e);
      return Promise.reject("[h2o.removeBio] Fetch Error: ");
    }

    const msg = `[Shell Completion] Succssfully removed bioinformatics CLI specs!`;
    void vscode.window.showInformationMessage(msg);
    return;
  });
  activationRegistrations.push(removeBio);


  // Command Explorer
  const commandListProvider = new CommandListProvider(fetcher);
  void initialCuratedFetch.then(() => commandListProvider.refresh(), () => undefined);
  activationRegistrations.push(
    vscode.window.registerTreeDataProvider('registeredCommands', commandListProvider),
  );
  activationRegistrations.push(vscode.commands.registerCommand('registeredCommands.refreshEntry', () =>
    commandListProvider.refresh()
  ));

  activationRegistrations.push(vscode.commands.registerCommand('registeredCommands.removeEntry', async (item: vscode.TreeItem) => {
    if (!!item && !!item.label) {
      const name = item.label as string;
      console.log(`[registeredCommands.removeEntry] Remove ${name}`);
      await fetcher.unset(name);
      commandListProvider.refresh();
    }
  }));


  activationRegistrations.push(vscode.workspace.onDidChangeTextDocument(edit));
  activationRegistrations.push(vscode.workspace.onDidCloseTextDocument(close));
  context.subscriptions.push(
    ...activationRegistrations,
    { dispose: () => disposeParserResources(parser, trees) },
  );
}

export async function activate(
  context: vscode.ExtensionContext,
  dependencies: ActivationDependencies = defaultActivationDependencies,
): Promise<void> {
  const parser = await dependencies.initializeParser();
  const trees: TreeCache = {};
  const activationRegistrations: vscode.Disposable[] = [];

  try {
    await registerExtension(context, parser, trees, activationRegistrations);
  } catch (error) {
    disposeActivationRegistrations(activationRegistrations);
    try {
      disposeParserResources(parser, trees);
    } catch (cleanupError) {
      console.error('[Activation] Failed to clean up parser resources:', cleanupError);
    }
    throw error;
  }
}


// Convert: vscode.Position -> Point
function asPoint(p: vscode.Position): Point {
  return { row: p.line, column: p.character };
}

function advancePoint(start: Point, text: string): Point {
  let row = start.row;
  let column = start.column;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      row += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { row, column };
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

function range(n: Node): vscode.Range {
  return new vscode.Range(
    n.startPosition.row,
    n.startPosition.column,
    n.endPosition.row,
    n.endPosition.column,
  );
}

function rangeOfWord(word: CommandWord): vscode.Range {
  return new vscode.Range(
    word.startPosition.row,
    word.startPosition.column,
    word.endPosition.row,
    word.endPosition.column,
  );
}


// --------------- For Hovers and Completions ----------------------

// Find the deepest node that contains the position in its range.
export function getCurrentNode(n: Node, position: vscode.Position): Node {
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
export function walkbackIfNeeded(document: vscode.TextDocument, root: Node, position: vscode.Position): vscode.Position {
  let currentPosition = position;
  let moveCount = 0;

  while (true) {
    const thisNode = getCurrentNode(root, currentPosition);
    if (thisNode.type === ';') {
      if (moveCount > 0) {
        console.debug(`[walkbackIfNeeded] moved ${moveCount} time(s); stopped at ${thisNode.type}.`);
      }
      return currentPosition;
    }

    if (currentPosition.character > 0 && thisNode.type !== 'word') {
      currentPosition = currentPosition.translate(0, -1);
      moveCount += 1;
      continue;
    } else if (thisNode.type !== 'word' && currentPosition.character === 0 && currentPosition.line > 0) {
      const prevLineIndex = currentPosition.line - 1;
      const prevLine = document.lineAt(prevLineIndex);
      if (prevLine.text.trimEnd().endsWith('\\')) {
        const charIndex = prevLine.text.trimEnd().length - 1;
        currentPosition = new vscode.Position(prevLineIndex, charIndex);
        moveCount += 1;
        continue;
      }
    }
    if (moveCount > 0) {
      console.debug(`[walkbackIfNeeded] moved ${moveCount} time(s); stopped at ${thisNode.type}.`);
    }
    return currentPosition;
  }
}

export function updateTree(p: Parser, trees: TreeCache, edit: vscode.TextDocumentChangeEvent): void {
  if (
    edit.document.isClosed ||
    edit.contentChanges.length === 0 ||
    !supportedLanguages.includes(edit.document.languageId)
  ) { return; }

  const key = edit.document.uri.toString();
  const old = trees[key];
  if (!!old) {
    // Apply later ranges first so each remaining range still addresses the pre-edit tree.
    const changes = [...edit.contentChanges].sort((left, right) => right.rangeOffset - left.rangeOffset);
    for (const e of changes) {
      const startIndex = e.rangeOffset;
      const oldEndIndex = e.rangeOffset + e.rangeLength;
      const newEndIndex = e.rangeOffset + e.text.length;
      const startPosition = asPoint(e.range.start);
      const oldEndPosition = asPoint(e.range.end);
      const newEndPosition = advancePoint(startPosition, e.text);
      const delta = new Edit({ startIndex, oldEndIndex, newEndIndex, startPosition, oldEndPosition, newEndPosition });
      old.edit(delta);
    }
  }
  const t = parseTree(p, edit.document.getText(), old);
  trees[key] = t;
  old?.delete();
}

export function disposeParserResources(p: Pick<Parser, 'delete'>, trees: TreeCache): void {
  let firstError: unknown;
  let failed = false;

  for (const key of Object.keys(trees)) {
    try {
      trees[key].delete();
    } catch (error) {
      if (!failed) {
        firstError = error;
        failed = true;
      }
    } finally {
      delete trees[key];
    }
  }

  try {
    p.delete();
  } catch (error) {
    if (!failed) {
      firstError = error;
      failed = true;
    }
  }

  if (failed) {
    throw firstError;
  }
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
      if (shortOptionNames.length > 1 && shortOptionNames.length === shortOptions.length) {
        return shortOptions;        // i.e. -xvf
      } else if (shortOptions.length > 0) {
        return [shortOptions[0]];   // i.e. -oArgument
      }
    }
  }
  return [];
}

function isOldStyle(name: string): boolean {
  return name.startsWith('-') && !name.startsWith('--') && name.length > 2;
}

function unstackOption(name: string): string[] {
  const xs = name.substring(1).split('').map(c => c.padStart(2, '-'));
  if (!xs.length) {
    return [];
  }
  const ys = new Set(xs);
  if (xs.length !== ys.size) {
    // if characters are NOT unique like -baba
    // then it returns ['-b'] assuming 'aba' is the argument
    return [xs[0]];
  }
  return xs;
}

// Get command node inferred from the current position
export function _getContextCommandNode(root: Node, position: vscode.Position): Node | undefined {
  let currentNode: Node | null = getCurrentNode(root, position);
  while (currentNode) {
    if (currentNode.type === 'command') {
      return currentNode;
    }
    if (nestedCommandScopeBoundaries.has(currentNode.type)) {
      return undefined;
    }
    currentNode = currentNode.parent;
  }
  return undefined;
}

// Get command name covering the position if exists
export function getContextCommandName(root: Node, position: vscode.Position): string | undefined {
  const commandNode = _getContextCommandNode(root, position);
  return getCommandName(commandNode);
}

// Get command and subcommand inferred from the current position
async function getContextCommandResolution(
  root: Node,
  position: vscode.Position,
  fetcher: CachingFetcher,
  includeArgumentAtPosition = true,
): Promise<ResolvedCommandContext> {
  const commandNode = _getContextCommandNode(root, position);
  const invocation = getCommandInvocationToPosition(
    commandNode,
    asPoint(position),
    includeArgumentAtPosition,
  );
  if (!invocation) {
    return Promise.reject("[getContextCommandResolution] Command name not found.");
  }

  try {
    const command = await fetcher.fetch(invocation.name.text);
    return {
      invocation,
      resolution: resolveCommandPath(command, invocation.arguments),
    };
  } catch (e) {
    console.error("[getContextCommandResolution] Error: ", e);
    return Promise.reject("[getContextCommandResolution] unknown command!");
  }
}


// Get command arguments as string[]
function getContextCmdArgs(
  root: Node,
  position: vscode.Position,
  includeArgumentAtPosition: boolean,
): string[] {
  const commandNode = _getContextCommandNode(root, position);
  const invocation = getCommandInvocationToPosition(
    commandNode,
    asPoint(position),
    includeArgumentAtPosition,
  );
  return (invocation?.arguments ?? []).map(argument => {
    let text = argument.text;
    // --option=arg
    if (text.startsWith('--') && text.includes('=')) {
      text = text.split('=', 2)[0];
    }
    return text;
  });
}


// Get subcommand completions
function getCompletionsSubcommands(deepestCmd: Command): vscode.CompletionItem[] {
  const labels = getDirectSubcommandLabels(deepestCmd);
  if (labels.length) {
    const compitems = labels.map((label, idx) => {
      const description = label.matchedBy === 'alias'
        ? `(Alias of ${label.command.name}) ${label.command.description}`
        : label.command.description;
      const item = createCompletionItem(label.spelling, description);
      item.sortText = `33-${idx.toString().padStart(4)}`;
      return item;
    });
    return compitems;
  }
  return [];
}


// Get option completion
function getCompletionsOptions(
  root: Node,
  position: vscode.Position,
  cmdSeq: Command[],
  includeArgumentAtPosition: boolean,
): vscode.CompletionItem[] {
  const args = getContextCmdArgs(root, position, includeArgumentAtPosition);
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
  const options = (!!deepestCmd && !!deepestCmd.options) ? deepestCmd.options.concat(...inheritedOptionsArray) : [];
  return options;
}


export function deactivate() { }
