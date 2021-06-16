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
  const out = proc.stdout;
  console.log(`[CacheFetcher.runH2o] got output for ${name}: ${out}`);
  if (out) {
    const command = JSON.parse(out);
    if (command) {
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
  private memento: Memento;

  constructor(memento: Memento) {
    this.memento = memento;
  }

  static getKey(name: string): string {
    return CachingFetcher.keyPrefix + name;
  }

  private get(name: string): Command | undefined {
    const key = CachingFetcher.getKey(name);
    return this.memento.get(key);
  }

  private update(name: string, command: Command | undefined) {
    const key = CachingFetcher.getKey(name);
    return this.memento.update(key, command);
  }

  fetch(name: string): Command | undefined {
    if (name.length < 2) {
      return;
    }

    let cached = this.get(name);
    if (cached === undefined) {
      console.log('[CacheFetcher.fetch] Fetching from H2O: ', name);
      const command = runH2o(name);
      if (command) {
        this.update(name, command);
        return command;
      } else {
        console.warn(`[CacheFetcher.fetch] Failed to fetch command ${name} from H2O`);
      }
    } else {
      console.log('[CacheFetcher.fetch] Fetching from cache: ', name);
    }

    return cached as Command;
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
      return;
    }

    let commands: Command[] = [];
    try {
      const s = await response.buffer();
      const decoded = pako.inflate(s, { to: 'string' });
      commands = JSON.parse(decoded) as Command[];
    } catch (err) {
      console.log("[fetchAllCurated] Error: ", err);
    }

    for (const cmd of commands) {
      const key = CachingFetcher.getKey(cmd.name);
      if (this.get(cmd.name) === undefined) {
        console.log(`[fetchAllCurated] Loading: ${cmd.name}`);
        this.update(cmd.name, cmd);
      }
    }
  }

  unset(name: string) {
    this.update(name, undefined);
    console.log('[CacheFetcher.unset] Unset the key for ... ', name);
  }
}
