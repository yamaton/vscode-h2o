import * as assert from 'assert';

import type { CommandCacheSnapshot } from '../../cacheStorage';
import type { Command } from '../../command';

// Keep the performance child independent from extension implementation modules:
// importing cacheStorage before extension.activate() would warm the module cache
// and understate cold-activation cost. A unit test guards this format version
// against the production cache codec.
const fixtureCommandCacheSnapshotVersion = 1;

export type ActivationProfile = 'empty' | 'general' | 'general-bio';

export interface ActivationFixtureSnapshot {
  snapshot: CommandCacheSnapshot;
  jsonBytes: number;
}

function generatedCommand(index: number): Command {
  const name = `fixture-command-${String(index).padStart(4, '0')}`;
  return {
    name,
    description: `Generated activation fixture ${name}`,
    options: Array.from({ length: 8 }, (_, optionIndex) => ({
      names: [`--option-${optionIndex}`],
      argument: optionIndex % 2 === 0 ? 'VALUE' : '',
      description: `Generated option ${optionIndex} for ${name}`,
    })),
    positionalArguments: [
      { name: 'input', description: `Input for ${name}` },
      { name: 'output', description: `Output for ${name}` },
    ],
    subcommands: Array.from({ length: 2 }, (_, subcommandIndex) => ({
      name: `subcommand-${subcommandIndex}`,
      description: `Generated subcommand ${subcommandIndex} for ${name}`,
      options: Array.from({ length: 3 }, (_, optionIndex) => ({
        names: [`--sub-option-${optionIndex}`],
        argument: '',
        description: `Generated subcommand option ${optionIndex}`,
      })),
    })),
  };
}

function deterministicFiller(length: number, seed: number): string {
  const content = Buffer.allocUnsafe(length);
  let state = (seed + 1) * 0x9e3779b1;
  let current = 97 + ((state >>> 0) % 2);
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    if (((state >>> 0) & 3) === 0) {
      current = current === 97 ? 98 : 97;
    }
    content[index] = current;
  }
  return content.toString('ascii');
}

export function createActivationFixtureSnapshot(
  profile: ActivationProfile,
): ActivationFixtureSnapshot {
  if (profile === 'empty') {
    return {
      snapshot: { version: fixtureCommandCacheSnapshotVersion, commands: [] },
      jsonBytes: 0,
    };
  }
  const commandCount = profile === 'general' ? 411 : 1017;
  const targetJsonBytes = profile === 'general' ? 11_811_096 : 20_283_379;
  const commands = Array.from({ length: commandCount }, (_, index) => generatedCommand(index));
  const snapshot: CommandCacheSnapshot = {
    version: fixtureCommandCacheSnapshotVersion,
    commands,
  };
  const initialBytes = Buffer.byteLength(JSON.stringify(snapshot));
  assert.ok(initialBytes < targetJsonBytes, `${profile} generated fixture exceeds its target size`);
  let remaining = targetJsonBytes - initialBytes;
  for (let index = 0; index < commands.length; index += 1) {
    const addition = Math.floor(remaining / (commands.length - index));
    commands[index].description += deterministicFiller(addition, index);
    remaining -= addition;
  }
  assert.strictEqual(remaining, 0);
  assert.strictEqual(Buffer.byteLength(JSON.stringify(snapshot)), targetJsonBytes);
  return { snapshot, jsonBytes: targetJsonBytes };
}
