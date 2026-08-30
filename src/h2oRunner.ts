import { ChildProcess, SpawnOptions, spawn } from 'child_process';
import * as path from 'path';
import type * as Vscode from 'vscode';

import { Command } from './command';
import { validateCommands } from './cacheStorage';

const defaultTimeoutMs = 10_000;
const defaultMaxOutputBytes = 1024 * 1024;
const forceKillDelayMs = 250;

export type ProcessExecutionFailureKind =
  | 'aborted'
  | 'exit'
  | 'output-limit'
  | 'spawn'
  | 'timeout';

export class ProcessExecutionError extends Error {
  constructor(
    public readonly kind: ProcessExecutionFailureKind,
    message: string,
    public readonly originalError?: unknown,
  ) {
    super(message);
    this.name = 'ProcessExecutionError';
  }
}

export interface ProcessOutput {
  stdout: string;
  stderr: string;
}

export interface ProcessExecutionOptions {
  maxOutputBytes: number;
  signal?: AbortSignal;
  terminateDescendants: boolean;
  timeoutMs: number;
}

export interface ProcessExecutionDependencies {
  platform: NodeJS.Platform;
  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  killProcessGroup(pid: number, signal: NodeJS.Signals): void;
  isProcessGroupAlive(pid: number): boolean;
}

const defaultProcessExecutionDependencies: ProcessExecutionDependencies = {
  platform: process.platform,
  spawn: (command, args, options) => spawn(command, args, options),
  killProcessGroup: (pid, signal) => process.kill(-pid, signal),
  isProcessGroupAlive: pid => process.kill(-pid, 0),
};

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

export function executeProcess(
  command: string,
  args: readonly string[],
  options: ProcessExecutionOptions,
  dependencies: ProcessExecutionDependencies = defaultProcessExecutionDependencies,
): Promise<ProcessOutput> {
  if (options.signal?.aborted) {
    return Promise.reject(new ProcessExecutionError('aborted', 'Process execution was aborted.'));
  }

  const useProcessGroup = options.terminateDescendants && dependencies.platform !== 'win32';
  let child: ChildProcess;
  try {
    child = dependencies.spawn(command, args, {
      detached: useProcessGroup,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    return Promise.reject(new ProcessExecutionError('spawn', 'Failed to spawn process.', error));
  }

  if (!child.stdout || !child.stderr) {
    try {
      child.kill('SIGTERM');
    } catch {
      // A child without the requested pipes cannot produce a usable result.
    }
    return Promise.reject(new ProcessExecutionError('spawn', 'Spawned process has no output pipes.'));
  }
  const childStdout = child.stdout;
  const childStderr = child.stderr;

  return new Promise<ProcessOutput>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let childClosed = false;
    let forceKillSent = false;
    let terminationError: ProcessExecutionError | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const clearForceKillTimer = (): void => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }
    };

    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (useProcessGroup && child.pid !== undefined) {
          dependencies.killProcessGroup(child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch (error) {
        if (!isNoSuchProcess(error)) {
          console.warn(`[H2O process] Failed to send ${signal}:`, error);
        }
      }
    };

    const isProcessGroupAlive = (): boolean => {
      if (!useProcessGroup || child.pid === undefined) {
        return false;
      }
      try {
        return dependencies.isProcessGroupAlive(child.pid);
      } catch (error) {
        if (isNoSuchProcess(error)) {
          return false;
        }
        console.warn('[H2O process] Failed to inspect the process group:', error);
        return true;
      }
    };

    const terminate = (error: ProcessExecutionError): void => {
      if (settled || terminationError) {
        return;
      }
      terminationError = error;
      kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined;
        forceKillSent = true;
        kill('SIGKILL');
        if (childClosed) {
          finish(() => reject(terminationError!));
        }
      }, forceKillDelayMs);
    };

    const removeAbortListener = (): void => {
      options.signal?.removeEventListener('abort', abort);
    };

    const finish = (operation: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearForceKillTimer();
      removeAbortListener();
      operation();
    };

    const abort = (): void => terminate(
      new ProcessExecutionError('aborted', 'Process execution was aborted.'),
    );
    const timeoutTimer = setTimeout(() => terminate(
      new ProcessExecutionError('timeout', `Process execution exceeded ${options.timeoutMs} ms.`),
    ), options.timeoutMs);

    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    }

    childStdout.on('data', (chunk: Buffer | string) => {
      const content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += content.length;
      if (stdoutBytes > options.maxOutputBytes) {
        terminate(new ProcessExecutionError(
          'output-limit',
          `Process stdout exceeded ${options.maxOutputBytes} bytes.`,
        ));
        return;
      }
      stdoutChunks.push(content);
    });
    childStderr.on('data', (chunk: Buffer | string) => {
      const content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += content.length;
      if (stderrBytes > options.maxOutputBytes) {
        terminate(new ProcessExecutionError(
          'output-limit',
          `Process stderr exceeded ${options.maxOutputBytes} bytes.`,
        ));
        return;
      }
      stderrChunks.push(content);
    });
    child.once('error', error => {
      if (!terminationError) {
        finish(() => reject(
          new ProcessExecutionError('spawn', 'Failed to spawn process.', error),
        ));
      }
    });
    child.once('close', (code, signal) => {
      childClosed = true;
      if (terminationError) {
        if (!forceKillSent && isProcessGroupAlive()) {
          return;
        }
        finish(() => reject(terminationError!));
        return;
      }
      finish(() => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (code !== 0) {
          reject(new ProcessExecutionError(
            'exit',
            `Process exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}.`,
          ));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  });
}

export interface H2oRuntime {
  extensionDir: string;
  platform: NodeJS.Platform;
  getConfiguredPath(): string;
  showErrorMessage(message: string): void;
  execute(
    command: string,
    args: readonly string[],
    options: ProcessExecutionOptions,
  ): Promise<ProcessOutput>;
}

let neverNotifiedError = true;

function createDefaultH2oRuntime(): H2oRuntime {
  // `vscode` is only available inside the extension host. Loading it lazily
  // keeps the command runner testable in a plain Node.js process.
  const vscode = require('vscode') as typeof Vscode;
  return {
    extensionDir: __dirname,
    platform: process.platform,
    getConfiguredPath: () => vscode.workspace.getConfiguration('shellCompletion').get('h2oPath') as string,
    showErrorMessage: message => {
      void vscode.window.showErrorMessage(message);
    },
    execute: (command, args, options) => executeProcess(command, args, options),
  };
}

export async function runH2o(
  name: string,
  runtime: H2oRuntime = createDefaultH2oRuntime(),
  signal?: AbortSignal,
): Promise<Command | undefined> {
  let h2opath = runtime.getConfiguredPath();
  if (h2opath === '<bundled>') {
    if (runtime.platform !== 'linux' && runtime.platform !== 'darwin') {
      if (neverNotifiedError) {
        const message = 'Bundled help scanner (H2O) supports Linux and MacOS. Please set the H2O path.';
        runtime.showErrorMessage(message);
      }
      neverNotifiedError = false;
      return undefined;
    }
    h2opath = path.join(runtime.extensionDir, '../bin/h2o');
  }

  const wrapperPath = path.join(runtime.extensionDir, '../bin/wrap-h2o');
  let output: ProcessOutput;
  try {
    output = await runtime.execute(wrapperPath, [h2opath, name], {
      maxOutputBytes: defaultMaxOutputBytes,
      signal,
      terminateDescendants: runtime.platform === 'linux' || runtime.platform === 'darwin',
      timeoutMs: defaultTimeoutMs,
    });
  } catch (error) {
    if (error instanceof ProcessExecutionError && error.kind === 'aborted') {
      throw error;
    }
    console.warn(`[CacheFetcher.runH2o] Failed to run H2O for ${name}:`, error);
    return undefined;
  }

  try {
    const command = validateCommands([JSON.parse(output.stdout) as unknown])[0];
    if (command.name !== name) {
      throw new Error(`H2O returned ${command.name} for requested command ${name}.`);
    }
    return command;
  } catch (error) {
    console.warn('[CacheFetcher.runH2o] Failed to parse H2O result as JSON:', name, error);
    return undefined;
  }
}
