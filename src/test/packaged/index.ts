import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Command } from '../../command';

const extensionId = 'tetradresearch.vscode-h2o';

async function withTimeout<T>(operation: PromiseLike<T>, timeoutMs: number): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<T>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error(`Operation exceeded ${timeoutMs} ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

export async function run(): Promise<void> {
	const extension = vscode.extensions.getExtension(extensionId);
	assert.ok(extension, `${extensionId} must be installed from the VSIX`);

	const sourceRoot = path.resolve(process.env.VSCODE_H2O_SOURCE_ROOT!);
	const extensionsDir = path.resolve(process.env.VSCODE_H2O_EXTENSIONS_DIR!);
	const extensionPath = path.resolve(extension.extensionPath);
	assert.ok(extensionPath.startsWith(`${extensionsDir}${path.sep}`), `${extensionPath} must be inside the isolated extensions directory`);
	assert.ok(extensionPath !== sourceRoot && !extensionPath.startsWith(`${sourceRoot}${path.sep}`), 'the source checkout must not satisfy the VSIX smoke test');

	const packagedCacheFetcherModule = require(path.join(extensionPath, 'out/cacheFetcher.js')) as typeof import('../../cacheFetcher');
	const packagedCachingFetcher = packagedCacheFetcherModule.CachingFetcher;
	const originalStartInitialCuratedFetch = packagedCachingFetcher.prototype.startInitialCuratedFetch;
	packagedCachingFetcher.prototype.startInitialCuratedFetch = async () => undefined;
	try {
		await withTimeout(extension.activate(), 10000);
	} finally {
		packagedCachingFetcher.prototype.startInitialCuratedFetch = originalStartInitialCuratedFetch;
	}
	assert.strictEqual(extension.isActive, true);
	const commands = new Set(await vscode.commands.getCommands(true));
	for (const command of ['h2o.clearCache', 'h2o.loadCommand', 'registeredCommands.refreshEntry']) {
		assert.ok(commands.has(command), `${command} must be registered by the packaged extension`);
	}

	const originalFetch = packagedCachingFetcher.prototype.fetch;
	packagedCachingFetcher.prototype.fetch = async function fetch(name: string): Promise<Command> {
		assert.strictEqual(name, 'git');
		return {
			name: 'git',
			description: 'packaged parser smoke fixture',
			options: [{
				names: ['--vscode-h2o-packaged-smoke'],
				argument: '',
				description: 'packaged parser smoke option',
			}],
		};
	};
	try {
		const document = await vscode.workspace.openTextDocument({
			language: 'shellscript',
			content: 'git --v',
		});
		const completion = await withTimeout(
			vscode.commands.executeCommand<vscode.CompletionList>(
				'vscode.executeCompletionItemProvider',
				document.uri,
				document.positionAt(document.getText().length),
			),
			10000,
		);
		assert.ok(
			completion.items.some(item =>
				(typeof item.label === 'string' ? item.label : item.label.label)
				=== '--vscode-h2o-packaged-smoke'
			),
			'the installed VSIX must parse a shell document and provide an option completion',
		);
	} finally {
		packagedCachingFetcher.prototype.fetch = originalFetch;
	}
}
