import * as assert from 'assert';
import { Command } from '../../command';
import {
  CommandPathResolution,
  getDirectSubcommandLabels,
  resolveCommandPath,
} from '../../commandResolver';

interface TestWord {
  text: string;
  ordinal: number;
}

function command(name: string, subcommands: Command[] = [], aliases?: string[]): Command {
  return { name, description: name, options: [], subcommands, aliases };
}

function words(...texts: string[]): TestWord[] {
  return texts.map((text, ordinal) => ({ text, ordinal }));
}

function names(resolution: CommandPathResolution<TestWord>): string[] {
  return resolution.path.map(node => node.name);
}

suite('command path resolver', () => {
  const docker = command('docker', [
    command('run'),
    command('build'),
    command('builder', [
      command('imagetools', [command('create')]),
    ]),
    command('trust', [
      command('key', [command('load')]),
      command('signer', [command('add'), command('remove')]),
    ]),
  ]);

  test('consumes each source word once against direct children', () => {
    assert.deepStrictEqual(
      names(resolveCommandPath(docker, words('builder', 'imagetools', 'create'))),
      ['docker', 'builder', 'imagetools', 'create'],
    );
    assert.deepStrictEqual(
      names(resolveCommandPath(docker, words('trust', 'add', 'signer'))),
      ['docker', 'trust'],
    );
    assert.deepStrictEqual(
      names(resolveCommandPath(docker, words('trust', 'signer', 'add', 'remove'))),
      ['docker', 'trust', 'signer', 'add'],
    );
  });

  test('does not promote a later sibling after a subcommand or positional', () => {
    const sibling = resolveCommandPath(docker, words('run', 'build'));
    assert.deepStrictEqual(names(sibling), ['docker', 'run']);
    assert.strictEqual(sibling.stopReason, 'unresolved-word');

    const positional = resolveCommandPath(docker, words('run', 'alpine', 'build'));
    assert.deepStrictEqual(names(positional), ['docker', 'run']);
    assert.strictEqual(positional.stopReason, 'unresolved-word');
  });

  test('ignores option-looking words without guessing their arity', () => {
    assert.deepStrictEqual(
      names(resolveCommandPath(docker, words('--verbose', 'run'))),
      ['docker', 'run'],
    );
    assert.deepStrictEqual(
      names(resolveCommandPath(docker, words('builder', '-q', 'imagetools'))),
      ['docker', 'builder', 'imagetools'],
    );
  });

  test('stops at the explicit end-of-options marker', () => {
    const resolution = resolveCommandPath(docker, words('--', 'run'));
    assert.deepStrictEqual(names(resolution), ['docker']);
    assert.strictEqual(resolution.stopReason, 'end-of-options');
  });

  test('resolves aliases to their canonical child', () => {
    const build = command('build', [], ['b']);
    const cargo = command('cargo', [build]);
    const source = words('b');

    const resolution = resolveCommandPath(cargo, source);

    assert.deepStrictEqual(resolution.path, [cargo, build]);
    assert.deepStrictEqual(resolution.steps, [{
      command: build,
      source: source[0],
      matchedBy: 'alias',
    }]);
  });

  test('prefers one canonical match over aliases with the same spelling', () => {
    const aliasOwner = command('canonical', [], ['shared']);
    const canonical = command('shared');
    const root = command('tool', [aliasOwner, canonical]);

    const resolution = resolveCommandPath(root, words('shared'));

    assert.strictEqual(resolution.path[1], canonical);
    assert.strictEqual(resolution.steps[0].matchedBy, 'canonical');
  });

  test('does not choose between ambiguous sibling labels', () => {
    const duplicateNames = command('tool', [command('same'), command('same')]);
    const canonicalCollision = resolveCommandPath(duplicateNames, words('same'));
    assert.deepStrictEqual(names(canonicalCollision), ['tool']);
    assert.strictEqual(canonicalCollision.stopReason, 'unresolved-word');

    const duplicateAliases = command('tool', [
      command('first', [], ['short']),
      command('second', [], ['short']),
    ]);
    const aliasCollision = resolveCommandPath(duplicateAliases, words('short'));
    assert.deepStrictEqual(names(aliasCollision), ['tool']);
    assert.strictEqual(aliasCollision.stopReason, 'unresolved-word');
  });

  test('lists only labels that resolve under canonical and alias precedence', () => {
    const canonical = command('shared');
    const aliasOwner = command('canonical', [], ['shared']);
    const first = command('first', [], ['short']);
    const second = command('second', [], ['short']);
    const root = command('tool', [aliasOwner, canonical, first, second]);

    const labels = getDirectSubcommandLabels(root);

    assert.deepStrictEqual(
      labels.map(label => [label.spelling, label.command.name, label.matchedBy]),
      [
        ['canonical', 'canonical', 'canonical'],
        ['shared', 'shared', 'canonical'],
        ['first', 'first', 'canonical'],
        ['second', 'second', 'canonical'],
      ],
    );
  });

  test('records the exact source word that caused each transition', () => {
    const nestedAdd = command('add', [command('leaf')]);
    const bun = command('bun', [nestedAdd]);
    const source = words('add', 'add');

    const resolution = resolveCommandPath(bun, source);

    assert.deepStrictEqual(names(resolution), ['bun', 'add']);
    assert.strictEqual(resolution.steps.length, 1);
    assert.strictEqual(resolution.steps[0].source, source[0]);
    assert.notStrictEqual(resolution.steps[0].source, source[1]);
  });

  test('does not mutate the command tree', () => {
    const root = command('tool', [command('child', [], ['c'])]);
    const before = JSON.stringify(root);

    resolveCommandPath(root, words('c'));

    assert.strictEqual(JSON.stringify(root), before);
  });
});
