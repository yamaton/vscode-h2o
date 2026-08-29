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
  isCommandTokenNode,
} from './analyzer';
import { loadLanguageOnce } from './parserLanguage';
import { formatTldr, isPrefixOf, getLabelString, formatUsage, formatDescription } from './utils';
import {
  CommandNameCompletionContext,
  getCommandNameCompletionContext,
} from './completionTarget';
import { waitForPromiseOrCancellation } from './cancellable';
import {
  debugDocumentScheme,
  LiveDebugViewManager,
  type LiveCompletionProviderTrace,
  type LiveDebugPresentationState,
  type LiveHoverProviderTrace,
  type LiveProviderTraces,
} from './debugView';


const supportedLanguages = ['shellscript', 'bitbake'];
const nestedCommandScopeBoundaries = new Set(['command_substitution', 'process_substitution', 'subshell']);
const providerSuppressedNodeTypes = new Set([
  'file_redirect',
  'herestring_redirect',
  'heredoc_redirect',
]);

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

export type ProviderSuppressionReason =
  | 'ERROR'
  | 'MISSING'
  | 'file_redirect'
  | 'herestring_redirect'
  | 'heredoc_redirect';

export interface DebugPosition {
  line: number;
  character: number;
}

export interface DebugLocation extends DebugPosition {
  offset: number;
  lineText: string;
}

export interface DebugNode {
  id: number;
  type: string;
  grammarType: string;
  fieldName: string | null;
  typeId: number;
  grammarId: number;
  named: boolean;
  extra: boolean;
  error: boolean;
  missing: boolean;
  hasError: boolean;
  hasChanges: boolean;
  parseState: number;
  nextParseState: number;
  commandToken: boolean;
  start: DebugPosition & { index: number };
  end: DebugPosition & { index: number };
  text: string;
}

export interface DebugInvocation {
  name: DebugWord;
  arguments: DebugWord[];
}

export interface DebugWord {
  text: string;
  start: DebugPosition;
  end: DebugPosition;
}

export interface DebugResolution {
  path: string[];
  steps: Array<{
    command: string;
    source: string;
    sourceRange: {
      start: DebugPosition;
      end: DebugPosition;
    };
    matchedBy: 'canonical' | 'alias';
  }>;
  stopReason: CommandPathResolution['stopReason'] | null;
}

export interface DebugProviderDecision {
  enabled: boolean;
  lookupKind: ProviderLookupKind;
  requestedPosition: DebugPosition;
  resolvedPosition: DebugPosition;
  moved: boolean;
  walkbackUnchanged: boolean;
  includeArgumentAtPosition: boolean;
  resumedAfterHerestring: boolean;
  requestSuppressionReasons: ProviderSuppressionReason[];
  resolvedSuppressionReasons: ProviderSuppressionReason[];
  resolvedNode: DebugNode;
  commandNode: DebugNode | null;
  invocation: DebugInvocation | null;
  resolution: DebugResolution | null;
  lookupError: string | null;
}

export interface DebugTreeReport {
  root: DebugNode;
  currentNode: DebugNode;
  ancestors: DebugNode[];
  completion: DebugProviderDecision;
  hover: DebugProviderDecision;
}

export interface CaretDebugReport {
  generatedAt: string;
  document: {
    uri: string;
    languageId: string;
    version: number;
  };
  caret: DebugLocation;
  cached: DebugTreeReport;
  fresh: DebugTreeReport;
  comparison: {
    syntaxAtCaretEquivalent: boolean;
    completionEquivalent: boolean;
    hoverEquivalent: boolean;
  };
}

export type LiveDebugNode = DebugNode;

export interface LiveDebugProviderDecision {
  enabled: boolean;
  lookupKind: ProviderLookupKind;
  resolvedPosition: DebugPosition;
  moved: boolean;
  walkbackUnchanged: boolean;
  includeArgumentAtPosition: boolean;
  resumedAfterHerestring: boolean;
  requestSuppressionReasons: ProviderSuppressionReason[];
  resolvedSuppressionReasons: ProviderSuppressionReason[];
  resolvedNode: LiveDebugNode;
  invocation: DebugInvocation | null;
  resolution: DebugResolution | null;
  lookupError: string | null;
}

/**
 * A caret is the editor insertion point used by completion. A cursor is the
 * pointer position delivered to the hover provider. Provider decisions may
 * resolve either request to a separate position.
 */
export interface LiveEditorDebugSnapshot {
  document: CaretDebugReport['document'];
  caret: DebugLocation;
  caretNode: LiveDebugNode;
  caretAncestors: LiveDebugNode[];
  cursor: DebugLocation | null;
  cursorNode: LiveDebugNode | null;
  cursorAncestors: LiveDebugNode[];
  completion: LiveDebugProviderDecision;
  hover: LiveDebugProviderDecision | null;
}

export interface LiveEditorDebugToggleResult {
  enabled: boolean;
  snapshot?: LiveEditorDebugSnapshot;
}

export interface LiveEditorDebugState {
  enabled: boolean;
  paused: boolean;
  updateSequence: number;
  traces: LiveProviderTraces;
  presentation: LiveDebugPresentationState;
  snapshot?: LiveEditorDebugSnapshot;
}

export interface LiveEditorDebugPauseResult {
  enabled: boolean;
  paused: boolean;
}

interface ProviderPositionDecision {
  enabled: boolean;
  position: vscode.Position;
  walkbackUnchanged: boolean;
  resumedAfterHerestring: boolean;
  requestSuppressionReasons: ProviderSuppressionReason[];
  resolvedSuppressionReasons: ProviderSuppressionReason[];
}

export type ProviderLookupKind = 'none' | 'command-name' | 'command-spec';

interface CompletionRequestAnalysis {
  decision: ProviderPositionDecision;
  commandNameContext: CommandNameCompletionContext | undefined;
  includeArgumentAtPosition: boolean;
}

interface LineTextProvider {
  lineAt(line: number): { text: string };
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
      async provideCompletionItems(document, caret, token, context) {
        const liveTraceRequest = trackLiveCompletionRequest(document, caret);
        if (!parser) {
          console.error("[Completion] Parser is unavailable!");
          trackLiveCompletionResult(liveTraceRequest, 'error', {
            error: 'Parser unavailable!',
          });
          return Promise.reject("Parser unavailable!");
        }
        if (!trees[document.uri.toString()]) {
          console.log("[Completion] Creating tree");
          trees[document.uri.toString()] = parseTree(parser, document.getText());
        }
        const tree = trees[document.uri.toString()];
        return withTreeCopy(tree, async requestTree => {
          const completionAnalysis = getCompletionRequestAnalysis(
            document,
            requestTree.rootNode,
            caret,
          );
          const caretDecision = completionAnalysis.decision;
          if (!caretDecision.enabled) {
            trackLiveCompletionResult(liveTraceRequest, 'suppressed', { itemCount: 0 });
            return [];
          }

          const resolvedPosition = caretDecision.position;
          const isCaretTouchingWord = caretDecision.walkbackUnchanged;
          console.log(`[Completion] isCaretTouchingWord: ${isCaretTouchingWord}`);

          if (completionAnalysis.commandNameContext) {
            const commandName = completionAnalysis.commandNameContext;
            // Editing inside an existing command word is not treated as typing
            // a command name. Do not replace text after the caret or resolve
            // the partially edited word through H2O.
            if (!commandName.atWordEnd) {
              trackLiveCompletionResult(liveTraceRequest, 'items', { itemCount: 0 });
              return [];
            }

            let snapshot = fetcher.getCommandNameSnapshot();
            let matchingNames = snapshot.names.filter(name =>
              isPrefixOf(commandName.word.text, name)
            );
            if (matchingNames.length === 0 && snapshot.initialCuratedPending) {
              const available = await waitForPromiseOrCancellation(
                fetcher.waitForInitialCuratedAvailability(),
                token,
              );
              if (!available) {
                trackLiveCompletionResult(liveTraceRequest, 'items', { itemCount: 0 });
                return [];
              }
              snapshot = fetcher.getCommandNameSnapshot();
              matchingNames = snapshot.names.filter(name =>
                isPrefixOf(commandName.word.text, name)
              );
            }
            if (token.isCancellationRequested) {
              trackLiveCompletionResult(liveTraceRequest, 'items', { itemCount: 0 });
              return [];
            }

            const replacing = rangeOfWord(commandName.word);
            const compItems = matchingNames.map(name => {
              const item = new vscode.CompletionItem(name);
              item.range = replacing;
              return item;
            });
            trackLiveCompletionResult(liveTraceRequest, 'items', {
              itemCount: compItems.length,
            });
            return new vscode.CompletionList(compItems, snapshot.initialCuratedPending);
          }

          try {
            const includeCurrentArgument = completionAnalysis.includeArgumentAtPosition;
            const commandContext = await getContextCommandResolution(
              requestTree.rootNode,
              resolvedPosition,
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
                  resolvedPosition,
                  cmdSeq,
                  includeCurrentArgument,
                );
              let compItems = [
                ...compSubcommands,
                ...compOptions,
              ];

              if (isCaretTouchingWord) {
                const currentNode = getCurrentNode(requestTree.rootNode, caret);
                const currentWord = currentNode.text;
                compItems = compItems.filter(compItem => isPrefixOf(currentWord, getLabelString(compItem.label)));
                compItems.forEach(compItem => {
                  compItem.range = range(currentNode);
                });
                console.info(`[Completion] currentWord: ${currentWord}`);
              }
              trackLiveCompletionResult(liveTraceRequest, 'items', {
                itemCount: compItems.length,
              });
              return compItems;
            } else {
              throw new Error("unknown command");
            }
          } catch (e) {
            console.warn("[Completion] No completion item is available (1)", e);
            trackLiveCompletionResult(liveTraceRequest, 'items', {
              itemCount: 0,
              error: debugError(e),
            });
            return [];
          }
        });
      }
    },
    ' ',  // triggerCharacter
  );
  activationRegistrations.push(compprovider);

  const hoverprovider = vscode.languages.registerHoverProvider(supportedLanguages, {
    async provideHover(document, cursor, token) {
      const liveTraceRequest = trackLiveHoverRequest(document, cursor);

      if (!parser) {
        console.error("[Hover] Parser is unavailable!");
        trackLiveHoverResult(liveTraceRequest, 'error', 'Parser is unavailable!');
        return Promise.reject("Parser is unavailable!");
      }

      if (!trees[document.uri.toString()]) {
        console.log("[Hover] Creating tree");
        trees[document.uri.toString()] = parseTree(parser, document.getText());
      }
      const tree = trees[document.uri.toString()];
      return withTreeCopy(tree, async requestTree => {
        if (isProviderSuppressedAtPosition(requestTree.rootNode, cursor)) {
          trackLiveHoverResult(liveTraceRequest, 'suppressed');
          return undefined;
        }
        const currentWord = getCurrentNode(requestTree.rootNode, cursor).text;
        try {
          const commandContext = await getContextCommandResolution(requestTree.rootNode, cursor, fetcher);
          const cmdSeq = commandContext.resolution.path;
          if (!!cmdSeq && cmdSeq.length) {
            const name = cmdSeq[0].name;
            const subcommandStepIndex = commandContext.resolution.steps.findIndex(
              step => rangeOfWord(step.source).contains(cursor),
            );
            const subcommandStep = commandContext.resolution.steps[subcommandStepIndex];
            if (rangeOfWord(commandContext.invocation.name).contains(cursor)) {
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
              trackLiveHoverResult(liveTraceRequest, 'hover');
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
              trackLiveHoverResult(liveTraceRequest, 'hover');
              return new vscode.Hover(new vscode.MarkdownString(msg));
            } else if (cmdSeq.length
              && commandContext.resolution.stopReason !== 'end-of-options') {
              const opts = getMatchingOption(currentWord, name, cmdSeq);
              const msg = optsToMessage(opts);
              trackLiveHoverResult(liveTraceRequest, 'hover');
              return new vscode.Hover(new vscode.MarkdownString(msg));
            } else {
              trackLiveHoverResult(liveTraceRequest, 'none', `No hover is available for ${currentWord}`);
              return Promise.reject(`No hover is available for ${currentWord}`);
            }
          }
        } catch (e) {
          console.log("[Hover] Error: ", e);
          trackLiveHoverResult(liveTraceRequest, 'error', debugError(e));
          return Promise.reject("No hover is available");
        }
        trackLiveHoverResult(liveTraceRequest, 'none');
        return undefined;
      });
    }
  });
  activationRegistrations.push(hoverprovider);

  let debugOutputChannel: vscode.OutputChannel | undefined;
  const inspectCaretContext = vscode.commands.registerCommand(
    'h2o.inspectCaretContext',
    async (): Promise<CaretDebugReport | undefined> => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !supportedLanguages.includes(editor.document.languageId)) {
        void vscode.window.showInformationMessage(
          '[Shell Completion] Open a Shell Script or BitBake editor to inspect caret context.',
        );
        return undefined;
      }

      const source = editor.document.getText();
      const caret = editor.selection.active;
      const caretOffset = editor.document.offsetAt(caret);
      const key = editor.document.uri.toString();
      if (!trees[key]) {
        trees[key] = parseTree(parser, source);
      }

      const report = await createCaretDebugReport(
        parser,
        trees[key],
        fetcher,
        {
          uri: key,
          languageId: editor.document.languageId,
          version: editor.document.version,
        },
        source,
        caret,
        caretOffset,
      );

      debugOutputChannel ??= vscode.window.createOutputChannel('Shell Completion Debug');
      debugOutputChannel.appendLine(
        `=== Caret Context: ${report.document.uri} @ ${report.caret.line + 1}:${report.caret.character + 1} ===`,
      );
      debugOutputChannel.appendLine(JSON.stringify(report, null, 2));
      debugOutputChannel.appendLine('');
      debugOutputChannel.show(true);
      return report;
    },
  );
  activationRegistrations.push(inspectCaretContext);
  activationRegistrations.push({
    dispose: () => debugOutputChannel?.dispose(),
  });

  let liveDebugEnabled = false;
  let liveDebugPaused = false;
  let liveDebugUpdateSequence = 0;
  let liveDebugLatestSnapshot: LiveEditorDebugSnapshot | undefined;
  let liveDebugCompletionTrace: LiveCompletionProviderTrace | null = null;
  let liveDebugHoverTrace: LiveHoverProviderTrace | null = null;
  interface LiveTraceRequest {
    id: number;
    documentUri: string;
    documentVersion: number;
    position: DebugPosition;
  }
  let liveDebugTraceRequestSequence = 0;
  let liveDebugCompletionRequestId: number | undefined;
  let liveDebugHoverRequestId: number | undefined;
  let liveDebugCursor: {
    documentUri: string;
    documentVersion: number;
    position: vscode.Position;
  } | undefined;
  let liveDebugRevision = 0;
  let liveDebugTimer: ReturnType<typeof setTimeout> | undefined;
  const liveDebugViews = new LiveDebugViewManager();
  activationRegistrations.push(liveDebugViews, ...liveDebugViews.registrations());
  void vscode.commands.executeCommand('setContext', 'h2o.liveDebugEnabled', false);
  void vscode.commands.executeCommand('setContext', 'h2o.liveDebugPaused', false);

  function liveDebugTraces(): LiveProviderTraces {
    return {
      completion: liveDebugCompletionTrace,
      hover: liveDebugHoverTrace,
    };
  }

  function renderLiveDebugViews(): void {
    try {
      liveDebugViews.update(
        liveDebugEnabled,
        liveDebugPaused,
        liveDebugLatestSnapshot,
        liveDebugTraces(),
      );
    } catch (error) {
      console.error(`[Live Debug] Failed to update the debug interface: ${debugError(error)}`);
    }
  }

  function traceRequest(document: vscode.TextDocument, position: vscode.Position): LiveTraceRequest {
    return {
      id: ++liveDebugTraceRequestSequence,
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      position: debugPosition(position),
    };
  }

  function trackLiveCompletionRequest(
    document: vscode.TextDocument,
    caret: vscode.Position,
  ): LiveTraceRequest | undefined {
    if (!liveDebugEnabled || liveDebugPaused) {
      return undefined;
    }
    const request = traceRequest(document, caret);
    liveDebugCompletionRequestId = request.id;
    liveDebugCompletionTrace = {
      documentUri: request.documentUri,
      documentVersion: request.documentVersion,
      position: request.position,
      observedAt: new Date().toISOString(),
      outcome: 'pending',
      itemCount: null,
      fallback: false,
      error: null,
    };
    renderLiveDebugViews();
    return request;
  }

  function trackLiveCompletionResult(
    request: LiveTraceRequest | undefined,
    outcome: LiveCompletionProviderTrace['outcome'],
    details: {
      itemCount?: number;
      fallback?: boolean;
      error?: string;
    } = {},
  ): void {
    if (
      !request
      || !liveDebugEnabled
      || liveDebugPaused
      || request.id !== liveDebugCompletionRequestId
    ) {
      return;
    }
    liveDebugCompletionTrace = {
      documentUri: request.documentUri,
      documentVersion: request.documentVersion,
      position: request.position,
      observedAt: new Date().toISOString(),
      outcome,
      itemCount: details.itemCount ?? null,
      fallback: details.fallback ?? false,
      error: details.error ?? null,
    };
    renderLiveDebugViews();
  }

  function trackLiveHoverRequest(
    document: vscode.TextDocument,
    cursor: vscode.Position,
  ): LiveTraceRequest | undefined {
    if (!liveDebugEnabled || liveDebugPaused) {
      return undefined;
    }
    const request = traceRequest(document, cursor);
    liveDebugHoverRequestId = request.id;
    liveDebugCursor = {
      documentUri: request.documentUri,
      documentVersion: request.documentVersion,
      position: cursor,
    };
    liveDebugHoverTrace = {
      documentUri: request.documentUri,
      documentVersion: request.documentVersion,
      position: request.position,
      observedAt: new Date().toISOString(),
      outcome: 'pending',
      error: null,
    };
    renderLiveDebugViews();
    scheduleLiveDebug();
    return request;
  }

  function trackLiveHoverResult(
    request: LiveTraceRequest | undefined,
    outcome: LiveHoverProviderTrace['outcome'],
    error?: string,
  ): void {
    if (
      !request
      || !liveDebugEnabled
      || liveDebugPaused
      || request.id !== liveDebugHoverRequestId
    ) {
      return;
    }
    liveDebugHoverTrace = {
      documentUri: request.documentUri,
      documentVersion: request.documentVersion,
      position: request.position,
      observedAt: new Date().toISOString(),
      outcome,
      error: error ?? null,
    };
    renderLiveDebugViews();
  }

  async function refreshLiveDebug(revision: number): Promise<LiveEditorDebugSnapshot | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme === debugDocumentScheme) {
      return liveDebugLatestSnapshot;
    }
    if (!editor || !supportedLanguages.includes(editor.document.languageId)) {
      if (liveDebugEnabled && !liveDebugPaused && revision === liveDebugRevision) {
        liveDebugLatestSnapshot = undefined;
        liveDebugUpdateSequence += 1;
        renderLiveDebugViews();
      }
      return undefined;
    }

    const source = editor.document.getText();
    const caret = editor.selection.active;
    const caretOffset = editor.document.offsetAt(caret);
    const key = editor.document.uri.toString();
    const cursor = liveDebugCursor?.documentUri === key
      && liveDebugCursor.documentVersion === editor.document.version
      ? liveDebugCursor.position
      : undefined;
    const cursorOffset = cursor ? editor.document.offsetAt(cursor) : undefined;
    if (!trees[key]) {
      trees[key] = parseTree(parser, source);
    }

    const snapshot = await createLiveEditorDebugSnapshot(
      trees[key],
      fetcher,
      {
        uri: key,
        languageId: editor.document.languageId,
        version: editor.document.version,
      },
      source,
      caret,
      caretOffset,
      cursor,
      cursorOffset,
    );
    if (!liveDebugEnabled || liveDebugPaused || revision !== liveDebugRevision) {
      return undefined;
    }

    liveDebugLatestSnapshot = snapshot;
    liveDebugUpdateSequence += 1;
    renderLiveDebugViews();
    return snapshot;
  }

  function runLiveDebugNow(): Promise<LiveEditorDebugSnapshot | undefined> {
    if (liveDebugTimer) {
      clearTimeout(liveDebugTimer);
      liveDebugTimer = undefined;
    }
    const revision = ++liveDebugRevision;
    return refreshLiveDebug(revision);
  }

  function scheduleLiveDebug(): void {
    if (!liveDebugEnabled || liveDebugPaused) {
      return;
    }
    if (liveDebugTimer) {
      clearTimeout(liveDebugTimer);
    }
    const revision = ++liveDebugRevision;
    liveDebugTimer = setTimeout(() => {
      liveDebugTimer = undefined;
      void refreshLiveDebug(revision).catch(error => {
        if (liveDebugEnabled && !liveDebugPaused && revision === liveDebugRevision) {
          console.error(`Live caret/cursor inspection failed: ${debugError(error)}`);
        }
      });
    }, 80);
  }

  const toggleLiveCaretAndCursorContext = vscode.commands.registerCommand(
    'h2o.toggleLiveCaretAndCursorContext',
    async (requestedState?: boolean): Promise<LiveEditorDebugToggleResult> => {
      const nextState = requestedState ?? !liveDebugEnabled;

      if (nextState) {
        if (!liveDebugEnabled) {
          liveDebugLatestSnapshot = undefined;
          liveDebugCompletionTrace = null;
          liveDebugHoverTrace = null;
          liveDebugCompletionRequestId = undefined;
          liveDebugHoverRequestId = undefined;
        }
        liveDebugEnabled = true;
        liveDebugPaused = false;
        liveDebugCursor = undefined;
        void vscode.commands.executeCommand('setContext', 'h2o.liveDebugEnabled', true);
        void vscode.commands.executeCommand('setContext', 'h2o.liveDebugPaused', false);
        renderLiveDebugViews();
        void vscode.commands.executeCommand('workbench.view.extension.h2oDebug');
        const snapshot = await runLiveDebugNow();
        return { enabled: true, snapshot };
      } else {
        liveDebugEnabled = false;
        liveDebugPaused = false;
        liveDebugRevision += 1;
        liveDebugLatestSnapshot = undefined;
        liveDebugCompletionTrace = null;
        liveDebugHoverTrace = null;
        liveDebugCompletionRequestId = undefined;
        liveDebugHoverRequestId = undefined;
        liveDebugCursor = undefined;
        if (liveDebugTimer) {
          clearTimeout(liveDebugTimer);
          liveDebugTimer = undefined;
        }
        void vscode.commands.executeCommand('setContext', 'h2o.liveDebugEnabled', false);
        void vscode.commands.executeCommand('setContext', 'h2o.liveDebugPaused', false);
        renderLiveDebugViews();
        return { enabled: false };
      }
    },
  );
  activationRegistrations.push(toggleLiveCaretAndCursorContext);
  activationRegistrations.push(vscode.commands.registerCommand(
    'h2o.getLiveCaretAndCursorContextState',
    (): LiveEditorDebugState => ({
      enabled: liveDebugEnabled,
      paused: liveDebugPaused,
      updateSequence: liveDebugUpdateSequence,
      traces: liveDebugTraces(),
      presentation: liveDebugViews.getPresentation(),
      snapshot: liveDebugLatestSnapshot,
    }),
  ));
  activationRegistrations.push(vscode.commands.registerCommand(
    'h2o.toggleLiveDebugPause',
    async (requestedState?: boolean): Promise<LiveEditorDebugPauseResult> => {
      if (!liveDebugEnabled) {
        return { enabled: false, paused: false };
      }
      liveDebugPaused = requestedState ?? !liveDebugPaused;
      void vscode.commands.executeCommand('setContext', 'h2o.liveDebugPaused', liveDebugPaused);
      if (liveDebugPaused) {
        liveDebugRevision += 1;
        liveDebugCompletionRequestId = undefined;
        liveDebugHoverRequestId = undefined;
        if (liveDebugTimer) {
          clearTimeout(liveDebugTimer);
          liveDebugTimer = undefined;
        }
        renderLiveDebugViews();
      } else {
        renderLiveDebugViews();
        await runLiveDebugNow();
      }
      return { enabled: true, paused: liveDebugPaused };
    },
  ));
  activationRegistrations.push(vscode.commands.registerCommand(
    'h2o.pauseLiveDebug',
    (): Thenable<LiveEditorDebugPauseResult> =>
      vscode.commands.executeCommand('h2o.toggleLiveDebugPause', true),
  ));
  activationRegistrations.push(vscode.commands.registerCommand(
    'h2o.resumeLiveDebug',
    (): Thenable<LiveEditorDebugPauseResult> =>
      vscode.commands.executeCommand('h2o.toggleLiveDebugPause', false),
  ));
  activationRegistrations.push(vscode.commands.registerCommand(
    'h2o.showLiveDebugViews',
    async (): Promise<void> => {
      if (!liveDebugEnabled) {
        await vscode.commands.executeCommand('h2o.toggleLiveCaretAndCursorContext', true);
      }
      await vscode.commands.executeCommand('workbench.view.extension.h2oDebug');
    },
  ));
  activationRegistrations.push(vscode.commands.registerCommand(
    'h2o.openCompletionDebugSnapshot',
    () => liveDebugViews.openSnapshot('completion'),
  ));
  activationRegistrations.push(vscode.commands.registerCommand(
    'h2o.openHoverDebugSnapshot',
    () => liveDebugViews.openSnapshot('hover'),
  ));
  activationRegistrations.push(vscode.commands.registerCommand(
    'h2o.openTreeSitterDebugSnapshot',
    () => liveDebugViews.openSnapshot('tree-sitter'),
  ));
  activationRegistrations.push(vscode.window.onDidChangeActiveTextEditor(() => {
    liveDebugCursor = undefined;
    scheduleLiveDebug();
  }));
  activationRegistrations.push(vscode.window.onDidChangeTextEditorSelection(event => {
    if (event.textEditor === vscode.window.activeTextEditor) {
      scheduleLiveDebug();
    }
  }));
  activationRegistrations.push({
    dispose: () => {
      liveDebugEnabled = false;
      liveDebugPaused = false;
      liveDebugRevision += 1;
      liveDebugLatestSnapshot = undefined;
      liveDebugCompletionTrace = null;
      liveDebugHoverTrace = null;
      liveDebugCompletionRequestId = undefined;
      liveDebugHoverRequestId = undefined;
      liveDebugCursor = undefined;
      if (liveDebugTimer) {
        clearTimeout(liveDebugTimer);
      }
    },
  });

  function edit(edit: vscode.TextDocumentChangeEvent) {
    updateTree(parser, trees, edit);
    if (vscode.window.activeTextEditor?.document.uri.toString() === edit.document.uri.toString()) {
      scheduleLiveDebug();
    }
  }

  function close(document: vscode.TextDocument) {
    console.log("[Close] removing a tree");
    const t = trees[document.uri.toString()];
    if (t) {
      t.delete();
      delete trees[document.uri.toString()];
    }
    scheduleLiveDebug();
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

function positionsEqual(left: Point, right: vscode.Position): boolean {
  return left.row === right.line && left.column === right.character;
}

function hasMissingNodeAtPosition(node: Node, position: vscode.Position): boolean {
  if (!range(node).contains(position)) {
    return false;
  }
  if (node.isMissing && positionsEqual(node.startPosition, position)) {
    return true;
  }
  return node.children.some(child => hasMissingNodeAtPosition(child, position));
}

/**
 * Provider error recovery is intentionally conservative: never interpret a
 * redirect payload, heredoc body, parser ERROR, or inserted MISSING token as a
 * command context. Callers may resume after a real shell boundary such as `;`.
 */
export function isProviderSuppressedAtPosition(root: Node, position: vscode.Position): boolean {
  return getProviderSuppressionReasons(root, position).length > 0;
}

export function getProviderSuppressionReasons(
  root: Node,
  position: vscode.Position,
): ProviderSuppressionReason[] {
  const reasons = new Set<ProviderSuppressionReason>();
  if (hasMissingNodeAtPosition(root, position)) {
    reasons.add('MISSING');
  }

  let node: Node | null = getCurrentNode(root, position);
  while (node) {
    if (node.isError) {
      reasons.add('ERROR');
    }
    if (node.isMissing) {
      reasons.add('MISSING');
    }
    if (providerSuppressedNodeTypes.has(node.type)) {
      reasons.add(node.type as ProviderSuppressionReason);
    }
    node = node.parent;
  }
  return [...reasons];
}

function isSafeHerestringWalkback(root: Node, position: vscode.Position): boolean {
  const reasons = getProviderSuppressionReasons(root, position);
  return reasons.length === 1 && reasons[0] === 'herestring_redirect';
}

function getCompletionCaretDecision(
  document: LineTextProvider,
  root: Node,
  caret: vscode.Position,
): ProviderPositionDecision {
  const requestSuppressionReasons = getProviderSuppressionReasons(root, caret);
  if (requestSuppressionReasons.length > 0) {
    return {
      enabled: false,
      position: caret,
      walkbackUnchanged: true,
      resumedAfterHerestring: false,
      requestSuppressionReasons,
      resolvedSuppressionReasons: requestSuppressionReasons,
    };
  }

  const resolvedPosition = walkbackCompletionCaretIfNeeded(document, root, caret);
  const resolvedSuppressionReasons = getProviderSuppressionReasons(root, resolvedPosition);
  const resumedAfterHerestring = isSafeHerestringWalkback(root, resolvedPosition);
  return {
    enabled: resolvedSuppressionReasons.length === 0 || resumedAfterHerestring,
    position: resolvedPosition,
    walkbackUnchanged: resolvedPosition === caret,
    resumedAfterHerestring,
    requestSuppressionReasons,
    resolvedSuppressionReasons,
  };
}

function getCompletionRequestAnalysis(
  document: LineTextProvider,
  root: Node,
  caret: vscode.Position,
): CompletionRequestAnalysis {
  const decision = getCompletionCaretDecision(document, root, caret);
  const commandNode = decision.enabled && decision.walkbackUnchanged
    ? _getContextCommandNode(root, caret)
    : undefined;
  return {
    decision,
    commandNameContext: commandNode
      ? getCommandNameCompletionContext(commandNode, asPoint(caret))
      : undefined,
    includeArgumentAtPosition: !decision.walkbackUnchanged,
  };
}

function getHoverCursorDecision(root: Node, cursor: vscode.Position): ProviderPositionDecision {
  const suppressionReasons = getProviderSuppressionReasons(root, cursor);
  return {
    enabled: suppressionReasons.length === 0,
    position: cursor,
    walkbackUnchanged: true,
    resumedAfterHerestring: false,
    requestSuppressionReasons: suppressionReasons,
    resolvedSuppressionReasons: suppressionReasons,
  };
}


// Moves the completion caret left by one character IF it is contained only in
// the root-node range. This is just a workaround as you cannot reach a command
// node if you start from the caret, say, after 'echo '.
// [FIXME] Do not rely on such an ugly hack
export function walkbackCompletionCaretIfNeeded(
  document: LineTextProvider,
  root: Node,
  caret: vscode.Position,
): vscode.Position {
  let currentPosition = caret;
  let moveCount = 0;

  while (true) {
    const thisNode = getCurrentNode(root, currentPosition);
    if (isProviderSuppressedAtPosition(root, currentPosition)) {
      if (moveCount > 0) {
        console.debug(`[walkbackCompletionCaretIfNeeded] moved ${moveCount} time(s); stopped in a suppressed syntax region.`);
      }
      return currentPosition;
    }
    if (thisNode.type === ';') {
      if (moveCount > 0) {
        console.debug(`[walkbackCompletionCaretIfNeeded] moved ${moveCount} time(s); stopped at ${thisNode.type}.`);
      }
      return currentPosition;
    }

    if (currentPosition.character > 0 && !isCommandTokenNode(thisNode)) {
      currentPosition = currentPosition.translate(0, -1);
      moveCount += 1;
      continue;
    } else if (!isCommandTokenNode(thisNode) && currentPosition.character === 0 && currentPosition.line > 0) {
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
      console.debug(`[walkbackCompletionCaretIfNeeded] moved ${moveCount} time(s); stopped at ${thisNode.type}.`);
    }
    return currentPosition;
  }
}

function debugPosition(point: Point | vscode.Position): DebugPosition {
  return 'row' in point
    ? { line: point.row, character: point.column }
    : { line: point.line, character: point.character };
}

function fieldNameForNode(node: Node): string | null {
  const parent = node.parent;
  if (!parent) {
    return null;
  }
  for (let index = 0; index < parent.childCount; index += 1) {
    if (parent.child(index)?.equals(node)) {
      return parent.fieldNameForChild(index);
    }
  }
  return null;
}

function debugText(text: string): string {
  const maximumLength = 160;
  return text.length <= maximumLength
    ? text
    : `${text.slice(0, maximumLength - 1)}…`;
}

function debugNode(node: Node): DebugNode {
  return {
    id: node.id,
    type: node.type,
    grammarType: node.grammarType,
    fieldName: fieldNameForNode(node),
    typeId: node.typeId,
    grammarId: node.grammarId,
    named: node.isNamed,
    extra: node.isExtra,
    error: node.isError,
    missing: node.isMissing,
    hasError: node.hasError,
    hasChanges: node.hasChanges,
    parseState: node.parseState,
    nextParseState: node.nextParseState,
    commandToken: isCommandTokenNode(node),
    start: { ...debugPosition(node.startPosition), index: node.startIndex },
    end: { ...debugPosition(node.endPosition), index: node.endIndex },
    text: debugText(node.text),
  };
}

function debugAncestors(node: Node): DebugNode[] {
  const ancestors: DebugNode[] = [];
  let ancestor: Node | null = node;
  while (ancestor) {
    ancestors.push(debugNode(ancestor));
    ancestor = ancestor.parent;
  }
  return ancestors;
}

function debugWord(word: CommandWord): DebugWord {
  return {
    text: word.text,
    start: debugPosition(word.startPosition),
    end: debugPosition(word.endPosition),
  };
}

function debugInvocation(invocation: CommandInvocation): DebugInvocation {
  return {
    name: debugWord(invocation.name),
    arguments: invocation.arguments.map(debugWord),
  };
}

function debugResolution(
  resolution: CommandPathResolution<CommandWord>,
): DebugResolution {
  return {
    path: resolution.path.map(command => command.name),
    steps: resolution.steps.map(step => ({
      command: step.command.name,
      source: step.source.text,
      sourceRange: {
        start: debugPosition(step.source.startPosition),
        end: debugPosition(step.source.endPosition),
      },
      matchedBy: step.matchedBy,
    })),
    stopReason: resolution.stopReason ?? null,
  };
}

function debugError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function inspectProviderDecision(
  root: Node,
  requestedPosition: vscode.Position,
  decision: ProviderPositionDecision,
  fetcher: CachingFetcher,
  includeArgumentAtPosition: boolean,
  commandNameContext?: CommandNameCompletionContext,
): Promise<DebugProviderDecision> {
  const commandNode = decision.enabled
    ? _getContextCommandNode(root, decision.position)
    : undefined;
  const report: DebugProviderDecision = {
    enabled: decision.enabled,
    lookupKind: !decision.enabled
      ? 'none'
      : commandNameContext?.atWordEnd
        ? 'command-name'
        : commandNameContext
          ? 'none'
          : 'command-spec',
    requestedPosition: debugPosition(requestedPosition),
    resolvedPosition: debugPosition(decision.position),
    moved: !decision.position.isEqual(requestedPosition),
    walkbackUnchanged: decision.walkbackUnchanged,
    includeArgumentAtPosition,
    resumedAfterHerestring: decision.resumedAfterHerestring,
    requestSuppressionReasons: decision.requestSuppressionReasons,
    resolvedSuppressionReasons: decision.resolvedSuppressionReasons,
    resolvedNode: debugNode(getCurrentNode(root, decision.position)),
    commandNode: commandNode ? debugNode(commandNode) : null,
    invocation: null,
    resolution: null,
    lookupError: null,
  };

  if (!decision.enabled) {
    return report;
  }

  if (commandNameContext) {
    const invocation = getCommandInvocationToPosition(
      commandNode,
      asPoint(decision.position),
      includeArgumentAtPosition,
    );
    report.invocation = invocation ? debugInvocation(invocation) : null;
    return report;
  }

  try {
    const context = await getContextCommandResolution(
      root,
      decision.position,
      fetcher,
      includeArgumentAtPosition,
    );
    report.invocation = debugInvocation(context.invocation);
    report.resolution = debugResolution(context.resolution);
  } catch (error) {
    const invocation = getCommandInvocationToPosition(
      commandNode,
      asPoint(decision.position),
      includeArgumentAtPosition,
    );
    report.invocation = invocation ? debugInvocation(invocation) : null;
    report.lookupError = debugError(error);
  }
  return report;
}

async function inspectTreeAtPosition(
  document: LineTextProvider,
  root: Node,
  position: vscode.Position,
  fetcher: CachingFetcher,
): Promise<DebugTreeReport> {
  const currentNode = getCurrentNode(root, position);
  const completionAnalysis = getCompletionRequestAnalysis(document, root, position);
  const hoverDecision = getHoverCursorDecision(root, position);

  return {
    root: debugNode(root),
    currentNode: debugNode(currentNode),
    ancestors: debugAncestors(currentNode),
    completion: await inspectProviderDecision(
      root,
      position,
      completionAnalysis.decision,
      fetcher,
      completionAnalysis.includeArgumentAtPosition,
      completionAnalysis.commandNameContext,
    ),
    hover: await inspectProviderDecision(root, position, hoverDecision, fetcher, true),
  };
}

function syntaxComparisonProjection(report: DebugTreeReport): unknown {
  return report.ancestors.map(node => ({
    type: node.type,
    grammarType: node.grammarType,
    fieldName: node.fieldName,
    named: node.named,
    extra: node.extra,
    error: node.error,
    missing: node.missing,
    hasError: node.hasError,
    commandToken: node.commandToken,
    start: node.start,
    end: node.end,
    text: node.text,
  }));
}

function providerComparisonProjection(decision: DebugProviderDecision): unknown {
  return {
    enabled: decision.enabled,
    lookupKind: decision.lookupKind,
    requestedPosition: decision.requestedPosition,
    resolvedPosition: decision.resolvedPosition,
    moved: decision.moved,
    walkbackUnchanged: decision.walkbackUnchanged,
    includeArgumentAtPosition: decision.includeArgumentAtPosition,
    resumedAfterHerestring: decision.resumedAfterHerestring,
    requestSuppressionReasons: decision.requestSuppressionReasons,
    resolvedSuppressionReasons: decision.resolvedSuppressionReasons,
    resolvedNode: {
      type: decision.resolvedNode.type,
      grammarType: decision.resolvedNode.grammarType,
      fieldName: decision.resolvedNode.fieldName,
      commandToken: decision.resolvedNode.commandToken,
      start: decision.resolvedNode.start,
      end: decision.resolvedNode.end,
      text: decision.resolvedNode.text,
    },
    commandNode: decision.commandNode && {
      type: decision.commandNode.type,
      grammarType: decision.commandNode.grammarType,
      fieldName: decision.commandNode.fieldName,
      commandToken: decision.commandNode.commandToken,
      start: decision.commandNode.start,
      end: decision.commandNode.end,
      text: decision.commandNode.text,
    },
    invocation: decision.invocation,
    resolution: decision.resolution,
    lookupError: decision.lookupError,
  };
}

function debugValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function createCaretDebugReport(
  parser: Parser,
  cachedTree: Tree,
  fetcher: CachingFetcher,
  document: CaretDebugReport['document'],
  source: string,
  caret: vscode.Position,
  caretOffset: number,
): Promise<CaretDebugReport> {
  const sourceLines = source.split(/\r\n|\r|\n/);
  const lineProvider: LineTextProvider = {
    lineAt: line => ({ text: sourceLines[line] ?? '' }),
  };

  return withTreeCopy(cachedTree, async cachedCopy => {
    const freshTree = parseTree(parser, source);
    try {
      const cached = await inspectTreeAtPosition(lineProvider, cachedCopy.rootNode, caret, fetcher);
      const fresh = await inspectTreeAtPosition(lineProvider, freshTree.rootNode, caret, fetcher);
      return {
        generatedAt: new Date().toISOString(),
        document,
        caret: {
          ...debugPosition(caret),
          offset: caretOffset,
          lineText: sourceLines[caret.line] ?? '',
        },
        cached,
        fresh,
        comparison: {
          syntaxAtCaretEquivalent: debugValuesEqual(
            syntaxComparisonProjection(cached),
            syntaxComparisonProjection(fresh),
          ),
          completionEquivalent: debugValuesEqual(
            providerComparisonProjection(cached.completion),
            providerComparisonProjection(fresh.completion),
          ),
          hoverEquivalent: debugValuesEqual(
            providerComparisonProjection(cached.hover),
            providerComparisonProjection(fresh.hover),
          ),
        },
      };
    } finally {
      freshTree.delete();
    }
  });
}

function liveDebugNode(node: DebugNode): LiveDebugNode {
  return node;
}

function liveProviderDecision(
  decision: DebugProviderDecision,
): LiveDebugProviderDecision {
  return {
    enabled: decision.enabled,
    lookupKind: decision.lookupKind,
    resolvedPosition: decision.resolvedPosition,
    moved: decision.moved,
    walkbackUnchanged: decision.walkbackUnchanged,
    includeArgumentAtPosition: decision.includeArgumentAtPosition,
    resumedAfterHerestring: decision.resumedAfterHerestring,
    requestSuppressionReasons: decision.requestSuppressionReasons,
    resolvedSuppressionReasons: decision.resolvedSuppressionReasons,
    resolvedNode: liveDebugNode(decision.resolvedNode),
    invocation: decision.invocation,
    resolution: decision.resolution,
    lookupError: decision.lookupError,
  };
}

async function createLiveEditorDebugSnapshot(
  cachedTree: Tree,
  fetcher: CachingFetcher,
  document: CaretDebugReport['document'],
  source: string,
  caret: vscode.Position,
  caretOffset: number,
  cursor?: vscode.Position,
  cursorOffset?: number,
): Promise<LiveEditorDebugSnapshot> {
  const sourceLines = source.split(/\r\n|\r|\n/);
  const lineProvider: LineTextProvider = {
    lineAt: line => ({ text: sourceLines[line] ?? '' }),
  };

  return withTreeCopy(cachedTree, async treeCopy => {
    const root = treeCopy.rootNode;
    const caretNode = getCurrentNode(root, caret);
    const completionAnalysis = getCompletionRequestAnalysis(lineProvider, root, caret);
    const completion = await inspectProviderDecision(
      root,
      caret,
      completionAnalysis.decision,
      fetcher,
      completionAnalysis.includeArgumentAtPosition,
      completionAnalysis.commandNameContext,
    );
    const cursorNode = cursor ? getCurrentNode(root, cursor) : undefined;
    const hoverDecision = cursor ? getHoverCursorDecision(root, cursor) : undefined;
    const hover = cursor && hoverDecision
      ? await inspectProviderDecision(root, cursor, hoverDecision, fetcher, true)
      : undefined;
    return {
      document,
      caret: {
        ...debugPosition(caret),
        offset: caretOffset,
        lineText: sourceLines[caret.line] ?? '',
      },
      caretNode: liveDebugNode(debugNode(caretNode)),
      caretAncestors: debugAncestors(caretNode).slice(1).map(liveDebugNode),
      cursor: cursor && cursorOffset !== undefined
        ? {
          ...debugPosition(cursor),
          offset: cursorOffset,
          lineText: sourceLines[cursor.line] ?? '',
        }
        : null,
      cursorNode: cursorNode ? liveDebugNode(debugNode(cursorNode)) : null,
      cursorAncestors: cursorNode
        ? debugAncestors(cursorNode).slice(1).map(liveDebugNode)
        : [],
      completion: liveProviderDecision(completion),
      hover: hover ? liveProviderDecision(hover) : null,
    };
  });
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
