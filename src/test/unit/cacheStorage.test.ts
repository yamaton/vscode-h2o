import * as assert from 'assert';
import { gzipSync } from 'zlib';
import {
  CacheFileSystem,
  CommandCacheSnapshot,
  GzipCommandCacheStorage,
  InvalidCommandCacheSnapshotError,
  commandCacheSnapshotVersion,
  decodeCommandBundle,
  decodeCommandCacheSnapshot,
  encodeCommandCacheSnapshot,
  validateCommands,
} from '../../cacheStorage';
import { Command } from '../../command';

function command(name: string, description = name): Command {
  return { name, description, options: [] };
}

class FakeFileSystem implements CacheFileSystem<string> {
  public readonly files = new Map<string, Uint8Array>();
  public readonly operations: string[] = [];
  public renameError: Error | undefined;
  public readError: Error | undefined;
  public writeError: Error | undefined;
  public deleteError: Error | undefined;
  public beforeRename: () => Promise<void> = async () => undefined;

  public async createDirectory(uri: string): Promise<void> {
    this.operations.push(`mkdir:${uri}`);
  }

  public async delete(uri: string): Promise<void> {
    this.operations.push(`delete:${uri}`);
    if (this.deleteError) {
      throw this.deleteError;
    }
    if (!this.files.delete(uri)) {
      throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
    }
  }

  public async readFile(uri: string): Promise<Uint8Array> {
    this.operations.push(`read:${uri}`);
    if (this.readError) {
      throw this.readError;
    }
    const content = this.files.get(uri);
    if (!content) {
      throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
    }
    return content;
  }

  public async writeFile(uri: string, content: Uint8Array): Promise<void> {
    this.operations.push(`write:${uri}`);
    this.files.set(uri, content);
    if (this.writeError) {
      throw this.writeError;
    }
  }

  public async rename(source: string, target: string, options: { overwrite: boolean }): Promise<void> {
    this.operations.push(`rename:${source}:${target}:${options.overwrite}`);
    await this.beforeRename();
    if (this.renameError) {
      throw this.renameError;
    }
    const content = this.files.get(source);
    if (!content) {
      throw new Error('rename source is missing');
    }
    this.files.set(target, content);
    this.files.delete(source);
  }
}

suite('command cache storage', () => {
  test('round-trips a versioned gzip snapshot', async () => {
    const snapshot: CommandCacheSnapshot = {
      version: commandCacheSnapshotVersion,
      commands: [command('git'), command('npm')],
    };

    const encoded = await encodeCommandCacheSnapshot(snapshot);
    assert.deepStrictEqual(await decodeCommandCacheSnapshot(encoded), snapshot);
  });

  test('validates command bundles and rejects invalid cache content', async () => {
    const invalidVersion = gzipSync(JSON.stringify({ version: 2, commands: [] }));
    await assert.rejects(decodeCommandCacheSnapshot(invalidVersion), /unsupported schema version/);
    await assert.rejects(decodeCommandCacheSnapshot(Buffer.from('not gzip')));
    assert.throws(() => validateCommands([command('git'), command('git')]), /duplicate command/);
    assert.throws(() => validateCommands([{ ...command('git'), options: [null] }]), /invalid command/);
    assert.throws(() => validateCommands([{ ...command('git'), subcommands: 'invalid' }]), /invalid command/);
    assert.throws(() => validateCommands([{
      ...command('git'),
      subcommands: [{ ...command('commit'), aliases: ['ci', 1] }],
    }]), /invalid command/);

    const commandBundle = gzipSync(JSON.stringify([command('git')]));
    const decoded = await decodeCommandBundle(commandBundle);
    assert.deepStrictEqual(decoded, [command('git')]);
    assert.strictEqual(Object.isFrozen(decoded[0]), true);
    assert.strictEqual(Object.isFrozen(decoded[0].options), true);
  });

  test('preserves and recursively freezes modeled and unmodeled JSON fields', async () => {
    const extended = {
      ...command('adb'),
      version: 'Android Debug Bridge version 1.0.41',
      positionalArguments: [{ name: 'HOST[:PORT]', description: 'target' }],
      // eslint-disable-next-line @typescript-eslint/naming-convention
      __meta__: { date: '2022-05-09' },
      futureField: { nested: ['before'] },
    };

    const commands = validateCommands([extended]);
    assert.deepStrictEqual(commands, [extended]);
    assert.strictEqual(Object.isFrozen(extended), true);
    assert.strictEqual(Object.isFrozen(extended.positionalArguments), true);
    assert.strictEqual(Object.isFrozen(extended.positionalArguments[0]), true);
    assert.strictEqual(Object.isFrozen(extended.__meta__), true);
    assert.strictEqual(Object.isFrozen(extended.futureField), true);
    assert.strictEqual(Object.isFrozen(extended.futureField.nested), true);
    assert.throws(() => {
      extended.positionalArguments[0].description = 'mutated';
    }, TypeError);
    assert.throws(() => {
      extended.futureField.nested[0] = 'mutated';
    }, TypeError);

    const encoded = await encodeCommandCacheSnapshot({ version: commandCacheSnapshotVersion, commands });
    const restored = await decodeCommandCacheSnapshot(encoded);
    assert.deepStrictEqual(restored.commands, [extended]);
    const restoredExtended = restored.commands[0] as Command & { futureField: { nested: string[] } };
    assert.strictEqual(Object.isFrozen(restoredExtended.futureField), true);
    assert.strictEqual(Object.isFrozen(restoredExtended.futureField.nested), true);
  });

  test('rejects values that cannot be preserved as JSON', () => {
    assert.throws(
      () => validateCommands([{ ...command('git'), futureField: BigInt(1) }]),
      /non-JSON-compatible value/,
    );
    assert.throws(
      () => validateCommands([{ ...command('git'), futureField: Number.NaN }]),
      /non-finite number/,
    );

    const cyclic = { ...command('git'), futureField: {} as Record<string, unknown> };
    cyclic.futureField['cycle'] = cyclic;
    assert.throws(() => validateCommands([cyclic]), /cyclic value/);

    const sparse = { ...command('git'), futureField: new Array(1) };
    assert.throws(() => validateCommands([sparse]), /sparse array/);

    let accessorValue = 'before';
    const accessor = { ...command('git') } as Command & { futureField?: string };
    Object.defineProperty(accessor, 'futureField', {
      enumerable: true,
      get: () => accessorValue,
    });
    assert.throws(() => validateCommands([accessor]), /non-JSON-compatible property/);
    accessorValue = 'after';
    assert.strictEqual(accessor.futureField, 'after');
  });

  test('returns undefined only when the snapshot is absent', async () => {
    const fileSystem = new FakeFileSystem();
    const storage = new GzipCommandCacheStorage(fileSystem, {
      directory: 'cache',
      snapshot: 'cache/commands-v1.json.gz',
      temporary: () => 'cache/commands-v1.json.gz.tmp',
    });

    assert.strictEqual(await storage.load(), undefined);
    fileSystem.files.set('cache/commands-v1.json.gz', Buffer.from('not gzip'));
    await assert.rejects(storage.load(), InvalidCommandCacheSnapshotError);
  });

  test('recognizes provider and Node missing-file error representations', async () => {
    const missingErrors = [
      Object.assign(new Error('missing'), { name: 'FileNotFound' }),
      Object.assign(new Error('missing'), { name: 'EntryNotFound (FileSystemError)' }),
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    ];

    for (const readError of missingErrors) {
      const fileSystem = new FakeFileSystem();
      fileSystem.readError = readError;
      const storage = new GzipCommandCacheStorage(fileSystem, {
        directory: 'cache',
        snapshot: 'cache/commands-v1.json.gz',
        temporary: () => 'cache/commands-v1.json.gz.tmp',
      });
      assert.strictEqual(await storage.load(), undefined);
    }
  });

  test('writes through a temporary file before replacing the snapshot', async () => {
    const fileSystem = new FakeFileSystem();
    const storage = new GzipCommandCacheStorage(fileSystem, {
      directory: 'cache',
      snapshot: 'cache/commands-v1.json.gz',
      temporary: () => 'cache/commands-v1.json.gz.tmp',
    });
    const snapshot: CommandCacheSnapshot = {
      version: commandCacheSnapshotVersion,
      commands: [command('git')],
    };

    await storage.save(snapshot);

    assert.deepStrictEqual(fileSystem.operations, [
      'mkdir:cache',
      'write:cache/commands-v1.json.gz.tmp',
      'rename:cache/commands-v1.json.gz.tmp:cache/commands-v1.json.gz:true',
    ]);
    assert.deepStrictEqual(await storage.load(), snapshot);
  });

  test('keeps the previous snapshot when replacement fails', async () => {
    const fileSystem = new FakeFileSystem();
    const storage = new GzipCommandCacheStorage(fileSystem, {
      directory: 'cache',
      snapshot: 'cache/commands-v1.json.gz',
      temporary: () => 'cache/commands-v1.json.gz.tmp',
    });
    const previous: CommandCacheSnapshot = {
      version: commandCacheSnapshotVersion,
      commands: [command('git', 'previous')],
    };
    await storage.save(previous);
    fileSystem.renameError = new Error('controlled rename failure');

    await assert.rejects(storage.save({
      version: commandCacheSnapshotVersion,
      commands: [command('git', 'next')],
    }), /controlled rename failure/);

    fileSystem.renameError = undefined;
    assert.deepStrictEqual(await storage.load(), previous);
    assert.strictEqual(fileSystem.files.has('cache/commands-v1.json.gz.tmp'), false);
    assert.ok(fileSystem.operations.includes('delete:cache/commands-v1.json.gz.tmp'));
  });

  test('deletes a partially written temporary snapshot and preserves the primary error', async () => {
    const fileSystem = new FakeFileSystem();
    const storage = new GzipCommandCacheStorage(fileSystem, {
      directory: 'cache',
      snapshot: 'cache/commands-v1.json.gz',
      temporary: () => 'cache/commands-v1.json.gz.tmp',
    });
    const writeError = new Error('controlled partial write failure');
    fileSystem.writeError = writeError;

    await assert.rejects(
      storage.save({ version: commandCacheSnapshotVersion, commands: [command('git')] }),
      error => error === writeError,
    );

    assert.strictEqual(fileSystem.files.has('cache/commands-v1.json.gz.tmp'), false);
    assert.deepStrictEqual(fileSystem.operations, [
      'mkdir:cache',
      'write:cache/commands-v1.json.gz.tmp',
      'delete:cache/commands-v1.json.gz.tmp',
    ]);
  });

  test('preserves the primary save error if temporary cleanup also fails', async () => {
    const fileSystem = new FakeFileSystem();
    const storage = new GzipCommandCacheStorage(fileSystem, {
      directory: 'cache',
      snapshot: 'cache/commands-v1.json.gz',
      temporary: () => 'cache/commands-v1.json.gz.tmp',
    });
    const renameError = new Error('controlled rename failure');
    fileSystem.renameError = renameError;
    fileSystem.deleteError = new Error('controlled cleanup failure');

    await assert.rejects(
      storage.save({ version: commandCacheSnapshotVersion, commands: [command('git')] }),
      error => error === renameError,
    );

    assert.strictEqual(fileSystem.files.has('cache/commands-v1.json.gz.tmp'), true);
  });

  test('uses a distinct temporary file for overlapping saves', async () => {
    const fileSystem = new FakeFileSystem();
    let temporaryId = 0;
    const storage = new GzipCommandCacheStorage(fileSystem, {
      directory: 'cache',
      snapshot: 'cache/commands-v1.json.gz',
      temporary: () => `cache/commands-v1.json.gz.${temporaryId += 1}.tmp`,
    });
    let renameCount = 0;
    let releaseRenames!: () => void;
    const bothRenamesStarted = new Promise<void>(resolve => {
      releaseRenames = resolve;
    });
    fileSystem.beforeRename = async () => {
      renameCount += 1;
      if (renameCount === 2) {
        releaseRenames();
      }
      await bothRenamesStarted;
    };

    await Promise.all([
      storage.save({ version: commandCacheSnapshotVersion, commands: [command('git')] }),
      storage.save({ version: commandCacheSnapshotVersion, commands: [command('npm')] }),
    ]);

    const writes = fileSystem.operations.filter(operation => operation.startsWith('write:'));
    assert.strictEqual(new Set(writes).size, 2);
    const stored = await storage.load();
    assert.ok(stored?.commands[0].name === 'git' || stored?.commands[0].name === 'npm');
  });
});
