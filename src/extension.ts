import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { Language, Node, Parser, Point, Tree } from 'web-tree-sitter';
import {
  CachingFetcher,
  CommandFetchCancelledError,
  UnknownCommandScanDisabledError,
} from './cacheFetcher';
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
  CompletionLookupTarget,
  getCompletionLookupTarget,
} from './completionTarget';
import { waitForPromiseOrCancellation, waitForValueOrCancellation } from './cancellable';
import {
  defaultMaximumDocumentCharacters,
  DocumentTreeCache,
  parseDocumentTree,
  supportedTreeLanguages,
  TreeCache,
  updateTree,
} from './treeCache';
export { parseDocumentTree, updateTree } from './treeCache';
export type { TreeCache } from './treeCache';
import {
  debugDocumentScheme,
  LiveDebugViewManager,
  type LiveCompletionProviderTrace,
  type LiveDebugPresentationState,
  type LiveHoverProviderTrace,
  type LiveProviderTraces,
} from './debugView';
import {
  getContextCommandNodeAtPoint,
  getCurrentNodeAtPoint,
  getProviderSuppressionReasonsAtPoint,
  resolveCompletionAnchor,
  type LineTextProvider,
  type ProviderSuppressionReason,
} from './providerContext';
import {
  ProviderMeasurement,
  ProviderPerformanceRecorder,
  type ProviderAccumulatedPhase,
  type ProviderPerformanceKind,
  type ProviderPerformanceSample,
  type ProviderPhaseTimings,
} from './providerPerformance';
import {
  requestUnknownCommandScanConsent,
  unknownCommandScanConsentStateKey,
} from './scanConsent';

export type { ProviderSuppressionReason } from './providerContext';


const supportedLanguages: string[] = [...supportedTreeLanguages];
const enableLocalScansLabel = 'Allow Local Scans';
const keepLocalScansDisabledLabel = 'Keep Disabled';

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

async function withTreeCopy<T>(
  tree: Tree,
  operation: (copy: Tree) => Promise<T>,
  measurement?: ProviderMeasurement,
): Promise<T> {
  const copy = measurement
    ? measurement.measure('treeCopyMs', () => tree.copy())
    : tree.copy();
  try {
    return await operation(copy);
  } finally {
    if (measurement) {
      measurement.measure('treeCopyMs', () => copy.delete());
    } else {
      copy.delete();
    }
  }
}

interface ResolvedCommandContext {
  invocation: CommandInvocation;
  resolution: CommandPathResolution<CommandWord>;
}

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
  lookupSkippedReason: 'completion-disabled' | 'unknown-command-scanning-disabled' | null;
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
  lookupSkippedReason: DebugProviderDecision['lookupSkippedReason'];
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
  commandNode: Node | undefined;
  touchingCommandToken: boolean;
  walkbackUnchanged: boolean;
  resumedAfterHerestring: boolean;
  requestSuppressionReasons: ProviderSuppressionReason[];
  resolvedSuppressionReasons: ProviderSuppressionReason[];
}

export type ProviderLookupKind = CompletionLookupTarget['kind'];

interface CompletionRequestAnalysis {
  decision: ProviderPositionDecision;
  lookupTarget: CompletionLookupTarget;
  includeArgumentAtPosition: boolean;
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
  const documentTrees = new DocumentTreeCache(parser, trees, {
    maximumDocumentCharacters: document => vscode.workspace
      .getConfiguration('shellCompletion', vscode.Uri.parse(document.uri.toString()))
      .get<number>('maxDocumentCharacters', defaultMaximumDocumentCharacters),
    onDocumentLimited: (document, characters, maximum) => {
      console.warn(
        `[Parser] Skipping ${document.uri.toString()}: ${characters} characters exceeds the configured maximum of ${maximum}.`,
      );
    },
    onError: (error, document) => {
      console.error(`[Parser] Failed to update ${document.uri.toString()}:`, error);
    },
  });
  activationRegistrations.push(documentTrees);
  const performanceRecorder = process.env.VSCODE_H2O_PERFORMANCE === '1'
    ? new ProviderPerformanceRecorder()
    : undefined;
  if (performanceRecorder) {
    activationRegistrations.push(
      vscode.commands.registerCommand(
        'h2o.getProviderPerformanceSamples',
        (): ProviderPerformanceSample[] => performanceRecorder.snapshot(),
      ),
      vscode.commands.registerCommand('h2o.clearProviderPerformanceSamples', () => {
        performanceRecorder.clear();
      }),
    );
  }
  const cacheDirectory = context.globalStorageUri;
  const cacheStorage = new GzipCommandCacheStorage(vscode.workspace.fs, {
    directory: cacheDirectory,
    snapshot: vscode.Uri.joinPath(cacheDirectory, 'commands-v1.json.gz'),
    temporary: () => vscode.Uri.joinPath(
      cacheDirectory,
      `commands-v1.${process.pid}.${randomUUID()}.json.gz.tmp`,
    ),
  });
  const performanceFixtureEnabled = process.env.VSCODE_H2O_PERFORMANCE_FIXTURE === '1';
  const performanceSuite = process.env.VSCODE_H2O_PERFORMANCE_SUITE;
  const providerFixtureEnabled = performanceFixtureEnabled && performanceSuite === 'provider';
  const activationFixtureEnabled = performanceFixtureEnabled && performanceSuite === 'activation';
  const fetcher = new CachingFetcher(
    context.globalState,
    providerFixtureEnabled
      ? {
        cacheStorage,
        runLocalCommand: async (name: string): Promise<Command> => ({
          name,
          description: 'Deterministic provider performance fixture',
          options: [{
            names: ['--version'],
            argument: '',
            description: 'Display version information',
          }],
        }),
      }
      : activationFixtureEnabled
        ? {
          cacheStorage,
          // Exercise initial curated-fetch setup without introducing network
          // completion or response parsing into cold-activation measurements.
          fetch: () => new Promise<never>(() => undefined),
        }
      : { cacheStorage },
  );
  const updateUnknownCommandScanPolicy = (): void => {
    const enabled = vscode.workspace
      .getConfiguration('shellCompletion')
      .get<boolean>('scanUnknownCommands', false);
    fetcher.setScanUnknownCommands(enabled);
  };
  updateUnknownCommandScanPolicy();
  activationRegistrations.push(fetcher);
  activationRegistrations.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('shellCompletion.scanUnknownCommands')) {
      updateUnknownCommandScanPolicy();
    }
  }));
  await fetcher.init();
  if (providerFixtureEnabled) {
    activationRegistrations.push(vscode.commands.registerCommand(
      'h2o.clearPerformanceCommandCache',
      (name: string): Promise<void> => fetcher.unset(name),
    ));
  }
  const initialCuratedFetch = providerFixtureEnabled
    ? Promise.resolve()
    : fetcher.startInitialCuratedFetch("general");
  void initialCuratedFetch.catch(() => {
    console.warn("Failed in fetch.fetchAllCurated().");
  });


  let completionEnabled = vscode.workspace
    .getConfiguration('shellCompletion')
    .get<boolean>('enableCompletion', true);
  const activeCompletionRequests = new Set<vscode.CancellationTokenSource>();
  const completionProvider: vscode.CompletionItemProvider = {
    async provideCompletionItems(document, caret, token, context) {
      if (!completionEnabled) {
        return [];
      }
      const requestCancellation = new vscode.CancellationTokenSource();
      activeCompletionRequests.add(requestCancellation);
      const editorCancellation = token.onCancellationRequested(() => {
        requestCancellation.cancel();
      });
      if (token.isCancellationRequested) {
        requestCancellation.cancel();
      }
      const requestToken = requestCancellation.token;
      const liveTraceRequest = trackLiveCompletionRequest(document, caret);
      try {
          if (!parser) {
            console.error("[Completion] Parser is unavailable!");
            trackLiveCompletionResult(liveTraceRequest, 'error', {
              error: 'Parser unavailable!',
            });
            return Promise.reject("Parser unavailable!");
          }
          const treeRequest = await measureProviderAsync(
            liveTraceRequest,
            'treeWaitMs',
            () => waitForValueOrCancellation(documentTrees.getWithTiming(document), requestToken),
          );
          if (!treeRequest.completed) {
            trackLiveCompletionResult(liveTraceRequest, 'cancelled', { itemCount: 0 });
            return [];
          }
          const treeAccess = treeRequest.value;
          liveTraceRequest?.measurement.add('parseMs', treeAccess.parseMs);
          const tree = treeAccess.tree;
          if (!tree) {
            trackLiveCompletionResult(liveTraceRequest, 'suppressed', { itemCount: 0 });
            return [];
          }
          return await withTreeCopy(tree, async requestTree => {
            const completionAnalysis = measureProvider(
              liveTraceRequest,
              'analysisMs',
              () => getCompletionRequestAnalysis(
                document,
                requestTree.rootNode,
                caret,
              ),
            );
            const caretDecision = completionAnalysis.decision;
            if (!caretDecision.enabled) {
              trackLiveCompletionResult(liveTraceRequest, 'suppressed', { itemCount: 0 });
              return [];
            }

            const resolvedPosition = caretDecision.position;
            const isCaretTouchingWord = caretDecision.touchingCommandToken;

            if (completionAnalysis.lookupTarget.kind === 'none') {
              trackLiveCompletionResult(liveTraceRequest, 'items', { itemCount: 0 });
              return [];
            }

            if (completionAnalysis.lookupTarget.kind === 'command-name') {
              const commandName = completionAnalysis.lookupTarget.context;
              let snapshot = fetcher.getCommandNameSnapshot();
              let matchingNames = snapshot.names.filter(name =>
                isPrefixOf(commandName.word.text, name)
              );
              if (matchingNames.length === 0 && snapshot.initialCuratedPending) {
                const available = await waitForPromiseOrCancellation(
                  fetcher.waitForInitialCuratedAvailability(),
                  requestToken,
                );
                if (!available) {
                  trackLiveCompletionResult(liveTraceRequest, 'cancelled', { itemCount: 0 });
                  return [];
                }
                snapshot = fetcher.getCommandNameSnapshot();
                matchingNames = snapshot.names.filter(name =>
                  isPrefixOf(commandName.word.text, name)
                );
              }
              if (requestToken.isCancellationRequested) {
                trackLiveCompletionResult(liveTraceRequest, 'cancelled', { itemCount: 0 });
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
              const commandContext = await getCommandNodeResolution(
                caretDecision.commandNode,
                resolvedPosition,
                fetcher,
                includeCurrentArgument,
                requestToken,
                liveTraceRequest?.measurement,
              );
              if (!commandContext) {
                trackLiveCompletionResult(liveTraceRequest, 'items', { itemCount: 0 });
                return [];
              }
              const cmdSeq = commandContext.resolution.path;
              if (!!cmdSeq && cmdSeq.length) {
                const compItems = measureProvider(liveTraceRequest, 'analysisMs', () => {
                  const deepestCmd = cmdSeq[cmdSeq.length - 1];
                  const compSubcommands = commandContext.resolution.stopReason === undefined
                    ? getCompletionsSubcommands(deepestCmd)
                    : [];
                  const compOptions = commandContext.resolution.stopReason === 'end-of-options'
                    ? []
                    : getCompletionsOptions(commandContext);
                  let items = [
                    ...compSubcommands,
                    ...compOptions,
                  ];

                  if (isCaretTouchingWord) {
                    const currentNode = getCurrentNode(requestTree.rootNode, caret);
                    const currentWord = currentNode.text;
                    items = items.filter(compItem => isPrefixOf(currentWord, getLabelString(compItem.label)));
                    items.forEach(compItem => {
                      compItem.range = range(currentNode);
                    });
                  }
                  return items;
                });
                trackLiveCompletionResult(liveTraceRequest, 'items', {
                  itemCount: compItems.length,
                });
                return compItems;
              } else {
                throw new Error("unknown command");
              }
            } catch (e) {
              if (e instanceof CommandFetchCancelledError) {
                trackLiveCompletionResult(liveTraceRequest, 'cancelled', { itemCount: 0 });
                return [];
              }
              if (e instanceof UnknownCommandScanDisabledError) {
                trackLiveCompletionResult(liveTraceRequest, 'items', { itemCount: 0 });
                return [];
              }
              console.warn("[Completion] No completion item is available (1)", e);
              trackLiveCompletionResult(liveTraceRequest, 'error', {
                itemCount: 0,
                error: debugError(e),
              });
              return [];
            }
          }, liveTraceRequest?.measurement);
      } catch (error) {
        trackLiveCompletionResult(liveTraceRequest, 'error', {
          error: debugError(error),
        });
        throw error;
      } finally {
        finalizeLiveCompletionRequest(liveTraceRequest);
        editorCancellation.dispose();
        activeCompletionRequests.delete(requestCancellation);
        requestCancellation.dispose();
      }
    },
  };
  let completionProviderRegistration: vscode.Disposable | undefined;
  const updateCompletionProviderRegistration = (): void => {
    const enabled = vscode.workspace
      .getConfiguration('shellCompletion')
      .get<boolean>('enableCompletion', true);
    completionEnabled = enabled;
    if (!enabled) {
      for (const request of activeCompletionRequests) {
        request.cancel();
      }
    }
    if (enabled && !completionProviderRegistration) {
      completionProviderRegistration = vscode.languages.registerCompletionItemProvider(
        supportedLanguages,
        completionProvider,
        ' ',
      );
    } else if (!enabled && completionProviderRegistration) {
      completionProviderRegistration.dispose();
      completionProviderRegistration = undefined;
    }
  };
  updateCompletionProviderRegistration();
  activationRegistrations.push({
    dispose: () => {
      for (const request of activeCompletionRequests) {
        request.cancel();
      }
      completionProviderRegistration?.dispose();
      completionProviderRegistration = undefined;
    },
  });
  activationRegistrations.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('shellCompletion.enableCompletion')) {
      updateCompletionProviderRegistration();
      scheduleLiveDebug();
    }
  }));

  const hoverprovider = vscode.languages.registerHoverProvider(supportedLanguages, {
    async provideHover(document, cursor, token) {
      const liveTraceRequest = trackLiveHoverRequest(document, cursor);
      try {

        if (!parser) {
          console.error("[Hover] Parser is unavailable!");
          trackLiveHoverResult(liveTraceRequest, 'error', 'Parser is unavailable!');
          return Promise.reject("Parser is unavailable!");
        }

        const treeRequest = await measureProviderAsync(
          liveTraceRequest,
          'treeWaitMs',
          () => waitForValueOrCancellation(documentTrees.getWithTiming(document), token),
        );
        if (!treeRequest.completed) {
          trackLiveHoverResult(liveTraceRequest, 'cancelled');
          return undefined;
        }
        const treeAccess = treeRequest.value;
        liveTraceRequest?.measurement.add('parseMs', treeAccess.parseMs);
        const tree = treeAccess.tree;
        if (!tree) {
          trackLiveHoverResult(liveTraceRequest, 'suppressed');
          return undefined;
        }
        return await withTreeCopy(tree, async requestTree => {
          const cursorDecision = measureProvider(
            liveTraceRequest,
            'analysisMs',
            () => getHoverCursorDecision(requestTree.rootNode, cursor),
          );
          if (!cursorDecision.enabled) {
            trackLiveHoverResult(liveTraceRequest, 'suppressed');
            return undefined;
          }
          const currentWord = getCurrentNode(requestTree.rootNode, cursor).text;
          let commandContext: ResolvedCommandContext | undefined;
          try {
            commandContext = await getCommandNodeResolution(
              cursorDecision.commandNode,
              cursor,
              fetcher,
              true,
              token,
              liveTraceRequest?.measurement,
            );
          } catch (e) {
            if (e instanceof CommandFetchCancelledError) {
              trackLiveHoverResult(liveTraceRequest, 'cancelled');
              return undefined;
            }
            if (e instanceof UnknownCommandScanDisabledError) {
              trackLiveHoverResult(liveTraceRequest, 'none');
              return undefined;
            }
            trackLiveHoverResult(liveTraceRequest, 'error', debugError(e));
            return undefined;
          }
          if (!commandContext) {
            trackLiveHoverResult(liveTraceRequest, 'none');
            return undefined;
          }

          const cmdSeq = commandContext.resolution.path;
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
          }
          if (subcommandStep) {
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
          }
          if (commandContext.resolution.stopReason !== 'end-of-options') {
            const opts = getMatchingOption(currentWord, name, cmdSeq);
            if (opts.length > 0) {
              const msg = optsToMessage(opts);
              trackLiveHoverResult(liveTraceRequest, 'hover');
              return new vscode.Hover(new vscode.MarkdownString(msg));
            }
          }
          trackLiveHoverResult(liveTraceRequest, 'none');
          return undefined;
        }, liveTraceRequest?.measurement);
      } catch (error) {
        trackLiveHoverResult(liveTraceRequest, 'error', debugError(error));
        throw error;
      } finally {
        finalizeLiveHoverRequest(liveTraceRequest);
      }
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

      const tree = await documentTrees.get(editor.document);
      if (!tree) {
        void vscode.window.showInformationMessage(
          '[Shell Completion] Parser features are unavailable for this document size.',
        );
        return undefined;
      }
      const source = editor.document.getText();
      const caret = editor.selection.active;
      const caretOffset = editor.document.offsetAt(caret);
      const key = editor.document.uri.toString();

      const report = await createCaretDebugReport(
        parser,
        tree,
        fetcher,
        completionEnabled,
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
    measurement: ProviderMeasurement;
    timings?: ProviderPhaseTimings;
    completionResult?: {
      outcome: LiveCompletionProviderTrace['outcome'];
      itemCount: number | null;
      fallback: boolean;
      error: string | null;
    };
    hoverResult?: {
      outcome: LiveHoverProviderTrace['outcome'];
      error: string | null;
    };
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
      measurement: new ProviderMeasurement(),
    };
  }

  function measureProvider<T>(
    request: LiveTraceRequest | undefined,
    phase: ProviderAccumulatedPhase,
    operation: () => T,
  ): T {
    return request ? request.measurement.measure(phase, operation) : operation();
  }

  async function measureProviderAsync<T>(
    request: LiveTraceRequest | undefined,
    phase: ProviderAccumulatedPhase,
    operation: () => Promise<T>,
  ): Promise<T> {
    return request ? request.measurement.measureAsync(phase, operation) : operation();
  }

  function finishProviderRequest(
    request: LiveTraceRequest | undefined,
    kind: ProviderPerformanceKind,
    outcome: string,
  ): ProviderPhaseTimings | null {
    if (!request) {
      return null;
    }
    if (!request.timings) {
      request.timings = request.measurement.finish();
      performanceRecorder?.record(kind, outcome, request.timings);
    }
    return request.timings;
  }

  function trackLiveCompletionRequest(
    document: vscode.TextDocument,
    caret: vscode.Position,
  ): LiveTraceRequest | undefined {
    const updateLiveDebug = liveDebugEnabled && !liveDebugPaused;
    if (!updateLiveDebug && !performanceRecorder) {
      return undefined;
    }
    const request = traceRequest(document, caret);
    if (!updateLiveDebug) {
      return request;
    }
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
      timings: null,
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
    if (!request) {
      return;
    }
    request.completionResult = {
      outcome,
      itemCount: details.itemCount ?? null,
      fallback: details.fallback ?? false,
      error: details.error ?? null,
    };
  }

  function finalizeLiveCompletionRequest(request: LiveTraceRequest | undefined): void {
    if (!request) {
      return;
    }
    const result = request.completionResult ?? {
      outcome: 'error' as const,
      itemCount: null,
      fallback: false,
      error: 'Completion provider finished without recording a result.',
    };
    const timings = finishProviderRequest(request, 'completion', result.outcome);
    if (
      !liveDebugEnabled
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
      ...result,
      timings,
    };
    renderLiveDebugViews();
  }

  function trackLiveHoverRequest(
    document: vscode.TextDocument,
    cursor: vscode.Position,
  ): LiveTraceRequest | undefined {
    const updateLiveDebug = liveDebugEnabled && !liveDebugPaused;
    if (!updateLiveDebug && !performanceRecorder) {
      return undefined;
    }
    const request = traceRequest(document, cursor);
    if (!updateLiveDebug) {
      return request;
    }
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
      timings: null,
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
    if (!request) {
      return;
    }
    request.hoverResult = {
      outcome,
      error: error ?? null,
    };
  }

  function finalizeLiveHoverRequest(request: LiveTraceRequest | undefined): void {
    if (!request) {
      return;
    }
    const result = request.hoverResult ?? {
      outcome: 'error' as const,
      error: 'Hover provider finished without recording a result.',
    };
    const timings = finishProviderRequest(request, 'hover', result.outcome);
    if (
      !liveDebugEnabled
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
      ...result,
      timings,
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

    const tree = await documentTrees.get(editor.document);
    if (!tree) {
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
    const snapshot = await createLiveEditorDebugSnapshot(
      tree,
      fetcher,
      completionEnabled,
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
    documentTrees.update(edit);
    if (vscode.window.activeTextEditor?.document.uri.toString() === edit.document.uri.toString()) {
      scheduleLiveDebug();
    }
  }

  function close(document: vscode.TextDocument) {
    documentTrees.close(document);
    scheduleLiveDebug();
  }


  // h2o.loadCommand: Download the command `name`
  const loadCommand = vscode.commands.registerCommand('h2o.loadCommand', async (name: string) => {
    let cmd = name;
    if (!name) {
      cmd = (await vscode.window.showInputBox({ placeHolder: 'which command?' }))!;
    }

    if (!cmd || !cmd.trim()) {
      return;
    }

    try {
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
      return;
    }

    try {
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
      await fetcher.unset(name);
      commandListProvider.refresh();
    }
  }));


  activationRegistrations.push(vscode.workspace.onDidChangeTextDocument(edit));
  activationRegistrations.push(vscode.workspace.onDidCloseTextDocument(close));
  void requestUnknownCommandScanConsent({
    configuredValue: () => vscode.workspace
      .getConfiguration('shellCompletion')
      .inspect<boolean>('scanUnknownCommands')?.globalValue,
    promptedVersion: () => context.globalState.get<number>(unknownCommandScanConsentStateKey),
    recordPromptedVersion: version => context.globalState.update(
      unknownCommandScanConsentStateKey,
      version,
    ),
    prompt: async () => {
      const choice = await vscode.window.showWarningMessage(
        'Allow Shell Completion to run unknown commands with --help to provide completions?',
        enableLocalScansLabel,
        keepLocalScansDisabledLabel,
      );
      if (choice === enableLocalScansLabel) {
        return 'enable';
      }
      if (choice === keepLocalScansDisabledLabel) {
        return 'keep-disabled';
      }
      return undefined;
    },
    updateConfiguredValue: enabled => vscode.workspace
      .getConfiguration('shellCompletion')
      .update('scanUnknownCommands', enabled, vscode.ConfigurationTarget.Global),
  }).catch(error => {
    console.error('[Unknown command scans] Failed to handle the local scan choice:', error);
    void vscode.window.showErrorMessage(
      'Shell Completion could not finish local command scan setup. Check shellCompletion.scanUnknownCommands in Settings and try again.',
    );
  });
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

function asPosition(point: Point): vscode.Position {
  return new vscode.Position(point.row, point.column);
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
  if (!range(n).contains(position)) {
    console.error("Out of range!");
  }
  return getCurrentNodeAtPoint(n, asPoint(position));
}

/**
 * Provider error recovery is intentionally conservative: never interpret a
 * plain redirect payload, heredoc body, parser ERROR, or inserted MISSING token
 * as a command context. Commands within executable redirect substitutions have
 * their own context. Callers may also resume after a real shell boundary such
 * as `;`.
 */
export function isProviderSuppressedAtPosition(root: Node, position: vscode.Position): boolean {
  return getProviderSuppressionReasons(root, position).length > 0;
}

export function getProviderSuppressionReasons(
  root: Node,
  position: vscode.Position,
): ProviderSuppressionReason[] {
  return getProviderSuppressionReasonsAtPoint(root, asPoint(position));
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
      commandNode: undefined,
      touchingCommandToken: false,
      walkbackUnchanged: true,
      resumedAfterHerestring: false,
      requestSuppressionReasons,
      resolvedSuppressionReasons: requestSuppressionReasons,
    };
  }

  const anchor = resolveCompletionAnchor(document, root, asPoint(caret));
  const resolvedPosition = asPosition(anchor.point);
  const resolvedSuppressionReasons = getProviderSuppressionReasons(root, resolvedPosition);
  const resumedAfterHerestring = isSafeHerestringWalkback(root, resolvedPosition);
  const enabled = resolvedSuppressionReasons.length === 0 || resumedAfterHerestring;
  return {
    enabled,
    position: resolvedPosition,
    commandNode: enabled ? anchor.commandNode : undefined,
    touchingCommandToken: enabled && anchor.touchingCommandToken,
    walkbackUnchanged: !anchor.moved,
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
  return {
    decision,
    lookupTarget: decision.commandNode
      ? getCompletionLookupTarget(decision.commandNode, asPoint(caret))
      : { kind: 'command-spec' },
    includeArgumentAtPosition: !decision.touchingCommandToken,
  };
}

function getHoverCursorDecision(root: Node, cursor: vscode.Position): ProviderPositionDecision {
  const suppressionReasons = getProviderSuppressionReasons(root, cursor);
  return {
    enabled: suppressionReasons.length === 0,
    position: cursor,
    commandNode: suppressionReasons.length === 0
      ? getContextCommandNodeAtPoint(root, asPoint(cursor))
      : undefined,
    touchingCommandToken: false,
    walkbackUnchanged: true,
    resumedAfterHerestring: false,
    requestSuppressionReasons: suppressionReasons,
    resolvedSuppressionReasons: suppressionReasons,
  };
}


// Retained for the debug/test API. Provider code consumes the command node and
// token affinity from the same scope-aware resolution instead of resolving the
// returned position a second time.
export function walkbackCompletionCaretIfNeeded(
  document: LineTextProvider,
  root: Node,
  caret: vscode.Position,
): vscode.Position {
  const anchor = resolveCompletionAnchor(document, root, asPoint(caret));
  return asPosition(anchor.point);
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
  lookupTarget?: CompletionLookupTarget,
  lookupSkippedReason: DebugProviderDecision['lookupSkippedReason'] = null,
): Promise<DebugProviderDecision> {
  const commandNode = decision.commandNode;
  const report: DebugProviderDecision = {
    enabled: decision.enabled,
    lookupKind: decision.enabled
      ? lookupTarget?.kind ?? 'command-spec'
      : 'none',
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
    lookupSkippedReason,
    lookupError: null,
  };

  if (!decision.enabled || lookupSkippedReason) {
    return report;
  }

  if (lookupTarget && lookupTarget.kind !== 'command-spec') {
    const invocation = getCommandInvocationToPosition(
      commandNode,
      asPoint(decision.position),
      includeArgumentAtPosition,
    );
    report.invocation = invocation ? debugInvocation(invocation) : null;
    return report;
  }

  try {
    const context = await getCommandNodeResolution(
      commandNode,
      decision.position,
      fetcher,
      includeArgumentAtPosition,
    );
    if (context) {
      report.invocation = debugInvocation(context.invocation);
      report.resolution = debugResolution(context.resolution);
    }
  } catch (error) {
    const invocation = getCommandInvocationToPosition(
      commandNode,
      asPoint(decision.position),
      includeArgumentAtPosition,
    );
    report.invocation = invocation ? debugInvocation(invocation) : null;
    if (error instanceof UnknownCommandScanDisabledError) {
      report.lookupSkippedReason = 'unknown-command-scanning-disabled';
    } else {
      report.lookupError = debugError(error);
    }
  }
  return report;
}

async function inspectTreeAtPosition(
  document: LineTextProvider,
  root: Node,
  position: vscode.Position,
  fetcher: CachingFetcher,
  completionEnabled: boolean,
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
      completionAnalysis.lookupTarget,
      completionEnabled ? null : 'completion-disabled',
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
    lookupSkippedReason: decision.lookupSkippedReason,
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
  completionEnabled: boolean,
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
      const cached = await inspectTreeAtPosition(
        lineProvider,
        cachedCopy.rootNode,
        caret,
        fetcher,
        completionEnabled,
      );
      const fresh = await inspectTreeAtPosition(
        lineProvider,
        freshTree.rootNode,
        caret,
        fetcher,
        completionEnabled,
      );
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
    lookupSkippedReason: decision.lookupSkippedReason,
    lookupError: decision.lookupError,
  };
}

async function createLiveEditorDebugSnapshot(
  cachedTree: Tree,
  fetcher: CachingFetcher,
  completionEnabled: boolean,
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
      completionAnalysis.lookupTarget,
      completionEnabled ? null : 'completion-disabled',
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
  return getContextCommandNodeAtPoint(root, asPoint(position));
}

// Get command name covering the position if exists
export function getContextCommandName(root: Node, position: vscode.Position): string | undefined {
  const commandNode = _getContextCommandNode(root, position);
  return getCommandName(commandNode);
}

// Get command and subcommand inferred from the current position
async function getCommandNodeResolution(
  commandNode: Node | null | undefined,
  position: vscode.Position,
  fetcher: CachingFetcher,
  includeArgumentAtPosition = true,
  cancellationToken?: vscode.CancellationToken,
  measurement?: ProviderMeasurement,
): Promise<ResolvedCommandContext | undefined> {
  const getInvocation = () => getCommandInvocationToPosition(
    commandNode,
    asPoint(position),
    includeArgumentAtPosition,
  );
  const invocation = measurement
    ? measurement.measure('analysisMs', getInvocation)
    : getInvocation();
  if (!invocation) {
    return undefined;
  }

  const fetchCommand = () => fetcher.fetch(invocation.name.text, cancellationToken);
  const command = measurement
    ? await measurement.measureAsync('commandFetchMs', fetchCommand)
    : await fetchCommand();
  const resolvePath = () => resolveCommandPath(command, invocation.arguments);
  return {
    invocation,
    resolution: measurement
      ? measurement.measure('pathResolveMs', resolvePath)
      : resolvePath(),
  };
}


function getOptionArgumentNames(invocation: CommandInvocation): string[] {
  return invocation.arguments.map(argument => {
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
function getCompletionsOptions(context: ResolvedCommandContext): vscode.CompletionItem[] {
  const args = getOptionArgumentNames(context.invocation);
  const compitems: vscode.CompletionItem[] = [];
  const options = getOptions(context.resolution.path);
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
