import { spawnSync } from 'child_process';
import * as path from 'path';
import type { Memento } from 'vscode';
import type * as Vscode from 'vscode';
import { Command } from './command';
import fetch from 'node-fetch';
import type { Response } from 'node-fetch';
import {
  CommandCacheSnapshot,
  CommandCacheStorage,
  InvalidCommandCacheSnapshotError,
  commandCacheSnapshotVersion,
  decodeCommandBundle,
  validateCommands,
  validateCommandsYielding,
} from './cacheStorage';

let neverNotifiedError = true;


interface SpawnResult {
  error?: Error;
  status: number | null;
  stdout?: string | Buffer;
}

export interface H2oRuntime {
  extensionDir: string;
  platform: NodeJS.Platform;
  getConfiguredPath(): string;
  showErrorMessage(message: string): void;
  spawn(command: string, args: string[]): SpawnResult;
}

export interface CachingFetcherDependencies {
  fetch(url: string, timeoutMs: number): Promise<Response>;
  runLocalCommand(name: string): Command | undefined;
  requestTimeoutMs: number;
  cacheStorage?: CommandCacheStorage;
}

export interface CommandNameSnapshot {
  names: string[];
  initialCuratedPending: boolean;
}

function createDefaultH2oRuntime(): H2oRuntime {
  // `vscode` is only available inside the extension host. Loading it lazily
  // keeps the command runner testable in a plain Node.js process.
  const vscode = require('vscode') as typeof Vscode;
  return {
    extensionDir: __dirname,
    platform: process.platform,
    getConfiguredPath: () => vscode.workspace.getConfiguration('shellCompletion').get('h2oPath') as string,
    showErrorMessage: (message: string) => {
      void vscode.window.showErrorMessage(message);
    },
    spawn: (command: string, args: string[]) => spawnSync(command, args, { encoding: 'utf8', timeout: 10000 }),
  };
}

const defaultDependencies: CachingFetcherDependencies = {
  // node-fetch v2 implements its own timeout, so this remains compatible with
  // the Node.js version embedded in the minimum supported VS Code (1.101).
  fetch: (url: string, timeoutMs: number) => fetch(url, { timeout: timeoutMs }),
  runLocalCommand: (name: string) => runH2o(name),
  requestTimeoutMs: 10000,
  cacheStorage: undefined,
};


// -----
// Call H2O executable and get command information from the local environment
export function runH2o(name: string, runtime: H2oRuntime = createDefaultH2oRuntime()): Command | undefined {
  let h2opath = runtime.getConfiguredPath();
  if (h2opath === '<bundled>') {
    if (runtime.platform !== 'linux' && runtime.platform !== 'darwin') {
      if (neverNotifiedError) {
        const msg = "Bundled help scanner (H2O) supports Linux and MacOS. Please set the H2O path.";
        runtime.showErrorMessage(msg);
      }
      neverNotifiedError = false;
      return undefined;
    }
    h2opath = path.join(runtime.extensionDir, '../bin/h2o');
  }

  const wrapperPath = path.join(runtime.extensionDir, '../bin/wrap-h2o');
  console.log(`[CacheFetcher.runH2o] spawning h2o: ${name}`);
  const proc = runtime.spawn(wrapperPath, [h2opath, name]);
  if (proc.error) {
    console.warn(`[CacheFetcher.runH2o] Failed to run H2O for ${name}: ${proc.error.message}`);
    return undefined;
  }
  if (proc.status !== 0) {
    console.log(`[CacheFetcher.runH2o] H2O raises error for ${name}`);
    return undefined;
  }
  console.log(`[CacheFetcher.runH2o] proc.status = ${proc.status}`);
  const out = proc.stdout;
  if (out) {
    try {
      const command = validateCommands([JSON.parse(out.toString()) as unknown])[0];
      if (command.name !== name) {
        throw new Error(`H2O returned ${command.name} for requested command ${name}.`);
      }
      console.log(`[CacheFetcher.runH2o] Got command output: ${command.name}`);
      return command;
    } catch (error) {
      console.warn('[CacheFetcher.runH2o] Failed to parse H2O result as JSON:', name, error);
    }
  } else {
    console.warn('[CacheFetcher.runH2o] Failed to get H2O output:', name);
  }
  return undefined;
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
  private readonly removedNames = new Set<string>();
  private saveChain: Promise<void> = Promise.resolve();
  private persistenceEnabled = true;
  private initialCuratedAvailability: Promise<void> | undefined;
  private initialCuratedCompletion: Promise<void> | undefined;
  private initialCuratedPending = false;

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

  private async updateCache(name: string, command: Command | undefined, logging: boolean = false): Promise<void> {
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
    this.commands = next;
    await this.persist();
    if (logging) {
      console.log(`[CacheFetcher.update] ${name}: Cache snapshot update took ${Date.now() - startedAt} ms.`);
    }
  }


  // Get command data from cache first, then run H2O if fails.
  public async fetch(name: string): Promise<Command> {
    if (name.length < 2) {
      return Promise.reject(`Command name too short: ${name}`);
    }

    let cached = this.commands.get(name);
    if (cached) {
      console.log('[CacheFetcher.fetch] Fetching from cache:', name);
      return cached;
    }

    if (this.initialCuratedAvailability) {
      await this.initialCuratedAvailability;
      cached = this.commands.get(name);
      if (cached) {
        console.log('[CacheFetcher.fetch] Fetching from newly available curated cache:', name);
        return cached;
      }
    }

    console.log('[CacheFetcher.fetch] Fetching from H2O:', name);
    try {
      const command = this.dependencies.runLocalCommand(name);
      if (!command) {
        console.warn(`[CacheFetcher.fetch] Failed to fetch command ${name} from H2O`);
        return Promise.reject(`Failed to fetch command ${name} from H2O`);
      }
      if (command.name !== name) {
        console.warn(`[CacheFetcher.fetch] H2O returned ${command.name} for requested command ${name}`);
        return Promise.reject(`H2O returned ${command.name} for requested command ${name}`);
      }
      let validated: Command;
      try {
        validated = validateCommands([command])[0];
      } catch (error) {
        console.warn(`[CacheFetcher.fetch] H2O returned invalid command data for ${name}:`, error);
        return Promise.reject(`H2O returned invalid command data for ${name}`);
      }
      try {
        await this.updateCache(name, validated, true);
      } catch (e) {
        console.log("Failed to update:", e);
      }
      return validated;

    } catch (e) {
      console.log("[CacheFetcher.fetch] Error: ", e);
      return Promise.reject(`[CacheFetcher.fetch] Failed in CacheFetcher.update() with name = ${name}`);
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
    this.commands = next;
    markAvailable?.();
    if (isForcing || inserted) {
      await this.persist();
    }
  }


  // Download the command `name` from the remote repository
  public async downloadCommandToCache(name: string, kind = 'experimental'): Promise<void> {
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
      removed = next.delete(name) || removed;
      this.removedNames.add(name);
    }
    this.commands = next;
    if (removed) {
      await this.persist();
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

}
