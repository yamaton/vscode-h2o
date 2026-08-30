import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
	downloadAndUnzipVSCode,
	resolveCliPathFromVSCodeExecutablePath,
	runTests,
} from '@vscode/test-electron';

async function main(): Promise<void> {
	const projectRoot = path.resolve(__dirname, '../../');
	const vsixPath = path.resolve(projectRoot, process.argv[2] || 'artifacts/vscode-h2o-linux-x64.vsix');
	assert.ok(statSync(vsixPath).isFile(), `${vsixPath} must be a VSIX file`);

	const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH
		|| await downloadAndUnzipVSCode({ version: process.env.VSCODE_VERSION || 'stable' });
	const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);
	const profileRoot = mkdtempSync(path.join(tmpdir(), 'vscode-h2o-vsix-'));
	const userDataDir = path.join(profileRoot, 'user-data');
	const extensionsDir = path.join(profileRoot, 'extensions');
	mkdirSync(userDataDir, { recursive: true });
	mkdirSync(extensionsDir, { recursive: true });

	const profileArguments = [
		`--user-data-dir=${userDataDir}`,
		`--extensions-dir=${extensionsDir}`,
	];
	const cliEnvironment: NodeJS.ProcessEnv = {
		...process.env,
		['DONT_PROMPT_WSL_INSTALL']: '1',
	};
	delete cliEnvironment['VSCODE_IPC_HOOK_CLI'];

	try {
		execFileSync(cliPath, [...profileArguments, '--install-extension', vsixPath, '--force'], {
			encoding: 'utf8',
			env: cliEnvironment,
			shell: process.platform === 'win32',
			stdio: 'inherit',
		});

		await runTests({
			vscodeExecutablePath,
			reuseMachineInstall: true,
			extensionDevelopmentPath: path.join(projectRoot, 'test/packaged-runner'),
			extensionTestsPath: path.join(projectRoot, 'out/test/packaged/index'),
			extensionTestsEnv: {
				['VSCODE_H2O_SOURCE_ROOT']: projectRoot,
				['VSCODE_H2O_EXTENSIONS_DIR']: extensionsDir,
			},
			launchArgs: [
				...profileArguments,
				'--disable-workspace-trust',
				'--skip-release-notes',
				'--skip-welcome',
				...(process.env.VSCODE_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
			],
		});
	} finally {
		rmSync(profileRoot, { recursive: true, force: true });
	}
}

void main().catch(error => {
	console.error('Packaged VSIX smoke test failed', error);
	process.exit(1);
});
