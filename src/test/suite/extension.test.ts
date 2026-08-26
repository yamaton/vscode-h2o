import * as assert from 'assert';
import * as vscode from 'vscode';

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

async function activateExtension(): Promise<vscode.Extension<unknown>> {
	const extension = vscode.extensions.getExtension(extensionId);
	assert.ok(extension, `${extensionId} must be installed in the Extension Host`);
	await withTimeout(extension.activate(), 10000);
	assert.strictEqual(extension.isActive, true);
	return extension;
}

async function verifyRegisteredCommands(): Promise<void> {
	const registered = new Set(await vscode.commands.getCommands(true));
	const expected = [
		'h2o.clearCache',
		'h2o.loadBio',
		'h2o.loadCommand',
		'h2o.loadCommon',
		'h2o.removeBio',
		'registeredCommands.refreshEntry',
		'registeredCommands.removeEntry',
	];

	for (const command of expected) {
		assert.ok(registered.has(command), `${command} must be registered during activation`);
	}
}

async function verifyCommandHandlers(): Promise<void> {
	await vscode.commands.executeCommand('registeredCommands.refreshEntry');
	await vscode.commands.executeCommand('h2o.clearCache', '__vscode_h2o_integration_missing__');
	await vscode.commands.executeCommand(
		'registeredCommands.removeEntry',
		new vscode.TreeItem('__vscode_h2o_integration_missing__'),
	);
	await vscode.commands.executeCommand('h2o.loadCommand', ' ');
}

export async function runExtensionTests(): Promise<void> {
	await activateExtension();
	await verifyRegisteredCommands();
	await verifyCommandHandlers();
}
