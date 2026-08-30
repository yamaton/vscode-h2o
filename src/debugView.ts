import * as vscode from 'vscode';
import type {
  DebugPosition,
  LiveDebugNode,
  LiveDebugProviderDecision,
  LiveEditorDebugSnapshot,
} from './extension';
import type { ProviderPhaseTimings } from './providerPerformance';

export const completionDebugViewId = 'h2o.debug.completion';
export const hoverDebugViewId = 'h2o.debug.hover';
export const treeSitterDebugViewId = 'h2o.debug.treeSitter';
export const debugDocumentScheme = 'h2o-debug';

export interface LiveCompletionProviderTrace {
  documentUri: string;
  documentVersion: number;
  position: DebugPosition;
  observedAt: string;
  outcome: 'pending' | 'suppressed' | 'items' | 'cancelled' | 'error';
  itemCount: number | null;
  fallback: boolean;
  error: string | null;
  timings: ProviderPhaseTimings | null;
}

export interface LiveHoverProviderTrace {
  documentUri: string;
  documentVersion: number;
  position: DebugPosition;
  observedAt: string;
  outcome: 'pending' | 'suppressed' | 'hover' | 'none' | 'cancelled' | 'error';
  error: string | null;
  timings: ProviderPhaseTimings | null;
}

export interface LiveProviderTraces {
  completion: LiveCompletionProviderTrace | null;
  hover: LiveHoverProviderTrace | null;
}

export interface DebugViewRow {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  expanded?: boolean;
  children?: DebugViewRow[];
}

export interface LiveDebugPresentationState {
  enabled: boolean;
  paused: boolean;
  statusText: string | null;
  completion: DebugViewRow[];
  hover: DebugViewRow[];
  treeSitter: DebugViewRow[];
}

type DebugViewKind = 'completion' | 'hover' | 'tree-sitter';

function positionText(position: DebugPosition): string {
  return `${position.line + 1}:${position.character + 1}`;
}

function clippedText(value: string, maximumLength = 80): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}

function suppressionReasons(decision: LiveDebugProviderDecision): string[] {
  return decision.requestSuppressionReasons.length > 0
    ? decision.requestSuppressionReasons
    : decision.resolvedSuppressionReasons;
}

function decisionState(decision: LiveDebugProviderDecision): {
  label: string;
  description: string;
  icon: string;
} {
  if (decision.lookupSkippedReason === 'completion-disabled') {
    return {
      label: 'Decision',
      description: 'Disabled by shellCompletion.enableCompletion',
      icon: 'circle-slash',
    };
  }
  if (decision.lookupSkippedReason === 'unknown-command-scanning-disabled') {
    return {
      label: 'Lookup',
      description: 'Skipped: unknown-command scanning disabled',
      icon: 'circle-slash',
    };
  }
  if (decision.lookupError) {
    return { label: 'Analysis', description: 'Lookup error', icon: 'warning' };
  }
  if (decision.enabled) {
    return { label: 'Decision', description: 'Enabled', icon: 'pass' };
  }
  const reasons = suppressionReasons(decision);
  return {
    label: 'Decision',
    description: `Suppressed: ${reasons.join(', ') || 'unknown'}`,
    icon: 'circle-slash',
  };
}

function positionsMatch(left: DebugPosition, right: DebugPosition): boolean {
  return left.line === right.line && left.character === right.character;
}

function traceMatches(
  snapshot: LiveEditorDebugSnapshot,
  trace: LiveCompletionProviderTrace | LiveHoverProviderTrace,
  position: DebugPosition | null,
): boolean {
  return position !== null
    && trace.documentUri === snapshot.document.uri
    && trace.documentVersion === snapshot.document.version
    && positionsMatch(trace.position, position);
}

function providerResultRow(
  kind: 'completion' | 'hover',
  snapshot: LiveEditorDebugSnapshot,
  trace: LiveCompletionProviderTrace | LiveHoverProviderTrace | null,
): DebugViewRow {
  const position = kind === 'completion' ? snapshot.caret : snapshot.cursor;
  if (!trace) {
    return {
      id: `${kind}.provider-result`,
      label: 'Provider result',
      description: 'Not observed',
      icon: 'circle-outline',
      tooltip: `No ${kind} provider request has been observed since live debugging was enabled.`,
    };
  }

  const stale = !traceMatches(snapshot, trace, position);
  let description: string;
  let icon = 'info';
  if (kind === 'completion') {
    const completion = trace as LiveCompletionProviderTrace;
    if (completion.outcome === 'pending') {
      description = 'Running';
      icon = 'loading~spin';
    } else if (completion.outcome === 'items') {
      description = `${completion.itemCount ?? 0} item(s)${completion.fallback ? ' (command fallback)' : ''}`;
      icon = 'list-unordered';
    } else if (completion.outcome === 'suppressed') {
      description = 'Suppressed; 0 items';
      icon = 'circle-slash';
    } else if (completion.outcome === 'cancelled') {
      description = 'Cancelled';
      icon = 'circle-slash';
    } else {
      description = 'Error';
      icon = 'error';
    }
  } else {
    const hover = trace as LiveHoverProviderTrace;
    if (hover.outcome === 'pending') {
      description = 'Running';
      icon = 'loading~spin';
    } else if (hover.outcome === 'hover') {
      description = 'Hover returned';
      icon = 'comment-discussion';
    } else if (hover.outcome === 'suppressed') {
      description = 'Suppressed; no hover';
      icon = 'circle-slash';
    } else if (hover.outcome === 'none') {
      description = 'No hover';
      icon = 'circle-outline';
    } else if (hover.outcome === 'cancelled') {
      description = 'Cancelled';
      icon = 'circle-slash';
    } else {
      description = 'Error';
      icon = 'error';
    }
  }

  return {
    id: `${kind}.provider-result`,
    label: 'Provider result',
    description: `${description}${stale ? ' · stale' : ''}`,
    icon,
    tooltip: [
      `Observed at ${trace.observedAt}`,
      `Request: ${positionText(trace.position)}`,
      trace.error ? `Error: ${trace.error}` : undefined,
      stale ? 'This result belongs to an older document version or position.' : undefined,
    ].filter((line): line is string => !!line).join('\n'),
  };
}

function providerTimingRow(
  kind: 'completion' | 'hover',
  timings: ProviderPhaseTimings | null,
): DebugViewRow[] {
  if (!timings) {
    return [];
  }
  const phases: Array<[string, keyof Omit<ProviderPhaseTimings, 'totalMs'>]> = [
    ['Tree wait (includes parse)', 'treeWaitMs'],
    ['Parse (inside tree wait)', 'parseMs'],
    ['Tree copy/delete', 'treeCopyMs'],
    ['Analysis', 'analysisMs'],
    ['Command fetch', 'commandFetchMs'],
    ['Path resolve', 'pathResolveMs'],
    ['Unclassified', 'unclassifiedMs'],
  ];
  return [{
    id: `${kind}.timing`,
    label: 'Timing',
    description: `${timings.totalMs.toFixed(2)} ms total`,
    icon: 'watch',
    children: phases.map(([label, phase]) => ({
      id: `${kind}.timing.${phase}`,
      label,
      description: `${timings[phase].toFixed(2)} ms`,
    })),
  }];
}

function providerRows(
  kind: 'completion' | 'hover',
  snapshot: LiveEditorDebugSnapshot,
  decision: LiveDebugProviderDecision,
  trace: LiveCompletionProviderTrace | LiveHoverProviderTrace | null,
): DebugViewRow[] {
  const state = decisionState(decision);
  const requestedPosition = kind === 'completion' ? snapshot.caret : snapshot.cursor;
  const requested = requestedPosition ? positionText(requestedPosition) : 'not observed';
  const resolved = positionText(decision.resolvedPosition);
  const positionDescription = decision.moved ? `${requested} → ${resolved}` : requested;
  const command = decision.invocation?.name.text ?? '—';
  const path = decision.resolution?.path.join(' > ') || '—';
  const stopReason = decision.resolution?.stopReason ?? '—';

  return [
    {
      id: `${kind}.decision`,
      label: state.label,
      description: state.description,
      icon: state.icon,
    },
    providerResultRow(kind, snapshot, trace),
    ...providerTimingRow(kind, trace?.timings ?? null),
    {
      id: `${kind}.position`,
      label: kind === 'completion' ? 'Caret' : 'Cursor',
      description: positionDescription,
      icon: 'location',
    },
    {
      id: `${kind}.command`,
      label: 'Command',
      description: command,
      icon: 'terminal',
    },
    {
      id: `${kind}.path`,
      label: 'Resolved path',
      description: path,
      icon: 'type-hierarchy-sub',
    },
    {
      id: `${kind}.stop-reason`,
      label: 'Resolver stop',
      description: stopReason,
      icon: 'debug-stop',
    },
    {
      id: `${kind}.node`,
      label: 'Resolved node',
      description: `${decision.resolvedNode.type} ${JSON.stringify(clippedText(decision.resolvedNode.text, 40))}`,
      icon: 'symbol-field',
    },
    {
      id: `${kind}.details`,
      label: 'Decision details',
      icon: 'list-tree',
      children: [
        {
          id: `${kind}.details.lookup-kind`,
          label: 'Lookup kind',
          description: decision.lookupKind,
        },
        {
          id: `${kind}.details.walkback`,
          label: 'Walkback unchanged',
          description: String(decision.walkbackUnchanged),
        },
        {
          id: `${kind}.details.include-argument`,
          label: 'Include argument at position',
          description: String(decision.includeArgumentAtPosition),
        },
        {
          id: `${kind}.details.resumed-herestring`,
          label: 'Resumed after here-string',
          description: String(decision.resumedAfterHerestring),
        },
        {
          id: `${kind}.details.request-suppression`,
          label: 'Request suppression',
          description: decision.requestSuppressionReasons.join(', ') || '—',
        },
        {
          id: `${kind}.details.resolved-suppression`,
          label: 'Resolved suppression',
          description: decision.resolvedSuppressionReasons.join(', ') || '—',
        },
        {
          id: `${kind}.details.lookup-error`,
          label: 'Lookup error',
          description: decision.lookupError ?? '—',
        },
      ],
    },
  ];
}

function nodeFlags(node: LiveDebugNode): string[] {
  const flags: string[] = [];
  if (node.error) {
    flags.push('ERROR');
  }
  if (node.missing) {
    flags.push('MISSING');
  }
  if (node.hasError && !node.error) {
    flags.push('descendant error');
  }
  if (node.hasChanges) {
    flags.push('changed');
  }
  if (node.commandToken) {
    flags.push('command token');
  }
  return flags;
}

function nodeRow(id: string, label: string, node: LiveDebugNode, expanded = false): DebugViewRow {
  const flags = nodeFlags(node);
  return {
    id,
    label,
    description: `${node.type} ${JSON.stringify(clippedText(node.text, 36))}`,
    tooltip: `${node.type} (${node.start.line + 1}:${node.start.character + 1}–${node.end.line + 1}:${node.end.character + 1})`,
    icon: node.error || node.missing || node.hasError ? 'warning' : 'symbol-field',
    expanded,
    children: [
      { id: `${id}.type`, label: 'type', description: node.type },
      { id: `${id}.grammar-type`, label: 'grammarType', description: node.grammarType },
      { id: `${id}.id`, label: 'node ID', description: String(node.id) },
      { id: `${id}.type-id`, label: 'type ID', description: String(node.typeId) },
      { id: `${id}.grammar-id`, label: 'grammar ID', description: String(node.grammarId) },
      { id: `${id}.field`, label: 'field', description: node.fieldName ?? '—' },
      { id: `${id}.range`, label: 'range', description: `${positionText(node.start)}–${positionText(node.end)}` },
      { id: `${id}.text`, label: 'text', description: JSON.stringify(clippedText(node.text)) },
      { id: `${id}.flags`, label: 'flags', description: flags.join(', ') || 'none' },
      { id: `${id}.named`, label: 'named', description: String(node.named) },
      { id: `${id}.extra`, label: 'extra', description: String(node.extra) },
      { id: `${id}.parse-state`, label: 'parse state', description: String(node.parseState) },
      { id: `${id}.next-parse-state`, label: 'next parse state', description: String(node.nextParseState) },
    ],
  };
}

function treeLocationRows(
  id: string,
  label: string,
  location: LiveEditorDebugSnapshot['caret'] | null,
  currentNode: LiveDebugNode | null,
  ancestors: LiveDebugNode[],
  expanded: boolean,
): DebugViewRow {
  if (!location || !currentNode) {
    return {
      id,
      label,
      description: 'Waiting for a hover request',
      icon: 'circle-outline',
    };
  }
  return {
    id,
    label,
    description: positionText(location),
    icon: 'location',
    expanded,
    children: [
      nodeRow(`${id}.current`, 'Current node', currentNode, true),
      {
        id: `${id}.ancestors`,
        label: 'Ancestors',
        description: `${ancestors.length}`,
        icon: 'list-tree',
        children: ancestors.map((node, index) =>
          nodeRow(`${id}.ancestor.${index}`, `${index + 1}`, node)
        ),
      },
    ],
  };
}

function emptyRows(message: string): DebugViewRow[] {
  return [{
    id: 'disabled',
    label: message,
    icon: 'debug-disconnect',
  }];
}

export function createLiveDebugPresentation(
  enabled: boolean,
  paused: boolean,
  snapshot: LiveEditorDebugSnapshot | undefined,
  traces: LiveProviderTraces,
): LiveDebugPresentationState {
  if (!enabled) {
    return {
      enabled: false,
      paused,
      statusText: null,
      completion: emptyRows('Live debugging is disabled'),
      hover: emptyRows('Live debugging is disabled'),
      treeSitter: emptyRows('Live debugging is disabled'),
    };
  }
  if (!snapshot) {
    const rows = emptyRows('Open a Shell Script or BitBake editor');
    return {
      enabled: true,
      paused,
      statusText: `H2O${paused ? '⏸' : ''} C— H— TS:—`,
      completion: rows,
      hover: rows,
      treeSitter: rows,
    };
  }

  const completionMark = snapshot.completion.enabled ? '✓' : '×';
  const hoverMark = snapshot.hover ? (snapshot.hover.enabled ? '✓' : '×') : '—';
  return {
    enabled: true,
    paused,
    statusText: `H2O${paused ? '⏸' : ''} C${completionMark} H${hoverMark} TS:${clippedText(snapshot.caretNode.type, 24)}`,
    completion: providerRows('completion', snapshot, snapshot.completion, traces.completion),
    hover: snapshot.hover
      ? providerRows('hover', snapshot, snapshot.hover, traces.hover)
      : [{
        id: 'hover.waiting',
        label: 'Waiting for a hover request',
        description: 'Move the pointer over a token',
        icon: 'circle-outline',
      }],
    treeSitter: [
      treeLocationRows(
        'tree.caret',
        'Caret',
        snapshot.caret,
        snapshot.caretNode,
        snapshot.caretAncestors,
        true,
      ),
      treeLocationRows(
        'tree.cursor',
        'Hover cursor',
        snapshot.cursor,
        snapshot.cursorNode,
        snapshot.cursorAncestors,
        false,
      ),
    ],
  };
}

class DebugTreeItem extends vscode.TreeItem {
  readonly row: DebugViewRow;

  constructor(row: DebugViewRow) {
    const collapsibleState = row.children && row.children.length > 0
      ? row.expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    super(row.label, collapsibleState);
    this.row = row;
    this.id = row.id;
    this.description = row.description;
    this.tooltip = row.tooltip ?? [row.label, row.description].filter(Boolean).join(': ');
    this.iconPath = row.icon ? new vscode.ThemeIcon(row.icon) : undefined;
  }
}

class DebugTreeProvider implements vscode.TreeDataProvider<DebugTreeItem>, vscode.Disposable {
  private rows: DebugViewRow[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<DebugTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  setRows(rows: DebugViewRow[]): void {
    this.rows = rows;
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(element: DebugTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DebugTreeItem): DebugTreeItem[] {
    return (element?.row.children ?? this.rows).map(row => new DebugTreeItem(row));
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

class DebugSnapshotDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly snapshots = new Map<string, string>();

  add(kind: DebugViewKind, sequence: number, value: unknown): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: debugDocumentScheme,
      path: `/${kind}-${sequence}.json`,
    });
    this.snapshots.set(uri.toString(), JSON.stringify(value, null, 2));
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.snapshots.get(uri.toString()) ?? '{}';
  }

  dispose(): void {
    this.snapshots.clear();
  }
}

export class LiveDebugViewManager implements vscode.Disposable {
  private readonly completionProvider = new DebugTreeProvider();
  private readonly hoverProvider = new DebugTreeProvider();
  private readonly treeSitterProvider = new DebugTreeProvider();
  private readonly documentProvider = new DebugSnapshotDocumentProvider();
  private readonly statusBar = vscode.window.createStatusBarItem(
    'h2o.liveDebugStatus',
    vscode.StatusBarAlignment.Right,
    90,
  );
  private sequence = 0;
  private snapshot: LiveEditorDebugSnapshot | undefined;
  private traces: LiveProviderTraces = { completion: null, hover: null };
  private presentation = createLiveDebugPresentation(false, false, undefined, this.traces);

  constructor() {
    this.statusBar.name = 'H2O Live Debug';
    this.statusBar.command = 'h2o.showLiveDebugViews';
    this.applyPresentation();
  }

  registrations(): vscode.Disposable[] {
    return [
      vscode.window.registerTreeDataProvider(completionDebugViewId, this.completionProvider),
      vscode.window.registerTreeDataProvider(hoverDebugViewId, this.hoverProvider),
      vscode.window.registerTreeDataProvider(treeSitterDebugViewId, this.treeSitterProvider),
      vscode.workspace.registerTextDocumentContentProvider(debugDocumentScheme, this.documentProvider),
    ];
  }

  update(
    enabled: boolean,
    paused: boolean,
    snapshot: LiveEditorDebugSnapshot | undefined,
    traces: LiveProviderTraces,
  ): void {
    this.snapshot = snapshot;
    this.traces = traces;
    this.presentation = createLiveDebugPresentation(enabled, paused, snapshot, traces);
    this.sequence += 1;
    this.applyPresentation();
  }

  getPresentation(): LiveDebugPresentationState {
    return this.presentation;
  }

  async openSnapshot(kind: DebugViewKind): Promise<void> {
    if (!this.snapshot) {
      void vscode.window.showInformationMessage('[Shell Completion] No live debug snapshot is available.');
      return;
    }

    let value: unknown;
    if (kind === 'completion') {
      value = {
        generatedAt: new Date().toISOString(),
        document: this.snapshot.document,
        caret: this.snapshot.caret,
        providerTrace: this.traces.completion,
        decision: this.snapshot.completion,
      };
    } else if (kind === 'hover') {
      value = {
        generatedAt: new Date().toISOString(),
        document: this.snapshot.document,
        cursor: this.snapshot.cursor,
        providerTrace: this.traces.hover,
        decision: this.snapshot.hover,
      };
    } else {
      value = {
        generatedAt: new Date().toISOString(),
        document: this.snapshot.document,
        caret: this.snapshot.caret,
        caretNode: this.snapshot.caretNode,
        caretAncestors: this.snapshot.caretAncestors,
        cursor: this.snapshot.cursor,
        cursorNode: this.snapshot.cursorNode,
        cursorAncestors: this.snapshot.cursorAncestors,
      };
    }
    const uri = this.documentProvider.add(kind, this.sequence, value);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private applyPresentation(): void {
    this.completionProvider.setRows(this.presentation.completion);
    this.hoverProvider.setRows(this.presentation.hover);
    this.treeSitterProvider.setRows(this.presentation.treeSitter);

    if (!this.presentation.statusText) {
      this.statusBar.hide();
      return;
    }
    this.statusBar.text = this.presentation.statusText;
    this.statusBar.tooltip = new vscode.MarkdownString([
      '**H2O live debug**',
      '',
      'C = completion, H = hover, TS = tree-sitter node',
      '',
      'Click to open the H2O Debug views.',
    ].join('\n'));
    this.statusBar.show();
  }

  dispose(): void {
    this.completionProvider.dispose();
    this.hoverProvider.dispose();
    this.treeSitterProvider.dispose();
    this.documentProvider.dispose();
    this.statusBar.dispose();
  }
}
