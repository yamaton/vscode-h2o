import * as assert from 'assert';
import * as path from 'path';
import { Node, Parser, Point, Tree } from 'web-tree-sitter';
import { loadLanguageOnce } from '../parserLanguage';

export interface NodeSnapshot {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: Point;
  endPosition: Point;
  hasError: boolean;
  children: NodeSnapshot[];
}

export async function createBashParser(): Promise<Parser> {
  await Parser.init();
  const parser = new Parser();
  const wasmPath = path.resolve(__dirname, '../../tree-sitter-bash.wasm');

  try {
    parser.setLanguage(await loadLanguageOnce(wasmPath));
    return parser;
  } catch (error) {
    parser.delete();
    throw error;
  }
}

export function parseTree(parser: Parser, source: string, oldTree?: Tree): Tree {
  const tree = parser.parse(source, oldTree);
  if (!tree) {
    throw new Error('Tree-sitter parsing was cancelled.');
  }
  return tree;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }

  return 'then' in value && typeof value.then === 'function';
}

/**
 * Lends a Tree to an operation and deletes it after the result settles.
 *
 * The operation must not delete the Tree or return the Tree, a Node,
 * a TreeCursor, or any other value whose lifetime is tied to the Tree.
 */
export function withTree<T>(
  tree: Tree,
  operation: (tree: Tree) => PromiseLike<T>,
): Promise<T>;
export function withTree<T>(tree: Tree, operation: (tree: Tree) => T): T;
export function withTree(
  tree: Tree,
  operation: (tree: Tree) => unknown,
): unknown {
  let result: unknown;

  try {
    result = operation(tree);
  } catch (error) {
    tree.delete();
    throw error;
  }

  let resultPromise: Promise<unknown> | undefined;
  try {
    if (isPromiseLike(result)) {
      resultPromise = Promise.resolve(result);
    }
  } catch (error) {
    tree.delete();
    throw error;
  }

  if (resultPromise) {
    return resultPromise.finally(() => tree.delete());
  }

  tree.delete();
  return result;
}

/**
 * Parses source and lends the resulting Tree to an operation.
 *
 * The operation follows the ownership rules documented by withTree.
 */
export function withParsedTree<T>(
  parser: Parser,
  source: string,
  operation: (tree: Tree) => PromiseLike<T>,
): Promise<T>;
export function withParsedTree<T>(
  parser: Parser,
  source: string,
  operation: (tree: Tree) => T,
): T;
export function withParsedTree(
  parser: Parser,
  source: string,
  operation: (tree: Tree) => unknown,
): unknown {
  return withTree(parseTree(parser, source), operation);
}

/**
 * Lends the first named node to an operation while its Tree is alive.
 *
 * The operation must return Tree-independent data and must not delete the
 * node's Tree.
 */
export function withFirstNamedNode<T>(
  parser: Parser,
  source: string,
  operation: (node: Node) => PromiseLike<T>,
): Promise<T>;
export function withFirstNamedNode<T>(
  parser: Parser,
  source: string,
  operation: (node: Node) => T,
): T;
export function withFirstNamedNode(
  parser: Parser,
  source: string,
  operation: (node: Node) => unknown,
): unknown {
  return withParsedTree(parser, source, tree => {
    const node = tree.rootNode.firstNamedChild;
    assert.ok(node, `Expected a syntax node for: ${source}`);
    return operation(node);
  });
}

/** Returns Tree-backed nodes that must not outlive their Tree. */
export function descendantsOfType(node: Node, type: string): Node[] {
  const matches = node.type === type ? [node] : [];
  return matches.concat(...node.children.map(child => descendantsOfType(child, type)));
}

/** Returns a Tree-independent snapshot of a node and all its descendants. */
export function snapshotNode(node: Node): NodeSnapshot {
  return {
    type: node.type,
    text: node.text,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    startPosition: node.startPosition,
    endPosition: node.endPosition,
    hasError: node.hasError,
    children: node.children.map(snapshotNode),
  };
}
