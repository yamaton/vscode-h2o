import { chmodSync, writeFileSync } from 'fs';
import { gzipSync } from 'zlib';
import { Response } from 'node-fetch';
import * as vscode from 'vscode';
import { CachingFetcher } from '../../cacheFetcher';
import {
  CacheFileSystem,
  CommandCacheSnapshot,
  CommandCacheStorage,
  GzipCommandCacheStorage,
  commandCacheSnapshotVersion,
} from '../../cacheStorage';
import { Command } from '../../command';

const legacyCommandKey = CachingFetcher.getKey('legacy');
const unrelatedKey = 'storageFixture.unrelated';

function command(name: string, description = name): Command {
  return { name, description, options: [] };
}

function storageFor(
  context: vscode.ExtensionContext,
  filename = 'commands-v1.json.gz',
  fileSystem: CacheFileSystem<vscode.Uri> = vscode.workspace.fs,
  temporary?: () => vscode.Uri,
): GzipCommandCacheStorage<vscode.Uri> {
  return new GzipCommandCacheStorage(fileSystem, {
    directory: context.globalStorageUri,
    snapshot: vscode.Uri.joinPath(context.globalStorageUri, filename),
    temporary: temporary ?? (() => vscode.Uri.joinPath(
      context.globalStorageUri,
      `${filename}.${process.pid}.${Date.now()}.tmp`,
    )),
  });
}

function bundleResponse(commands: Command[]): Response {
  return new Response(gzipSync(JSON.stringify(commands)), { status: 200 });
}

async function isAbsent(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return false;
  } catch (error) {
    return (error as { code?: string }).code === 'FileNotFound';
  }
}

async function runPhase(context: vscode.ExtensionContext, phase: string): Promise<Record<string, unknown>> {
  const storage = storageFor(context);
  const canonical = vscode.Uri.joinPath(context.globalStorageUri, 'commands-v1.json.gz');

  if (phase === 'seed') {
    // Queue the Memento updates in one scheduler turn. Awaiting each update
    // separately allows a delayed storage echo to replace a newer local value.
    await Promise.all([
      context.globalState.update(legacyCommandKey, command('legacy', 'legacy Memento payload')),
      context.globalState.update(CachingFetcher.commandListKey, ['legacy']),
      context.globalState.update(unrelatedKey, true),
    ]);
    await storage.save({
      version: commandCacheSnapshotVersion,
      commands: [command('git', 'seed snapshot')],
    });
    return {
      phase,
      canonicalFsPath: canonical.fsPath,
      globalStorageScheme: context.globalStorageUri.scheme,
      keys: [...context.globalState.keys()],
    };
  }

  if (phase === 'restore-cleanup-noop') {
    const keysBefore = [...context.globalState.keys()];
    const statBefore = await vscode.workspace.fs.stat(canonical);
    const fetcher = new CachingFetcher(context.globalState, {
      cacheStorage: storage,
      fetch: async () => bundleResponse([command('git', 'remote should not replace')]),
    });
    await fetcher.init();
    await fetcher.fetchAllCurated('general', false);
    const statAfter = await vscode.workspace.fs.stat(canonical);
    return {
      phase,
      keysBefore,
      keysAfter: [...context.globalState.keys()],
      commandNames: fetcher.getList(),
      mtimeBefore: statBefore.mtime,
      mtimeAfter: statAfter.mtime,
    };
  }

  if (phase === 'verify-restart') {
    return {
      phase,
      keysBefore: [...context.globalState.keys()],
      storedNames: (await storage.load())?.commands.map(item => item.name),
    };
  }

  if (phase === 'recover-corrupt') {
    const fetcher = new CachingFetcher(context.globalState, {
      cacheStorage: storage,
      fetch: async () => bundleResponse([command('npm', 'recovered')]),
    });
    await fetcher.init();
    await fetcher.fetchAllCurated('general', false);
    return { phase, commandNames: fetcher.getList() };
  }

  if (phase === 'read-denied') {
    const restoreMode = Number(process.env.VSCODE_H2O_STORAGE_RESTORE_MODE);
    const fetcher = new CachingFetcher(context.globalState, {
      cacheStorage: storage,
      runLocalCommand: async () => command('git', 'session only'),
    });
    try {
      await fetcher.init();
    } finally {
      if (Number.isInteger(restoreMode)) {
        chmodSync(canonical.fsPath, restoreMode);
      }
    }
    await fetcher.fetch('git');
    return { phase, inMemoryNames: fetcher.getList() };
  }

  if (phase === 'failures-and-race') {
    const mismatchSnapshot = vscode.Uri.joinPath(context.globalStorageUri, 'mismatch.json.gz');
    const mismatchFetcher = new CachingFetcher(context.globalState, {
      cacheStorage: storageFor(context, 'mismatch.json.gz'),
      runLocalCommand: async () => command('wrong-local'),
      fetch: async () => new Response(JSON.stringify(command('wrong-remote')), { status: 200 }),
    });
    await mismatchFetcher.init();
    let localMismatchRejected = false;
    try {
      await mismatchFetcher.fetch('requested-local');
    } catch (error) {
      localMismatchRejected = true;
    }
    let experimentalMismatchRejected = false;
    try {
      await mismatchFetcher.downloadCommandToCache('requested-remote');
    } catch (error) {
      experimentalMismatchRejected = true;
    }

    const controlledRenameError = new Error('controlled rename failure');
    const cleanupTemporary = vscode.Uri.joinPath(context.globalStorageUri, 'cleanup.tmp');
    let cleanupDeleteCalls = 0;
    const cleanupFileSystem: CacheFileSystem<vscode.Uri> = {
      createDirectory: uri => vscode.workspace.fs.createDirectory(uri),
      delete: uri => {
        cleanupDeleteCalls += 1;
        return vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
      },
      readFile: uri => vscode.workspace.fs.readFile(uri),
      writeFile: (uri, content) => vscode.workspace.fs.writeFile(uri, content),
      rename: async () => { throw controlledRenameError; },
    };
    const cleanupStorage = storageFor(
      context,
      'cleanup-target.json.gz',
      cleanupFileSystem,
      () => cleanupTemporary,
    );
    let cleanupPrimaryPreserved = false;
    try {
      await cleanupStorage.save({ version: commandCacheSnapshotVersion, commands: [command('git')] });
    } catch (error) {
      cleanupPrimaryPreserved = error === controlledRenameError;
    }

    const doubleFailureTemporary = vscode.Uri.joinPath(context.globalStorageUri, 'double-failure.tmp');
    const doubleFailureFileSystem: CacheFileSystem<vscode.Uri> = {
      createDirectory: uri => vscode.workspace.fs.createDirectory(uri),
      delete: async () => { throw new Error('controlled cleanup failure'); },
      readFile: uri => vscode.workspace.fs.readFile(uri),
      writeFile: (uri, content) => vscode.workspace.fs.writeFile(uri, content),
      rename: async () => { throw controlledRenameError; },
    };
    const doubleFailureStorage = storageFor(
      context,
      'double-failure-target.json.gz',
      doubleFailureFileSystem,
      () => doubleFailureTemporary,
    );
    let doubleFailurePrimaryPreserved = false;
    try {
      await doubleFailureStorage.save({ version: commandCacheSnapshotVersion, commands: [command('git')] });
    } catch (error) {
      doubleFailurePrimaryPreserved = error === controlledRenameError;
    }
    const doubleFailureTemporaryRemained = !await isAbsent(doubleFailureTemporary);
    await vscode.workspace.fs.delete(doubleFailureTemporary, { recursive: false, useTrash: false });

    const raceStorage = storageFor(context, 'race.json.gz');
    await raceStorage.save({
      version: commandCacheSnapshotVersion,
      commands: [command('git', 'before'), command('npm'), command('tar')],
    });
    let saveCalls = 0;
    let markFirstSaveStarted!: () => void;
    const firstSaveStarted = new Promise<void>(resolve => {
      markFirstSaveStarted = resolve;
    });
    let releaseFirstSave!: () => void;
    const firstSaveGate = new Promise<void>(resolve => {
      releaseFirstSave = resolve;
    });
    const observedSnapshots: Array<{ names: string[]; gitDescription?: string }> = [];
    const delayedStorage: CommandCacheStorage = {
      load: () => raceStorage.load(),
      save: async (snapshot: CommandCacheSnapshot) => {
        saveCalls += 1;
        observedSnapshots.push({
          names: snapshot.commands.map(item => item.name),
          gitDescription: snapshot.commands.find(item => item.name === 'git')?.description,
        });
        if (saveCalls === 1) {
          markFirstSaveStarted();
          await firstSaveGate;
        }
        await raceStorage.save(snapshot);
      },
    };
    const raceFetcher = new CachingFetcher(context.globalState, { cacheStorage: delayedStorage });
    await raceFetcher.init();
    const cachedGit = await raceFetcher.fetch('git');
    const firstRemoval = raceFetcher.unset('npm');
    await firstSaveStarted;
    const secondRemoval = raceFetcher.unset('tar');
    let mutationRejected = false;
    try {
      cachedGit.description = 'mutated after persistence request';
    } catch (error) {
      mutationRejected = error instanceof TypeError;
    }
    releaseFirstSave();
    await Promise.all([firstRemoval, secondRemoval]);

    return {
      phase,
      localMismatchRejected,
      experimentalMismatchRejected,
      mismatchStoredNames: mismatchFetcher.getList(),
      mismatchSnapshotAbsent: await isAbsent(mismatchSnapshot),
      cleanupDeleteCalls,
      cleanupTemporaryAbsent: await isAbsent(cleanupTemporary),
      cleanupPrimaryPreserved,
      doubleFailureTemporaryRemained,
      doubleFailurePrimaryPreserved,
      mutationRejected,
      observedSnapshots,
      raceStoredNames: (await raceStorage.load())?.commands.map(item => item.name),
    };
  }

  throw new Error(`Unknown storage integration phase: ${phase}`);
}

export function activate(context: vscode.ExtensionContext): void {
  if (process.env.VSCODE_H2O_STORAGE_AUTORUN !== '1') {
    return;
  }
  const phase = process.env.VSCODE_H2O_STORAGE_PHASE;
  const reportPath = process.env.VSCODE_H2O_STORAGE_REPORT;
  if (!phase || !reportPath) {
    throw new Error('Storage integration environment is incomplete.');
  }

  void runPhase(context, phase).then(
    async report => {
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
      await new Promise(resolve => setTimeout(resolve, 500));
      await vscode.commands.executeCommand('workbench.action.quit');
    },
    async error => {
      writeFileSync(reportPath, JSON.stringify({
        phase,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }, null, 2));
      await vscode.commands.executeCommand('workbench.action.quit');
    },
  );
}

export function deactivate(): void {}
