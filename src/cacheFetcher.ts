import { spawnSync } from 'child_process';
import * as path from 'path';
import type { Memento } from 'vscode';
import type * as Vscode from 'vscode';
import { Command } from './command';
import fetch from 'node-fetch';
import type { Response } from 'node-fetch';
import * as pako from 'pako';

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
  // the Node.js version embedded in the minimum supported VS Code (1.63).
  fetch: (url: string, timeoutMs: number) => fetch(url, { timeout: timeoutMs }),
  runLocalCommand: (name: string) => runH2o(name),
  requestTimeoutMs: 10000,
};


// -----
// Call H2O executable and get command information from the local environment
export function runH2o(name: string, runtime: H2oRuntime = createDefaultH2oRuntime()): Command | undefined {
  let h2opath = runtime.getConfiguredPath();
  if (h2opath === '<bundled>') {
    if (runtime.platform === 'linux') {
      h2opath = path.join(runtime.extensionDir, '../bin/h2o-x86_64-unknown-linux');
    } else if (runtime.platform === 'darwin') {
      h2opath = path.join(runtime.extensionDir, '../bin/h2o-x86_64-apple-darwin');
    } else {
      if (neverNotifiedError) {
        const msg = "Bundled help scanner (H2O) supports Linux and MacOS. Please set the H2O path.";
        runtime.showErrorMessage(msg);
      }
      neverNotifiedError = false;
      return undefined;
    }
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
      const command = JSON.parse(out.toString()) as Command;
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
// CachingFetcher manages the local cache using Memento.
// It also pulls command data from the remote repository.
export class CachingFetcher {
  static readonly keyPrefix = 'h2oFetcher.cache.';
  static readonly commandListKey = 'h2oFetcher.registered.all';

  private readonly dependencies: CachingFetcherDependencies;

  constructor(
    private memento: Memento,
    dependencies: Partial<CachingFetcherDependencies> = {},
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  public async init(): Promise<void> {
    const existing = this.getList();

    if (!existing || !existing.length || existing.length === 0) {
      console.log(">>>---------------------------------------");
      console.log("  Clean state");
      console.log("<<<---------------------------------------");
    } else {
      console.log(">>>---------------------------------------");
      console.log("  Memento entries already exist");
      console.log("    # of command specs in the local DB:", existing.length);
      console.log("<<<---------------------------------------");
    }
  }

  // Get Memento key of the command `name`
  static getKey(name: string): string {
    return CachingFetcher.keyPrefix + name;
  }

  // Get Memento data of the command `name`
  private getCache(name: string): Command | undefined {
    const key = CachingFetcher.getKey(name);
    return this.memento.get(key);
  }

  // Update Memento record and the name list
  // Pass undefined to remove the value.
  private async updateCache(name: string, command: Command | undefined, logging: boolean = false): Promise<void> {
    if (logging) {
      console.log(`[CacheFetcher.update] Updating ${name}...`);
      const t0 = new Date();
      const key = CachingFetcher.getKey(name);
      await this.memento.update(key, command);
      const t1 = new Date();
      const diff = t1.getTime() - t0.getTime();
      console.log(`[CacheFetcher.update] ${name}: Memento update took ${diff} ms.`);
    } else {
      const key = CachingFetcher.getKey(name);
      await this.memento.update(key, command);
    }
  }


  // Get command data from cache first, then run H2O if fails.
  public async fetch(name: string): Promise<Command> {
    if (name.length < 2) {
      return Promise.reject(`Command name too short: ${name}`);
    }

    const cached = this.getCache(name);
    if (cached) {
      console.log('[CacheFetcher.fetch] Fetching from cache:', name);
      return cached as Command;
    }

    console.log('[CacheFetcher.fetch] Fetching from H2O:', name);
    try {
      const command = this.dependencies.runLocalCommand(name);
      if (!command) {
        console.warn(`[CacheFetcher.fetch] Failed to fetch command ${name} from H2O`);
        return Promise.reject(`Failed to fetch command ${name} from H2O`);
      }
      try {
        await this.updateCache(name, command, true);
      } catch (e) {
        console.log("Failed to update:", e);
      }
      return command;

    } catch (e) {
      console.log("[CacheFetcher.fetch] Error: ", e);
      return Promise.reject(`[CacheFetcher.fetch] Failed in CacheFetcher.update() with name = ${name}`);
    }
  }


  // Download the package bundle `kind` and load them to cache
  public async fetchAllCurated(kind = 'general', isForcing = false): Promise<void> {
    console.log("[CacheFetcher.fetchAllCurated] Started running...");
    const url = `https://github.com/yamaton/h2o-curated-data/raw/main/${kind}.json.gz`;
    const response = await this.fetchResponse(url);
    console.log("[CacheFetcher.fetchAllCurated] received HTTP response");

    let commands: Command[] = [];
    try {
      const s = await response.buffer();
      const decoded = pako.inflate(s, { to: 'string' });
      commands = JSON.parse(decoded) as Command[];
    } catch (err) {
      console.error("[fetchAllCurated] Error: ", err);
      return Promise.reject("Failed to inflate and parse the content as JSON.");
    }
    console.log("[CacheFetcher.fetchAllCurated] Done inflating and parsing. Command #:", commands.length);

    for (const cmd of commands) {
      if (isForcing || this.getCache(cmd.name) === undefined) {
        await this.updateCache(cmd.name, cmd, false);
      }
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
      cmd = JSON.parse(content) as Command;
    } catch (err) {
      const msg = `[CacheFetcher.downloadCommand] Error: ${err}`;
      console.error(msg);
      return Promise.reject(msg);
    }

    console.log(`[CacheFetcher.downloadCommand] Loading: ${cmd.name}`);
    await this.updateCache(cmd.name, cmd, true);
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
    await this.updateCache(name, undefined);
    console.log(`[CacheFetcher.unset] Unset ${name}`);
  }

  // Load a list of registered commands from Memento
  public getList(): string[] {
    const keys = this.memento.keys();
    const prefix = CachingFetcher.keyPrefix;
    const cmdKeys =
      keys.filter(x => x.startsWith(prefix))
          .map(x => x.substring(prefix.length));
    return cmdKeys;
  }

}
