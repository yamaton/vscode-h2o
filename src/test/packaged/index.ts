import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Command } from '../../command';
import type {
	CaretDebugReport,
	LiveEditorDebugState,
	LiveEditorDebugToggleResult,
} from '../../extension';

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
	const completionConfiguration = vscode.workspace.getConfiguration('shellCompletion');
	await completionConfiguration.update(
		'enableCompletion',
		false,
		vscode.ConfigurationTarget.Global,
	);

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
	const settings = extension.packageJSON.contributes.configuration.properties as Record<
		string,
		Record<string, unknown>
	>;
	assert.deepStrictEqual(
		{
			type: settings['shellCompletion.enableCompletion']?.type,
			default: settings['shellCompletion.enableCompletion']?.default,
			scope: settings['shellCompletion.enableCompletion']?.scope,
		},
		{ type: 'boolean', default: true, scope: 'window' },
		'the installed VSIX must expose the completion provider switch as a window setting',
	);
	assert.deepStrictEqual(
		{
			type: settings['shellCompletion.scanUnknownCommands']?.type,
			default: settings['shellCompletion.scanUnknownCommands']?.default,
			scope: settings['shellCompletion.scanUnknownCommands']?.scope,
		},
		{ type: 'boolean', default: true, scope: 'machine' },
		'the installed VSIX must expose the unknown-command scan policy as a machine setting',
	);
	assert.strictEqual(
		settings['shellCompletion.h2oPath']?.scope,
		'machine',
		'the installed VSIX must keep the scanner executable path outside workspace settings',
	);
	const commands = new Set(await vscode.commands.getCommands(true));
	for (const command of [
		'h2o.clearCache',
		'h2o.inspectCaretContext',
		'h2o.loadCommand',
		'h2o.openTreeSitterDebugSnapshot',
		'h2o.pauseLiveDebug',
		'h2o.resumeLiveDebug',
		'h2o.showLiveDebugViews',
		'h2o.toggleLiveCaretAndCursorContext',
		'registeredCommands.refreshEntry',
	]) {
		assert.ok(commands.has(command), `${command} must be registered by the packaged extension`);
	}

	const originalFetch = packagedCachingFetcher.prototype.fetch;
	let fetchCalls = 0;
	packagedCachingFetcher.prototype.fetch = async function fetch(name: string): Promise<Command> {
		fetchCalls += 1;
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
		const editor = await vscode.window.showTextDocument(document, { preview: false });
		const caret = document.positionAt(document.getText().length);
		editor.selection = new vscode.Selection(caret, caret);
		const disabledCompletion = await withTimeout(
			vscode.commands.executeCommand<vscode.CompletionList>(
				'vscode.executeCompletionItemProvider',
				document.uri,
				caret,
			),
			10000,
		);
		assert.ok(
			!disabledCompletion.items.some(item =>
				(typeof item.label === 'string' ? item.label : item.label.label)
				=== '--vscode-h2o-packaged-smoke'
			),
			'the installed VSIX must not provide completion while disabled at activation',
		);
		assert.strictEqual(fetchCalls, 0);

		await completionConfiguration.update(
			'enableCompletion',
			true,
			vscode.ConfigurationTarget.Global,
		);
		const completion = await withTimeout(
			vscode.commands.executeCommand<vscode.CompletionList>(
				'vscode.executeCompletionItemProvider',
				document.uri,
				caret,
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
		assert.strictEqual(fetchCalls, 1);

		const debugReport = await withTimeout(
			vscode.commands.executeCommand<CaretDebugReport>('h2o.inspectCaretContext'),
			10000,
		);
		assert.strictEqual(debugReport.document.uri, document.uri.toString());
		assert.strictEqual(debugReport.cached.completion.invocation?.name.text, 'git');
		assert.deepStrictEqual(debugReport.cached.completion.resolution?.path, ['git']);
		assert.deepStrictEqual(debugReport.comparison, {
			syntaxAtCaretEquivalent: true,
			completionEquivalent: true,
			hoverEquivalent: true,
		});

		const liveDebug = await withTimeout(
			vscode.commands.executeCommand<LiveEditorDebugToggleResult>(
				'h2o.toggleLiveCaretAndCursorContext',
				true,
			),
			10000,
		);
		assert.strictEqual(liveDebug.enabled, true);
		assert.strictEqual(liveDebug.snapshot?.caretNode.type, 'word');
		assert.strictEqual(liveDebug.snapshot?.caretNode.grammarType, 'word');
		const liveState = await vscode.commands.executeCommand<LiveEditorDebugState>(
			'h2o.getLiveCaretAndCursorContextState',
		);
		assert.strictEqual(liveState.presentation.statusText, 'H2O C✓ H— TS:word');
		assert.strictEqual(liveState.presentation.completion[0]?.description, 'Enabled');
		await vscode.commands.executeCommand('h2o.toggleLiveCaretAndCursorContext', false);
	} finally {
		packagedCachingFetcher.prototype.fetch = originalFetch;
	}
}
