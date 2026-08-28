import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

import { runTests } from '@vscode/test-electron';

async function main() {
	try {
		// The folder containing the Extension Manifest package.json
		// Passed to `--extensionDevelopmentPath`
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');

		// The path to test runner
		// Passed to --extensionTestsPath
		const extensionTestsPath = path.resolve(__dirname, './suite/index');
		const profileRoot = mkdtempSync(path.join(tmpdir(), 'vscode-h2o-integration-'));
		const userDataDir = path.join(profileRoot, 'user-data');
		const extensionsDir = path.join(profileRoot, 'extensions');
		mkdirSync(userDataDir, { recursive: true });
		mkdirSync(extensionsDir, { recursive: true });

		try {
			// Download VS Code, unzip it and run the integration test. CI overrides
			// VSCODE_VERSION to exercise both stable and the declared engine floor.
			await runTests({
				...(process.env.VSCODE_EXECUTABLE_PATH
					? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH }
					: { version: process.env.VSCODE_VERSION || 'stable' }),
				extensionDevelopmentPath,
				extensionTestsPath,
				launchArgs: [
					`--user-data-dir=${userDataDir}`,
					`--extensions-dir=${extensionsDir}`,
					'--disable-extensions',
					'--disable-workspace-trust',
					'--skip-release-notes',
					'--skip-welcome',
					...(process.env.VSCODE_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
				],
			});
		} finally {
			rmSync(profileRoot, { recursive: true, force: true });
		}
	} catch (err) {
		console.error('Failed to run tests', err);
		process.exit(1);
	}
}

void main();
