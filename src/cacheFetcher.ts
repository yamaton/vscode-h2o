import type { Memento } from 'vscode';
import { Command } from './command';
import fetch from 'node-fetch';
import type { Response } from 'node-fetch';
import {
  CancellationTokenLike,
  waitForValueOrCancellation,
} from './cancellable';
import { ProcessExecutionError, runH2o } from './h2oRunner';
import {
  CommandCacheSnapshot,
  CommandCacheStorage,
  InvalidCommandCacheSnapshotError,
  commandCacheSnapshotVersion,
  decodeCommandBundle,
  validateCommands,
  validateCommandsYielding,
} from './cacheStorage';

export interface CachingFetcherDependencies {
  fetch(url: string, timeoutMs: number): Promise<Response>;
  runLocalCommand(name: string, signal: AbortSignal): Promise<Command | undefined>;
  requestTimeoutMs: number;
  cacheStorage?: CommandCacheStorage;
}

export interface CommandNameSnapshot {
  names: string[];
  initialCuratedPending: boolean;
}

const defaultDependencies: CachingFetcherDependencies = {
  // node-fetch v2 implements its own timeout, so this remains compatible with
  // the Node.js version embedded in the minimum supported VS Code (1.101).
  fetch: (url: string, timeoutMs: number) => fetch(url, { timeout: timeoutMs }),
  runLocalCommand: (name: string, signal: AbortSignal) => runH2o(name, undefined, signal),
  requestTimeoutMs: 10000,
  cacheStorage: undefined,
};

export class CommandFetchCancelledError extends Error {
  constructor(message = 'Command fetch was cancelled.') {
    super(message);
    this.name = 'CommandFetchCancelledError';
  }
}

export class UnknownCommandScanDisabledError extends Error {
  constructor(message = 'Unknown command scanning is disabled by shellCompletion.scanUnknownCommands.') {
    super(message);
    this.name = 'UnknownCommandScanDisabledError';
  }
}

type LocalFetchState = 'queued' | 'running' | 'persisting' | 'settled';

interface LocalFetchEntry {
  readonly name: string;
  readonly controller: AbortController;
  readonly promise: Promise<Command>;
  readonly resolve: (command: Command) => void;
  readonly reject: (error: unknown) => void;
  abortError?: UnknownCommandScanDisabledError;
  state: LocalFetchState;
  subscribers: number;
}

interface CacheMutation {
  readonly revision: number;
  readonly persistence: Promise<void>;
}


// -----
// CachingFetcher keeps the active cache in memory and persists a versioned
// snapshot through CommandCacheStorage. Memento is retained only to delete
// cache entries written by older extension versions.
export class CachingFetcher {
  static readonly keyPrefix = 'h2oFetcher.cache.';
  static readonly commandListKey = 'h2oFetcher.registered.all';

  private readonly dependencies: CachingFetcherDependencies;
  private commands = new Map<string, Command>();
  private cacheRevision = 0;
  private readonly removedNames = new Set<string>();
  private saveChain: Promise<void> = Promise.resolve();
  private persistenceEnabled = true;
  private initialCuratedAvailability: Promise<void> | undefined;
  private initialCuratedCompletion: Promise<void> | undefined;
  private initialCuratedPending = false;
  private readonly localFetches = new Map<string, LocalFetchEntry>();
  private readonly localFetchQueue: LocalFetchEntry[] = [];
  private activeLocalFetch: LocalFetchEntry | undefined;
  private scanUnknownCommandsEnabled = false;
  private disposed = false;

  constructor(
    private memento: Memento,
    dependencies: Partial<CachingFetcherDependencies> = {},
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  public async init(): Promise<void> {
    if (this.dependencies.cacheStorage) {
      try {
        const snapshot = await this.dependencies.cacheStorage.load();
        if (snapshot) {
          const commands = await validateCommandsYielding(snapshot.commands);
          this.commands = new Map(commands.map(command => [command.name, command]));
        }
      } catch (error) {
        if (error instanceof InvalidCommandCacheSnapshotError) {
          console.warn('[CacheFetcher.init] Ignoring invalid command cache snapshot:', error.originalError);
        } else {
          this.persistenceEnabled = false;
          console.warn('[CacheFetcher.init] Failed to read the command cache snapshot; persistence is disabled for this session:', error);
        }
      }
    }

    await this.cleanupLegacyState();

    if (this.commands.size === 0) {
      console.log(">>>---------------------------------------");
      console.log("  Clean state");
      console.log("<<<---------------------------------------");
    } else {
      console.log(">>>---------------------------------------");
      console.log("  Command cache entries already exist");
      console.log("    # of command specs in the local DB:", this.commands.size);
      console.log("<<<---------------------------------------");
    }
  }

  // Get Memento key of the command `name`
  static getKey(name: string): string {
    return CachingFetcher.keyPrefix + name;
  }

  private async cleanupLegacyState(): Promise<void> {
    const keys = this.memento.keys().filter(key =>
      key.startsWith(CachingFetcher.keyPrefix) || key === CachingFetcher.commandListKey
    );
    const failures: Array<{ key: string; error: unknown }> = [];
    await Promise.all(keys.map(async key => {
      try {
        await this.memento.update(key, undefined);
      } catch (error) {
        failures.push({ key, error });
      }
    }));
    for (const failure of failures) {
      console.warn(`[CacheFetcher.init] Failed to delete legacy Memento entry ${failure.key}:`, failure.error);
    }
  }

  private snapshot(): CommandCacheSnapshot {
    return {
      version: commandCacheSnapshotVersion,
      commands: [...this.commands.values()],
    };
  }

  private persist(): Promise<void> {
    const storage = this.dependencies.cacheStorage;
    if (!storage || !this.persistenceEnabled) {
      return Promise.resolve();
    }
    const snapshot = this.snapshot();
    const save = this.saveChain.catch(() => undefined).then(() => storage.save(snapshot));
    this.saveChain = save;
    return save;
  }

  private commitCommands(commands: Map<string, Command>): CacheMutation {
    this.commands = commands;
    const revision = ++this.cacheRevision;
    return { revision, persistence: this.persist() };
  }

  private commitCacheUpdate(
    name: string,
    command: Command | undefined,
    logging: boolean = false,
  ): CacheMutation {
    if (command && command.name !== name) {
      throw new Error(`Received command ${command.name} for requested command ${name}.`);
    }
    if (command) {
      command = validateCommands([command])[0];
    }
    const startedAt = Date.now();
    const next = new Map(this.commands);
    if (command) {
      next.set(name, command);
      this.removedNames.delete(name);
    } else {
      next.delete(name);
      this.removedNames.add(name);
    }
    const mutation = this.commitCommands(next);
    const persistence = mutation.persistence.then(() => {
      if (logging) {
        console.log(`[CacheFetcher.update] ${name}: Cache snapshot update took ${Date.now() - startedAt} ms.`);
      }
    });
    return { revision: mutation.revision, persistence };
  }

  private async updateCache(name: string, command: Command | undefined, logging: boolean = false): Promise<void> {
    await this.commitCacheUpdate(name, command, logging).persistence;
  }

  public setScanUnknownCommands(enabled: boolean): void {
    if (this.scanUnknownCommandsEnabled === enabled) {
      return;
    }
    this.scanUnknownCommandsEnabled = enabled;
    if (enabled) {
      this.startNextLocalFetch();
      return;
    }

    if (this.activeLocalFetch?.state === 'running'
      && !this.activeLocalFetch.controller.signal.aborted) {
      this.activeLocalFetch.abortError = new UnknownCommandScanDisabledError();
      this.activeLocalFetch.controller.abort();
    }
    const error = new UnknownCommandScanDisabledError();
    for (const entry of this.localFetchQueue) {
      if (entry.state !== 'queued') {
        continue;
      }
      entry.state = 'settled';
      entry.controller.abort();
      entry.reject(error);
      if (this.localFetches.get(entry.name) === entry) {
        this.localFetches.delete(entry.name);
      }
    }
    this.localFetchQueue.length = 0;
  }


  // Get command data from cache first, then run H2O if it is unavailable.
  public async fetch(name: string, cancellationToken?: CancellationTokenLike): Promise<Command> {
    if (name.length < 2) {
      return Promise.reject(`Command name too short: ${name}`);
    }
    if (this.disposed || cancellationToken?.isCancellationRequested) {
      throw new CommandFetchCancelledError();
    }

    let cached = this.commands.get(name);
    if (cached) {
      console.log('[CacheFetcher.fetch] Fetching from cache:', name);
      return cached;
    }

    if (this.initialCuratedAvailability) {
      if (cancellationToken) {
        const availability = await waitForValueOrCancellation(
          this.initialCuratedAvailability,
          cancellationToken,
        );
        if (!availability.completed) {
          throw new CommandFetchCancelledError();
        }
      } else {
        await this.initialCuratedAvailability;
      }
      cached = this.commands.get(name);
      if (cached) {
        console.log('[CacheFetcher.fetch] Fetching from newly available curated cache:', name);
        return cached;
      }
    }

    if (this.disposed || cancellationToken?.isCancellationRequested) {
      throw new CommandFetchCancelledError();
    }
    if (!this.scanUnknownCommandsEnabled) {
      throw new UnknownCommandScanDisabledError();
    }

    let entry = this.localFetches.get(name);
    if (entry?.controller.signal.aborted) {
      entry = undefined;
    }
    if (entry) {
      entry.subscribers += 1;
    } else {
      entry = this.createLocalFetch(name);
    }

    try {
      if (!cancellationToken) {
        return await entry.promise;
      }
      const result = await waitForValueOrCancellation(entry.promise, cancellationToken);
      if (!result.completed) {
        throw new CommandFetchCancelledError();
      }
      return result.value;
    } finally {
      this.releaseLocalFetch(entry);
    }
  }

  private createLocalFetch(name: string): LocalFetchEntry {
    let resolve!: (command: Command) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Command>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // Cancellation can settle the subscriber before the scan observes its
    // AbortSignal. Keep that later rejection from becoming unhandled.
    void promise.catch(() => undefined);
    const entry: LocalFetchEntry = {
      name,
      controller: new AbortController(),
      promise,
      resolve,
      reject,
      state: 'queued',
      subscribers: 1,
    };
    this.localFetches.set(name, entry);
    this.localFetchQueue.push(entry);
    this.startNextLocalFetch();
    return entry;
  }

  private startNextLocalFetch(): void {
    if (this.activeLocalFetch || this.disposed || !this.scanUnknownCommandsEnabled) {
      return;
    }
    let entry: LocalFetchEntry | undefined;
    while ((entry = this.localFetchQueue.shift())) {
      if (entry.state === 'queued' && entry.subscribers > 0) {
        break;
      }
      entry = undefined;
    }
    if (!entry) {
      return;
    }

    this.activeLocalFetch = entry;
    entry.state = 'running';
    void this.executeLocalFetch(entry).then(command => {
      entry.state = 'settled';
      entry.resolve(command);
    }, error => {
      entry.state = 'settled';
      entry.reject(error);
    }).finally(() => {
      if (this.localFetches.get(entry.name) === entry) {
        this.localFetches.delete(entry.name);
      }
      if (this.activeLocalFetch === entry) {
        this.activeLocalFetch = undefined;
      }
      this.startNextLocalFetch();
    });
  }

  private async executeLocalFetch(entry: LocalFetchEntry): Promise<Command> {
    const cached = this.commands.get(entry.name);
    if (cached) {
      return cached;
    }
    if (!this.scanUnknownCommandsEnabled) {
      throw new UnknownCommandScanDisabledError();
    }

    console.log('[CacheFetcher.fetch] Fetching from H2O:', entry.name);
    let command: Command | undefined;
    try {
      command = await this.dependencies.runLocalCommand(entry.name, entry.controller.signal);
    } catch (error) {
      if (entry.controller.signal.aborted
        || (error instanceof ProcessExecutionError && error.kind === 'aborted')) {
        throw entry.abortError ?? new CommandFetchCancelledError();
      }
      console.log('[CacheFetcher.fetch] Error:', error);
      throw new Error(`[CacheFetcher.fetch] Failed in CacheFetcher.update() with name = ${entry.name}`);
    }

    if (entry.controller.signal.aborted) {
      throw entry.abortError ?? new CommandFetchCancelledError();
    }
    if (!command) {
      console.warn(`[CacheFetcher.fetch] Failed to fetch command ${entry.name} from H2O`);
      throw new Error(`Failed to fetch command ${entry.name} from H2O`);
    }
    if (command.name !== entry.name) {
      console.warn(`[CacheFetcher.fetch] H2O returned ${command.name} for requested command ${entry.name}`);
      throw new Error(`H2O returned ${command.name} for requested command ${entry.name}`);
    }

    let validated: Command;
    try {
      validated = validateCommands([command])[0];
    } catch (error) {
      console.warn(`[CacheFetcher.fetch] H2O returned invalid command data for ${entry.name}:`, error);
      throw new Error(`H2O returned invalid command data for ${entry.name}`);
    }

    // Curated or explicitly downloaded data that arrived during the scan is
    // authoritative and must not be replaced by a stale local result.
    const newlyCached = this.commands.get(entry.name);
    if (newlyCached) {
      return newlyCached;
    }
    if (entry.controller.signal.aborted) {
      throw entry.abortError ?? new CommandFetchCancelledError();
    }

    entry.state = 'persisting';
    const mutation = this.commitCacheUpdate(entry.name, validated, true);
    try {
      await mutation.persistence;
    } catch (error) {
      console.log('[CacheFetcher.fetch] Failed to persist command cache:', error);
    }
    return this.resolveCommittedLocalResult(entry, validated, mutation.revision);
  }

  private async resolveCommittedLocalResult(
    entry: LocalFetchEntry,
    local: Command,
    localRevision: number,
  ): Promise<Command> {
    while (true) {
      if (entry.controller.signal.aborted) {
        throw entry.abortError ?? new CommandFetchCancelledError();
      }
      const observedRevision = this.cacheRevision;
      if (observedRevision === localRevision) {
        return local;
      }

      // A curated download, explicit download, or removal published a newer
      // snapshot while the local snapshot was being saved. Wait for the newest
      // observed snapshot's persistence before returning its authoritative value.
      const persistence = this.saveChain;
      try {
        await persistence;
      } catch {
        // Cache reads continue to use the in-memory snapshot when persistence
        // is unavailable, matching updateCache's existing behavior.
      }
      if (observedRevision !== this.cacheRevision) {
        continue;
      }
      if (entry.controller.signal.aborted) {
        throw entry.abortError ?? new CommandFetchCancelledError();
      }
      const current = this.commands.get(entry.name);
      if (!current) {
        throw new CommandFetchCancelledError();
      }
      return current;
    }
  }

  private releaseLocalFetch(entry: LocalFetchEntry): void {
    entry.subscribers = Math.max(0, entry.subscribers - 1);
    if (entry.subscribers !== 0) {
      return;
    }

    if (entry.state === 'queued') {
      entry.state = 'settled';
      entry.controller.abort();
      entry.reject(new CommandFetchCancelledError());
      if (this.localFetches.get(entry.name) === entry) {
        this.localFetches.delete(entry.name);
      }
      this.startNextLocalFetch();
      return;
    }
    if (entry.state === 'running' || entry.state === 'persisting') {
      entry.controller.abort();
    }
  }

  private cancelLocalFetch(name: string): void {
    const entry = this.localFetches.get(name);
    if (!entry || entry.state === 'settled') {
      return;
    }
    entry.controller.abort();
    if (entry.state === 'queued') {
      entry.state = 'settled';
      entry.reject(new CommandFetchCancelledError());
      this.localFetches.delete(name);
      this.startNextLocalFetch();
    }
  }


  public startInitialCuratedFetch(kind = 'general'): Promise<void> {
    if (this.initialCuratedCompletion) {
      return this.initialCuratedCompletion;
    }

    let markAvailable!: () => void;
    let availabilityMarked = false;
    this.initialCuratedPending = true;
    this.initialCuratedAvailability = new Promise<void>(resolve => {
      markAvailable = () => {
        if (availabilityMarked) {
          return;
        }
        availabilityMarked = true;
        this.initialCuratedPending = false;
        resolve();
      };
    });
    const completion = this.fetchAllCuratedInternal(kind, false, markAvailable);
    void completion.then(markAvailable, markAvailable);
    this.initialCuratedCompletion = completion;
    return completion;
  }

  // Download the package bundle `kind` and load them to cache
  public async fetchAllCurated(kind = 'general', isForcing = false): Promise<void> {
    return this.fetchAllCuratedInternal(kind, isForcing);
  }

  private async fetchAllCuratedInternal(
    kind: string,
    isForcing: boolean,
    markAvailable?: () => void,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    console.log("[CacheFetcher.fetchAllCurated] Started running...");
    const url = `https://github.com/yamaton/h2o-curated-data/raw/main/${kind}.json.gz`;
    const response = await this.fetchResponse(url);
    console.log("[CacheFetcher.fetchAllCurated] received HTTP response");

    let commands: Command[];
    try {
      const s = await response.buffer();
      commands = await decodeCommandBundle(s);
    } catch (err) {
      console.error("[fetchAllCurated] Error: ", err);
      return Promise.reject("Failed to inflate and parse the content as JSON.");
    }
    console.log("[CacheFetcher.fetchAllCurated] Done inflating and parsing. Command #:", commands.length);

    if (this.disposed) {
      return;
    }

    const next = new Map(this.commands);
    let inserted = false;
    for (const cmd of commands) {
      if (isForcing || (!this.removedNames.has(cmd.name) && !next.has(cmd.name))) {
        next.set(cmd.name, cmd);
        inserted = true;
        if (isForcing) {
          this.removedNames.delete(cmd.name);
        }
      }
    }
    if (isForcing || inserted) {
      const mutation = this.commitCommands(next);
      markAvailable?.();
      await mutation.persistence;
    } else {
      markAvailable?.();
    }
  }


  // Download the command `name` from the remote repository
  public async downloadCommandToCache(name: string, kind = 'experimental'): Promise<void> {
    if (this.disposed) {
      return;
    }
    console.log(`[CacheFetcher.downloadCommand] Started getting ${name} in ${kind}...`);
    const url = `https://raw.githubusercontent.com/yamaton/h2o-curated-data/main/${kind}/json/${name}.json`;
    const response = await this.fetchResponse(url);
    console.log("[CacheFetcher.downloadCommand] received HTTP response");

    let cmd: Command;
    try {
      const content = await response.text();
      cmd = validateCommands([JSON.parse(content) as unknown])[0];
    } catch (err) {
      const msg = `[CacheFetcher.downloadCommand] Error: ${err}`;
      console.error(msg);
      return Promise.reject(msg);
    }

    if (this.disposed) {
      return;
    }
    console.log(`[CacheFetcher.downloadCommand] Loading: ${cmd.name}`);
    await this.updateCache(name, cmd, true);
  }


  // Get a list of the command bundle `kind`.
  // This is used for removal of bundled commands.
  public async fetchList(kind = 'bio'): Promise<string[]> {
    console.log("[CacheFetcher.fetchList] Started running...");
    const url = `https://raw.githubusercontent.com/yamaton/h2o-curated-data/main/${kind}.txt`;
    const response = await this.fetchResponse(url);
    console.log("[CacheFetcher.fetchList] received HTTP response");

    let names: string[] = [];
    try {
      const content = await response.text();
      names = content.split(/\r?\n/).map((str) => str.trim()).filter(s => !!s && s.length > 0);
    } catch (err) {
      const msg = `[CacheFetcher.fetchList] Error: ${err}`;
      console.error(msg);
      return Promise.reject(msg);
    }
    names.forEach((name) => console.log("    Received ", name));
    return names;
  }

  private async fetchResponse(url: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.dependencies.fetch(url, this.dependencies.requestTimeoutMs);
    } catch (error) {
      console.error(`[CacheFetcher] Failed to fetch ${url}:`, error);
      throw new Error("Failed to fetch over HTTP");
    }

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch (error) {
        console.error('[CacheFetcher] Failed to read HTTP error body:', error);
      }
      console.error(`HTTP ${response.status} ${response.statusText}: ${errorBody}`);
      throw new Error("Failed to fetch HTTP response.");
    }
    return response;
  }

  // Unset cache data of command `name` by assigning undefined
  public async unset(name: string): Promise<void> {
    this.cancelLocalFetch(name);
    if (!this.commands.has(name)) {
      this.removedNames.add(name);
      console.log(`[CacheFetcher.unset] ${name} was not cached`);
      return;
    }
    await this.updateCache(name, undefined);
    console.log(`[CacheFetcher.unset] Unset ${name}`);
  }

  public async unsetAll(names: readonly string[]): Promise<void> {
    const next = new Map(this.commands);
    let removed = false;
    for (const name of names) {
      this.cancelLocalFetch(name);
      removed = next.delete(name) || removed;
      this.removedNames.add(name);
    }
    if (removed) {
      await this.commitCommands(next).persistence;
    } else {
      this.commands = next;
    }
    console.log(`[CacheFetcher.unsetAll] Unset ${names.length} commands`);
  }

  // Load a list of registered commands from the in-memory snapshot.
  public getList(): string[] {
    return [...this.commands.keys()];
  }

  public getCommandNameSnapshot(): CommandNameSnapshot {
    return {
      names: this.getList(),
      initialCuratedPending: this.initialCuratedPending,
    };
  }

  public waitForInitialCuratedAvailability(): Promise<void> {
    return this.initialCuratedAvailability ?? Promise.resolve();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.activeLocalFetch?.controller.abort();
    for (const entry of this.localFetchQueue) {
      if (entry.state !== 'queued') {
        continue;
      }
      entry.state = 'settled';
      entry.controller.abort();
      entry.reject(new CommandFetchCancelledError());
      if (this.localFetches.get(entry.name) === entry) {
        this.localFetches.delete(entry.name);
      }
    }
    this.localFetchQueue.length = 0;
  }

}
