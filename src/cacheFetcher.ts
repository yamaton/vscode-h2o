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

export function runH2o(name: string): Command | undefined {
  let h2opath = vscode.workspace.getConfiguration('h2o').get('h2oPath') as string;
  if (h2opath === '<bundled>') {
    if (process.platform === 'linux') {
      h2opath = `${__dirname}/../bin/h2o-x86_64-unknown-linux`;
    } else if (process.platform === 'darwin') {
      h2opath = `${__dirname}/../bin/h2o-x86_64-apple-darwin`;
    } else {
      if (neverNotifiedError) {
        const msg = "Bundled H2O supports only Linux and MacOS. Please set the H2O path in the configuration.";
        vscode.window.showErrorMessage(msg);
      }
      neverNotifiedError = false;
      return;
    }
  }

  const wrapperPath = `${__dirname}/../bin/wrap-h2o`;
  console.log(`[CacheFetcher.runH2o] spawning h2o: ${name}`);
  const proc = spawnSync(wrapperPath, [h2opath, name]);
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

export class CachingFetcher {
  static readonly keyPrefix = 'h2oFetcher.cache.';
  static readonly commandListKey = 'h2oFetcher.registered.all';
  private memento: Memento;
  private registeredCommands: string[];

  constructor(memento: Memento) {
    this.memento = memento;
    this.registeredCommands = [];
  }

  async init() {
    const existing = this.getList();

    if (!existing || !existing.length || existing.length === 0) {
      console.log("---------------------------------------");
      console.log("              INIT");
      console.log("---------------------------------------");
      this.registeredCommands = [];
      await this.updateList();
      console.log("this.getBag() = ", this.getList());
    } else {
      console.log("---------------------------------------");
      console.log("              LOAD");
      console.log("---------------------------------------");
      this.registeredCommands = existing;
      console.log("this.getBag() = ", this.getList());
    }
  }

  static getKey(name: string): string {
    return CachingFetcher.keyPrefix + name;
  }

  private get(name: string): Command | undefined {
    const key = CachingFetcher.getKey(name);
    return this.memento.get(key);
  }

  private async update(name: string, command: Command | undefined) {
    const key = CachingFetcher.getKey(name);

    console.log(`list = `, this.registeredCommands);
    if (command === undefined) {
      console.log(`--------delete ${name} from the list ---------`);
      this.registeredCommands = this.registeredCommands.filter(x => x !== name);
    } else {
      console.log(`--------add ${name} to the list ---------`);
      this.registeredCommands = this.registeredCommands.filter(x => x !== name);
      this.registeredCommands.push(name);
    }

    try {
      await this.updateList();
      console.log("[list update] done update");
      console.log("[list update] ", this.registeredCommands);
      console.log("[list update] ", this.getList());
    } catch (e) {
      console.log("Failed to update command set: ", e);
    }

    await this.memento.update(key, command);
  }

  async fetch(name: string): Promise<Command> {
    if (name.length < 2) {
      return Promise.reject(`Command name too short: ${name}`);
    }

    let cached = this.get(name);
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
        await this.update(name, command);
      } catch (e) {
        console.log("Failed to update: ", e);
      }
      return command;

    } catch (e) {
      console.log("[CacheFetcher.fetch] Error: ", e);
      return Promise.reject(`[CacheFetcher.fetch] Failed in CacheFetcher.update() with name = ${name}`);
    }
  }

  async fetchAllCurated(kind = 'general', isForcing = false) {
    console.log("[CacheFetcher.fetchAllCurated] Started running...");
    const url = `https://raw.githubusercontent.com/yamaton/h2o-curated-data/main/${kind}.json.gz`;
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
        const errorBody = await error.response.text();
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
      if (isForcing || this.get(cmd.name) === undefined) {
        console.log(`[fetchAllCurated] Loading: ${cmd.name}`);
        await this.update(cmd.name, cmd);
      }
    }
  }

  async fetchList(kind = 'bio'): Promise<string[]> {
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
        const errorBody = await error.response.text();
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

  async unset(name: string) {
    await this.update(name, undefined);
    console.log('[CacheFetcher.unset] Unset the key for ... ', name);
  }

  getList() {
    return this.memento.get<string[]>(CachingFetcher.commandListKey);
  }

  private async updateList() {
    this.memento.update(CachingFetcher.commandListKey, this.registeredCommands);
  }

}
