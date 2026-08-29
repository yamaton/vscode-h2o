import { Edit, Parser, Tree } from 'web-tree-sitter';

export const supportedTreeLanguages = ['shellscript', 'bitbake'] as const;
export const defaultTreeParseDebounceMs = 100;
export const defaultMaximumDocumentCharacters = 1024 * 1024;

export type TreeCache = { [uri: string]: Tree };

interface PositionLike {
  readonly line: number;
  readonly character: number;
}

interface RangeLike {
  readonly start: PositionLike;
  readonly end: PositionLike;
}

interface ContentChangeLike {
  readonly range: RangeLike;
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly text: string;
}

export interface TreeDocumentLike {
  readonly uri: { toString(): string };
  readonly languageId: string;
  readonly version: number;
  readonly isClosed: boolean;
  getText(): string;
}

export interface TreeDocumentChangeLike {
  readonly document: TreeDocumentLike;
  readonly contentChanges: readonly ContentChangeLike[];
}

interface PendingParse {
  document: TreeDocumentLike;
  promise: Promise<Tree | undefined>;
  resolve(tree: Tree | undefined): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface LimitedDocument {
  version: number;
  characters: number;
}

export interface DocumentTreeCacheOptions {
  debounceMs?: number;
  maximumDocumentCharacters?(document: TreeDocumentLike): number;
  schedule?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  cancelSchedule?(timer: ReturnType<typeof setTimeout>): void;
  onDocumentLimited?(document: TreeDocumentLike, characters: number, maximum: number): void;
  onError?(error: unknown, document: TreeDocumentLike): void;
}

function asPoint(position: PositionLike): { row: number; column: number } {
  return { row: position.line, column: position.character };
}

function advancePoint(start: { row: number; column: number }, text: string): { row: number; column: number } {
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

/** Applies document deltas to an existing tree without parsing the document. */
export function updateTree(
  _parser: Parser,
  trees: TreeCache,
  event: TreeDocumentChangeLike,
): boolean {
  if (
    event.document.isClosed
    || event.contentChanges.length === 0
    || !supportedTreeLanguages.includes(
      event.document.languageId as typeof supportedTreeLanguages[number],
    )
  ) {
    return false;
  }

  const tree = trees[event.document.uri.toString()];
  if (!tree) {
    return false;
  }

  // Apply later ranges first so each remaining range still addresses the pre-edit tree.
  const changes = [...event.contentChanges].sort((left, right) => right.rangeOffset - left.rangeOffset);
  for (const change of changes) {
    const startPosition = asPoint(change.range.start);
    tree.edit(new Edit({
      startIndex: change.rangeOffset,
      oldEndIndex: change.rangeOffset + change.rangeLength,
      newEndIndex: change.rangeOffset + change.text.length,
      startPosition,
      oldEndPosition: asPoint(change.range.end),
      newEndPosition: advancePoint(startPosition, change.text),
    }));
  }
  return true;
}

/** Parses the current document, atomically replacing and deleting its prior cached tree. */
export function parseDocumentTree(
  parser: Parser,
  trees: TreeCache,
  document: TreeDocumentLike,
): Tree {
  const key = document.uri.toString();
  const oldTree = trees[key];
  const tree = parser.parse(document.getText(), oldTree);
  if (!tree) {
    throw new Error('[Parser] Parsing was cancelled.');
  }
  trees[key] = tree;
  oldTree?.delete();
  return tree;
}

/** Owns dirty state and coalesced parsing for the document tree cache. */
export class DocumentTreeCache {
  private readonly dirtyDocuments = new Set<string>();
  private readonly pendingParses = new Map<string, PendingParse>();
  private readonly limitedDocuments = new Map<string, LimitedDocument>();
  private readonly debounceMs: number;
  private readonly maximumDocumentCharacters: (document: TreeDocumentLike) => number;
  private readonly scheduleCallback: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly cancelCallback: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly onDocumentLimited: DocumentTreeCacheOptions['onDocumentLimited'];
  private readonly onError: DocumentTreeCacheOptions['onError'];
  private disposed = false;

  public constructor(
    private readonly parser: Parser,
    private readonly trees: TreeCache,
    options: DocumentTreeCacheOptions = {},
  ) {
    this.debounceMs = Math.max(0, options.debounceMs ?? defaultTreeParseDebounceMs);
    this.maximumDocumentCharacters = options.maximumDocumentCharacters
      ?? (() => defaultMaximumDocumentCharacters);
    this.scheduleCallback = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelCallback = options.cancelSchedule ?? (timer => clearTimeout(timer));
    this.onDocumentLimited = options.onDocumentLimited;
    this.onError = options.onError;
  }

  public update(event: TreeDocumentChangeLike): boolean {
    if (this.disposed || !updateTree(this.parser, this.trees, event)) {
      return false;
    }

    const key = event.document.uri.toString();
    this.dirtyDocuments.add(key);
    this.limitedDocuments.delete(key);
    void this.schedule(event.document);
    return true;
  }

  public async get(document: TreeDocumentLike): Promise<Tree | undefined> {
    if (this.disposed || document.isClosed) {
      return undefined;
    }

    const key = document.uri.toString();
    const cached = this.trees[key];
    const configuredMaximum = this.maximumDocumentCharacters(document);
    const knownLimitation = this.limitedDocuments.get(key);
    if (
      !cached
      && knownLimitation?.version === document.version
      && this.isOverLimit(knownLimitation.characters, configuredMaximum)
    ) {
      return undefined;
    }
    if (cached && this.exceedsLimit(document, cached.rootNode.endIndex, configuredMaximum)) {
      const pending = this.takePending(key);
      pending?.resolve(undefined);
      this.dirtyDocuments.delete(key);
      this.dropTree(key, document);
      return undefined;
    }

    if (!cached) {
      return this.parseNow(document, configuredMaximum);
    }
    this.limitedDocuments.delete(key);
    if (!this.dirtyDocuments.has(key)) {
      return cached;
    }
    return this.pendingParses.get(key)?.promise ?? this.schedule(document);
  }

  public flush(document: TreeDocumentLike): Tree | undefined {
    const key = document.uri.toString();
    const pending = this.takePending(key);
    const tree = this.refresh(document);
    pending?.resolve(tree);
    return tree;
  }

  public close(document: TreeDocumentLike): void {
    const key = document.uri.toString();
    const pending = this.takePending(key);
    pending?.resolve(undefined);
    this.dirtyDocuments.delete(key);
    this.limitedDocuments.delete(key);
    this.dropTree(key, document);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const key of [...this.pendingParses.keys()]) {
      const pending = this.takePending(key);
      pending?.resolve(undefined);
    }
    this.dirtyDocuments.clear();
    this.limitedDocuments.clear();
  }

  private schedule(document: TreeDocumentLike): Promise<Tree | undefined> {
    const key = document.uri.toString();
    let pending = this.pendingParses.get(key);
    if (!pending) {
      let resolve!: (tree: Tree | undefined) => void;
      const promise = new Promise<Tree | undefined>(resolvePromise => {
        resolve = resolvePromise;
      });
      pending = { document, promise, resolve, timer: undefined };
      this.pendingParses.set(key, pending);
    } else {
      pending.document = document;
      if (pending.timer) {
        this.cancelCallback(pending.timer);
      }
    }

    pending.timer = this.scheduleCallback(() => {
      const current = this.pendingParses.get(key);
      if (current !== pending) {
        return;
      }
      this.pendingParses.delete(key);
      current.timer = undefined;
      const tree = this.refresh(current.document);
      current.resolve(tree);
    }, this.debounceMs);
    return pending.promise;
  }

  private refresh(document: TreeDocumentLike): Tree | undefined {
    if (this.disposed || document.isClosed) {
      return undefined;
    }
    const key = document.uri.toString();
    if (!this.dirtyDocuments.has(key)) {
      return this.trees[key] ?? this.parseNow(document);
    }
    return this.parseNow(document);
  }

  private parseNow(
    document: TreeDocumentLike,
    configuredMaximum = this.maximumDocumentCharacters(document),
  ): Tree | undefined {
    const key = document.uri.toString();
    const oldTree = this.trees[key];
    const knownLength = oldTree?.rootNode.endIndex;
    if (knownLength !== undefined && this.exceedsLimit(document, knownLength, configuredMaximum)) {
      this.dirtyDocuments.delete(key);
      this.dropTree(key, document);
      return undefined;
    }

    const source = document.getText();
    if (this.exceedsLimit(document, source.length, configuredMaximum)) {
      this.dirtyDocuments.delete(key);
      this.dropTree(key, document);
      return undefined;
    }
    this.limitedDocuments.delete(key);

    let tree: Tree | null;
    try {
      tree = this.parser.parse(source, oldTree);
    } catch (error) {
      this.handleParseFailure(key, document, oldTree, error);
      return undefined;
    }
    if (!tree) {
      try {
        this.parser.reset();
      } catch (error) {
        this.onError?.(error, document);
      }
      this.handleParseFailure(
        key,
        document,
        oldTree,
        new Error('[Parser] Parsing was cancelled.'),
      );
      return undefined;
    }

    this.trees[key] = tree;
    this.dirtyDocuments.delete(key);
    if (oldTree) {
      try {
        oldTree.delete();
      } catch (error) {
        this.onError?.(error, document);
      }
    }
    return tree;
  }

  private isOverLimit(characters: number, configuredMaximum: number): boolean {
    return Number.isFinite(configuredMaximum)
      && configuredMaximum > 0
      && characters > configuredMaximum;
  }

  private exceedsLimit(
    document: TreeDocumentLike,
    characters: number,
    configuredMaximum: number,
  ): boolean {
    if (!this.isOverLimit(characters, configuredMaximum)) {
      return false;
    }
    const key = document.uri.toString();
    const previousLimitation = this.limitedDocuments.get(key);
    this.limitedDocuments.set(key, { version: document.version, characters });
    if (!previousLimitation) {
      this.onDocumentLimited?.(document, characters, Math.floor(configuredMaximum));
    }
    return true;
  }

  private handleParseFailure(
    key: string,
    document: TreeDocumentLike,
    oldTree: Tree | undefined,
    error: unknown,
  ): void {
    this.dirtyDocuments.delete(key);
    if (this.trees[key] === oldTree) {
      delete this.trees[key];
    }
    if (oldTree) {
      try {
        oldTree.delete();
      } catch (cleanupError) {
        this.onError?.(cleanupError, document);
      }
    }
    this.onError?.(error, document);
  }

  private dropTree(key: string, document: TreeDocumentLike): void {
    const tree = this.trees[key];
    if (!tree) {
      return;
    }
    delete this.trees[key];
    try {
      tree.delete();
    } catch (error) {
      this.onError?.(error, document);
    }
  }

  private takePending(key: string): PendingParse | undefined {
    const pending = this.pendingParses.get(key);
    if (!pending) {
      return undefined;
    }
    this.pendingParses.delete(key);
    if (pending.timer) {
      this.cancelCallback(pending.timer);
      pending.timer = undefined;
    }
    return pending;
  }
}
