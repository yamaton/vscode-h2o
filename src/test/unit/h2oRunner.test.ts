import * as assert from 'assert';
import { ChildProcess, SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import {
  executeProcess,
  type H2oRuntime,
  type ProcessExecutionDependencies,
  ProcessExecutionError,
  runH2o,
  supportsLocalCommandScanning,
} from '../../h2oRunner';

class FakeChildProcess extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly pid = 1234;
  public readonly signals: NodeJS.Signals[] = [];

  public kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    return true;
  }

  public asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

function executionOptions(overrides: Partial<Parameters<typeof executeProcess>[2]> = {}): Parameters<typeof executeProcess>[2] {
  return {
    maxOutputBytes: 1024,
    terminateDescendants: true,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function hasFailureKind(kind: ProcessExecutionError['kind']): (error: unknown) => boolean {
  return error => error instanceof ProcessExecutionError && error.kind === kind;
}

function fakeExecution(
  action?: (child: FakeChildProcess) => void,
  platform: NodeJS.Platform = 'linux',
  processGroupSurvivesTerm = false,
): {
  child: FakeChildProcess;
  dependencies: ProcessExecutionDependencies;
  spawnOptions(): SpawnOptions | undefined;
} {
  const child = new FakeChildProcess();
  let processGroupAlive = true;
  let capturedOptions: SpawnOptions | undefined;
  const dependencies: ProcessExecutionDependencies = {
    platform,
    spawn: (_command, _args, options) => {
      capturedOptions = options;
      if (action) {
        setImmediate(() => action(child));
      }
      return child.asChildProcess();
    },
    killProcessGroup: (_pid, signal) => {
      child.signals.push(signal);
      if (signal === 'SIGTERM') {
        setImmediate(() => {
          processGroupAlive = processGroupSurvivesTerm;
          child.emit('close', null, signal);
        });
      } else if (signal === 'SIGKILL') {
        processGroupAlive = false;
      }
    },
    isProcessGroupAlive: () => processGroupAlive,
  };
  return { child, dependencies, spawnOptions: () => capturedOptions };
}

suite('asynchronous process execution', () => {
  test('captures stdout and stderr without a shell', async () => {
    const fake = fakeExecution(child => {
      child.stdout.write('output');
      child.stderr.write('warning');
      child.emit('close', 0, null);
    });
    const output = await executeProcess('h2o', ['git'], executionOptions(), fake.dependencies);

    assert.deepStrictEqual(output, { stdout: 'output', stderr: 'warning' });
    assert.strictEqual(fake.spawnOptions()?.shell, false);
    assert.strictEqual(fake.spawnOptions()?.detached, true);
  });

  test('reports non-zero exits', async () => {
    const fake = fakeExecution(child => child.emit('close', 7, null));

    await assert.rejects(
      executeProcess('h2o', ['git'], executionOptions(), fake.dependencies),
      hasFailureKind('exit'),
    );
  });

  test('reports asynchronous spawn failures', async () => {
    const fake = fakeExecution(child => child.emit('error', new Error('spawn failed')));

    await assert.rejects(
      executeProcess('h2o', ['git'], executionOptions(), fake.dependencies),
      hasFailureKind('spawn'),
    );
  });

  test('enforces output limits and terminates the process group', async () => {
    const fake = fakeExecution(child => child.stdout.write('x'.repeat(2048)));

    await assert.rejects(
      executeProcess('h2o', ['git'], executionOptions({ maxOutputBytes: 128 }), fake.dependencies),
      hasFailureKind('output-limit'),
    );
    assert.deepStrictEqual(fake.child.signals, ['SIGTERM']);
  });

  test('terminates a running process on timeout', async () => {
    const fake = fakeExecution();

    await assert.rejects(
      executeProcess('h2o', ['git'], executionOptions({ timeoutMs: 5 }), fake.dependencies),
      hasFailureKind('timeout'),
    );
    assert.deepStrictEqual(fake.child.signals, ['SIGTERM']);
  });

  test('force-kills descendants after the process-group leader exits on termination', async () => {
    const fake = fakeExecution(undefined, 'linux', true);

    await assert.rejects(
      executeProcess('h2o', ['git'], executionOptions({ timeoutMs: 5 }), fake.dependencies),
      hasFailureKind('timeout'),
    );
    assert.deepStrictEqual(fake.child.signals, ['SIGTERM', 'SIGKILL']);
  });

  test('terminates a running process on abort', async () => {
    const controller = new AbortController();
    const fake = fakeExecution();
    const running = executeProcess(
      'h2o',
      ['git'],
      executionOptions({ signal: controller.signal }),
      fake.dependencies,
    );
    controller.abort();

    await assert.rejects(running, hasFailureKind('aborted'));
    assert.deepStrictEqual(fake.child.signals, ['SIGTERM']);
  });

  test('uses direct child termination on Windows', async () => {
    const fake = fakeExecution(undefined, 'win32');
    const controller = new AbortController();
    const running = executeProcess(
      'h2o',
      ['git'],
      executionOptions({ signal: controller.signal }),
      fake.dependencies,
    );
    controller.abort();
    setImmediate(() => fake.child.emit('close', null, 'SIGTERM'));

    await assert.rejects(running, hasFailureKind('aborted'));
    assert.deepStrictEqual(fake.child.signals, ['SIGTERM']);
    assert.strictEqual(fake.spawnOptions()?.detached, false);
  });

  test('does not spawn when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeExecution();

    await assert.rejects(executeProcess(
      'h2o',
      ['git'],
      executionOptions({ signal: controller.signal }),
      fake.dependencies,
    ), hasFailureKind('aborted'));
    assert.strictEqual(fake.spawnOptions(), undefined);
  });
});

suite('local command scanning support', () => {
  test('supports only Unix hosts with bundled scanner packages', () => {
    assert.strictEqual(supportsLocalCommandScanning('linux'), true);
    assert.strictEqual(supportsLocalCommandScanning('darwin'), true);
    assert.strictEqual(supportsLocalCommandScanning('win32'), false);
  });

  test('does not run a configured H2O executable on Windows', async () => {
    let executions = 0;
    const runtime: H2oRuntime = {
      extensionDir: '/extension/out',
      platform: 'win32',
      getConfiguredPath: () => 'C:\\tools\\h2o.exe',
      execute: async () => {
        executions += 1;
        return { stdout: '', stderr: '' };
      },
    };

    assert.strictEqual(await runH2o('dir', runtime), undefined);
    assert.strictEqual(executions, 0);
  });
});
