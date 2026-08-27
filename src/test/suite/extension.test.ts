import * as assert from 'assert';
import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { SyntaxNode } from 'web-tree-sitter';
import { Response } from 'node-fetch';
import * as pako from 'pako';
import {
	disposeParserResources,
	getContextCommandName,
	getCurrentNode,
	initializeParser,
	updateTree,
	walkbackIfNeeded,
} from '../../extension';
import type { TreeCache } from '../../extension';
import { CachingFetcher, CachingFetcherDependencies } from '../../cacheFetcher';
import type { Command } from '../../command';

const extensionId = 'tetradresearch.vscode-h2o';

interface InitialCuratedProbe {
	completion: Promise<void>;
	commandNames: string[];
	memento: vscode.Memento;
	startedAt: number;
	updateStarts: number[];
}

let initialCuratedProbe: InitialCuratedProbe | undefined;

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

	const originalStartInitialCuratedFetch = CachingFetcher.prototype.startInitialCuratedFetch;
	const runId = `${Date.now()}-${process.pid}`;
	const commands = Array.from({ length: 128 }, (_value, index): Command => ({
		name: `vscode-h2o-integration-${runId}-${index}`,
		description: 'x'.repeat(4096),
		options: [],
	}));
	const body = Buffer.from(pako.gzip(JSON.stringify(commands)));

	CachingFetcher.prototype.startInitialCuratedFetch = function startInitialCuratedFetch(kind = 'general'): Promise<void> {
		const internals = this as unknown as {
			memento: vscode.Memento;
			dependencies: CachingFetcherDependencies;
		};
		const memento = internals.memento;
		const updateStarts: number[] = [];
		internals.memento = {
			keys: () => memento.keys(),
			get: memento.get.bind(memento) as vscode.Memento['get'],
			update: (key, value) => {
				updateStarts.push(Date.now());
				return memento.update(key, value);
			},
		};
		internals.dependencies = {
			...internals.dependencies,
			fetch: async () => new Response(body, { status: 200 }),
		};
		const startedAt = Date.now();
		const completion = originalStartInitialCuratedFetch.call(this, kind);
		initialCuratedProbe = {
			completion,
			commandNames: commands.map(command => command.name),
			memento,
			startedAt,
			updateStarts,
		};
		return completion;
	};

	try {
		await withTimeout(extension.activate(), 10000);
	} finally {
		CachingFetcher.prototype.startInitialCuratedFetch = originalStartInitialCuratedFetch;
	}
	assert.strictEqual(extension.isActive, true);
	assert.ok(initialCuratedProbe, 'activation must start the controlled curated load');
	return extension;
}

async function verifyInitialCuratedPersistence(): Promise<void> {
	assert.ok(initialCuratedProbe);
	await withTimeout(initialCuratedProbe.completion, 15000);
	assert.strictEqual(initialCuratedProbe.updateStarts.length, initialCuratedProbe.commandNames.length);
	const updateStartSpan = Math.max(...initialCuratedProbe.updateStarts) - Math.min(...initialCuratedProbe.updateStarts);
	assert.ok(updateStartSpan < 1000, `curated Memento writes started over ${updateStartSpan} ms instead of one batch`);
	assert.ok(Date.now() - initialCuratedProbe.startedAt < 15000, 'controlled curated persistence exceeded 15 seconds');
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

interface NodeSnapshot {
	type: string;
	text: string;
	startIndex: number;
	endIndex: number;
	startPosition: Parser.Point;
	endPosition: Parser.Point;
	children: NodeSnapshot[];
}

function snapshot(node: SyntaxNode): NodeSnapshot {
	return {
		type: node.type,
		text: node.text,
		startIndex: node.startIndex,
		endIndex: node.endIndex,
		startPosition: node.startPosition,
		endPosition: node.endPosition,
		children: node.children.map(snapshot),
	};
}

function trackDeletion(tree: Parser.Tree): () => number {
	let count = 0;
	const originalDelete = tree.delete.bind(tree);
	tree.delete = () => {
		count += 1;
		originalDelete();
	};
	return () => count;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

interface DeferredFetch {
	started: Deferred<void>;
	result: Deferred<Command>;
}

function commandForProviderRace(): Command {
	return {
		name: 'git',
		description: 'VSCODE_H2O_RACE_DESCRIPTION',
		options: [{
			names: ['--vscode-h2o-race'],
			argument: '',
			description: 'Option returned only by the h2o race test',
		}],
	};
}

function completionLabel(item: vscode.CompletionItem): string {
	return typeof item.label === 'string' ? item.label : item.label.label;
}

function hoverText(hovers: vscode.Hover[]): string {
	return hovers.flatMap(hover => hover.contents).map(content => {
		return typeof content === 'string' ? content : content.value;
	}).join('\n');
}

async function editDocument(document: vscode.TextDocument, text: string): Promise<void> {
	const edit = new vscode.WorkspaceEdit();
	edit.insert(document.uri, document.positionAt(document.getText().length), text);
	await captureDocumentChange(document, () => vscode.workspace.applyEdit(edit));
}

async function verifyProviderTreeOwnership(parser: Parser): Promise<void> {
	const sampleTree = parser.parse('git');
	const treePrototype = Object.getPrototypeOf(sampleTree) as {
		copy(this: Parser.Tree): Parser.Tree;
		delete(this: Parser.Tree): void;
	};
	const originalCopy = treePrototype.copy;
	const originalDelete = treePrototype.delete;
	const originalFetch = CachingFetcher.prototype.fetch;
	const copyDeleteCounts: Array<() => number> = [];
	const requestTrees = new WeakSet<Parser.Tree>();
	let cacheDeleteCount = 0;
	let activeFetch: DeferredFetch | undefined;
	sampleTree.delete();

	treePrototype.delete = function deleteTree(this: Parser.Tree): void {
		if (!requestTrees.has(this)) {
			cacheDeleteCount += 1;
		}
		originalDelete.call(this);
	};
	treePrototype.copy = function copy(this: Parser.Tree): Parser.Tree {
		const requestTree = originalCopy.call(this);
		requestTrees.add(requestTree);
		copyDeleteCounts.push(trackDeletion(requestTree));
		return requestTree;
	};
	CachingFetcher.prototype.fetch = async function fetch(): Promise<Command> {
		assert.ok(activeFetch, 'a deferred fetch must be installed before invoking a provider');
		activeFetch.started.resolve();
		return activeFetch.result.promise;
	};

	try {
		activeFetch = { started: deferred<void>(), result: deferred<Command>() };
		const completionDocument = await vscode.workspace.openTextDocument({
			language: 'shellscript',
			content: 'git ',
		});
		const completion = vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider',
			completionDocument.uri,
			new vscode.Position(0, 4),
		);
		await withTimeout(activeFetch.started.promise, 5000);
		assert.strictEqual(copyDeleteCounts.length, 1);
		await editDocument(completionDocument, 'status');
		assert.strictEqual(cacheDeleteCount, 1);
		activeFetch.result.resolve(commandForProviderRace());
		const completionList = await withTimeout(completion, 5000);
		assert.ok(completionList.items.some(item => completionLabel(item) === '--vscode-h2o-race'));
		assert.strictEqual(copyDeleteCounts[0](), 1);

		activeFetch = { started: deferred<void>(), result: deferred<Command>() };
		const hoverDocument = await vscode.workspace.openTextDocument({
			language: 'shellscript',
			content: 'git',
		});
		const hover = vscode.commands.executeCommand<vscode.Hover[]>(
			'vscode.executeHoverProvider',
			hoverDocument.uri,
			new vscode.Position(0, 1),
		);
		await withTimeout(activeFetch.started.promise, 5000);
		assert.strictEqual(copyDeleteCounts.length, 2);
		await editDocument(hoverDocument, ' status');
		assert.strictEqual(cacheDeleteCount, 2);
		activeFetch.result.resolve(commandForProviderRace());
		const hovers = await withTimeout(hover, 5000);
		assert.ok(hoverText(hovers).includes('VSCODE_H2O_RACE_DESCRIPTION'));
		assert.strictEqual(copyDeleteCounts[1](), 1);

		activeFetch = { started: deferred<void>(), result: deferred<Command>() };
		const rejectedHoverDocument = await vscode.workspace.openTextDocument({
			language: 'shellscript',
			content: 'git',
		});
		const rejectedHover = vscode.commands.executeCommand<vscode.Hover[]>(
			'vscode.executeHoverProvider',
			rejectedHoverDocument.uri,
			new vscode.Position(0, 1),
		);
		await withTimeout(activeFetch.started.promise, 5000);
		assert.strictEqual(copyDeleteCounts.length, 3);
		activeFetch.result.reject(new Error('controlled provider failure'));
		await withTimeout(rejectedHover, 5000);
		assert.strictEqual(copyDeleteCounts[2](), 1);
	} finally {
		activeFetch?.result.reject(new Error('provider ownership test cleanup'));
		treePrototype.copy = originalCopy;
		treePrototype.delete = originalDelete;
		CachingFetcher.prototype.fetch = originalFetch;
	}
}

async function verifyCompletionRefreshesCommandList(): Promise<void> {
	const originalFetch = CachingFetcher.prototype.fetch;
	const originalGetList = CachingFetcher.prototype.getList;
	const fetchStarted = deferred<void>();
	const releaseFetch = deferred<void>();
	let commandListAvailable = false;

	CachingFetcher.prototype.getList = function getList(): string[] {
		return commandListAvailable ? ['git'] : [];
	};
	CachingFetcher.prototype.fetch = async function fetch(): Promise<Command> {
		fetchStarted.resolve();
		await releaseFetch.promise;
		commandListAvailable = true;
		throw new Error('controlled command lookup failure');
	};

	try {
		const document = await vscode.workspace.openTextDocument({
			language: 'shellscript',
			content: 'gi',
		});
		const completion = vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider',
			document.uri,
			new vscode.Position(0, 2),
		);
		await withTimeout(fetchStarted.promise, 5000);
		releaseFetch.resolve();
		const completionList = await withTimeout(completion, 5000);

		assert.ok(completionList.items.some(item => completionLabel(item) === 'git'));
	} finally {
		releaseFetch.resolve();
		CachingFetcher.prototype.fetch = originalFetch;
		CachingFetcher.prototype.getList = originalGetList;
	}
}

async function verifyCommandContext(parser: Parser): Promise<void> {
	const content = [
		'git status; npm test | grep ok',
		'git \\',
		'  --flag',
		'echo ',
		'git "unterminated',
	].join('\n');
	const document = await vscode.workspace.openTextDocument({ language: 'shellscript', content });
	const tree = parser.parse(document.getText());
	const root = tree.rootNode;

	assert.strictEqual(getCurrentNode(root, new vscode.Position(0, 1)).text, 'git');
	assert.strictEqual(getCurrentNode(root, new vscode.Position(0, 10)).text, 'status');
	assert.strictEqual(getCurrentNode(root, new vscode.Position(0, 11)).type, ';');
	assert.strictEqual(getContextCommandName(root, new vscode.Position(0, 13)), 'npm');
	assert.strictEqual(getContextCommandName(root, new vscode.Position(0, 24)), 'grep');
	assert.strictEqual(getContextCommandName(root, new vscode.Position(2, 8)), 'git');

	const afterEchoSpace = new vscode.Position(3, 5);
	const walkedEchoPosition = walkbackIfNeeded(document, root, afterEchoSpace);
	assert.deepStrictEqual(walkedEchoPosition, new vscode.Position(3, 4));
	assert.strictEqual(getContextCommandName(root, walkedEchoPosition), 'echo');

	const afterSemicolon = new vscode.Position(0, 11);
	assert.strictEqual(walkbackIfNeeded(document, root, afterSemicolon), afterSemicolon);

	const incompleteQuoteEnd = new vscode.Position(4, 17);
	const walkedIncompletePosition = walkbackIfNeeded(document, root, incompleteQuoteEnd);
	assert.strictEqual(getContextCommandName(root, walkedIncompletePosition), 'git');

	tree.delete();
}

async function captureDocumentChange(
	document: vscode.TextDocument,
	apply: () => Thenable<boolean>,
): Promise<vscode.TextDocumentChangeEvent> {
	let subscription: vscode.Disposable | undefined;
	const event = new Promise<vscode.TextDocumentChangeEvent>((resolve) => {
		subscription = vscode.workspace.onDidChangeTextDocument((change) => {
			if (change.document.uri.toString() === document.uri.toString() && change.contentChanges.length > 0) {
				resolve(change);
			}
		});
	});

	try {
		assert.strictEqual(await apply(), true);
		return await withTimeout(event, 5000);
	} finally {
		subscription?.dispose();
	}
}

async function verifyIncrementalParsing(parser: Parser): Promise<void> {
	const document = await vscode.workspace.openTextDocument({
		language: 'shellscript',
		content: 'git status\necho ok',
	});
	const key = document.uri.toString();
	const trees: TreeCache = { [key]: parser.parse(document.getText()) };

	const firstTree = trees[key];
	const firstTreeDeleteCount = trackDeletion(firstTree);
	const replacement = new vscode.WorkspaceEdit();
	replacement.replace(document.uri, new vscode.Range(0, 4, 0, 10), 'log --oneline');
	const replacementEvent = await captureDocumentChange(document, () => vscode.workspace.applyEdit(replacement));
	updateTree(parser, trees, replacementEvent);
	assert.strictEqual(firstTreeDeleteCount(), 1);
	assert.notStrictEqual(trees[key], firstTree);

	let fresh = parser.parse(document.getText());
	assert.deepStrictEqual(snapshot(trees[key].rootNode), snapshot(fresh.rootNode));
	fresh.delete();

	const secondTree = trees[key];
	const secondTreeDeleteCount = trackDeletion(secondTree);
	const multilineReplacement = new vscode.WorkspaceEdit();
	multilineReplacement.replace(document.uri, new vscode.Range(0, 3, 1, 0), ' status ');
	const multilineEvent = await captureDocumentChange(document, () => vscode.workspace.applyEdit(multilineReplacement));
	updateTree(parser, trees, multilineEvent);
	assert.strictEqual(secondTreeDeleteCount(), 1);
	assert.notStrictEqual(trees[key], secondTree);

	fresh = parser.parse(document.getText());
	assert.deepStrictEqual(snapshot(trees[key].rootNode), snapshot(fresh.rootNode));
	fresh.delete();
	trees[key].delete();
}

async function verifyUnrelatedLanguagesAreIgnored(parser: Parser): Promise<void> {
	const document = await vscode.workspace.openTextDocument({
		language: 'typescript',
		content: 'const value = 1;',
	});
	const trees: TreeCache = {};
	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, new vscode.Range(0, 14, 0, 15), '2');
	const event = await captureDocumentChange(document, () => vscode.workspace.applyEdit(edit));

	updateTree(parser, trees, event);
	assert.deepStrictEqual(Object.keys(trees), []);
}

async function verifyParserResourceDisposal(): Promise<void> {
	const parser = await initializeParser();
	const trees: TreeCache = {
		first: parser.parse('echo first'),
		second: parser.parse('echo second'),
	};
	const firstDeleteCount = trackDeletion(trees.first);
	const secondDeleteCount = trackDeletion(trees.second);
	let parserDeleteCount = 0;
	const parserResource = {
		delete: () => {
			parserDeleteCount += 1;
			parser.delete();
		},
	};

	disposeParserResources(parserResource, trees);
	assert.strictEqual(firstDeleteCount(), 1);
	assert.strictEqual(secondDeleteCount(), 1);
	assert.strictEqual(parserDeleteCount, 1);
	assert.deepStrictEqual(Object.keys(trees), []);
}

suiteSetup(async () => {
	await activateExtension();
});

suiteTeardown(async () => {
	if (initialCuratedProbe) {
		await Promise.all(initialCuratedProbe.commandNames.map(name =>
			initialCuratedProbe!.memento.update(CachingFetcher.getKey(name), undefined)
		));
	}
});

suite('Extension activation', () => {
	test('registers contributed commands', verifyRegisteredCommands);
	test('batches controlled curated writes through real globalState', verifyInitialCuratedPersistence);
	test('handles non-destructive command paths', verifyCommandHandlers);
});

suite('Parser and provider behavior', () => {
	let parser: Parser;

	suiteSetup(async () => {
		parser = await initializeParser();
	});

	suiteTeardown(() => {
		parser.delete();
	});

	test('resolves command context', async () => verifyCommandContext(parser));
	test('keeps incremental trees equivalent to fresh parses', async () => verifyIncrementalParsing(parser));
	test('ignores edits in unrelated languages', async () => verifyUnrelatedLanguagesAreIgnored(parser));
	test('owns provider tree copies across document races', async () => verifyProviderTreeOwnership(parser));
	test('refreshes command names after asynchronous lookup', verifyCompletionRefreshesCommandList);
});

suite('Parser resource disposal', () => {
	test('deletes cached trees and the parser', verifyParserResourceDisposal);
});
