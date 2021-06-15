import * as vscode from 'vscode';
import { Memento } from "vscode";
import { spawn, spawnSync } from 'child_process';
import { Command } from './command';

let neverNotifiedError = true;

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

  async fetchAsync(name: string): Promise<Command> {
    const key = CachingFetcher.getKey(name);
    let cached = this.memento.get(key);
    if (cached !== undefined) {
      console.log('[CacheFetcher.fetch] Fetching from cache: ', name);
      return Promise.resolve(cached as Command);
    }

    console.log('[CacheFetcher.fetch] Getting curated data: ', name);
    const commandP = fetchCurated(name);
    try {
      const command = await commandP;
      this.memento.update(key, command);
      return command;
    } catch (err) {
      console.log("[CacheFetcher.fetch] Failed to get curated data: ", name);
      const command = runH2o(name);
      if (command) {
        this.memento.update(key, command);
        return command;
      } else {
        return Promise.reject(`[CacheFetcher.fetch] Filed to fetch: ${name}`);
      }
    }
  }

  unset(name: string) {
    const key = CachingFetcher.getKey(name);
    this.memento.update(key, undefined).then(() => {
      console.log('[CacheFetcher.unset] Unset the key for ... ', name);
    });
  }
}
