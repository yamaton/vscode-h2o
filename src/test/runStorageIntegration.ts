import * as assert from 'assert';
import { spawnSync } from 'child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { gunzipSync } from 'zlib';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

interface PhaseReport {
	phase: string;
	error?: string;
	stack?: string;
	[key: string]: unknown;
}

interface StoredSnapshot {
	version: number;
	commands: Array<{ name: string }>;
}

function readSnapshot(snapshotPath: string): StoredSnapshot {
	return JSON.parse(gunzipSync(readFileSync(snapshotPath)).toString('utf8')) as StoredSnapshot;
}

async function main(): Promise<void> {
	const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH
		|| await downloadAndUnzipVSCode({ version: process.env.VSCODE_VERSION || 'stable' });
	const fixturePath = path.resolve(__dirname, '../../test/storage-integration');
	// VS Code derives a Unix-domain socket path from --user-data-dir. The long
	// per-user directory returned by macOS tmpdir() can exceed its 103-byte
	// socket-path limit before the storage fixture starts.
	const profileParent = process.platform === 'darwin' ? '/tmp' : tmpdir();
	const profileRoot = mkdtempSync(path.join(profileParent, 'h2o-storage-'));
	const userDataDir = path.join(profileRoot, 'user-data');
	const extensionsDir = path.join(profileRoot, 'extensions');
	mkdirSync(userDataDir, { recursive: true });
	mkdirSync(extensionsDir, { recursive: true });

	const launchArguments = [
		`--user-data-dir=${userDataDir}`,
		`--extensions-dir=${extensionsDir}`,
		`--extensionDevelopmentPath=${fixturePath}`,
		'--disable-extensions',
		'--disable-workspace-trust',
		'--skip-release-notes',
		'--skip-welcome',
		'--new-window',
		...(process.env.VSCODE_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
	];

	function runPhase(phase: string, extraEnvironment: NodeJS.ProcessEnv = {}): PhaseReport {
		const reportPath = path.join(profileRoot, `${phase}.json`);
		const result = spawnSync(vscodeExecutablePath, launchArguments, {
			encoding: 'utf8',
			env: {
				...process.env,
				...extraEnvironment,
				['VSCODE_H2O_STORAGE_AUTORUN']: '1',
				['VSCODE_H2O_STORAGE_PHASE']: phase,
				['VSCODE_H2O_STORAGE_REPORT']: reportPath,
			},
			maxBuffer: 32 * 1024 * 1024,
			timeout: 15_000,
		});

		if (result.stdout) {
			process.stdout.write(result.stdout);
		}
		if (result.stderr) {
			process.stderr.write(result.stderr);
		}
		const timedOutAfterReport = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
			&& existsSync(reportPath);
		if (result.error && !timedOutAfterReport) {
			throw result.error;
		}
		if (result.status !== 0 && !timedOutAfterReport) {
			throw new Error(`VS Code storage phase ${phase} exited with status ${result.status} and signal ${result.signal}.`);
		}
		assert.ok(existsSync(reportPath), `VS Code storage phase ${phase} did not create a report.`);
		const report = JSON.parse(readFileSync(reportPath, 'utf8')) as PhaseReport;
		assert.strictEqual(report.phase, phase);
		if (report.error) {
			throw new Error(`VS Code storage phase ${phase} failed: ${report.error}\n${report.stack || ''}`);
		}
		return report;
	}

	try {
		const seed = runPhase('seed');
		assert.strictEqual(seed.globalStorageScheme, 'vscode-userdata');
		assert.deepStrictEqual(new Set(seed.keys as string[]), new Set([
			'h2oFetcher.cache.legacy',
			'h2oFetcher.registered.all',
			'storageFixture.unrelated',
		]));
		const canonicalPath = seed.canonicalFsPath as string;
		assert.ok(statSync(canonicalPath).isFile());

		const restored = runPhase('restore-cleanup-noop');
		assert.deepStrictEqual(new Set(restored.keysBefore as string[]), new Set([
			'h2oFetcher.cache.legacy',
			'h2oFetcher.registered.all',
			'storageFixture.unrelated',
		]));
		assert.deepStrictEqual(restored.keysAfter, ['storageFixture.unrelated']);
		assert.deepStrictEqual(restored.commandNames, ['git']);
		assert.strictEqual(restored.mtimeAfter, restored.mtimeBefore, 'A fully cached bundle must not rewrite the snapshot.');

		const restarted = runPhase('verify-restart');
		assert.deepStrictEqual(restarted.keysBefore, ['storageFixture.unrelated']);
		assert.deepStrictEqual(restarted.storedNames, ['git']);

		writeFileSync(canonicalPath, 'controlled corrupt snapshot');
		const recovered = runPhase('recover-corrupt');
		assert.deepStrictEqual(recovered.commandNames, ['npm']);
		assert.deepStrictEqual(readSnapshot(canonicalPath).commands.map(command => command.name), ['npm']);

		if (process.platform !== 'win32') {
			const originalMode = statSync(canonicalPath).mode & 0o777;
			chmodSync(canonicalPath, 0);
			const readDenied = runPhase('read-denied', {
				['VSCODE_H2O_STORAGE_RESTORE_MODE']: String(originalMode),
			});
			assert.deepStrictEqual(readDenied.inMemoryNames, ['git']);
			assert.deepStrictEqual(
				readSnapshot(canonicalPath).commands.map(command => command.name),
				['npm'],
				'A read failure must prevent the session from replacing an unread snapshot.',
			);
		}

		const failuresAndRace = runPhase('failures-and-race');
		assert.strictEqual(failuresAndRace.localMismatchRejected, true);
		assert.strictEqual(failuresAndRace.experimentalMismatchRejected, true);
		assert.deepStrictEqual(failuresAndRace.mismatchStoredNames, []);
		assert.strictEqual(failuresAndRace.mismatchSnapshotAbsent, true);
		assert.strictEqual(failuresAndRace.cleanupDeleteCalls, 1);
		assert.strictEqual(failuresAndRace.cleanupTemporaryAbsent, true);
		assert.strictEqual(failuresAndRace.cleanupPrimaryPreserved, true);
		assert.strictEqual(failuresAndRace.doubleFailureTemporaryRemained, true);
		assert.strictEqual(failuresAndRace.doubleFailurePrimaryPreserved, true);
		assert.strictEqual(failuresAndRace.mutationRejected, true);
		assert.deepStrictEqual(failuresAndRace.observedSnapshots, [
			{ names: ['git', 'tar'], gitDescription: 'before' },
			{ names: ['git'], gitDescription: 'before' },
		]);
		assert.deepStrictEqual(failuresAndRace.raceStoredNames, ['git']);

		console.log('Storage migration integration checks passed.');
	} finally {
		rmSync(profileRoot, { recursive: true, force: true });
	}
}

void main().catch(error => {
	console.error('Storage migration integration checks failed', error);
	process.exit(1);
});
