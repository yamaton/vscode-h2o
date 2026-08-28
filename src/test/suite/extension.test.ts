import * as assert from 'assert';
import { gzipSync } from 'node:zlib';
import * as vscode from 'vscode';
import { Edit, Language, Node, Parser, Point, Tree } from 'web-tree-sitter';
import { Response } from 'node-fetch';
import {
	activate,
	disposeParserResources,
	getContextCommandName,
	getCurrentNode,
	initializeParser,
	isProviderSuppressedAtPosition,
	updateTree,
	walkbackCompletionCaretIfNeeded,
} from '../../extension';
import type {
	CaretDebugReport,
	LiveEditorDebugState,
	LiveEditorDebugToggleResult,
	TreeCache,
} from '../../extension';
import { CachingFetcher, CachingFetcherDependencies } from '../../cacheFetcher';
import type { CommandCacheStorage } from '../../cacheStorage';
import type { Command } from '../../command';
import { parseTree, withParsedTree } from '../parserTestUtils';

const extensionId = 'tetradresearch.vscode-h2o';
const positionMarker = '<|position|>';

interface InitialCuratedProbe {
	completion: Promise<void>;
	commandNames: string[];
	storage: CommandCacheStorage;
	startedAt: number;
	saveStarts: number[];
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
			dependencies: CachingFetcherDependencies;
		};
		const storage = internals.dependencies.cacheStorage;
		assert.ok(storage, 'activation must configure command cache storage');
		const saveStarts: number[] = [];
		const observedStorage: CommandCacheStorage = {
			load: () => storage.load(),
			save: snapshot => {
				saveStarts.push(Date.now());
				return storage.save(snapshot);
			},
		};
		internals.dependencies = {
			...internals.dependencies,
			cacheStorage: observedStorage,
			fetch: async () => new Response(body, { status: 200 }),
		};
		const startedAt = Date.now();
		const completion = originalStartInitialCuratedFetch.call(this, kind);
		initialCuratedProbe = {
			completion,
			commandNames: commands.map(command => command.name),
			storage: observedStorage,
			startedAt,
			saveStarts,
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
	assert.strictEqual(initialCuratedProbe.saveStarts.length, 1);
	const snapshot = await initialCuratedProbe.storage.load();
	assert.ok(snapshot, 'controlled curated load must persist a snapshot');
	assert.deepStrictEqual(
		new Set(snapshot.commands.map(command => command.name)),
		new Set(initialCuratedProbe.commandNames),
	);
	assert.ok(Date.now() - initialCuratedProbe.startedAt < 15000, 'controlled curated persistence exceeded 15 seconds');
}

async function verifyRegisteredCommands(): Promise<void> {
	const registered = new Set(await vscode.commands.getCommands(true));
	const expected = [
		'h2o.clearCache',
		'h2o.loadBio',
		'h2o.loadCommand',
		'h2o.loadCommon',
		'h2o.inspectCaretContext',
		'h2o.removeBio',
		'h2o.toggleLiveCaretAndCursorContext',
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

function extractPosition(markedContent: string): MarkedSource {
	const offset = markedContent.indexOf(positionMarker);
	assert.notStrictEqual(offset, -1, 'A position marker is required');
	assert.strictEqual(
		markedContent.indexOf(positionMarker, offset + positionMarker.length),
		-1,
		'Only one position marker is allowed',
	);
	return {
		content: markedContent.slice(0, offset) + markedContent.slice(offset + positionMarker.length),
		offset,
	};
}

interface CommandContextObservation {
	commandName: string | undefined;
	currentNodeText: string;
	currentNodeType: string;
	currentNodeStart: { line: number; character: number };
	currentNodeEnd: { line: number; character: number };
	resolvedPosition: { line: number; character: number };
	moved: boolean;
}

function observeCommandContextInTree(
	document: vscode.TextDocument,
	root: Node,
	requestedPosition: vscode.Position,
	walkback: boolean,
): CommandContextObservation {
	const position = walkback
		? walkbackCompletionCaretIfNeeded(document, root, requestedPosition)
		: requestedPosition;
	const currentNode = getCurrentNode(root, position);
	return {
		commandName: getContextCommandName(root, position),
		currentNodeText: currentNode.text,
		currentNodeType: currentNode.type,
		currentNodeStart: {
			line: currentNode.startPosition.row,
			character: currentNode.startPosition.column,
		},
		currentNodeEnd: {
			line: currentNode.endPosition.row,
			character: currentNode.endPosition.column,
		},
		resolvedPosition: { line: position.line, character: position.character },
		moved: !position.isEqual(requestedPosition),
	};
}

async function observeCommandContext(
	parser: Parser,
	markedContent: string,
	walkback: boolean,
): Promise<CommandContextObservation> {
	const { content, offset } = extractPosition(markedContent);
	const document = await vscode.workspace.openTextDocument({ language: 'shellscript', content });
	return withParsedTree(parser, content, tree => {
		const requestedPosition = document.positionAt(offset);
		return observeCommandContextInTree(document, tree.rootNode, requestedPosition, walkback);
	});
}

interface NodeSnapshot {
	type: string;
	text: string;
	startIndex: number;
	endIndex: number;
	startPosition: Point;
	endPosition: Point;
	children: NodeSnapshot[];
}

function snapshot(node: Node): NodeSnapshot {
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

function assertCachedPositionMatchesFresh(
	parser: Parser,
	trees: TreeCache,
	document: vscode.TextDocument,
	requestedPosition: vscode.Position,
	walkback: boolean,
): CommandContextObservation {
	const cachedTree = trees[document.uri.toString()];
	assert.ok(cachedTree, 'the incremental tree must be cached');
	const cached = observeCommandContextInTree(document, cachedTree.rootNode, requestedPosition, walkback);
	const fresh = withParsedTree(parser, document.getText(), tree =>
		observeCommandContextInTree(document, tree.rootNode, requestedPosition, walkback));
	assert.deepStrictEqual(cached, fresh, document.getText());
	return cached;
}

function trackDeletion(tree: Tree): () => number {
	let count = 0;
	const originalDelete = tree.delete.bind(tree);
	tree.delete = () => {
		count += 1;
		originalDelete();
	};
	return () => count;
}

type EditSnapshot = Pick<
	Edit,
	'startIndex' | 'oldEndIndex' | 'newEndIndex' | 'startPosition' | 'oldEndPosition' | 'newEndPosition'
>;

function trackEdits(tree: Tree): EditSnapshot[] {
	const edits: EditSnapshot[] = [];
	const originalEdit = tree.edit.bind(tree);
	tree.edit = (delta) => {
		edits.push({
			startIndex: delta.startIndex,
			oldEndIndex: delta.oldEndIndex,
			newEndIndex: delta.newEndIndex,
			startPosition: delta.startPosition,
			oldEndPosition: delta.oldEndPosition,
			newEndPosition: delta.newEndPosition,
		});
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

function caretEditCommand(name: 'git' | 'npm'): Command {
	return {
		name,
		description: `CARET_EDIT_${name.toUpperCase()}_DESCRIPTION`,
		options: [{
			names: [`--caret-${name}`],
			argument: '',
			description: `option for ${name} caret/edit compatibility`,
		}],
	};
}

function hierarchicalDockerCommand(): Command {
	return {
		name: 'docker',
		description: 'docker root',
		options: [],
		inheritedOptions: [{
			names: ['--verbose'],
			argument: '',
			description: 'verbose output',
		}],
			subcommands: [
				{
					name: 'run',
					description: 'run a container',
				options: [{
					names: ['--run-only'],
					argument: '',
					description: 'RUN_ONLY_DESCRIPTION',
				}],
				subcommands: [{
					name: 'child',
					description: 'nested run command',
					options: [{
						names: ['--child-only'],
						argument: '',
						description: 'child option',
					}],
				}],
			},
			{
				name: 'build',
				description: 'build an image',
				options: [{
					names: ['--build-only'],
					argument: '',
					description: 'build option',
				}],
			},
			{
				name: 'builder',
				description: 'manage builds',
				options: [],
				subcommands: [{
					name: 'imagetools',
					description: 'work with images',
					options: [],
					subcommands: [{
						name: 'create',
						description: 'create an image',
						options: [{
							names: ['--create-only'],
							argument: '',
							description: 'deep option',
						}],
					}],
				}],
			},
		],
	};
}

function cargoCommandWithBuildAlias(): Command {
	return {
		name: 'cargo',
		description: 'Rust package manager',
		options: [],
		subcommands: [{
			name: 'build',
			aliases: ['b'],
			description: 'Compile the current package',
			options: [{
				names: ['--release'],
				argument: '',
				description: 'Build optimized artifacts',
			}],
		}],
	};
}

function bunCommand(): Command {
	return {
		name: 'bun',
		description: 'BUN_ROOT_DESCRIPTION',
		options: [],
		subcommands: [{
			name: 'add',
			description: 'BUN_ADD_DESCRIPTION',
			options: [],
		}],
	};
}

function aliasCollisionCommand(): Command {
	return {
		name: 'clash',
		description: 'alias collision fixture',
		options: [],
		subcommands: [{
			name: 'canonical',
			aliases: ['shared'],
			description: 'alias owner',
			options: [{
				names: ['--alias-owner'],
				argument: '',
				description: 'alias owner option',
			}],
		}, {
			name: 'shared',
			description: 'canonical owner',
			options: [{
				names: ['--canonical-only'],
				argument: '',
				description: 'canonical option',
			}],
		}, {
			name: 'first',
			aliases: ['short'],
			description: 'first ambiguous alias owner',
			options: [],
		}, {
			name: 'second',
			aliases: ['short'],
			description: 'second ambiguous alias owner',
			options: [],
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

async function applyTrackedEdit(
	parser: Parser,
	trees: TreeCache,
	document: vscode.TextDocument,
	edit: vscode.WorkspaceEdit,
): Promise<void> {
	const event = await captureDocumentChange(document, () => vscode.workspace.applyEdit(edit));
	updateTree(parser, trees, event);
}

async function completionLabelsAt(
	document: vscode.TextDocument,
	position = document.positionAt(document.getText().length),
): Promise<{ labels: string[]; items: vscode.CompletionItem[] }> {
	const completion = await withTimeout(
		vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider',
			document.uri,
			position,
		),
		5000,
	);
	return {
		labels: completion.items.map(completionLabel),
		items: completion.items,
	};
}

async function hoverTextAt(document: vscode.TextDocument, position: vscode.Position): Promise<string> {
	const hovers = await withTimeout(
		vscode.commands.executeCommand<vscode.Hover[]>(
			'vscode.executeHoverProvider',
			document.uri,
			position,
		),
		5000,
	);
	return hoverText(hovers);
}

async function verifyProviderTreeOwnership(parser: Parser): Promise<void> {
	const sampleTree = parseTree(parser, 'git');
	const treePrototype = Object.getPrototypeOf(sampleTree) as {
		copy(this: Tree): Tree;
		delete(this: Tree): void;
	};
	const originalCopy = treePrototype.copy;
	const originalDelete = treePrototype.delete;
	const originalFetch = CachingFetcher.prototype.fetch;
	const copyDeleteCounts: Array<() => number> = [];
	const requestTrees = new WeakSet<Tree>();
	let cacheDeleteCount = 0;
	let activeFetch: DeferredFetch | undefined;
	sampleTree.delete();

	treePrototype.delete = function deleteTree(this: Tree): void {
		if (!requestTrees.has(this)) {
			cacheDeleteCount += 1;
		}
		originalDelete.call(this);
	};
	treePrototype.copy = function copy(this: Tree): Tree {
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

async function verifyEditorFacingParserCompatibility(): Promise<void> {
	const originalFetch = CachingFetcher.prototype.fetch;
	CachingFetcher.prototype.fetch = async function fetch(name: string): Promise<Command> {
		assert.strictEqual(name, 'git');
		return commandForProviderRace();
	};

	async function optionCompletion(content: string): Promise<vscode.CompletionItem> {
		const document = await vscode.workspace.openTextDocument({ language: 'shellscript', content });
		const completion = await withTimeout(
			vscode.commands.executeCommand<vscode.CompletionList>(
				'vscode.executeCompletionItemProvider',
				document.uri,
				document.positionAt(content.length),
			),
			5000,
		);
		const option = completion.items.find(item => completionLabel(item) === '--vscode-h2o-race');
		assert.ok(option, content);
		return option;
	}

	try {
		const unicodeOption = await optionCompletion('echo 😀あ; git --v');
		assert.deepStrictEqual(unicodeOption.range, new vscode.Range(0, 14, 0, 17));
	} finally {
		CachingFetcher.prototype.fetch = originalFetch;
	}
}

async function verifyCaretDebugInterface(): Promise<void> {
	const originalFetch = CachingFetcher.prototype.fetch;
	CachingFetcher.prototype.fetch = async function fetch(name: string): Promise<Command> {
		assert.strictEqual(name, 'git');
		return commandForProviderRace();
	};

	async function inspectDocument(
		document: vscode.TextDocument,
		offset: number,
	): Promise<CaretDebugReport> {
		const editor = await vscode.window.showTextDocument(document, { preview: false });
		const position = document.positionAt(offset);
		editor.selection = new vscode.Selection(position, position);
		return withTimeout(
			vscode.commands.executeCommand<CaretDebugReport>('h2o.inspectCaretContext'),
			5000,
		);
	}

	async function inspect(markedContent: string): Promise<CaretDebugReport> {
		const { content, offset } = extractPosition(markedContent);
		const document = await vscode.workspace.openTextDocument({ language: 'shellscript', content });
		return inspectDocument(document, offset);
	}

	try {
		const incrementalDocument = await vscode.workspace.openTextDocument({
			language: 'shellscript',
			content: 'git --v',
		});
		const beforeEdit = await completionLabelsAt(incrementalDocument);
		assert.ok(beforeEdit.labels.includes('--vscode-h2o-race'));

		// Reuse the provider-owned tree across a Unicode edit that changes the grammar boundary.
		const boundaryEdit = new vscode.WorkspaceEdit();
		const herestringText = 'git <<< pay😀load ';
		boundaryEdit.replace(
			incrementalDocument.uri,
			new vscode.Range(0, 4, 0, 7),
			herestringText.slice(4),
		);
		await captureDocumentChange(
			incrementalDocument,
			() => vscode.workspace.applyEdit(boundaryEdit),
		);
		assert.strictEqual(incrementalDocument.getText(), herestringText);

		const herestring = await inspectDocument(incrementalDocument, herestringText.length);
		assert.strictEqual(herestring.document.languageId, 'shellscript');
		assert.strictEqual(herestring.caret.offset, herestringText.length);
		assert.ok(!('cursor' in herestring));
		assert.strictEqual(herestring.cached.ancestors[0].type, herestring.cached.currentNode.type);
		assert.strictEqual(typeof herestring.cached.currentNode.parseState, 'number');
		assert.strictEqual(herestring.cached.completion.enabled, true);
		assert.strictEqual(herestring.cached.completion.moved, true);
		assert.strictEqual(herestring.cached.completion.resumedAfterHerestring, true);
		assert.deepStrictEqual(
			herestring.cached.completion.resolvedSuppressionReasons,
			['herestring_redirect'],
		);
		assert.strictEqual(herestring.cached.completion.invocation?.name.text, 'git');
		assert.deepStrictEqual(herestring.cached.completion.resolution?.path, ['git']);
		assert.deepStrictEqual(herestring.comparison, {
			syntaxAtCaretEquivalent: true,
			completionEquivalent: true,
			hoverEquivalent: true,
		});

		const redirect = await inspect(`git 2> err${positionMarker}ors.log`);
		assert.strictEqual(redirect.cached.completion.enabled, false);
		assert.ok(redirect.cached.completion.requestSuppressionReasons.includes('file_redirect'));
		assert.strictEqual(redirect.cached.hover.enabled, false);
		assert.ok(redirect.cached.hover.requestSuppressionReasons.includes('file_redirect'));
		assert.strictEqual(redirect.cached.completion.invocation, null);
		assert.strictEqual(redirect.comparison.completionEquivalent, true);
		assert.strictEqual(redirect.comparison.hoverEquivalent, true);

		const recovery = await inspect(`git "unter${positionMarker}minated`);
		assert.strictEqual(recovery.cached.completion.enabled, false);
		assert.ok(recovery.cached.completion.requestSuppressionReasons.includes('ERROR'));
		assert.strictEqual(recovery.cached.hover.enabled, false);
		assert.ok(recovery.cached.hover.requestSuppressionReasons.includes('ERROR'));
		assert.strictEqual(recovery.comparison.syntaxAtCaretEquivalent, true);
	} finally {
		CachingFetcher.prototype.fetch = originalFetch;
	}
}

async function verifyLiveCaretAndCursorDebugInterface(): Promise<void> {
	const originalFetch = CachingFetcher.prototype.fetch;
	CachingFetcher.prototype.fetch = async function fetch(name: string): Promise<Command> {
		assert.strictEqual(name, 'git');
		return {
			...commandForProviderRace(),
			subcommands: [{
				name: 'status',
				aliases: ['st'],
				description: 'live caret/cursor debug subcommand',
				options: [],
			}],
		};
	};

	function getLiveState(): Thenable<LiveEditorDebugState> {
		return vscode.commands.executeCommand<LiveEditorDebugState>('h2o.getLiveCaretAndCursorContextState');
	}

	async function waitForLiveUpdate(
		afterSequence: number,
		predicate: (state: LiveEditorDebugState) => boolean = () => true,
	): Promise<LiveEditorDebugState> {
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const state = await getLiveState();
			if (state.updateSequence > afterSequence && predicate(state)) {
				return state;
			}
			await new Promise<void>(resolve => setTimeout(resolve, 10));
		}
		throw new Error(`Live caret/cursor context did not update after sequence ${afterSequence}`);
	}

	async function requestHover(document: vscode.TextDocument, position: vscode.Position): Promise<void> {
		await withTimeout(
			vscode.commands.executeCommand<vscode.Hover[]>(
				'vscode.executeHoverProvider',
				document.uri,
				position,
			),
			5000,
		);
	}

	try {
		const document = await vscode.workspace.openTextDocument({
			language: 'shellscript',
			content: 'git --v',
		});
		const editor = await vscode.window.showTextDocument(document, { preview: false });
		const end = document.positionAt(document.getText().length);
		editor.selection = new vscode.Selection(end, end);

		const enabled = await withTimeout(
			vscode.commands.executeCommand<LiveEditorDebugToggleResult>('h2o.toggleLiveCaretAndCursorContext'),
			5000,
		);
		assert.strictEqual(enabled.enabled, true);
		assert.ok(enabled.snapshot);
		assert.deepStrictEqual(enabled.snapshot.caretNode, {
			type: 'word',
			fieldName: 'argument',
			commandToken: true,
			text: '--v',
			error: false,
			missing: false,
			start: { line: 0, character: 4, index: 4 },
			end: { line: 0, character: 7, index: 7 },
		});
		assert.ok(!('grammarType' in enabled.snapshot.caretNode));
		assert.strictEqual(enabled.snapshot.completion.includeArgumentAtPosition, false);
		assert.deepStrictEqual(enabled.snapshot.completion.invocation?.arguments, []);
		assert.strictEqual(enabled.snapshot.cursor, null);
		assert.strictEqual(enabled.snapshot.cursorNode, null);
		assert.strictEqual(enabled.snapshot.hover, null);

		const beforeHover = await getLiveState();
		const optionCursor = new vscode.Position(0, 5);
		await requestHover(document, optionCursor);
		const hoverState = await waitForLiveUpdate(
			beforeHover.updateSequence,
			state => state.snapshot?.cursor?.character === optionCursor.character,
		);
		assert.strictEqual(hoverState.snapshot?.caret.character, 7);
		assert.deepStrictEqual(hoverState.snapshot?.cursor, {
			line: 0,
			character: 5,
			offset: 5,
			lineText: 'git --v',
		});
		assert.strictEqual(hoverState.snapshot?.cursorNode?.text, '--v');
		assert.strictEqual(hoverState.snapshot?.hover?.includeArgumentAtPosition, true);
		assert.deepStrictEqual(
			hoverState.snapshot?.hover?.invocation?.arguments.map(argument => argument.text),
			['--v'],
		);

		const beforeSelection = hoverState;
		const commandPosition = new vscode.Position(0, 1);
		editor.selection = new vscode.Selection(commandPosition, commandPosition);
		const selectionState = await waitForLiveUpdate(beforeSelection.updateSequence);
		assert.strictEqual(selectionState.snapshot?.document.version, document.version);
		assert.deepStrictEqual(selectionState.snapshot?.caret, {
			line: 0,
			character: 1,
			offset: 1,
			lineText: 'git --v',
		});
		assert.strictEqual(selectionState.snapshot?.caretNode.text, 'git');
		assert.deepStrictEqual(selectionState.snapshot?.completion.resolvedPosition, {
			line: 0,
			character: 1,
		});
		assert.strictEqual(selectionState.snapshot?.completion.moved, false);
		assert.strictEqual(selectionState.snapshot?.cursor?.character, 5);
		assert.deepStrictEqual(selectionState.snapshot?.hover?.resolvedPosition, {
			line: 0,
			character: 5,
		});
		assert.strictEqual(selectionState.snapshot?.hover?.moved, false);
		assert.strictEqual(selectionState.snapshot?.completion.invocation?.name.text, 'git');
		assert.strictEqual(selectionState.snapshot?.hover?.invocation?.name.text, 'git');

		const beforeEdit = selectionState.updateSequence;
		const append = new vscode.WorkspaceEdit();
		append.insert(document.uri, document.positionAt(document.getText().length), 'x');
		await captureDocumentChange(document, () => vscode.workspace.applyEdit(append));
		const editState = await waitForLiveUpdate(beforeEdit);
		assert.strictEqual(editState.snapshot?.document.version, document.version);
		assert.strictEqual(editState.snapshot?.caret.character, 1);
		assert.strictEqual(editState.snapshot?.caretNode.text, 'git');
		assert.strictEqual(editState.snapshot?.cursor, null);
		assert.strictEqual(editState.snapshot?.cursorNode, null);
		assert.strictEqual(editState.snapshot?.hover, null);

		const beforeRedirect = editState.updateSequence;
		const redirectEdit = new vscode.WorkspaceEdit();
		redirectEdit.replace(document.uri, new vscode.Range(0, 4, 0, 8), '2> errors.log');
		await captureDocumentChange(document, () => vscode.workspace.applyEdit(redirectEdit));
		const redirectPosition = new vscode.Position(0, 8);
		editor.selection = new vscode.Selection(redirectPosition, redirectPosition);
		await requestHover(document, redirectPosition);
		const redirectState = await waitForLiveUpdate(
			beforeRedirect,
			state => state.snapshot?.cursor?.character === redirectPosition.character,
		);
		assert.strictEqual(redirectState.snapshot?.document.version, document.version);
		assert.strictEqual(redirectState.snapshot?.caret.character, 8);
		assert.strictEqual(redirectState.snapshot?.caretNode.text, 'errors.log');
		assert.strictEqual(redirectState.snapshot?.completion.enabled, false);
		assert.ok(redirectState.snapshot?.completion.requestSuppressionReasons.includes('file_redirect'));
		assert.strictEqual(redirectState.snapshot?.hover?.enabled, false);
		assert.ok(redirectState.snapshot?.hover?.requestSuppressionReasons.includes('file_redirect'));

		const beforeSubcommand = redirectState.updateSequence;
		const subcommandEdit = new vscode.WorkspaceEdit();
		subcommandEdit.replace(
			document.uri,
			new vscode.Range(0, 0, 0, document.getText().length),
			'git st',
		);
		await captureDocumentChange(document, () => vscode.workspace.applyEdit(subcommandEdit));
		const subcommandPosition = new vscode.Position(0, 5);
		editor.selection = new vscode.Selection(subcommandPosition, subcommandPosition);
		await requestHover(document, subcommandPosition);
		const subcommandState = await waitForLiveUpdate(
			beforeSubcommand,
			state => state.snapshot?.cursor?.character === subcommandPosition.character,
		);
		assert.deepStrictEqual(subcommandState.snapshot?.hover?.resolution?.steps, [{
			command: 'status',
			source: 'st',
			sourceRange: {
				start: { line: 0, character: 4 },
				end: { line: 0, character: 6 },
			},
			matchedBy: 'alias',
		}]);

		const beforeWalkback = subcommandState.updateSequence;
		const walkbackEdit = new vscode.WorkspaceEdit();
		walkbackEdit.replace(
			document.uri,
			new vscode.Range(0, 0, 0, document.getText().length),
			'git ',
		);
		await captureDocumentChange(document, () => vscode.workspace.applyEdit(walkbackEdit));
		const trailingSpaceCaret = new vscode.Position(0, 4);
		editor.selection = new vscode.Selection(trailingSpaceCaret, trailingSpaceCaret);
		const commandCursor = new vscode.Position(0, 1);
		await requestHover(document, commandCursor);
		const walkbackState = await waitForLiveUpdate(
			beforeWalkback,
			state => state.snapshot?.caret.character === trailingSpaceCaret.character
				&& state.snapshot.cursor?.character === commandCursor.character,
		);
		assert.deepStrictEqual(walkbackState.snapshot?.caret, {
			line: 0,
			character: 4,
			offset: 4,
			lineText: 'git ',
		});
		assert.deepStrictEqual(walkbackState.snapshot?.completion.resolvedPosition, {
			line: 0,
			character: 3,
		});
		assert.strictEqual(walkbackState.snapshot?.completion.moved, true);
		assert.deepStrictEqual(walkbackState.snapshot?.cursor, {
			line: 0,
			character: 1,
			offset: 1,
			lineText: 'git ',
		});
		assert.deepStrictEqual(walkbackState.snapshot?.hover?.resolvedPosition, {
			line: 0,
			character: 1,
		});
		assert.strictEqual(walkbackState.snapshot?.hover?.moved, false);

		const disabled = await vscode.commands.executeCommand<LiveEditorDebugToggleResult>(
			'h2o.toggleLiveCaretAndCursorContext',
		);
		assert.strictEqual(disabled.enabled, false);
		const disabledState = await getLiveState();
		assert.strictEqual(disabledState.enabled, false);
		const disabledSequence = disabledState.updateSequence;
		const disabledPosition = new vscode.Position(0, 1);
		editor.selection = new vscode.Selection(disabledPosition, disabledPosition);
		const disabledEdit = new vscode.WorkspaceEdit();
		disabledEdit.insert(document.uri, document.positionAt(document.getText().length), ' ');
		await captureDocumentChange(document, () => vscode.workspace.applyEdit(disabledEdit));
		await new Promise<void>(resolve => setTimeout(resolve, 160));
		assert.strictEqual((await getLiveState()).updateSequence, disabledSequence);
	} finally {
		await vscode.commands.executeCommand('h2o.toggleLiveCaretAndCursorContext', false);
		CachingFetcher.prototype.fetch = originalFetch;
	}
}

async function verifyProviderSuppressionRegions(): Promise<void> {
	const originalFetch = CachingFetcher.prototype.fetch;
	const originalGetList = CachingFetcher.prototype.getList;
	const commands = new Map<string, Command>([
		['git', caretEditCommand('git')],
		['npm', caretEditCommand('npm')],
	]);
	let fetchCount = 0;
	let getListCount = 0;

	CachingFetcher.prototype.fetch = async function fetch(name: string): Promise<Command> {
		fetchCount += 1;
		const command = commands.get(name);
		assert.ok(command, `unexpected command lookup in provider suppression test: ${name}`);
		return command;
	};
	CachingFetcher.prototype.getList = function getList(): string[] {
		getListCount += 1;
		return [...commands.keys()];
	};

	async function assertSuppressed(markedContent: string): Promise<void> {
		const { content, offset } = extractPosition(markedContent);
		const document = await vscode.workspace.openTextDocument({ language: 'shellscript', content });
		const position = document.positionAt(offset);
		const fetchCountBefore = fetchCount;
		const getListCountBefore = getListCount;

		const completion = await completionLabelsAt(document, position);
		const hover = await hoverTextAt(document, position);
		assert.ok(!completion.labels.includes('--caret-git'), markedContent);
		assert.ok(!completion.labels.includes('--caret-npm'), markedContent);
		assert.ok(!hover.includes('CARET_EDIT_'), markedContent);
		assert.strictEqual(fetchCount, fetchCountBefore, markedContent);
		assert.strictEqual(getListCount, getListCountBefore, markedContent);
	}

	try {
		for (const markedContent of [
			`git 2> errors${positionMarker}.log --caret-git`,
			`git 2> errors.log ${positionMarker}`,
			`git <<< pay${positionMarker}load --caret-git`,
			`cat <<EOF\nhel${positionMarker}lo\nEOF`,
			`cat <<EOF\nhello\nE${positionMarker}OF`,
			`git "unterminated${positionMarker}`,
			`if git; then${positionMarker}`,
		]) {
			await assertSuppressed(markedContent);
		}

		for (const content of [
			'git --caret- 2> errors.log',
			'git --caret- <<< input',
			'git --caret- <<EOF\nbody\nEOF',
		]) {
			const beforeRedirect = await vscode.workspace.openTextDocument({ language: 'shellscript', content });
			const optionEnd = content.indexOf(' --caret-') + ' --caret-'.length;
			assert.ok(
				(await completionLabelsAt(beforeRedirect, beforeRedirect.positionAt(optionEnd)))
					.labels.includes('--caret-git'),
				content,
			);
			assert.match(
				await hoverTextAt(beforeRedirect, new vscode.Position(0, 1)),
				/CARET_EDIT_GIT_DESCRIPTION/,
			);
		}

		const afterFileRedirect = await vscode.workspace.openTextDocument({
			language: 'shellscript',
			content: 'git 2> errors.log; npm --caret-',
		});
		assert.ok((await completionLabelsAt(afterFileRedirect)).labels.includes('--caret-npm'));
		assert.match(
			await hoverTextAt(afterFileRedirect, new vscode.Position(0, 20)),
			/CARET_EDIT_NPM_DESCRIPTION/,
		);

		for (const content of [
			'git <<< input ',
			'git <<< input --caret-',
		]) {
			const afterHerestring = await vscode.workspace.openTextDocument({ language: 'shellscript', content });
			assert.ok((await completionLabelsAt(afterHerestring)).labels.includes('--caret-git'), content);
		}

		const afterHeredoc = await vscode.workspace.openTextDocument({
			language: 'shellscript',
			content: 'cat <<EOF\nbody\nEOF\nnpm --caret-',
		});
		assert.ok((await completionLabelsAt(afterHeredoc)).labels.includes('--caret-npm'));
	} finally {
		CachingFetcher.prototype.fetch = originalFetch;
		CachingFetcher.prototype.getList = originalGetList;
	}
}

async function verifyCaretBehaviorAcrossEdits(parser: Parser): Promise<void> {
	const originalFetch = CachingFetcher.prototype.fetch;
	const originalGetList = CachingFetcher.prototype.getList;
	const commands = new Map<string, Command>([
		['git', caretEditCommand('git')],
		['npm', caretEditCommand('npm')],
		['docker', hierarchicalDockerCommand()],
		['echo', {
			name: 'echo',
			description: 'CARET_EDIT_ECHO_DESCRIPTION',
			options: [{
				names: ['--caret-echo'],
				argument: '',
				description: 'option for echo caret/edit compatibility',
			}],
		}],
	]);
	const treeCaches: TreeCache[] = [];

	CachingFetcher.prototype.fetch = async function fetch(name: string): Promise<Command> {
		const command = commands.get(name);
		assert.ok(command, `unexpected command lookup after an edit: ${name}`);
		return command;
	};
	CachingFetcher.prototype.getList = function getList(): string[] {
		return [...commands.keys()];
	};

	function createTreeCache(document: vscode.TextDocument): TreeCache {
		const trees: TreeCache = {
			[document.uri.toString()]: parseTree(parser, document.getText()),
		};
		treeCaches.push(trees);
		return trees;
	}

	function caretOptionRange(document: vscode.TextDocument): vscode.Range {
		const text = document.getText();
		const startOffset = text.lastIndexOf('--caret-');
		assert.ok(startOffset >= 0, text);
		return new vscode.Range(document.positionAt(startOffset), document.positionAt(text.length));
	}

	async function assertOptionCompletion(
		document: vscode.TextDocument,
		trees: TreeCache,
		expectedCommand: 'git' | 'npm',
		expectedRange: vscode.Range | undefined,
		caret = document.positionAt(document.getText().length),
	): Promise<CommandContextObservation> {
		const observation = assertCachedPositionMatchesFresh(parser, trees, document, caret, true);
		assert.strictEqual(observation.commandName, expectedCommand, document.getText());

		const expectedLabel = `--caret-${expectedCommand}`;
		const unexpectedLabel = expectedCommand === 'git' ? '--caret-npm' : '--caret-git';
		const completion = await completionLabelsAt(document, caret);
		assert.ok(completion.labels.includes(expectedLabel), document.getText());
		assert.ok(!completion.labels.includes(unexpectedLabel), document.getText());

		if (expectedRange) {
			assert.strictEqual(observation.currentNodeType, 'word');
			assert.ok(expectedLabel.startsWith(observation.currentNodeText), document.getText());
			assert.deepStrictEqual(observation.currentNodeStart, {
				line: expectedRange.start.line,
				character: expectedRange.start.character,
			});
			assert.deepStrictEqual(observation.currentNodeEnd, {
				line: expectedRange.end.line,
				character: expectedRange.end.character,
			});
			const item = completion.items.find(candidate => completionLabel(candidate) === expectedLabel);
			assert.ok(item);
			assert.deepStrictEqual(item.range, expectedRange);
		}

		return observation;
	}

	async function assertProviderSuppressed(
		document: vscode.TextDocument,
		trees: TreeCache,
		requestedPosition = document.positionAt(document.getText().length),
	): Promise<vscode.Position> {
		const cachedTree = trees[document.uri.toString()];
		assert.ok(cachedTree);
		const cachedPosition = walkbackCompletionCaretIfNeeded(
			document,
			cachedTree.rootNode,
			requestedPosition,
		);
		assert.strictEqual(
			isProviderSuppressedAtPosition(cachedTree.rootNode, cachedPosition),
			true,
			document.getText(),
		);

		withParsedTree(parser, document.getText(), freshTree => {
			const freshPosition = walkbackCompletionCaretIfNeeded(
				document,
				freshTree.rootNode,
				requestedPosition,
			);
			assert.deepStrictEqual(cachedPosition, freshPosition, document.getText());
			assert.strictEqual(
				isProviderSuppressedAtPosition(freshTree.rootNode, freshPosition),
				true,
				document.getText(),
			);
		});

		const completion = await completionLabelsAt(document, requestedPosition);
		assert.ok(!completion.labels.some(label => label.startsWith('--caret-')), document.getText());
		assert.ok(!(await hoverTextAt(document, requestedPosition)).includes('CARET_EDIT_'), document.getText());
		return cachedPosition;
	}

	try {
		const separatorDocument = await vscode.workspace.openTextDocument({
			language: 'shellscript',
			content: 'git npm --caret-',
		});
		const separatorTrees = createTreeCache(separatorDocument);
		await assertOptionCompletion(separatorDocument, separatorTrees, 'git', caretOptionRange(separatorDocument));

		let characterEdit = new vscode.WorkspaceEdit();
		characterEdit.insert(
			separatorDocument.uri,
			separatorDocument.positionAt(separatorDocument.getText().length),
			'g',
		);
		await applyTrackedEdit(parser, separatorTrees, separatorDocument, characterEdit);
		await assertOptionCompletion(separatorDocument, separatorTrees, 'git', caretOptionRange(separatorDocument));
		await assertOptionCompletion(
			separatorDocument,
			separatorTrees,
			'git',
			caretOptionRange(separatorDocument),
			separatorDocument.positionAt(separatorDocument.getText().length - 1),
		);

		characterEdit = new vscode.WorkspaceEdit();
		characterEdit.delete(separatorDocument.uri, new vscode.Range(
			separatorDocument.positionAt(separatorDocument.getText().length - 1),
			separatorDocument.positionAt(separatorDocument.getText().length),
		));
		await applyTrackedEdit(parser, separatorTrees, separatorDocument, characterEdit);
		await assertOptionCompletion(separatorDocument, separatorTrees, 'git', caretOptionRange(separatorDocument));

		const separatorOffset = 'git'.length;
		let separator = '';
		async function replaceSeparator(replacement: string): Promise<void> {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(
				separatorDocument.uri,
				new vscode.Range(
					separatorDocument.positionAt(separatorOffset),
					separatorDocument.positionAt(separatorOffset + separator.length),
				),
				replacement,
			);
			await applyTrackedEdit(parser, separatorTrees, separatorDocument, edit);
			separator = replacement;
		}

		await replaceSeparator(';');
		await assertOptionCompletion(separatorDocument, separatorTrees, 'npm', caretOptionRange(separatorDocument));
		const npmOffset = separatorDocument.getText().indexOf('npm');
		assert.ok(npmOffset >= 0);
		assert.match(
			await hoverTextAt(separatorDocument, separatorDocument.positionAt(npmOffset + 1)),
			/CARET_EDIT_NPM_DESCRIPTION/,
		);

		for (const replacement of ['|', '&&', '\n']) {
			await replaceSeparator(replacement);
			await assertOptionCompletion(separatorDocument, separatorTrees, 'npm', caretOptionRange(separatorDocument));
		}
		await replaceSeparator('');
		await assertOptionCompletion(separatorDocument, separatorTrees, 'git', caretOptionRange(separatorDocument));

		const recoveryDocument = await vscode.workspace.openTextDocument({
			language: 'shellscript',
			content: 'if true; then git status; else echo missing; fi',
		});
		const recoveryTrees = createTreeCache(recoveryDocument);
		let echoOffset = recoveryDocument.getText().indexOf('echo');
		assert.ok(echoOffset >= 0);
		assert.match(
			await hoverTextAt(recoveryDocument, recoveryDocument.positionAt(echoOffset + 2)),
			/CARET_EDIT_ECHO_DESCRIPTION/,
		);

		let recoveryEdit = new vscode.WorkspaceEdit();
		recoveryEdit.insert(recoveryDocument.uri, new vscode.Position(0, 12), 'x');
		await applyTrackedEdit(parser, recoveryTrees, recoveryDocument, recoveryEdit);
		echoOffset = recoveryDocument.getText().indexOf('echo');
		assert.ok(echoOffset >= 0);
		await assertProviderSuppressed(
			recoveryDocument,
			recoveryTrees,
			recoveryDocument.positionAt(echoOffset + 2),
		);

		recoveryEdit = new vscode.WorkspaceEdit();
		recoveryEdit.delete(recoveryDocument.uri, new vscode.Range(0, 12, 0, 13));
		await applyTrackedEdit(parser, recoveryTrees, recoveryDocument, recoveryEdit);
		echoOffset = recoveryDocument.getText().indexOf('echo');
		assert.ok(echoOffset >= 0);
		assertCachedPositionMatchesFresh(
			parser,
			recoveryTrees,
			recoveryDocument,
			recoveryDocument.positionAt(echoOffset + 2),
			false,
		);
		assert.match(
			await hoverTextAt(recoveryDocument, recoveryDocument.positionAt(echoOffset + 2)),
			/CARET_EDIT_ECHO_DESCRIPTION/,
		);

		const hierarchyDocument = await vscode.workspace.openTextDocument({
			language: 'shellscript',
			content: 'docker ru',
		});
		const hierarchyTrees = createTreeCache(hierarchyDocument);
		async function assertDockerCompletion(
			position: vscode.Position,
			expectedLabel: string,
			expectedRange: vscode.Range,
		): Promise<void> {
			const observation = assertCachedPositionMatchesFresh(
				parser,
				hierarchyTrees,
				hierarchyDocument,
				position,
				true,
			);
			assert.strictEqual(observation.commandName, 'docker');
			assert.deepStrictEqual(observation.currentNodeStart, {
				line: expectedRange.start.line,
				character: expectedRange.start.character,
			});
			assert.deepStrictEqual(observation.currentNodeEnd, {
				line: expectedRange.end.line,
				character: expectedRange.end.character,
			});
			const completion = await completionLabelsAt(hierarchyDocument, position);
			const item = completion.items.find(candidate => completionLabel(candidate) === expectedLabel);
			assert.ok(item, hierarchyDocument.getText());
			assert.deepStrictEqual(item.range, expectedRange);
		}

		await assertDockerCompletion(new vscode.Position(0, 9), 'run', new vscode.Range(0, 7, 0, 9));
		let hierarchyEdit = new vscode.WorkspaceEdit();
		hierarchyEdit.insert(hierarchyDocument.uri, new vscode.Position(0, 9), 'n');
		await applyTrackedEdit(parser, hierarchyTrees, hierarchyDocument, hierarchyEdit);
		await assertDockerCompletion(new vscode.Position(0, 10), 'run', new vscode.Range(0, 7, 0, 10));
		await assertDockerCompletion(new vscode.Position(0, 9), 'run', new vscode.Range(0, 7, 0, 10));
		assert.match(await hoverTextAt(hierarchyDocument, new vscode.Position(0, 2)), /docker root/);
		assert.match(await hoverTextAt(hierarchyDocument, new vscode.Position(0, 8)), /run a container/);

		hierarchyEdit = new vscode.WorkspaceEdit();
		hierarchyEdit.insert(hierarchyDocument.uri, new vscode.Position(0, 10), ' --r');
		await applyTrackedEdit(parser, hierarchyTrees, hierarchyDocument, hierarchyEdit);
		await assertDockerCompletion(new vscode.Position(0, 14), '--run-only', new vscode.Range(0, 11, 0, 14));
		await assertDockerCompletion(new vscode.Position(0, 13), '--run-only', new vscode.Range(0, 11, 0, 14));

		const incompleteDocument = await vscode.workspace.openTextDocument({
			language: 'shellscript',
			content: 'git ',
		});
		const incompleteTrees = createTreeCache(incompleteDocument);
		await assertOptionCompletion(incompleteDocument, incompleteTrees, 'git', undefined);

		let edit = new vscode.WorkspaceEdit();
		edit.insert(incompleteDocument.uri, incompleteDocument.positionAt(incompleteDocument.getText().length), '"unterminated');
		await applyTrackedEdit(parser, incompleteTrees, incompleteDocument, edit);
		await assertProviderSuppressed(incompleteDocument, incompleteTrees);

		edit = new vscode.WorkspaceEdit();
		edit.insert(incompleteDocument.uri, incompleteDocument.positionAt(incompleteDocument.getText().length), '" ');
		await applyTrackedEdit(parser, incompleteTrees, incompleteDocument, edit);
		await assertOptionCompletion(incompleteDocument, incompleteTrees, 'git', undefined);

		edit = new vscode.WorkspaceEdit();
		edit.delete(incompleteDocument.uri, new vscode.Range(
			incompleteDocument.positionAt(incompleteDocument.getText().length - 2),
			incompleteDocument.positionAt(incompleteDocument.getText().length),
		));
		await applyTrackedEdit(parser, incompleteTrees, incompleteDocument, edit);
		await assertProviderSuppressed(incompleteDocument, incompleteTrees);

		edit = new vscode.WorkspaceEdit();
		edit.replace(
			incompleteDocument.uri,
			new vscode.Range(new vscode.Position(0, 0), incompleteDocument.positionAt(incompleteDocument.getText().length)),
			'git |   ',
		);
		await applyTrackedEdit(parser, incompleteTrees, incompleteDocument, edit);
		for (const character of [4, 5]) {
			const pipelineBoundary = assertCachedPositionMatchesFresh(
				parser,
				incompleteTrees,
				incompleteDocument,
				new vscode.Position(0, character),
				false,
			);
			assert.strictEqual(pipelineBoundary.commandName, undefined);
			assert.strictEqual(pipelineBoundary.currentNodeType, '|');
			assert.strictEqual(pipelineBoundary.currentNodeText, '|');
			assert.deepStrictEqual(pipelineBoundary.currentNodeStart, { line: 0, character: 4 });
			assert.deepStrictEqual(pipelineBoundary.currentNodeEnd, { line: 0, character: 5 });
		}
		const missingCommandPosition = await assertProviderSuppressed(incompleteDocument, incompleteTrees);
		assert.strictEqual(missingCommandPosition.character, 5);
		assert.strictEqual(missingCommandPosition.isEqual(new vscode.Position(0, 8)), false);

		edit = new vscode.WorkspaceEdit();
		edit.insert(
			incompleteDocument.uri,
			incompleteDocument.positionAt(incompleteDocument.getText().length),
			'npm --caret-',
		);
		await applyTrackedEdit(parser, incompleteTrees, incompleteDocument, edit);
		await assertOptionCompletion(incompleteDocument, incompleteTrees, 'npm', caretOptionRange(incompleteDocument));

		const crlfDocument = await vscode.workspace.openTextDocument({
			language: 'shellscript',
			content: 'echo base\r\ngit --caret-',
		});
		const crlfTrees = createTreeCache(crlfDocument);
		await assertOptionCompletion(crlfDocument, crlfTrees, 'git', caretOptionRange(crlfDocument));

		edit = new vscode.WorkspaceEdit();
		edit.replace(crlfDocument.uri, new vscode.Range(0, 5, 0, 9), '😀あ');
		await applyTrackedEdit(parser, crlfTrees, crlfDocument, edit);
		assert.strictEqual(crlfDocument.getText(), 'echo 😀あ\r\ngit --caret-');
		await assertOptionCompletion(crlfDocument, crlfTrees, 'git', caretOptionRange(crlfDocument));

		edit = new vscode.WorkspaceEdit();
		edit.delete(crlfDocument.uri, new vscode.Range(
			new vscode.Position(0, 0),
			crlfDocument.positionAt(crlfDocument.getText().length),
		));
		await applyTrackedEdit(parser, crlfTrees, crlfDocument, edit);
		const empty = assertCachedPositionMatchesFresh(
			parser,
			crlfTrees,
			crlfDocument,
			new vscode.Position(0, 0),
			true,
		);
		assert.strictEqual(empty.commandName, undefined);
		assert.strictEqual(empty.currentNodeType, 'program');
		assert.strictEqual(empty.currentNodeText, '');

		edit = new vscode.WorkspaceEdit();
		edit.insert(crlfDocument.uri, new vscode.Position(0, 0), 'npm --caret-');
		await applyTrackedEdit(parser, crlfTrees, crlfDocument, edit);
		await assertOptionCompletion(crlfDocument, crlfTrees, 'npm', caretOptionRange(crlfDocument));

		const continuationDocument = await vscode.workspace.openTextDocument({
			language: 'shellscript',
			content: 'git \\\r\n  ',
		});
		const continuationTrees = createTreeCache(continuationDocument);
		await assertProviderSuppressed(continuationDocument, continuationTrees);

		edit = new vscode.WorkspaceEdit();
		edit.delete(continuationDocument.uri, new vscode.Range(
			new vscode.Position(0, 4),
			continuationDocument.positionAt(continuationDocument.getText().length),
		));
		await applyTrackedEdit(parser, continuationTrees, continuationDocument, edit);
		assert.strictEqual(continuationDocument.getText(), 'git ');
		await assertOptionCompletion(continuationDocument, continuationTrees, 'git', undefined);

		edit = new vscode.WorkspaceEdit();
		edit.insert(continuationDocument.uri, new vscode.Position(0, 4), '\\\r\n  ');
		await applyTrackedEdit(parser, continuationTrees, continuationDocument, edit);
		assert.strictEqual(continuationDocument.getText(), 'git \\\r\n  ');
		await assertProviderSuppressed(continuationDocument, continuationTrees);
	} finally {
		for (const trees of treeCaches) {
			for (const tree of Object.values(trees)) {
				tree.delete();
			}
		}
		CachingFetcher.prototype.fetch = originalFetch;
		CachingFetcher.prototype.getList = originalGetList;
	}
}

async function verifyHierarchicalCommandResolution(): Promise<void> {
	const originalFetch = CachingFetcher.prototype.fetch;
	CachingFetcher.prototype.fetch = async function fetch(name: string): Promise<Command> {
		if (name === 'docker') {
			return hierarchicalDockerCommand();
		}
		if (name === 'cargo') {
			return cargoCommandWithBuildAlias();
		}
		if (name === 'bun') {
			return bunCommand();
		}
		if (name === 'clash') {
			return aliasCollisionCommand();
		}
		throw new Error(`Unexpected command lookup: ${name}`);
	};

	async function completionLabels(content: string): Promise<string[]> {
		const document = await vscode.workspace.openTextDocument({ language: 'shellscript', content });
		const completion = await withTimeout(
			vscode.commands.executeCommand<vscode.CompletionList>(
				'vscode.executeCompletionItemProvider',
				document.uri,
				document.positionAt(content.length),
			),
			5000,
		);
		return completion.items
			.filter(item => item.sortText?.startsWith('33-') || item.sortText?.startsWith('55-'))
			.map(completionLabel);
	}

	async function hoverAt(content: string, character: number): Promise<string> {
		const document = await vscode.workspace.openTextDocument({ language: 'shellscript', content });
		const hovers = await withTimeout(
			vscode.commands.executeCommand<vscode.Hover[]>(
				'vscode.executeHoverProvider',
				document.uri,
				new vscode.Position(0, character),
			),
			5000,
		);
		return hoverText(hovers);
	}

	try {
		const siblingAfterPositional = await completionLabels('docker run build ');
		assert.ok(siblingAfterPositional.includes('--run-only'));
		assert.ok(!siblingAfterPositional.includes('--build-only'));
		assert.ok(!siblingAfterPositional.includes('child'));

		const editingSeparator = await completionLabels('docker --');
		assert.ok(editingSeparator.includes('--verbose'));
		assert.ok(!editingSeparator.includes('run'));

		const afterSeparator = await completionLabels('docker -- ');
		assert.ok(!afterSeparator.includes('run'));
		assert.ok(!afterSeparator.includes('--verbose'));

		const optionBeforeSubcommand = await completionLabels('docker --verbose run ');
		assert.ok(optionBeforeSubcommand.includes('--run-only'));

		const deepPath = await completionLabels('docker builder imagetools create ');
		assert.ok(deepPath.includes('--create-only'));

		const touchingExactSubcommand = await completionLabels('docker run');
		assert.ok(touchingExactSubcommand.includes('run'));

		const afterSubcommand = await completionLabels('docker run ');
		assert.ok(afterSubcommand.includes('--run-only'));

		const afterAlias = await completionLabels('cargo b ');
		assert.ok(afterAlias.includes('--release'));

		assert.ok((await hoverAt('docker run --run-only child', 13)).includes('RUN_ONLY_DESCRIPTION'));
		assert.ok((await hoverAt('docker run image --run-only', 19)).includes('RUN_ONLY_DESCRIPTION'));
		assert.ok(!(await hoverAt('docker -- --verbose', 12)).includes('verbose output'));

		const aliasHoverText = await hoverAt('cargo b', 6);
		assert.ok(aliasHoverText.includes('cargo **b**'));
		assert.ok(aliasHoverText.includes('(Alias of build) Compile the current package'));

		assert.ok(!(await hoverAt('bun add add', 9)).includes('BUN_ADD_DESCRIPTION'));
		assert.ok(!(await hoverAt('bun add bun', 9)).includes('BUN_ROOT_DESCRIPTION'));

		const collidingLabels = await completionLabels('clash sh');
		assert.strictEqual(collidingLabels.filter(label => label === 'shared').length, 1);
		assert.ok(!collidingLabels.includes('short'));

		const canonicalAfterCollision = await completionLabels('clash shared ');
		assert.ok(canonicalAfterCollision.includes('--canonical-only'));
		assert.ok(!canonicalAfterCollision.includes('--alias-owner'));
	} finally {
		CachingFetcher.prototype.fetch = originalFetch;
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
			markedContent: `g${positionMarker}it status`,
			expectedCommandName: 'git',
			expectedNodeText: 'git',
		},
		{
			description: 'command argument',
			markedContent: `git status${positionMarker}`,
			expectedCommandName: 'git',
			expectedNodeText: 'status',
		},
		{
			description: 'argument end before a semicolon',
			markedContent: `git status${positionMarker}; npm test`,
			expectedCommandName: 'git',
			expectedNodeText: 'status',
		},
		{
			description: 'command after a semicolon',
			markedContent: `git status; np${positionMarker}m test`,
			expectedCommandName: 'npm',
		},
		{
			description: 'command inside a pipeline',
			markedContent: `npm test | gr${positionMarker}ep ok`,
			expectedCommandName: 'grep',
		},
		{
			description: 'quoted argument',
			markedContent: `printf "%s ${positionMarker}value" done`,
			expectedCommandName: 'printf',
		},
		{
			description: 'command after environment assignments',
			markedContent: `A=1 B=two gi${positionMarker}t status`,
			expectedCommandName: 'git',
		},
		{
			description: 'function body',
			markedContent: `deploy() { gi${positionMarker}t status; }`,
			expectedCommandName: 'git',
		},
		{
			description: 'command substitution inside a string',
			markedContent: `echo "$(gi${positionMarker}t status)"`,
			expectedCommandName: 'git',
		},
		{
			description: 'command substitution separator boundary',
			markedContent: `echo "$(git status;${positionMarker} npm test)"`,
			expectedCommandName: undefined,
			expectedNodeType: ';',
		},
		{
			description: 'process substitution',
			markedContent: `diff <(gi${positionMarker}t show HEAD) file`,
			expectedCommandName: 'git',
		},
		{
			description: 'process substitution separator boundary',
			markedContent: `diff <(git status;${positionMarker} npm test) file`,
			expectedCommandName: undefined,
			expectedNodeType: ';',
		},
		{
			description: 'if body',
			markedContent: `if true; then gi${positionMarker}t status; fi`,
			expectedCommandName: 'git',
		},
		{
			description: 'while body',
			markedContent: `while true; do sle${positionMarker}ep 1; done`,
			expectedCommandName: 'sleep',
		},
		{
			description: 'redirected command body',
			markedContent: `cat inp${positionMarker}ut.txt > output.txt`,
			expectedCommandName: 'cat',
		},
		{
			description: 'semicolon boundary',
			markedContent: `git status;${positionMarker} npm test`,
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
			markedContent: `echo   ${positionMarker}`,
			expectedCommandName: 'echo',
			expectedMoved: true,
		},
		{
			description: 'line continuation',
			markedContent: `git \\\n  ${positionMarker}`,
			expectedCommandName: undefined,
			expectedMoved: false,
		},
		{
			description: 'incomplete quote',
			markedContent: `git "unterminated${positionMarker}`,
			expectedCommandName: undefined,
			expectedMoved: false,
		},
		{
			description: 'numeric argument subtype',
			markedContent: `tool 42   ${positionMarker}`,
			expectedCommandName: 'tool',
			expectedNodeType: 'number',
			expectedMoved: true,
		},
		{
			description: 'quoted argument subtype',
			markedContent: `tool "two words"   ${positionMarker}`,
			expectedCommandName: 'tool',
			expectedMoved: true,
		},
		{
			description: 'concatenated argument subtype',
			markedContent: `tool a\${value}b   ${positionMarker}`,
			expectedCommandName: 'tool',
			expectedMoved: true,
		},
		{
			description: 'trailing space after a semicolon',
			markedContent: `git status;  ${positionMarker}`,
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

async function verifyIterativeCaretWalkback(parser: Parser): Promise<void> {
	for (const { content, expectedCharacter, expectedCommandName } of [
		{ content: 'tool alpha |   ', expectedCharacter: 12, expectedCommandName: undefined },
		{ content: 'tool alpha |&   ', expectedCharacter: 13, expectedCommandName: undefined },
		{ content: 'tool alpha &&   ', expectedCharacter: 13, expectedCommandName: undefined },
		{ content: 'tool alpha ||   ', expectedCharacter: 13, expectedCommandName: undefined },
		{ content: 'tool alpha &   ', expectedCharacter: 10, expectedCommandName: 'tool' },
	]) {
		const document = await vscode.workspace.openTextDocument({ language: 'shellscript', content });
		const tree = parseTree(parser, document.getText());
		try {
			const walked = walkbackCompletionCaretIfNeeded(
				document,
				tree.rootNode,
				document.positionAt(content.length),
			);
			assert.deepStrictEqual(walked, new vscode.Position(0, expectedCharacter));
			assert.strictEqual(getContextCommandName(tree.rootNode, walked), expectedCommandName);
		} finally {
			tree.delete();
		}
	}

	const content = `tool alpha ${' '.repeat(20_000)}`;
	const document = await vscode.workspace.openTextDocument({ language: 'shellscript', content });
	const tree = parseTree(parser, document.getText());
	try {
		const walked = walkbackCompletionCaretIfNeeded(
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
	const trees: TreeCache = { [key]: parseTree(parser, document.getText()) };

	const firstTree = trees[key];
	const firstTreeDeleteCount = trackDeletion(firstTree);
	const replacement = new vscode.WorkspaceEdit();
	replacement.replace(document.uri, new vscode.Range(0, 4, 0, 10), 'log --oneline');
	const replacementEvent = await captureDocumentChange(document, () => vscode.workspace.applyEdit(replacement));
	updateTree(parser, trees, replacementEvent);
	assert.strictEqual(firstTreeDeleteCount(), 1);
	assert.notStrictEqual(trees[key], firstTree);

	let fresh = parseTree(parser, document.getText());
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

	fresh = parseTree(parser, document.getText());
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
	const shorteningTree = parseTree(parser, shorteningDocument.getText());
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
	let fresh = parseTree(parser, shorteningDocument.getText());
	assert.deepStrictEqual(snapshot(shorteningTrees[shorteningKey].rootNode), snapshot(fresh.rootNode));
	fresh.delete();
	shorteningTrees[shorteningKey].delete();

	const multipleDocument = await vscode.workspace.openTextDocument({
		language: 'shellscript',
		content: 'git status\necho keep\nnpm test',
	});
	const multipleKey = multipleDocument.uri.toString();
	const multipleTree = parseTree(parser, multipleDocument.getText());
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
	fresh = parseTree(parser, multipleDocument.getText());
	assert.deepStrictEqual(snapshot(multipleTrees[multipleKey].rootNode), snapshot(fresh.rootNode));
	fresh.delete();
	multipleTrees[multipleKey].delete();

	const unicodeDocument = await vscode.workspace.openTextDocument({
		language: 'shellscript',
		content: 'echo 😀あ\r\ngit status',
	});
	const unicodeKey = unicodeDocument.uri.toString();
	const unicodeTree = parseTree(parser, unicodeDocument.getText());
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
	fresh = parseTree(parser, unicodeDocument.getText());
	assert.deepStrictEqual(snapshot(unicodeTrees[unicodeKey].rootNode), snapshot(fresh.rootNode));
	fresh.delete();
	unicodeTrees[unicodeKey].delete();
}

async function verifyIncrementalBoundaryEdits(parser: Parser): Promise<void> {
	const emptyDocument = await vscode.workspace.openTextDocument({
		language: 'shellscript',
		content: '',
	});
	const emptyKey = emptyDocument.uri.toString();
	const emptyTrees: TreeCache = {};
	const initialInsertion = new vscode.WorkspaceEdit();
	initialInsertion.insert(emptyDocument.uri, new vscode.Position(0, 0), 'echo ok');
	const initialEvent = await captureDocumentChange(
		emptyDocument,
		() => vscode.workspace.applyEdit(initialInsertion),
	);
	updateTree(parser, emptyTrees, initialEvent);
	assert.strictEqual(emptyTrees[emptyKey].rootNode.text, emptyDocument.getText());
	emptyTrees[emptyKey].delete();

	const initialText = 'echo ok\r\n';
	const document = await vscode.workspace.openTextDocument({
		language: 'shellscript',
		content: initialText,
	});
	const key = document.uri.toString();
	const populatedTree = parseTree(parser, document.getText());
	const trees: TreeCache = { [key]: populatedTree };
	const populatedEdits = trackEdits(populatedTree);
	const populatedDeleteCount = trackDeletion(populatedTree);
	const deletion = new vscode.WorkspaceEdit();
	deletion.delete(document.uri, new vscode.Range(new vscode.Position(0, 0), document.positionAt(initialText.length)));
	const deletionEvent = await captureDocumentChange(document, () => vscode.workspace.applyEdit(deletion));
	updateTree(parser, trees, deletionEvent);
	assert.deepStrictEqual(populatedEdits, [{
		startIndex: 0,
		oldEndIndex: initialText.length,
		newEndIndex: 0,
		startPosition: { row: 0, column: 0 },
		oldEndPosition: { row: 1, column: 0 },
		newEndPosition: { row: 0, column: 0 },
	}]);
	assert.strictEqual(populatedDeleteCount(), 1);
	assert.strictEqual(trees[key].rootNode.text, '');
	const freshEmpty = parseTree(parser, document.getText());
	assert.deepStrictEqual(snapshot(trees[key].rootNode), snapshot(freshEmpty.rootNode));
	freshEmpty.delete();

	const emptyTree = trees[key];
	const emptyEdits = trackEdits(emptyTree);
	const unicodeText = 'echo 😀\r\ngit status';
	const unicodeInsertion = new vscode.WorkspaceEdit();
	unicodeInsertion.insert(document.uri, new vscode.Position(0, 0), unicodeText);
	const unicodeEvent = await captureDocumentChange(
		document,
		() => vscode.workspace.applyEdit(unicodeInsertion),
	);
	updateTree(parser, trees, unicodeEvent);
	assert.deepStrictEqual(emptyEdits, [{
		startIndex: 0,
		oldEndIndex: 0,
		newEndIndex: unicodeText.length,
		startPosition: { row: 0, column: 0 },
		oldEndPosition: { row: 0, column: 0 },
		newEndPosition: { row: 1, column: 10 },
	}]);

	const fresh = parseTree(parser, document.getText());
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
		first: parseTree(parser, 'echo first'),
		second: parseTree(parser, 'echo second'),
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
					return {} as Language;
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
		globalStorageUri: vscode.Uri.file('/tmp/vscode-h2o-failed-activation'),
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

suite('Extension activation', () => {
	test('registers contributed commands', verifyRegisteredCommands);
	test('persists a controlled curated load as one global-storage snapshot', verifyInitialCuratedPersistence);
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
	test('iterates without changing completion caret walkback results', async () =>
		verifyIterativeCaretWalkback(parser));
	test('keeps incremental trees equivalent to fresh parses', async () => verifyIncrementalParsing(parser));
	test('uses pre-edit coordinates for incremental tree edits', async () => verifyIncrementalEditCoordinates(parser));
	test('handles empty, whole-document, CRLF, and Unicode edits', async () => {
		await verifyIncrementalBoundaryEdits(parser);
	});
	test('ignores edits in unrelated languages', async () => verifyUnrelatedLanguagesAreIgnored(parser));
	test('reuses the loaded language across parser initialization', async () => {
		const otherParser = await initializeParser();
		try {
			assert.notStrictEqual(otherParser, parser);
			assert.strictEqual(otherParser.language, parser.language);
		} finally {
			otherParser.delete();
		}

		withParsedTree(parser, 'echo still-alive', tree => {
			assert.strictEqual(tree.rootNode.text, 'echo still-alive');
		});
	});
	test('owns provider tree copies across document races', async () => verifyProviderTreeOwnership(parser));
	test('refreshes command names after asynchronous lookup', verifyCompletionRefreshesCommandList);
	test('preserves editor-facing Unicode ranges', verifyEditorFacingParserCompatibility);
	test('reports caret parser and provider metadata', verifyCaretDebugInterface);
	test('updates provider-critical caret/cursor metadata live', verifyLiveCaretAndCursorDebugInterface);
	test('suppresses providers inside redirects and parser recovery regions', verifyProviderSuppressionRegions);
	test('preserves caret behavior across incremental edits', async () => {
		await verifyCaretBehaviorAcrossEdits(parser);
	});
	test('resolves command specs strictly through their hierarchy', verifyHierarchicalCommandResolution);
});

suite('Parser resource disposal', () => {
	test('deletes parsers after initialization fails', verifyFailedParserInitializationDisposesParser);
	test('deletes parsers after activation fails', verifyFailedActivationDisposesParser);
	test('deletes cached trees and the parser', verifyParserResourceDisposal);
	test('continues parser cleanup after a tree deletion fails', verifyParserResourceDisposalContinuesAfterFailure);
});
