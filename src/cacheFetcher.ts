import * as vscode from 'vscode';
import { Memento } from 'vscode';
import { spawnSync } from 'child_process';
import { Command } from './command';
import fetch from 'node-fetch';
import { Response } from 'node-fetch';
import * as pako from 'pako';

let neverNotifiedError = true;


class HTTPResponseError extends Error {
  response: Response;
  constructor(res: Response) {
    super(`HTTP Error Response: ${res.status} ${res.statusText}`);
    this.response = res;
  }
}


// -----
// Call H2O executable and get command information from the local environment
export function runH2o(name: string): Command | undefined {
  let h2opath = vscode.workspace.getConfiguration('h2o').get('h2oPath') as string;
  if (h2opath === '<bundled>') {
    if (process.platform === 'linux') {
      h2opath = `${__dirname}/../bin/h2o-x86_64-unknown-linux`;
    } else if (process.platform === 'darwin') {
      h2opath = `${__dirname}/../bin/h2o-x86_64-apple-darwin`;
    } else {
      if (neverNotifiedError) {
        const msg = "Bundled help scanner (H2O) supports Linux and MacOS. Please set the H2O path.";
        vscode.window.showErrorMessage(msg);
      }
      neverNotifiedError = false;
      return;
    }
  }

  const wrapperPath = `${__dirname}/../bin/wrap-h2o`;
  console.log(`[CacheFetcher.runH2o] spawning h2o: ${name}`);
  const proc = spawnSync(wrapperPath, [h2opath, name], {encoding: "utf8"});
  if (proc.status !== 0) {
    console.log(`[CacheFetcher.runH2o] H2O raises error for ${name}`);
    return;
  }
  console.log(`[CacheFetcher.runH2o] proc.status = ${proc.status}`);
  const out = proc.stdout;
  if (out) {
    const command = JSON.parse(out);
    if (command) {
      console.log(`[CacheFetcher.runH2o] Got command output: ${command.name}`);
      return command;
    } else {
      console.warn('[CacheFetcher.runH2o] Failed to parse H2O result as JSON: ', name);
    }
  } else {
    console.warn('[CacheFetcher.runH2o] Failed to get H2O output: ', name);
  }
}


// -----
// CachingFetcher manages the local cache using Memento.
// It also pulls command data from the remote repository.
export class CachingFetcher {
  static readonly keyPrefix = 'h2oFetcher.cache.';
  static readonly commandListKey = 'h2oFetcher.registered.all';

  constructor(
    private memento: Memento
  ) {}

  public async init(): Promise<void> {
    const existing = this.getList();

    if (!existing || !existing.length || existing.length === 0) {
      console.log("---------------------------------------");
      console.log("          Clean state");
      console.log("---------------------------------------");
    } else {
      console.log("---------------------------------------");
      console.log("   Memento entries already exist");
      console.log("---------------------------------------");
      console.log("this.getList() = ", this.getList());
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
  private async updateCache(name: string, command: Command | undefined): Promise<void> {
    const t0 = new Date();
    const key = CachingFetcher.getKey(name);
    await this.memento.update(key, command);
    const t1 = new Date();
    const diff = t1.getTime() - t0.getTime();
    console.log(`[CacheFetcher.update] ${name}: Memento update took ${diff} ms.`);
  }


  // Get command data from cache first, then run H2O if fails.
  public async fetch(name: string): Promise<Command> {
    if (name.length < 2) {
      return Promise.reject(`Command name too short: ${name}`);
    }

    let cached = this.getCache(name);
    if (cached) {
      console.log('[CacheFetcher.fetch] Fetching from cache: ', name);
      return cached as Command;
    }

    console.log('[CacheFetcher.fetch] Fetching from H2O: ', name);
    try {
      const command = runH2o(name);
      if (!command) {
        console.warn(`[CacheFetcher.fetch] Failed to fetch command ${name} from H2O`);
        return Promise.reject(`Failed to fetch command ${name} from H2O`);
      }
      try {
        await this.updateCache(name, command);
      } catch (e) {
        console.log("Failed to update: ", e);
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
    const checkStatus = (res: Response) => {
      if (res.ok) {
        return res;
      } else {
        throw new HTTPResponseError(res);
      }
    };

    let response: Response;
    try {
      response = await fetch(url);
      checkStatus(response);
    } catch (error) {
      try {
        const err = error as HTTPResponseError;
        const errorBody = await err.response.text();
        console.error(`Error body: ${errorBody}`);
        return Promise.reject("Failed to fetch HTTP response.");
      } catch (e) {
        console.error('Error ... even failed to fetch error body: ', e);
        return Promise.reject("Failed to fetch over HTTP");
      }
    }
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
    console.log("[CacheFetcher.fetchAllCurated] Done inflating and parsing. Command #: ", commands.length);

    for (const cmd of commands) {
      const key = CachingFetcher.getKey(cmd.name);
      if (isForcing || this.getCache(cmd.name) === undefined) {
        console.log(`[fetchAllCurated] Loading: ${cmd.name}`);
        await this.updateCache(cmd.name, cmd);
      }
    }
  }


  // Download the command `name` from the remote repository
  public async downloadCommandToCache(name: string, kind = 'experimental'): Promise<void> {
    console.log(`[CacheFetcher.downloadCommand] Started getting ${name} in ${kind}...`);
    const url = `https://raw.githubusercontent.com/yamaton/h2o-curated-data/main/${kind}/json/${name}.json`;
    const checkStatus = (res: Response) => {
      if (res.ok) {
        return res;
      } else {
        throw new HTTPResponseError(res);
      }
    };

    let response: Response;
    try {
      response = await fetch(url);
      checkStatus(response);
    } catch (error) {
      try {
        const err = error as HTTPResponseError;
        const errorBody = await err.response.text();
        console.error(`Error body: ${errorBody}`);
        return Promise.reject("Failed to fetch HTTP response.");
      } catch (e) {
        console.error('Error ... even failed to fetch error body: ', e);
        return Promise.reject("Failed to fetch over HTTP");
      }
    }
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
      await this.updateCache(cmd.name, cmd);
  }


  // Get a list of the command bundle `kind`.
  // This is used for removal of bundled commands.
  public async fetchList(kind = 'bio'): Promise<string[]> {
    console.log("[CacheFetcher.fetchList] Started running...");
    const url = `https://raw.githubusercontent.com/yamaton/h2o-curated-data/main/${kind}.txt`;
    const checkStatus = (res: Response) => {
      if (res.ok) {
        return res;
      } else {
        throw new HTTPResponseError(res);
      }
    };

    let response: Response;
    try {
      response = await fetch(url);
      checkStatus(response);
    } catch (error) {
      try {
        const err = error as HTTPResponseError;
        const errorBody = await err.response.text();
        console.error(`Error body: ${errorBody}`);
        return Promise.reject("Failed to fetch HTTP response.");
      } catch (e) {
        console.error('Error ... even failed to fetch error body: ', e);
        return Promise.reject("Failed to fetch over HTTP");
      }
    }
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
