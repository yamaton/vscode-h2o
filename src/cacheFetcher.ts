import { Memento } from "vscode";
import { spawn, spawnSync } from 'child_process';
import { Command } from './command';

export function runH2o(name: string): Command | undefined {
  console.log('spawning h2o: ', name);
  const process = spawnSync('h2o', ['--command', name, '--json']);
  const out = process.stdout;
  console.log('got output: ', out);
  if (out) {
    const command = JSON.parse(out);
    if (command) {
      return command;
    } else {
      console.warn('Failed to parsing H2O result as JSON: ', name);
    }
  } else {
    console.warn('Failed to get H2O result: ', name);
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
      console.log('Fetching from H2O: ', name);
      const command = runH2o(name);
      if (command) {
        this.memento.update(key, command);
        return command;
      } else {
        console.warn('Failed to get command from H2O');
      }
    } else {
      console.log('Returning from memento: ', name);
    }

    return cached as Command;
  }

  unset(name: string) {
    const key = CachingFetcher.getKey(name);
    this.memento.update(key, undefined).then(() => {
      console.log('Unset the key for ... ', name);
    });
  }
}
