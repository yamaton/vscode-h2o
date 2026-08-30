import * as assert from 'assert';
import type { Memento } from 'vscode';
import { Response } from 'node-fetch';
import { gzipSync } from 'zlib';
import {
  CachingFetcher as DefaultDisabledCachingFetcher,
  CachingFetcherDependencies,
  CommandFetchCancelledError,
  UnknownCommandScanDisabledError,
} from '../../cacheFetcher';
import {
  CommandCacheSnapshot,
  CommandCacheStorage,
  InvalidCommandCacheSnapshotError,
  commandCacheSnapshotVersion,
} from '../../cacheStorage';
import { Command } from '../../command';
import {
  H2oRuntime,
  ProcessExecutionError,
  ProcessExecutionOptions,
  ProcessOutput,
  runH2o,
} from '../../h2oRunner';

type BeforeMementoUpdate = (key: string, value: unknown) => Promise<void>;

class FakeMemento implements Memento {
  private readonly values: Map<string, unknown>;
  public readonly getCalls: string[] = [];
  public readonly updateCalls: string[] = [];
  public readonly updateErrors = new Map<string, Error>();

  constructor(
    entries: Array<[string, unknown]> = [],
    private readonly beforeUpdate: BeforeMementoUpdate = async () => undefined,
  ) {
    this.values = new Map(entries);
  }

  public keys(): readonly string[] {
    return [...this.values.keys()];
  }

  public get<T>(key: string): T | undefined;
  public get<T>(key: string, defaultValue: T): T;
  public get<T>(key: string, defaultValue?: T): T | undefined {
    this.getCalls.push(key);
    return this.values.has(key) ? this.values.get(key) as T : defaultValue;
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.updateCalls.push(key);
    await this.beforeUpdate(key, value);
    const error = this.updateErrors.get(key);
    if (error) {
      throw error;
    }
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
  }
}

// Most cache tests exercise local scanning itself. Make that opt-in explicit
// in the test fixture while retaining the production class for default-policy
// coverage.
class CachingFetcher extends DefaultDisabledCachingFetcher {
  constructor(
    memento: Memento,
    dependencies: Partial<CachingFetcherDependencies> = {},
  ) {
    super(memento, dependencies);
    this.setScanUnknownCommands(true);
  }
}

function cloneSnapshot(snapshot: CommandCacheSnapshot): CommandCacheSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as CommandCacheSnapshot;
}

class FakeCacheStorage implements CommandCacheStorage {
  public readonly saves: CommandCacheSnapshot[] = [];
  public readonly saveAttempts: CommandCacheSnapshot[] = [];
  public beforeSave: (snapshot: CommandCacheSnapshot) => Promise<void> = async () => undefined;
  public readonly saveErrors: Error[] = [];
  public loadError: Error | undefined;

  constructor(public stored: CommandCacheSnapshot | undefined = undefined) {}

  public async load(): Promise<CommandCacheSnapshot | undefined> {
    if (this.loadError) {
      throw this.loadError;
    }
    return this.stored ? cloneSnapshot(this.stored) : undefined;
  }

  public async save(snapshot: CommandCacheSnapshot): Promise<void> {
    const saved = cloneSnapshot(snapshot);
    this.saveAttempts.push(saved);
    await this.beforeSave(saved);
    const error = this.saveErrors.shift();
    if (error) {
      throw error;
    }
    this.saves.push(saved);
    this.stored = saved;
  }
}

function command(name: string, description = name): Command {
  return { name, description, options: [] };
}

function dependencies(overrides: Partial<CachingFetcherDependencies> = {}): Partial<CachingFetcherDependencies> {
  return {
    fetch: async () => new Response('', { status: 200 }),
    runLocalCommand: async () => undefined,
    cacheStorage: new FakeCacheStorage(),
    ...overrides,
  };
}

function responseWithGzip(commands: Command[]): Response {
  return new Response(gzipSync(JSON.stringify(commands)), { status: 200 });
}

class FakeCancellationToken {
  public isCancellationRequested = false;
  private readonly listeners = new Set<() => void>();

  public readonly onCancellationRequested = (listener: () => void): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  public cancel(): void {
    this.isCancellationRequested = true;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForAsyncCondition(
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (!(await condition())) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Condition was not met within ${timeoutMs} ms`);
    }
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

suite('CachingFetcher', () => {
  test('starts with unknown-command scans disabled', async () => {
    let localCalls = 0;
    const fetcher = new DefaultDisabledCachingFetcher(new FakeMemento(), dependencies({
      runLocalCommand: async name => {
        localCalls += 1;
        return command(name, 'local');
      },
    }));
    await fetcher.init();

    await assert.rejects(
      fetcher.fetch('git'),
      error => error instanceof UnknownCommandScanDisabledError,
    );
    assert.strictEqual(localCalls, 0);
  });

  test('loads cached commands without invoking H2O', async () => {
    const cached = command('git', 'cached');
    const storage = new FakeCacheStorage({
      version: commandCacheSnapshotVersion,
      commands: [cached],
    });
    let localCalls = 0;
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      runLocalCommand: async () => {
        localCalls += 1;
        return command('git', 'local');
      },
    }));
    await fetcher.init();

    assert.deepStrictEqual(await fetcher.fetch('git'), cached);
    assert.strictEqual(localCalls, 0);
  });

  test('uses cached commands without scanning when unknown-command scans are disabled', async () => {
    const cached = command('git', 'cached');
    const storage = new FakeCacheStorage({
      version: commandCacheSnapshotVersion,
      commands: [cached],
    });
    let localCalls = 0;
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      runLocalCommand: async name => {
        localCalls += 1;
        return command(name, 'local');
      },
    }));
    await fetcher.init();
    fetcher.setScanUnknownCommands(false);

    assert.deepStrictEqual(await fetcher.fetch('git'), cached);
    await assert.rejects(
      fetcher.fetch('npm'),
      error => error instanceof UnknownCommandScanDisabledError,
    );
    assert.strictEqual(localCalls, 0);
    assert.strictEqual(storage.saves.length, 0);
  });

  test('uses newly available curated commands without scanning when scans are disabled', async () => {
    let localCalls = 0;
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      fetch: async () => responseWithGzip([command('git', 'curated')]),
      runLocalCommand: async name => {
        localCalls += 1;
        return command(name, 'local');
      },
    }));
    await fetcher.init();
    fetcher.setScanUnknownCommands(false);

    const initialFetch = fetcher.startInitialCuratedFetch();
    assert.deepStrictEqual(await fetcher.fetch('git'), command('git', 'curated'));
    await initialFetch;
    assert.strictEqual(localCalls, 0);
  });

  test('scans a later cache miss after unknown-command scans are re-enabled', async () => {
    let localCalls = 0;
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      runLocalCommand: async name => {
        localCalls += 1;
        return command(name, 'local');
      },
    }));
    await fetcher.init();
    fetcher.setScanUnknownCommands(false);

    await assert.rejects(
      fetcher.fetch('git'),
      error => error instanceof UnknownCommandScanDisabledError,
    );
    fetcher.setScanUnknownCommands(true);
    assert.deepStrictEqual(await fetcher.fetch('git'), command('git', 'local'));
    assert.strictEqual(localCalls, 1);
  });

  test('aborts a running scan and rejects queued scans when scans are disabled', async () => {
    const scans = new Map<string, ReturnType<typeof deferred<Command | undefined>>>();
    const signals = new Map<string, AbortSignal>();
    const invocations: string[] = [];
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      runLocalCommand: (name, signal) => {
        invocations.push(name);
        signals.set(name, signal);
        const scan = deferred<Command | undefined>();
        scans.set(name, scan);
        signal.addEventListener('abort', () => scan.resolve(undefined), { once: true });
        return scan.promise;
      },
    }));
    await fetcher.init();

    const running = fetcher.fetch('git');
    const queued = fetcher.fetch('npm');
    const runningRejection = assert.rejects(
      running,
      error => error instanceof UnknownCommandScanDisabledError,
    );
    const queuedRejection = assert.rejects(
      queued,
      error => error instanceof UnknownCommandScanDisabledError,
    );
    assert.deepStrictEqual(invocations, ['git']);

    fetcher.setScanUnknownCommands(false);
    assert.strictEqual(signals.get('git')?.aborted, true);
    await Promise.all([runningRejection, queuedRejection]);
    assert.deepStrictEqual(invocations, ['git']);
    assert.deepStrictEqual(fetcher.getList(), []);
  });

  test('deletes legacy Memento state concurrently without reading payloads', async () => {
    let releaseUpdates!: () => void;
    const updateGate = new Promise<void>(resolve => {
      releaseUpdates = resolve;
    });
    const legacyGit = CachingFetcher.getKey('git');
    const memento = new FakeMemento([
      [legacyGit, command('git', 'legacy')],
      [CachingFetcher.commandListKey, ['git']],
      ['unrelated.setting', true],
    ], () => updateGate);
    const snapshotGit = command('git', 'snapshot');
    const storage = new FakeCacheStorage({
      version: commandCacheSnapshotVersion,
      commands: [snapshotGit],
    });
    const fetcher = new CachingFetcher(memento, dependencies({ cacheStorage: storage }));

    const initialization = fetcher.init();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepStrictEqual(new Set(memento.updateCalls), new Set([legacyGit, CachingFetcher.commandListKey]));
    assert.deepStrictEqual(memento.getCalls, []);

    releaseUpdates();
    await initialization;
    assert.deepStrictEqual(memento.keys(), ['unrelated.setting']);
    assert.deepStrictEqual(await fetcher.fetch('git'), snapshotGit);
  });

  test('retries legacy cleanup on the next initialization after a deletion failure', async () => {
    const legacyKey = CachingFetcher.getKey('git');
    const memento = new FakeMemento([[legacyKey, command('git', 'legacy')]]);
    memento.updateErrors.set(legacyKey, new Error('controlled deletion failure'));
    const storage = new FakeCacheStorage();

    await new CachingFetcher(memento, dependencies({ cacheStorage: storage })).init();
    assert.deepStrictEqual(memento.keys(), [legacyKey]);

    memento.updateErrors.clear();
    await new CachingFetcher(memento, dependencies({ cacheStorage: storage })).init();
    assert.deepStrictEqual(memento.keys(), []);
  });

  test('repairs an invalid snapshot with a later successful save', async () => {
    const legacyKey = CachingFetcher.getKey('legacy');
    const memento = new FakeMemento([[legacyKey, command('legacy')]]);
    const storage = new FakeCacheStorage();
    storage.loadError = new InvalidCommandCacheSnapshotError(new Error('controlled decode failure'));
    const local = command('git', 'local');
    const fetcher = new CachingFetcher(memento, dependencies({
      cacheStorage: storage,
      runLocalCommand: async () => local,
    }));

    await fetcher.init();
    assert.deepStrictEqual(memento.keys(), []);
    storage.loadError = undefined;
    assert.deepStrictEqual(await fetcher.fetch('git'), local);
    assert.deepStrictEqual(storage.stored?.commands, [local]);
  });

  test('does not overwrite the prior snapshot after a read failure', async () => {
    const previous = command('samtools', 'previous snapshot');
    const storage = new FakeCacheStorage({
      version: commandCacheSnapshotVersion,
      commands: [previous],
    });
    storage.loadError = Object.assign(new Error('controlled read failure'), { code: 'NoPermissions' });
    const local = command('git', 'local');
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      runLocalCommand: async () => local,
    }));

    await fetcher.init();
    assert.deepStrictEqual(await fetcher.fetch('git'), local);

    assert.deepStrictEqual(fetcher.getList(), ['git']);
    assert.deepStrictEqual(storage.stored?.commands, [previous]);
    assert.strictEqual(storage.saveAttempts.length, 0);
  });

  test('publishes local commands immediately and persists them before resolving', async () => {
    let releaseSave!: () => void;
    const saveGate = new Promise<void>(resolve => {
      releaseSave = resolve;
    });
    const storage = new FakeCacheStorage();
    const local = command('git', 'local');
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      runLocalCommand: async () => local,
    }));
    await fetcher.init();
    storage.beforeSave = () => saveGate;

    const pendingFetch = fetcher.fetch('git');
    let settled = false;
    void pendingFetch.then(() => {
      settled = true;
    });
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.strictEqual(settled, false);
    assert.deepStrictEqual(fetcher.getList(), ['git']);
    assert.strictEqual(storage.stored, undefined);

    releaseSave();
    assert.deepStrictEqual(await pendingFetch, local);
    assert.deepStrictEqual((await storage.load())?.commands, [local]);
  });

  test('recovers the save queue after a persistence failure', async () => {
    const storage = new FakeCacheStorage();
    storage.saveErrors.push(new Error('controlled save failure'));
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      runLocalCommand: async name => command(name, 'local'),
    }));
    await fetcher.init();

    assert.deepStrictEqual(await fetcher.fetch('git'), command('git', 'local'));
    assert.strictEqual(storage.stored, undefined);
    assert.deepStrictEqual(await fetcher.fetch('npm'), command('npm', 'local'));
    assert.deepStrictEqual((await storage.load())?.commands, [command('git', 'local'), command('npm', 'local')]);
  });

  test('rejects short and unavailable command names', async () => {
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies());
    await fetcher.init();

    await assert.rejects(fetcher.fetch('x'), /Command name too short/);
    await assert.rejects(fetcher.fetch('missing'), /Failed to fetch command/);
  });

  test('shares one local scan between concurrent fetches for the same command', async () => {
    const scan = deferred<Command | undefined>();
    const storage = new FakeCacheStorage();
    let localCalls = 0;
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      runLocalCommand: async () => {
        localCalls += 1;
        return scan.promise;
      },
    }));
    await fetcher.init();

    const first = fetcher.fetch('git');
    const second = fetcher.fetch('git');
    assert.strictEqual(localCalls, 1);

    const local = command('git', 'local');
    scan.resolve(local);
    assert.deepStrictEqual(await Promise.all([first, second]), [local, local]);
    assert.strictEqual(localCalls, 1);
    assert.strictEqual(storage.saves.length, 1);
  });

  test('runs local scans for different commands one at a time', async () => {
    const scans = new Map<string, ReturnType<typeof deferred<Command | undefined>>>();
    const invocations: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      runLocalCommand: async name => {
        invocations.push(name);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const scan = deferred<Command | undefined>();
        scans.set(name, scan);
        try {
          return await scan.promise;
        } finally {
          active -= 1;
        }
      },
    }));
    await fetcher.init();

    const git = fetcher.fetch('git');
    const npm = fetcher.fetch('npm');
    assert.deepStrictEqual(invocations, ['git']);
    scans.get('git')?.resolve(command('git'));
    assert.deepStrictEqual(await git, command('git'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepStrictEqual(invocations, ['git', 'npm']);
    scans.get('npm')?.resolve(command('npm'));
    assert.deepStrictEqual(await npm, command('npm'));
    assert.strictEqual(maximumActive, 1);
  });

  test('releases one cancelled subscriber while a useful shared scan continues', async () => {
    const scan = deferred<Command | undefined>();
    let localCalls = 0;
    let signal: AbortSignal | undefined;
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      runLocalCommand: (_name, localSignal) => {
        localCalls += 1;
        signal = localSignal;
        return scan.promise;
      },
    }));
    await fetcher.init();

    const token = new FakeCancellationToken();
    const cancelled = fetcher.fetch('git', token);
    const joined = fetcher.fetch('git');
    token.cancel();
    await assert.rejects(cancelled, error => error instanceof Error && error.name === 'CommandFetchCancelledError');
    assert.strictEqual(signal?.aborted, false);

    const local = command('git', 'local');
    scan.resolve(local);
    assert.deepStrictEqual(await joined, local);
    assert.strictEqual(localCalls, 1);
  });

  test('aborts a running scan as soon as its last subscriber cancels', async () => {
    const scans = new Map<string, ReturnType<typeof deferred<Command | undefined>>>();
    const signals = new Map<string, AbortSignal>();
    const invocations: string[] = [];
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      runLocalCommand: (name, signal) => {
        invocations.push(name);
        signals.set(name, signal);
        const scan = deferred<Command | undefined>();
        scans.set(name, scan);
        signal.addEventListener('abort', () => scan.resolve(undefined), { once: true });
        return scan.promise;
      },
    }));
    await fetcher.init();

    const token = new FakeCancellationToken();
    const abandoned = fetcher.fetch('git', token);
    token.cancel();
    await assert.rejects(abandoned, error => error instanceof Error && error.name === 'CommandFetchCancelledError');
    assert.strictEqual(signals.get('git')?.aborted, true);

    const npm = fetcher.fetch('npm');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepStrictEqual(invocations, ['git', 'npm']);
    scans.get('npm')?.resolve(command('npm'));
    assert.deepStrictEqual(await npm, command('npm'));
    assert.deepStrictEqual(fetcher.getList(), ['npm']);
  });

  test('does not resurrect a command unset while its local scan is running', async () => {
    const scan = deferred<Command | undefined>();
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      runLocalCommand: () => scan.promise,
    }));
    await fetcher.init();

    const pending = fetcher.fetch('git');
    await fetcher.unset('git');
    scan.resolve(command('git', 'stale local'));
    await assert.rejects(pending, error => error instanceof Error && error.name === 'CommandFetchCancelledError');
    assert.deepStrictEqual(fetcher.getList(), []);
  });

  test('queues a fresh fetch instead of joining an aborted scan', async () => {
    const scans: Array<ReturnType<typeof deferred<Command | undefined>>> = [];
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      runLocalCommand: async () => {
        const scan = deferred<Command | undefined>();
        scans.push(scan);
        return scan.promise;
      },
    }));
    await fetcher.init();

    const stale = fetcher.fetch('git');
    await fetcher.unset('git');
    const fresh = fetcher.fetch('git');
    assert.strictEqual(scans.length, 1);

    scans[0].resolve(command('git', 'stale'));
    await assert.rejects(stale, error => error instanceof Error && error.name === 'CommandFetchCancelledError');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.strictEqual(scans.length, 2);
    scans[1].resolve(command('git', 'fresh'));
    assert.deepStrictEqual(await fresh, command('git', 'fresh'));
  });

  test('keeps curated data that arrives while a local scan is running', async () => {
    const scan = deferred<Command | undefined>();
    const remote = command('git', 'curated');
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      fetch: async () => responseWithGzip([remote]),
      runLocalCommand: () => scan.promise,
    }));
    await fetcher.init();

    const pending = fetcher.fetch('git');
    await fetcher.fetchAllCurated('general', true);
    scan.resolve(command('git', 'stale local'));
    assert.deepStrictEqual(await pending, remote);
    assert.deepStrictEqual(await fetcher.fetch('git'), remote);
  });

  test('does not return a local result unset while its persistence is pending', async () => {
    const saveStarted = deferred<void>();
    const releaseSave = deferred<void>();
    const storage = new FakeCacheStorage();
    let firstSave = true;
    storage.beforeSave = async () => {
      if (firstSave) {
        firstSave = false;
        saveStarted.resolve();
        await releaseSave.promise;
      }
    };
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      runLocalCommand: async () => command('git', 'local'),
    }));
    await fetcher.init();

    const pending = fetcher.fetch('git');
    await saveStarted.promise;
    const removal = fetcher.unset('git');
    releaseSave.resolve();

    await assert.rejects(pending, error => error instanceof CommandFetchCancelledError);
    await removal;
    assert.deepStrictEqual(fetcher.getList(), []);
    assert.deepStrictEqual(storage.stored?.commands, []);
  });

  test('returns forced curated data that replaces a local result during persistence', async () => {
    const saveStarted = deferred<void>();
    const releaseSave = deferred<void>();
    const storage = new FakeCacheStorage();
    let firstSave = true;
    storage.beforeSave = async () => {
      if (firstSave) {
        firstSave = false;
        saveStarted.resolve();
        await releaseSave.promise;
      }
    };
    const remote = command('git', 'curated');
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      fetch: async () => responseWithGzip([remote]),
      runLocalCommand: async () => command('git', 'local'),
    }));
    await fetcher.init();

    const pending = fetcher.fetch('git');
    await saveStarted.promise;
    const forced = fetcher.fetchAllCurated('general', true);
    await waitForAsyncCondition(
      async () => (await fetcher.fetch('git')).description === remote.description,
      1000,
    );
    assert.strictEqual((await fetcher.fetch('git')).description, remote.description);
    releaseSave.resolve();

    assert.deepStrictEqual(await pending, remote);
    await forced;
    assert.deepStrictEqual(storage.stored?.commands, [remote]);
  });

  test('cancels a fetch waiting for initial curated availability without starting H2O', async () => {
    const response = deferred<Response>();
    let localCalls = 0;
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      fetch: async () => response.promise,
      runLocalCommand: async () => {
        localCalls += 1;
        return command('git');
      },
    }));
    await fetcher.init();

    const initial = fetcher.startInitialCuratedFetch();
    const token = new FakeCancellationToken();
    const pending = fetcher.fetch('git', token);
    token.cancel();
    await assert.rejects(pending, error => error instanceof Error && error.name === 'CommandFetchCancelledError');
    assert.strictEqual(localCalls, 0);

    response.resolve(responseWithGzip([]));
    await initial;
  });

  test('loads curated gzip data without replacing existing entries by default', async () => {
    const existing = command('git', 'existing');
    const storage = new FakeCacheStorage({
      version: commandCacheSnapshotVersion,
      commands: [existing],
    });
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      fetch: async () => responseWithGzip([command('git', 'remote'), command('npm', 'remote')]),
    }));
    await fetcher.init();

    await fetcher.fetchAllCurated();

    assert.deepStrictEqual(await fetcher.fetch('git'), existing);
    assert.deepStrictEqual(await fetcher.fetch('npm'), command('npm', 'remote'));
    assert.deepStrictEqual(storage.stored?.commands, [existing, command('npm', 'remote')]);
    assert.strictEqual(storage.saves.length, 1);
  });

  test('skips a fully cached initial bundle save and releases waiting fetches', async () => {
    let releaseResponse!: (response: Response) => void;
    const response = new Promise<Response>(resolve => {
      releaseResponse = resolve;
    });
    const storage = new FakeCacheStorage({
      version: commandCacheSnapshotVersion,
      commands: [command('git', 'existing')],
    });
    let localCalls = 0;
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      fetch: async () => response,
      runLocalCommand: async name => {
        localCalls += 1;
        return command(name, 'local');
      },
    }));
    await fetcher.init();

    const initial = fetcher.startInitialCuratedFetch();
    const waitingFetch = fetcher.fetch('npm');
    releaseResponse(responseWithGzip([command('git', 'remote')]));

    await initial;
    assert.deepStrictEqual(await waitingFetch, command('npm', 'local'));
    assert.strictEqual(localCalls, 1);
    assert.strictEqual(storage.saves.length, 1);
    assert.deepStrictEqual(storage.saves[0].commands.map(item => item.name), ['git', 'npm']);
  });

  test('replaces curated entries when forcing an update', async () => {
    const storage = new FakeCacheStorage({
      version: commandCacheSnapshotVersion,
      commands: [command('git', 'existing')],
    });
    const remote = command('git', 'remote');
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      fetch: async () => responseWithGzip([remote]),
    }));
    await fetcher.init();

    await fetcher.fetchAllCurated('general', true);
    assert.deepStrictEqual(await fetcher.fetch('git'), remote);
    assert.deepStrictEqual(storage.stored?.commands, [remote]);
  });

  test('persists identical and empty forced bundles once per request', async () => {
    const existing = command('git', 'existing');
    const storage = new FakeCacheStorage({
      version: commandCacheSnapshotVersion,
      commands: [existing],
    });
    const responses = [responseWithGzip([existing]), responseWithGzip([])];
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      fetch: async () => responses.shift()!,
    }));
    await fetcher.init();

    await fetcher.fetchAllCurated('general', true);
    await fetcher.fetchAllCurated('general', true);

    assert.strictEqual(storage.saves.length, 2);
    assert.deepStrictEqual(storage.saves.map(snapshot => snapshot.commands.map(item => item.name)), [
      ['git'],
      ['git'],
    ]);
  });

  test('rejects corrupt curated and individual command data', async () => {
    const responses = [
      new Response('not gzip', { status: 200 }),
      new Response(JSON.stringify({ name: 'invalid' }), { status: 200 }),
    ];
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      fetch: async () => responses.shift()!,
    }));
    await fetcher.init();

    await assert.rejects(fetcher.fetchAllCurated(), /Failed to inflate and parse/);
    await assert.rejects(fetcher.downloadCommandToCache('invalid'), /invalid command/);
  });

  test('rejects an individual command whose payload name differs from the request', async () => {
    const storage = new FakeCacheStorage();
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      fetch: async () => new Response(JSON.stringify(command('different-name')), { status: 200 }),
    }));
    await fetcher.init();

    await assert.rejects(fetcher.downloadCommandToCache('requested-name'), /Received command different-name/);
    assert.deepStrictEqual(fetcher.getList(), []);
    assert.strictEqual(storage.saveAttempts.length, 0);
  });

  test('rejects local output whose payload name differs from the request', async () => {
    const storage = new FakeCacheStorage();
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      runLocalCommand: async () => command('different-name'),
    }));
    await fetcher.init();

    await assert.rejects(fetcher.fetch('requested-name'), /H2O returned different-name/);
    assert.deepStrictEqual(fetcher.getList(), []);
    assert.strictEqual(storage.saveAttempts.length, 0);
  });

  test('rejects malformed local output without inserting or saving it', async () => {
    const storage = new FakeCacheStorage();
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      runLocalCommand: async () => ({ ...command('git'), options: [null] } as unknown as Command),
    }));
    await fetcher.init();

    await assert.rejects(fetcher.fetch('git'), /invalid command data/);
    assert.deepStrictEqual(fetcher.getList(), []);
    assert.strictEqual(storage.saveAttempts.length, 0);
  });

  test('downloads individual commands and command lists', async () => {
    const storage = new FakeCacheStorage();
    const downloaded = command('jq', 'downloaded');
    const responses = [
      new Response(JSON.stringify(downloaded), { status: 200 }),
      new Response('git\n\nnpm \r\n', { status: 200 }),
    ];
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      fetch: async () => responses.shift()!,
    }));
    await fetcher.init();

    await fetcher.downloadCommandToCache('jq');
    assert.deepStrictEqual(storage.stored?.commands, [downloaded]);
    assert.deepStrictEqual(await fetcher.fetchList(), ['git', 'npm']);
  });

  test('rejects network and HTTP failures', async () => {
    const networkFailure = new CachingFetcher(new FakeMemento(), dependencies({
      fetch: async () => { throw new Error('offline'); },
    }));
    const httpFailure = new CachingFetcher(new FakeMemento(), dependencies({
      fetch: async () => new Response('missing', { status: 404, statusText: 'Not Found' }),
    }));
    await networkFailure.init();
    await httpFailure.init();

    await assert.rejects(networkFailure.fetchList(), /Failed to fetch over HTTP/);
    await assert.rejects(httpFailure.fetchList(), /Failed to fetch HTTP response/);
  });

  test('passes the configured request deadline to the HTTP client', async () => {
    let observedTimeout: number | undefined;
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      requestTimeoutMs: 5,
      fetch: async (_url, timeoutMs) => {
        observedTimeout = timeoutMs;
        return new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(new Error('timed out')), timeoutMs);
        });
      },
    }));
    await fetcher.init();

    await assert.rejects(fetcher.fetchList(), /Failed to fetch over HTTP/);
    assert.strictEqual(observedTimeout, 5);
  });

  test('removes cached commands and bundles with one save per operation', async () => {
    const storage = new FakeCacheStorage({
      version: commandCacheSnapshotVersion,
      commands: [command('git'), command('samtools'), command('bcftools')],
    });
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({ cacheStorage: storage }));
    await fetcher.init();

    await fetcher.unset('git');
    await fetcher.unsetAll(['samtools', 'bcftools']);

    assert.deepStrictEqual(fetcher.getList(), []);
    assert.deepStrictEqual(storage.saves.map(snapshot => snapshot.commands.map(item => item.name)), [
      ['samtools', 'bcftools'],
      [],
    ]);
  });

  test('skips persistence when unset operations remove no cached commands', async () => {
    const storage = new FakeCacheStorage({
      version: commandCacheSnapshotVersion,
      commands: [command('git')],
    });
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({ cacheStorage: storage }));
    await fetcher.init();

    await fetcher.unset('missing');
    await fetcher.unsetAll(['also-missing', 'still-missing']);

    assert.deepStrictEqual(fetcher.getList(), ['git']);
    assert.strictEqual(storage.saves.length, 0);
  });

  test('serializes overlapping snapshot saves in mutation order', async () => {
    let releaseFirstSave!: () => void;
    const firstSaveGate = new Promise<void>(resolve => {
      releaseFirstSave = resolve;
    });
    let saveCalls = 0;
    const storage = new FakeCacheStorage({
      version: commandCacheSnapshotVersion,
      commands: [command('git'), command('npm')],
    });
    storage.beforeSave = async () => {
      saveCalls += 1;
      if (saveCalls === 1) {
        await firstSaveGate;
      }
    };
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({ cacheStorage: storage }));
    await fetcher.init();

    const firstRemoval = fetcher.unset('git');
    const secondRemoval = fetcher.unset('npm');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.strictEqual(saveCalls, 1);

    releaseFirstSave();
    await Promise.all([firstRemoval, secondRemoval]);
    assert.deepStrictEqual(storage.saves.map(snapshot => snapshot.commands.map(item => item.name)), [['npm'], []]);
  });

  test('keeps two queued membership snapshots immutable across a later mutation attempt', async () => {
    let releaseFirstSave!: () => void;
    const firstSaveGate = new Promise<void>(resolve => {
      releaseFirstSave = resolve;
    });
    let saveCalls = 0;
    const storage = new FakeCacheStorage({
      version: commandCacheSnapshotVersion,
      commands: [command('git', 'before'), command('npm'), command('tar')],
    });
    storage.beforeSave = async () => {
      saveCalls += 1;
      if (saveCalls === 1) {
        await firstSaveGate;
      }
    };
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({ cacheStorage: storage }));
    await fetcher.init();
    const cachedGit = await fetcher.fetch('git');

    const firstRemoval = fetcher.unset('npm');
    await new Promise<void>(resolve => setImmediate(resolve));
    const secondRemoval = fetcher.unset('tar');
    assert.throws(() => {
      cachedGit.description = 'mutated after persistence request';
    }, TypeError);

    releaseFirstSave();
    await Promise.all([firstRemoval, secondRemoval]);
    assert.deepStrictEqual(storage.saves.map(snapshot => ({
      names: snapshot.commands.map(item => item.name),
      gitDescription: snapshot.commands.find(item => item.name === 'git')?.description,
    })), [
      { names: ['git', 'tar'], gitDescription: 'before' },
      { names: ['git'], gitDescription: 'before' },
    ]);
  });

  test('keeps real positional-argument fields immutable across queued saves', async () => {
    let releaseFirstSave!: () => void;
    const firstSaveGate = new Promise<void>(resolve => {
      releaseFirstSave = resolve;
    });
    let saveCalls = 0;
    const adb: Command = {
      ...command('adb'),
      subcommands: [{
        ...command('connect'),
        positionalArguments: [{ name: 'HOST[:PORT]', description: 'before' }],
      }],
    };
    const storage = new FakeCacheStorage({
      version: commandCacheSnapshotVersion,
      commands: [adb, command('npm'), command('tar')],
    });
    storage.beforeSave = async () => {
      saveCalls += 1;
      if (saveCalls === 1) {
        await firstSaveGate;
      }
    };
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({ cacheStorage: storage }));
    await fetcher.init();
    const cachedAdb = await fetcher.fetch('adb');

    const firstRemoval = fetcher.unset('npm');
    await new Promise<void>(resolve => setImmediate(resolve));
    const secondRemoval = fetcher.unset('tar');
    assert.throws(() => {
      cachedAdb.subcommands![0].positionalArguments![0].description = 'after';
    }, TypeError);

    releaseFirstSave();
    await Promise.all([firstRemoval, secondRemoval]);
    assert.deepStrictEqual(storage.saves.map(snapshot => ({
      names: snapshot.commands.map(item => item.name),
      description: snapshot.commands[0].subcommands![0].positionalArguments![0].description,
    })), [
      { names: ['adb', 'tar'], description: 'before' },
      { names: ['adb'], description: 'before' },
    ]);
  });

  test('publishes initial curated data before its snapshot save finishes', async () => {
    let releaseResponse!: (response: Response) => void;
    const response = new Promise<Response>(resolve => {
      releaseResponse = resolve;
    });
    let releaseSave!: () => void;
    const saveGate = new Promise<void>(resolve => {
      releaseSave = resolve;
    });
    const storage = new FakeCacheStorage();
    storage.beforeSave = () => saveGate;
    let localCalls = 0;
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      fetch: async () => response,
      runLocalCommand: async () => {
        localCalls += 1;
        return command('git', 'local');
      },
    }));
    await fetcher.init();

    const initialFetch = fetcher.startInitialCuratedFetch();
    let initialSettled = false;
    void initialFetch.then(() => {
      initialSettled = true;
    });
    assert.deepStrictEqual(fetcher.getCommandNameSnapshot(), {
      names: [],
      initialCuratedPending: true,
    });
    const initialAvailability = fetcher.waitForInitialCuratedAvailability();
    let availabilitySettled = false;
    void initialAvailability.then(() => {
      availabilitySettled = true;
    });
    const commandFetch = fetcher.fetch('git');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.strictEqual(localCalls, 0);
    assert.strictEqual(availabilitySettled, false);

    releaseResponse(responseWithGzip([command('git', 'curated')]));
    assert.deepStrictEqual(await commandFetch, command('git', 'curated'));
    await initialAvailability;
    assert.deepStrictEqual(fetcher.getCommandNameSnapshot(), {
      names: ['git'],
      initialCuratedPending: false,
    });
    assert.strictEqual(localCalls, 0);
    assert.strictEqual(initialSettled, false);

    releaseSave();
    await initialFetch;
    assert.deepStrictEqual(storage.stored?.commands, [command('git', 'curated')]);
  });

  test('exposes cached command names while the initial refresh is pending', async () => {
    let releaseResponse!: (response: Response) => void;
    const response = new Promise<Response>(resolve => {
      releaseResponse = resolve;
    });
    const cached = command('mamba', 'cached');
    const storage = new FakeCacheStorage({
      version: commandCacheSnapshotVersion,
      commands: [cached],
    });
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      fetch: async () => response,
    }));
    await fetcher.init();

    const initialFetch = fetcher.startInitialCuratedFetch();
    assert.deepStrictEqual(fetcher.getCommandNameSnapshot(), {
      names: ['mamba'],
      initialCuratedPending: true,
    });
    let availabilitySettled = false;
    void fetcher.waitForInitialCuratedAvailability().then(() => {
      availabilitySettled = true;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.strictEqual(availabilitySettled, false);

    releaseResponse(responseWithGzip([]));
    await initialFetch;
    assert.deepStrictEqual(fetcher.getCommandNameSnapshot(), {
      names: ['mamba'],
      initialCuratedPending: false,
    });
  });

  test('falls back to H2O after the initial curated request fails', async () => {
    let localCalls = 0;
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      fetch: async () => { throw new Error('offline'); },
      runLocalCommand: async () => {
        localCalls += 1;
        return command('git', 'local');
      },
    }));
    await fetcher.init();

    const initialFetch = fetcher.startInitialCuratedFetch();
    const handledFailure = initialFetch.catch(() => undefined);
    await fetcher.waitForInitialCuratedAvailability();
    assert.deepStrictEqual(fetcher.getCommandNameSnapshot(), {
      names: [],
      initialCuratedPending: false,
    });
    assert.deepStrictEqual(await fetcher.fetch('git'), command('git', 'local'));
    await handledFailure;
    assert.strictEqual(localCalls, 1);
  });

  test('does not publish or persist an initial curated response after disposal', async () => {
    const response = deferred<Response>();
    const storage = new FakeCacheStorage();
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      fetch: async () => response.promise,
    }));
    await fetcher.init();

    const initial = fetcher.startInitialCuratedFetch();
    fetcher.dispose();
    response.resolve(responseWithGzip([command('git', 'curated')]));
    await initial;

    assert.deepStrictEqual(fetcher.getList(), []);
    assert.strictEqual(storage.saves.length, 0);
    assert.deepStrictEqual(fetcher.getCommandNameSnapshot(), {
      names: [],
      initialCuratedPending: false,
    });
  });

  test('does not resurrect a command removed during the initial download unless forced', async () => {
    let releaseResponse!: (response: Response) => void;
    const response = new Promise<Response>(resolve => {
      releaseResponse = resolve;
    });
    const remote = command('git', 'curated');
    const responses: Array<Promise<Response> | Response> = [response, responseWithGzip([remote])];
    const storage = new FakeCacheStorage();
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      cacheStorage: storage,
      fetch: async () => responses.shift()!,
    }));
    await fetcher.init();

    const initialFetch = fetcher.startInitialCuratedFetch();
    await fetcher.unset('git');
    releaseResponse(responseWithGzip([remote]));
    await initialFetch;
    assert.deepStrictEqual(fetcher.getList(), []);
    assert.strictEqual(storage.saves.length, 0);

    await fetcher.fetchAllCurated('general', true);
    assert.deepStrictEqual(await fetcher.fetch('git'), remote);
    assert.strictEqual(storage.saves.length, 1);
  });
});

suite('runH2o', () => {
  function runtime(
    execute: (
      command: string,
      args: readonly string[],
      options: ProcessExecutionOptions,
    ) => Promise<ProcessOutput>,
  ): H2oRuntime {
    return {
      extensionDir: '/extension/out',
      platform: 'linux',
      getConfiguredPath: () => '<bundled>',
      showErrorMessage: () => undefined,
      execute,
    };
  }

  test('uses the bundled platform binary and parses JSON output', async () => {
    let invocation: { command: string; args: readonly string[]; options: ProcessExecutionOptions } | undefined;
    const actual = await runH2o('git', runtime(async (commandPath, args, options) => {
      invocation = { command: commandPath, args, options };
      return { stdout: JSON.stringify(command('git')), stderr: '' };
    }));

    assert.deepStrictEqual(actual, command('git'));
    assert.ok(invocation?.command.endsWith('/bin/wrap-h2o'));
    assert.ok(invocation?.args[0].endsWith('/bin/h2o'));
    assert.strictEqual(invocation?.args[1], 'git');
    assert.strictEqual(invocation?.options.maxOutputBytes, 1024 * 1024);
    assert.strictEqual(invocation?.options.timeoutMs, 10_000);
    assert.strictEqual(invocation?.options.terminateDescendants, true);
  });

  test('returns undefined for process and JSON failures', async () => {
    assert.strictEqual(await runH2o('git', runtime(async () => {
      throw new ProcessExecutionError('exit', 'exit 1');
    })), undefined);
    assert.strictEqual(await runH2o('git', runtime(async () => ({ stdout: '{invalid', stderr: '' }))), undefined);
    assert.strictEqual(await runH2o('git', runtime(async () => {
      throw new ProcessExecutionError('timeout', 'timeout');
    })), undefined);
    assert.strictEqual(await runH2o('git', runtime(async () => ({
      stdout: JSON.stringify(command('npm')),
      stderr: '',
    }))), undefined);
    assert.strictEqual(await runH2o('git', runtime(async () => ({
      stdout: JSON.stringify({ ...command('git'), options: [null] }),
      stderr: '',
    }))), undefined);
  });
});
