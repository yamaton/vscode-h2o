import * as assert from 'assert';
import { gzipSync } from 'node:zlib';
import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import { SyntaxNode } from 'web-tree-sitter';
import { Response } from 'node-fetch';
import {
	activate,
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
import { withParsedTree } from '../parserTestUtils';

const extensionId = 'tetradresearch.vscode-h2o';
const cursorMarker = '<|cursor|>';

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
	const body = gzipSync(JSON.stringify(commands));

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

interface MarkedSource {
	content: string;
	offset: number;
}

function extractCursor(markedContent: string): MarkedSource {
	const offset = markedContent.indexOf(cursorMarker);
	assert.notStrictEqual(offset, -1, 'A cursor marker is required');
	assert.strictEqual(
		markedContent.indexOf(cursorMarker, offset + cursorMarker.length),
		-1,
		'Only one cursor marker is allowed',
	);
	return {
		content: markedContent.slice(0, offset) + markedContent.slice(offset + cursorMarker.length),
		offset,
	};
}

interface CommandContextObservation {
	commandName: string | undefined;
	currentNodeText: string;
	currentNodeType: string;
	moved: boolean;
}

async function observeCommandContext(
	parser: Parser,
	markedContent: string,
	walkback: boolean,
): Promise<CommandContextObservation> {
	const { content, offset } = extractCursor(markedContent);
	const document = await vscode.workspace.openTextDocument({ language: 'shellscript', content });
	return withParsedTree(parser, content, tree => {
		const cursor = document.positionAt(offset);
		const position = walkback ? walkbackIfNeeded(document, tree.rootNode, cursor) : cursor;
		const currentNode = getCurrentNode(tree.rootNode, position);
		return {
			commandName: getContextCommandName(tree.rootNode, position),
			currentNodeText: currentNode.text,
			currentNodeType: currentNode.type,
			moved: !position.isEqual(cursor),
		};
	});
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

function trackEdits(tree: Parser.Tree): Parser.Edit[] {
	const edits: Parser.Edit[] = [];
	const originalEdit = tree.edit.bind(tree);
	tree.edit = (delta) => {
		edits.push(delta);
		return originalEdit(delta);
	};
	return edits;
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
		const trustedMarkdown = hovers
			.flatMap(result => result.contents)
			.find((content): content is vscode.MarkdownString =>
				typeof content !== 'string' && 'isTrusted' in content
			);
		assert.ok(trustedMarkdown, 'the root command hover must contain trusted Markdown');
		assert.deepStrictEqual(trustedMarkdown.isTrusted, {
			enabledCommands: ['h2o.clearCache'],
		});
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
	const cases: Array<{
		description: string;
		markedContent: string;
		expectedCommandName: string | undefined;
		expectedNodeText?: string;
		expectedNodeType?: string;
	}> = [
		{
			description: 'command name',
			markedContent: `g${cursorMarker}it status`,
			expectedCommandName: 'git',
			expectedNodeText: 'git',
		},
		{
			description: 'command argument',
			markedContent: `git status${cursorMarker}`,
			expectedCommandName: 'git',
			expectedNodeText: 'status',
		},
		{
			description: 'argument end before a semicolon',
			markedContent: `git status${cursorMarker}; npm test`,
			expectedCommandName: 'git',
			expectedNodeText: 'status',
		},
		{
			description: 'command after a semicolon',
			markedContent: `git status; np${cursorMarker}m test`,
			expectedCommandName: 'npm',
		},
		{
			description: 'command inside a pipeline',
			markedContent: `npm test | gr${cursorMarker}ep ok`,
			expectedCommandName: 'grep',
		},
		{
			description: 'quoted argument',
			markedContent: `printf "%s ${cursorMarker}value" done`,
			expectedCommandName: 'printf',
		},
		{
			description: 'command after environment assignments',
			markedContent: `A=1 B=two gi${cursorMarker}t status`,
			expectedCommandName: 'git',
		},
		{
			description: 'function body',
			markedContent: `deploy() { gi${cursorMarker}t status; }`,
			expectedCommandName: 'git',
		},
		{
			description: 'command substitution inside a string',
			markedContent: `echo "$(gi${cursorMarker}t status)"`,
			expectedCommandName: 'git',
		},
		{
			description: 'process substitution',
			markedContent: `diff <(gi${cursorMarker}t show HEAD) file`,
			expectedCommandName: 'git',
		},
		{
			description: 'if body',
			markedContent: `if true; then gi${cursorMarker}t status; fi`,
			expectedCommandName: 'git',
		},
		{
			description: 'while body',
			markedContent: `while true; do sle${cursorMarker}ep 1; done`,
			expectedCommandName: 'sleep',
		},
		{
			description: 'redirected command body',
			markedContent: `cat inp${cursorMarker}ut.txt > output.txt`,
			expectedCommandName: 'cat',
		},
		{
			description: 'semicolon boundary',
			markedContent: `git status;${cursorMarker} npm test`,
			expectedCommandName: undefined,
			expectedNodeType: ';',
		},
	];

	for (const contextCase of cases) {
		const observation = await observeCommandContext(parser, contextCase.markedContent, false);
		assert.strictEqual(observation.commandName, contextCase.expectedCommandName, contextCase.description);
		if (contextCase.expectedNodeText !== undefined) {
			assert.strictEqual(observation.currentNodeText, contextCase.expectedNodeText, contextCase.description);
		}
		if (contextCase.expectedNodeType !== undefined) {
			assert.strictEqual(observation.currentNodeType, contextCase.expectedNodeType, contextCase.description);
		}
	}
}

async function verifyWalkbackCommandContext(parser: Parser): Promise<void> {
	const cases: Array<{
		description: string;
		markedContent: string;
		expectedCommandName: string | undefined;
		expectedNodeType?: string;
		expectedMoved?: boolean;
	}> = [
		{
			description: 'trailing spaces',
			markedContent: `echo   ${cursorMarker}`,
			expectedCommandName: 'echo',
			expectedMoved: true,
		},
		{
			description: 'line continuation',
			markedContent: `git \\\n  ${cursorMarker}`,
			expectedCommandName: 'git',
			expectedMoved: true,
		},
		{
			description: 'incomplete quote',
			markedContent: `git "unterminated${cursorMarker}`,
			expectedCommandName: 'git',
		},
		{
			description: 'trailing space after a semicolon',
			markedContent: `git status;  ${cursorMarker}`,
			expectedCommandName: undefined,
			expectedNodeType: ';',
			expectedMoved: true,
		},
	];

	for (const contextCase of cases) {
		const observation = await observeCommandContext(parser, contextCase.markedContent, true);
		assert.strictEqual(observation.commandName, contextCase.expectedCommandName, contextCase.description);
		if (contextCase.expectedNodeType !== undefined) {
			assert.strictEqual(observation.currentNodeType, contextCase.expectedNodeType, contextCase.description);
		}
		if (contextCase.expectedMoved !== undefined) {
			assert.strictEqual(observation.moved, contextCase.expectedMoved, contextCase.description);
		}
	}
}

async function verifyIterativeWalkback(parser: Parser): Promise<void> {
	for (const content of [
		'tool alpha |   ',
		'tool alpha |&   ',
		'tool alpha &&   ',
		'tool alpha ||   ',
		'tool alpha &   ',
	]) {
		const document = await vscode.workspace.openTextDocument({ language: 'shellscript', content });
		const tree = parser.parse(document.getText());
		try {
			const walked = walkbackIfNeeded(
				document,
				tree.rootNode,
				document.positionAt(content.length),
			);
			assert.deepStrictEqual(walked, new vscode.Position(0, 10));
			assert.strictEqual(getContextCommandName(tree.rootNode, walked), 'tool');
		} finally {
			tree.delete();
		}
	}

	const content = `tool alpha ${' '.repeat(20_000)}`;
	const document = await vscode.workspace.openTextDocument({ language: 'shellscript', content });
	const tree = parser.parse(document.getText());
	try {
		const walked = walkbackIfNeeded(
			document,
			tree.rootNode,
			document.positionAt(content.length),
		);
		assert.deepStrictEqual(walked, new vscode.Position(0, 10));
		assert.strictEqual(getContextCommandName(tree.rootNode, walked), 'tool');
	} finally {
		tree.delete();
	}
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

async function verifyIncrementalEditCoordinates(parser: Parser): Promise<void> {
	const shorteningDocument = await vscode.workspace.openTextDocument({
		language: 'shellscript',
		content: 'git status\necho ok',
	});
	const shorteningKey = shorteningDocument.uri.toString();
	const shorteningTree = parser.parse(shorteningDocument.getText());
	const shorteningEdits = trackEdits(shorteningTree);
	const shorteningTrees: TreeCache = { [shorteningKey]: shorteningTree };
	const shortening = new vscode.WorkspaceEdit();
	shortening.replace(shorteningDocument.uri, new vscode.Range(0, 4, 0, 10), 'st');
	const shorteningEvent = await captureDocumentChange(
		shorteningDocument,
		() => vscode.workspace.applyEdit(shortening),
	);
	updateTree(parser, shorteningTrees, shorteningEvent);
	assert.deepStrictEqual(shorteningEdits, [{
		startIndex: 4,
		oldEndIndex: 10,
		newEndIndex: 6,
		startPosition: { row: 0, column: 4 },
		oldEndPosition: { row: 0, column: 10 },
		newEndPosition: { row: 0, column: 6 },
	}]);
	let fresh = parser.parse(shorteningDocument.getText());
	assert.deepStrictEqual(snapshot(shorteningTrees[shorteningKey].rootNode), snapshot(fresh.rootNode));
	fresh.delete();
	shorteningTrees[shorteningKey].delete();

	const multipleDocument = await vscode.workspace.openTextDocument({
		language: 'shellscript',
		content: 'git status\necho keep\nnpm test',
	});
	const multipleKey = multipleDocument.uri.toString();
	const multipleTree = parser.parse(multipleDocument.getText());
	const multipleEdits = trackEdits(multipleTree);
	const multipleTrees: TreeCache = { [multipleKey]: multipleTree };
	const multiple = new vscode.WorkspaceEdit();
	multiple.replace(multipleDocument.uri, new vscode.Range(0, 4, 0, 10), 'log\n--oneline');
	multiple.replace(multipleDocument.uri, new vscode.Range(1, 5, 1, 9), 'kept value');
	multiple.replace(multipleDocument.uri, new vscode.Range(2, 4, 2, 8), 'run --silent');
	const multipleEvent = await captureDocumentChange(multipleDocument, () => vscode.workspace.applyEdit(multiple));
	const ascendingMultipleEvent: vscode.TextDocumentChangeEvent = {
		...multipleEvent,
		contentChanges: [...multipleEvent.contentChanges].sort(
			(left, right) => left.rangeOffset - right.rangeOffset,
		),
	};
	assert.deepStrictEqual(
		ascendingMultipleEvent.contentChanges.map(change => change.rangeOffset),
		[4, 16, 25],
	);
	updateTree(parser, multipleTrees, ascendingMultipleEvent);
	assert.deepStrictEqual(multipleEdits, [
		{
			startIndex: 25,
			oldEndIndex: 29,
			newEndIndex: 37,
			startPosition: { row: 2, column: 4 },
			oldEndPosition: { row: 2, column: 8 },
			newEndPosition: { row: 2, column: 16 },
		},
		{
			startIndex: 16,
			oldEndIndex: 20,
			newEndIndex: 26,
			startPosition: { row: 1, column: 5 },
			oldEndPosition: { row: 1, column: 9 },
			newEndPosition: { row: 1, column: 15 },
		},
		{
			startIndex: 4,
			oldEndIndex: 10,
			newEndIndex: 17,
			startPosition: { row: 0, column: 4 },
			oldEndPosition: { row: 0, column: 10 },
			newEndPosition: { row: 1, column: 9 },
		},
	]);
	fresh = parser.parse(multipleDocument.getText());
	assert.deepStrictEqual(snapshot(multipleTrees[multipleKey].rootNode), snapshot(fresh.rootNode));
	fresh.delete();
	multipleTrees[multipleKey].delete();

	const unicodeDocument = await vscode.workspace.openTextDocument({
		language: 'shellscript',
		content: 'echo 😀あ\r\ngit status',
	});
	const unicodeKey = unicodeDocument.uri.toString();
	const unicodeTree = parser.parse(unicodeDocument.getText());
	const unicodeEdits = trackEdits(unicodeTree);
	const unicodeTrees: TreeCache = { [unicodeKey]: unicodeTree };
	const unicode = new vscode.WorkspaceEdit();
	unicode.replace(unicodeDocument.uri, new vscode.Range(0, 5, 0, 8), '🎉い');
	unicode.replace(unicodeDocument.uri, new vscode.Range(1, 4, 1, 10), 'log\n--oneline');
	const unicodeEvent = await captureDocumentChange(unicodeDocument, () => vscode.workspace.applyEdit(unicode));
	updateTree(parser, unicodeTrees, unicodeEvent);
	assert.deepStrictEqual(unicodeEdits, [
		{
			startIndex: 14,
			oldEndIndex: 20,
			newEndIndex: 28,
			startPosition: { row: 1, column: 4 },
			oldEndPosition: { row: 1, column: 10 },
			newEndPosition: { row: 2, column: 9 },
		},
		{
			startIndex: 5,
			oldEndIndex: 8,
			newEndIndex: 8,
			startPosition: { row: 0, column: 5 },
			oldEndPosition: { row: 0, column: 8 },
			newEndPosition: { row: 0, column: 8 },
		},
	]);
	fresh = parser.parse(unicodeDocument.getText());
	assert.deepStrictEqual(snapshot(unicodeTrees[unicodeKey].rootNode), snapshot(fresh.rootNode));
	fresh.delete();
	unicodeTrees[unicodeKey].delete();
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

async function verifyFailedParserInitializationDisposesParser(): Promise<void> {
	for (const failurePoint of ['load', 'setLanguage'] as const) {
		const expectedError = new Error(`controlled ${failurePoint} failure`);
		let parserDeleteCount = 0;
		const parser = {
			delete: () => {
				parserDeleteCount += 1;
			},
			setLanguage: () => {
				if (failurePoint === 'setLanguage') {
					throw expectedError;
				}
			},
		} as unknown as Parser;

		await assert.rejects(
			initializeParser({
				init: async () => undefined,
				createParser: () => parser,
				loadLanguage: async () => {
					if (failurePoint === 'load') {
						throw expectedError;
					}
					return {} as Parser.Language;
				},
			}),
			error => error === expectedError,
		);
		assert.strictEqual(parserDeleteCount, 1, failurePoint);
	}
}

async function verifyFailedActivationDisposesParser(): Promise<void> {
	const expectedError = new Error('controlled activation failure');
	let parserDeleteCount = 0;
	const disposalOrder: string[] = [];
	const parser = {
		delete: () => {
			parserDeleteCount += 1;
		},
	} as unknown as Parser;
	const context = {
		globalState: {},
		subscriptions: [],
	} as unknown as vscode.ExtensionContext;
	const languages = vscode.languages as unknown as {
		registerCompletionItemProvider: typeof vscode.languages.registerCompletionItemProvider;
		registerHoverProvider: typeof vscode.languages.registerHoverProvider;
	};
	const commands = vscode.commands as unknown as {
		registerCommand: typeof vscode.commands.registerCommand;
	};
	const originalInit = CachingFetcher.prototype.init;
	const originalStartInitialCuratedFetch = CachingFetcher.prototype.startInitialCuratedFetch;
	const originalRegisterCompletionItemProvider = languages.registerCompletionItemProvider;
	const originalRegisterHoverProvider = languages.registerHoverProvider;
	const originalRegisterCommand = commands.registerCommand;

	CachingFetcher.prototype.init = async () => undefined;
	CachingFetcher.prototype.startInitialCuratedFetch = async () => undefined;
	languages.registerCompletionItemProvider = (() => ({
		dispose: () => disposalOrder.push('completion'),
	})) as typeof vscode.languages.registerCompletionItemProvider;
	languages.registerHoverProvider = (() => ({
		dispose: () => disposalOrder.push('hover'),
	})) as typeof vscode.languages.registerHoverProvider;
	commands.registerCommand = (() => {
		throw expectedError;
	}) as typeof vscode.commands.registerCommand;

	try {
		await assert.rejects(
			activate(context, { initializeParser: async () => parser }),
			error => error === expectedError,
		);
	} finally {
		CachingFetcher.prototype.init = originalInit;
		CachingFetcher.prototype.startInitialCuratedFetch = originalStartInitialCuratedFetch;
		languages.registerCompletionItemProvider = originalRegisterCompletionItemProvider;
		languages.registerHoverProvider = originalRegisterHoverProvider;
		commands.registerCommand = originalRegisterCommand;
	}

	assert.deepStrictEqual(disposalOrder, ['hover', 'completion']);
	assert.strictEqual(parserDeleteCount, 1);
	assert.deepStrictEqual(context.subscriptions, []);
}

function verifyParserResourceDisposalContinuesAfterFailure(): void {
	const expectedError = new Error('controlled tree deletion failure');
	let secondTreeDeleteCount = 0;
	let parserDeleteCount = 0;
	const trees = {
		first: {
			delete: () => {
				throw expectedError;
			},
		},
		second: {
			delete: () => {
				secondTreeDeleteCount += 1;
			},
		},
	} as unknown as TreeCache;
	const parser = {
		delete: () => {
			parserDeleteCount += 1;
		},
	};

	assert.throws(
		() => disposeParserResources(parser, trees),
		error => error === expectedError,
	);
	assert.strictEqual(secondTreeDeleteCount, 1);
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
	test('walks back to command context at incomplete and boundary positions', async () => {
		await verifyWalkbackCommandContext(parser);
	});
	test('iterates without changing walkback results', async () => verifyIterativeWalkback(parser));
	test('keeps incremental trees equivalent to fresh parses', async () => verifyIncrementalParsing(parser));
	test('uses pre-edit coordinates for incremental tree edits', async () => verifyIncrementalEditCoordinates(parser));
	test('ignores edits in unrelated languages', async () => verifyUnrelatedLanguagesAreIgnored(parser));
	test('reuses the loaded language across parser initialization', async () => {
		const otherParser = await initializeParser();
		try {
			assert.notStrictEqual(otherParser, parser);
			assert.strictEqual(otherParser.getLanguage(), parser.getLanguage());
		} finally {
			otherParser.delete();
		}

		withParsedTree(parser, 'echo still-alive', tree => {
			assert.strictEqual(tree.rootNode.text, 'echo still-alive');
		});
	});
	test('owns provider tree copies across document races', async () => verifyProviderTreeOwnership(parser));
	test('refreshes command names after asynchronous lookup', verifyCompletionRefreshesCommandList);
});

suite('Parser resource disposal', () => {
	test('deletes parsers after initialization fails', verifyFailedParserInitializationDisposesParser);
	test('deletes parsers after activation fails', verifyFailedActivationDisposesParser);
	test('deletes cached trees and the parser', verifyParserResourceDisposal);
	test('continues parser cleanup after a tree deletion fails', verifyParserResourceDisposalContinuesAfterFailure);
});
