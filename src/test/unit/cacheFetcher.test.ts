import * as assert from 'assert';
import { gzipSync } from 'node:zlib';
import type { Memento } from 'vscode';
import { Response } from 'node-fetch';
import { CachingFetcher, CachingFetcherDependencies, H2oRuntime, runH2o } from '../../cacheFetcher';
import { Command } from '../../command';

class FakeMemento implements Memento {
  private readonly values = new Map<string, unknown>();

  constructor(private readonly beforeUpdate: () => Promise<void> = async () => undefined) {}

  public keys(): readonly string[] {
    return [...this.values.keys()];
  }

  public get<T>(key: string): T | undefined;
  public get<T>(key: string, defaultValue: T): T;
  public get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? this.values.get(key) as T : defaultValue;
  }

  public async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
    await this.beforeUpdate();
  }
}

function command(name: string, description = name): Command {
  return { name, description, options: [] };
}

function dependencies(overrides: Partial<CachingFetcherDependencies> = {}): Partial<CachingFetcherDependencies> {
  return {
    fetch: async () => new Response('', { status: 200 }),
    runLocalCommand: () => undefined,
    ...overrides,
  };
}

function responseWithGzip(commands: Command[]): Response {
  const body = gzipSync(JSON.stringify(commands));
  return new Response(body, { status: 200 });
}

suite('CachingFetcher', () => {
  test('returns cached commands without invoking H2O', async () => {
    const memento = new FakeMemento();
    const cached = command('git', 'cached');
    await memento.update(CachingFetcher.getKey('git'), cached);
    let localCalls = 0;
    const fetcher = new CachingFetcher(memento, dependencies({
      runLocalCommand: () => {
        localCalls += 1;
        return command('git', 'local');
      },
    }));

    assert.deepStrictEqual(await fetcher.fetch('git'), cached);
    assert.strictEqual(localCalls, 0);
  });

  test('stores commands returned by H2O before resolving', async () => {
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const memento = new FakeMemento(() => updateGate);
    const local = command('git', 'local');
    const fetcher = new CachingFetcher(memento, dependencies({ runLocalCommand: () => local }));

    const pendingFetch = fetcher.fetch('git');
    let settled = false;
    void pendingFetch.then(() => {
      settled = true;
    });
    await Promise.resolve();

    assert.strictEqual(settled, false);
    assert.deepStrictEqual(memento.get(CachingFetcher.getKey('git')), local);

    releaseUpdate();
    assert.deepStrictEqual(await pendingFetch, local);
    assert.deepStrictEqual(memento.get(CachingFetcher.getKey('git')), local);
  });

  test('rejects short and unavailable command names', async () => {
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies());

    await assert.rejects(fetcher.fetch('x'), /Command name too short/);
    await assert.rejects(fetcher.fetch('missing'), /Failed to fetch command/);
  });

  test('loads curated gzip data without replacing existing entries by default', async () => {
    const memento = new FakeMemento();
    const existing = command('git', 'existing');
    await memento.update(CachingFetcher.getKey('git'), existing);
    const fetcher = new CachingFetcher(memento, dependencies({
      fetch: async () => responseWithGzip([command('git', 'remote'), command('npm', 'remote')]),
    }));

    await fetcher.fetchAllCurated();

    assert.deepStrictEqual(memento.get(CachingFetcher.getKey('git')), existing);
    assert.deepStrictEqual(memento.get(CachingFetcher.getKey('npm')), command('npm', 'remote'));
  });

  test('starts all curated cache writes before waiting for persistence', async () => {
    let releaseUpdates!: () => void;
    const updateGate = new Promise<void>(resolve => {
      releaseUpdates = resolve;
    });
    let updateCalls = 0;
    const memento = new FakeMemento(async () => {
      updateCalls += 1;
      await updateGate;
    });
    const commands = [command('git', 'remote'), command('npm', 'remote')];
    const fetcher = new CachingFetcher(memento, dependencies({
      fetch: async () => responseWithGzip(commands),
    }));

    const pending = fetcher.fetchAllCurated();
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.strictEqual(updateCalls, 2);
    assert.deepStrictEqual(memento.get(CachingFetcher.getKey('git')), commands[0]);
    assert.deepStrictEqual(memento.get(CachingFetcher.getKey('npm')), commands[1]);

    releaseUpdates();
    await pending;
  });

  test('uses initial curated data without falling back to H2O while persistence finishes', async () => {
    let releaseResponse!: (response: Response) => void;
    const response = new Promise<Response>(resolve => {
      releaseResponse = resolve;
    });
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>(resolve => {
      releaseUpdate = resolve;
    });
    const memento = new FakeMemento(() => updateGate);
    let localCalls = 0;
    const fetcher = new CachingFetcher(memento, dependencies({
      fetch: async () => response,
      runLocalCommand: () => {
        localCalls += 1;
        return command('git', 'local');
      },
    }));

    const initialFetch = fetcher.startInitialCuratedFetch();
    let initialSettled = false;
    void initialFetch.then(() => {
      initialSettled = true;
    });
    const commandFetch = fetcher.fetch('git');
    await Promise.resolve();
    assert.strictEqual(localCalls, 0);

    const curated = command('git', 'curated');
    releaseResponse(responseWithGzip([curated]));
    assert.deepStrictEqual(await commandFetch, curated);
    assert.strictEqual(localCalls, 0);
    assert.strictEqual(initialSettled, false);

    releaseUpdate();
    await initialFetch;
  });

  test('falls back to H2O after the initial curated request fails', async () => {
    let localCalls = 0;
    const local = command('git', 'local');
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      fetch: async () => { throw new Error('offline'); },
      runLocalCommand: () => {
        localCalls += 1;
        return local;
      },
    }));

    const initialFetch = fetcher.startInitialCuratedFetch();
    const handledFailure = initialFetch.catch(() => undefined);

    assert.deepStrictEqual(await fetcher.fetch('git'), local);
    await handledFailure;
    assert.strictEqual(localCalls, 1);
  });

  test('does not restore a command removed during the initial download', async () => {
    let releaseResponse!: (response: Response) => void;
    const response = new Promise<Response>(resolve => {
      releaseResponse = resolve;
    });
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      fetch: async () => response,
    }));

    const initialFetch = fetcher.startInitialCuratedFetch();
    await fetcher.unset('git');
    releaseResponse(responseWithGzip([command('git', 'curated')]));
    await initialFetch;

    assert.deepStrictEqual(fetcher.getList(), []);
  });

  test('replaces curated entries when forcing an update', async () => {
    const memento = new FakeMemento();
    await memento.update(CachingFetcher.getKey('git'), command('git', 'existing'));
    const remote = command('git', 'remote');
    const fetcher = new CachingFetcher(memento, dependencies({
      fetch: async () => responseWithGzip([remote]),
    }));

    await fetcher.fetchAllCurated('general', true);

    assert.deepStrictEqual(memento.get(CachingFetcher.getKey('git')), remote);
  });

  test('rejects corrupt curated data', async () => {
    const fetcher = new CachingFetcher(new FakeMemento(), dependencies({
      fetch: async () => new Response('not gzip', { status: 200 }),
    }));

    await assert.rejects(fetcher.fetchAllCurated(), /Failed to decompress and parse/);
  });

  test('downloads individual commands and command lists', async () => {
    const memento = new FakeMemento();
    const downloaded = command('jq', 'downloaded');
    const responses = [
      new Response(JSON.stringify(downloaded), { status: 200 }),
      new Response('git\n\nnpm \r\n', { status: 200 }),
    ];
    const fetcher = new CachingFetcher(memento, dependencies({
      fetch: async () => responses.shift()!,
    }));

    await fetcher.downloadCommandToCache('jq');
    assert.deepStrictEqual(memento.get(CachingFetcher.getKey('jq')), downloaded);
    assert.deepStrictEqual(await fetcher.fetchList(), ['git', 'npm']);
  });

  test('rejects network and HTTP failures', async () => {
    const networkFailure = new CachingFetcher(new FakeMemento(), dependencies({
      fetch: async () => { throw new Error('offline'); },
    }));
    const httpFailure = new CachingFetcher(new FakeMemento(), dependencies({
      fetch: async () => new Response('missing', { status: 404, statusText: 'Not Found' }),
    }));

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

    await assert.rejects(fetcher.fetchList(), /Failed to fetch over HTTP/);
    assert.strictEqual(observedTimeout, 5);
  });

  test('removes cached commands', async () => {
    const memento = new FakeMemento();
    await memento.update(CachingFetcher.getKey('git'), command('git'));
    const fetcher = new CachingFetcher(memento, dependencies());

    await fetcher.unset('git');

    assert.deepStrictEqual(fetcher.getList(), []);
  });
});

suite('runH2o', () => {
  function runtime(spawn: H2oRuntime['spawn']): H2oRuntime {
    return {
      extensionDir: '/extension/out',
      platform: 'linux',
      getConfiguredPath: () => '<bundled>',
      showErrorMessage: () => undefined,
      spawn,
    };
  }

  test('uses the bundled platform binary and parses JSON output', () => {
    let invocation: { command: string; args: string[] } | undefined;
    const actual = runH2o('git', runtime((commandPath, args) => {
      invocation = { command: commandPath, args };
      return { status: 0, stdout: JSON.stringify(command('git')) };
    }));

    assert.deepStrictEqual(actual, command('git'));
    assert.ok(invocation?.command.endsWith('/bin/wrap-h2o'));
    assert.ok(invocation?.args[0].endsWith('/bin/h2o'));
    assert.strictEqual(invocation?.args[1], 'git');
  });

  test('returns undefined for process and JSON failures', () => {
    assert.strictEqual(runH2o('git', runtime(() => ({ status: 1, stdout: '' }))), undefined);
    assert.strictEqual(runH2o('git', runtime(() => ({ status: 0, stdout: '{invalid' }))), undefined);
    assert.strictEqual(runH2o('git', runtime(() => ({ status: null, error: new Error('timeout') }))), undefined);
  });
});
