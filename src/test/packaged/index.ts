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

async function updateGlobalConfiguration<T>(
	configuration: vscode.WorkspaceConfiguration,
	key: string,
	value: T | undefined,
): Promise<void> {
	if (Object.is(configuration.inspect<T>(key)?.globalValue, value)) {
		return;
	}
	const changed = new Promise<void>(resolve => {
		const registration = vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(`shellCompletion.${key}`)) {
				registration.dispose();
				resolve();
			}
		});
	});
	await configuration.update(key, value, vscode.ConfigurationTarget.Global);
	await withTimeout(changed, 10000);
}

function loadActivatedExtensionModule<T>(extensionPath: string, relativePath: string): T {
	const expectedPath = path.resolve(extensionPath, relativePath);
	const normalizedExpectedPath = process.platform === 'win32'
		? expectedPath.toLowerCase()
		: expectedPath;
	const cachePath = Object.keys(require.cache).find(candidate => {
		const resolvedCandidate = path.resolve(candidate);
		return (process.platform === 'win32' ? resolvedCandidate.toLowerCase() : resolvedCandidate)
			=== normalizedExpectedPath;
	});
	assert.ok(cachePath, `${relativePath} must be loaded by the installed extension`);
	return require(cachePath) as T;
}

export async function run(): Promise<void> {
	const expectScannerlessWindows = process.env.VSCODE_H2O_EXPECT_SCANNERLESS_WINDOWS === '1';
	if (expectScannerlessWindows) {
		assert.strictEqual(process.platform, 'win32', 'the scannerless Windows smoke must run on Windows');
	}
	const extension = vscode.extensions.getExtension(extensionId);
	assert.ok(extension, `${extensionId} must be installed from the VSIX`);
	const completionConfiguration = vscode.workspace.getConfiguration('shellCompletion');
	await updateGlobalConfiguration(
		completionConfiguration,
		'enableCompletion',
		expectScannerlessWindows ? undefined : false,
	);
	await updateGlobalConfiguration(
		completionConfiguration,
		'scanUnknownCommands',
		expectScannerlessWindows ? undefined : false,
	);

	const sourceRoot = path.resolve(process.env.VSCODE_H2O_SOURCE_ROOT!);
	const extensionsDir = path.resolve(process.env.VSCODE_H2O_EXTENSIONS_DIR!);
	const extensionPath = path.resolve(extension.extensionPath);
	assert.ok(extensionPath.startsWith(`${extensionsDir}${path.sep}`), `${extensionPath} must be inside the isolated extensions directory`);
	assert.ok(extensionPath !== sourceRoot && !extensionPath.startsWith(`${sourceRoot}${path.sep}`), 'the source checkout must not satisfy the VSIX smoke test');

	await withTimeout(extension.activate(), 10000);
	assert.strictEqual(extension.isActive, true);
	const packagedCacheFetcherModule = loadActivatedExtensionModule<typeof import('../../cacheFetcher')>(
		extensionPath,
		'out/cacheFetcher.js',
	);
	const packagedCachingFetcher = packagedCacheFetcherModule.CachingFetcher;
	if (expectScannerlessWindows) {
		const packagedH2oRunnerModule = loadActivatedExtensionModule<{
			runH2o: typeof import('../../h2oRunner').runH2o;
		}>(extensionPath, 'out/h2oRunner.js');
		const originalRunH2o = packagedH2oRunnerModule.runH2o;
		let localScanCalls = 0;
		try {
			packagedH2oRunnerModule.runH2o = async () => {
				localScanCalls += 1;
				return undefined;
			};
			await updateGlobalConfiguration(
				completionConfiguration,
				'scanUnknownCommands',
				true,
			);
			const unknownDocument = await vscode.workspace.openTextDocument({
				language: 'shellscript',
				content: 'vscode-h2o-scannerless-probe --v',
			});
			const unknownCaret = unknownDocument.positionAt(unknownDocument.getText().length);
			await withTimeout(
				vscode.commands.executeCommand<vscode.CompletionList>(
					'vscode.executeCompletionItemProvider',
					unknownDocument.uri,
					unknownCaret,
				),
				10000,
			);
			assert.strictEqual(
				localScanCalls,
				0,
				'the Windows Extension Host must ignore an enabled local scan setting',
			);
		} finally {
			packagedH2oRunnerModule.runH2o = originalRunH2o;
			await updateGlobalConfiguration(
				completionConfiguration,
				'scanUnknownCommands',
				undefined,
			);
		}
	}
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
		{ type: 'boolean', default: false, scope: 'machine' },
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
		if (!expectScannerlessWindows) {
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

			await updateGlobalConfiguration(
				completionConfiguration,
				'enableCompletion',
				true,
			);
		}
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

		const hoverSource = 'git --vscode-h2o-packaged-smoke';
		const hoverDocument = await vscode.workspace.openTextDocument({
			language: 'shellscript',
			content: hoverSource,
		});
		const hoverPosition = new vscode.Position(0, hoverSource.indexOf('packaged'));
		const hovers = await withTimeout(
			vscode.commands.executeCommand<vscode.Hover[]>(
				'vscode.executeHoverProvider',
				hoverDocument.uri,
				hoverPosition,
			),
			10000,
		);
		const hoverText = hovers
			.flatMap(hover => hover.contents)
			.map(content => typeof content === 'string' ? content : content.value)
			.join('\n');
		assert.ok(
			hoverText.includes('packaged parser smoke option'),
			'the installed VSIX must provide hover from cached command data',
		);

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
