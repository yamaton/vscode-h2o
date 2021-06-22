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
  let path = vscode.workspace.getConfiguration('h2o').get('h2oPath') as string;
  if (path === '<bundled>') {
    if (process.platform === 'linux') {
      path = `${__dirname}/../bin/h2o-x86_64-unknown-linux`;
    } else if (process.platform === 'darwin') {
      path = `${__dirname}/../bin/h2o-x86_64-apple-darwin`;
    } else {
      if (neverNotifiedError) {
        const msg = "Bundled H2O supports only Linux and MacOS. Please set the H2O path in the configuration.";
        vscode.window.showErrorMessage(msg);
      }
      neverNotifiedError = false;
      return;
    }
  }

  console.log(`[CacheFetcher.runH2o] spawning h2o: ${name}`);
  const proc = spawnSync(path, ['--command', name, '--json']);
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
  private registeredCommands: Set<string>;

  constructor(memento: Memento) {
    this.memento = memento;
    this.registeredCommands = new Set<string>([]);
  }

  async init() {
    const existing = this.getBag();

    // if (!existing || existing.size === 0) {
    console.log("---------------------------------------");
    console.log("              INIT");
    console.log("---------------------------------------");
    this.registeredCommands = new Set<string>(["nanachi"]);
    await this.updateBag();
    // } else {
    //   console.log("---------------------------------------");
    //   console.log("              LOAD");
    //   console.log(existing.size);
    //   console.log("---------------------------------------");
    //   this.registeredCommands = existing;
    // }
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

    console.log(`set = `, this.registeredCommands);
    if (command === undefined) {
      console.log(`--------newSet.delete ... doing nothing: ${name}---------`);
      this.registeredCommands.delete(name);
    } else {
      console.log(`--------newSet.add ${name}---------`);
      this.registeredCommands.add(name);
    }

    try {
      await this.updateBag();
      console.log("[set update] done update");
      console.log("[set update] ", this.registeredCommands);
      console.log("[set update] ", this.getBag());
    } catch (e) {
      console.log("Failed to update command set: ", e);
    }

    await this.memento.update(key, command);
  }

  async fetch(name: string): Promise<Command> {
    if (name.length < 2) {
      return Promise.reject("Command name too short.");
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

  async fetchAllCurated() {
    console.log("[CacheFetcher.fetchAllCurated] Started running...");
    const url = 'https://raw.githubusercontent.com/yamaton/h2o-curated-data/main/all.json.gz';
    const response = await fetch(url);
    const checkStatus = (res: Response) => {
      if (res.ok) {
        return res;
      } else {
        throw new HTTPResponseError(res);
      }
    };

    try {
      checkStatus(response);
    } catch (error) {
      const errorBody = await error.response.text();
      console.error(`Error body: ${errorBody}`);
      return Promise.reject("Failed to fetch HTTP response.");
    }

    let commands: Command[] = [];
    try {
      const s = await response.buffer();
      const decoded = pako.inflate(s, { to: 'string' });
      commands = JSON.parse(decoded) as Command[];
    } catch (err) {
      console.error("[fetchAllCurated] Error: ", err);
      return Promise.reject("Failed to inflate and parse the content as JSON.");
    }

    for (const cmd of commands) {
      const key = CachingFetcher.getKey(cmd.name);
      if (this.get(cmd.name) === undefined) {
        console.log(`[fetchAllCurated] Loading: ${cmd.name}`);
        await this.update(cmd.name, cmd);
      }
    }
  }

  async unset(name: string) {
    await this.update(name, undefined);
    console.log('[CacheFetcher.unset] Unset the key for ... ', name);
  }

  getBag() {
    return this.memento.get<Set<string>>(CachingFetcher.commandListKey);
  }

  private async updateBag() {
    this.memento.update(CachingFetcher.commandListKey, this.registeredCommands);
  }

}