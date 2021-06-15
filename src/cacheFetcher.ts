import * as vscode from 'vscode';
import { Memento } from 'vscode';
import { spawnSync } from 'child_process';
import { Command } from './command';
import { Response } from 'node-fetch';
import fetch from 'node-fetch';

let neverNotifiedError = true;

class HTTPResponseError extends Error {
  response: Response;
  constructor(res: Response) {
    super(`HTTP Error Response: ${res.status} ${res.statusText}`);
    this.response = res;
  }
}

export async function fetchCurated(name: string): Promise<Command> {
  const url = `https://raw.githubusercontent.com/yamaton/h2o-curated-data/main/json/${name}.json`;
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
    console.error(error);
    const errorBody = await error.response.text();
    console.error(`Error body: ${errorBody}`);
  }

  return await response.json();
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

  fetch(name: string): Command | undefined {
    const key = CachingFetcher.getKey(name);
    let cached = this.memento.get(key);
    if (cached === undefined) {
      console.log('[CacheFetcher.fetch] Fetching from H2O: ', name);
      const command = runH2o(name);
      if (command) {
        this.memento.update(key, command);
        return command;
      } else {
        console.warn(`[CacheFetcher.fetch] Failed to fetch command ${name} from H2O`);
      }
    } else {
      console.log('[CacheFetcher.fetch] Fetching from cache: ', name);
    }

    return cached as Command;
  }

  unset(name: string) {
    const key = CachingFetcher.getKey(name);
    this.memento.update(key, undefined).then(() => {
      console.log('[CacheFetcher.unset] Unset the key for ... ', name);
    });
  }
}
