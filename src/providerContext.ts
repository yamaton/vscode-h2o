import type { Node, Point } from 'web-tree-sitter';

import { isCommandTokenNode } from './analyzer';

const nestedCommandScopeBoundaries = new Set([
  'command_substitution',
  'process_substitution',
  'subshell',
]);
const executableRedirectPayloadBoundaries = new Set([
  'command_substitution',
  'process_substitution',
]);
const providerSuppressedNodeTypes = new Set([
  'file_redirect',
  'herestring_redirect',
  'heredoc_redirect',
]);
const closingDelimiterTypes = new Set([')', '`']);
const openingDelimiterTypes = new Set(['$(', '<(', '>(', '(', '`']);
// A separator belongs to the previous command syntactically, but completion
// walkback must not cross it into that command.
const completionWalkbackBoundaryTypes = new Set([';']);

export type ProviderSuppressionReason =
  | 'ERROR'
  | 'MISSING'
  | 'file_redirect'
  | 'herestring_redirect'
  | 'heredoc_redirect';

export interface LineTextProvider {
  lineAt(line: number): { text: string };
}

export interface CompletionAnchor {
  point: Point;
  commandNode: Node | undefined;
  moved: boolean;
  touchingCommandToken: boolean;
}

function comparePoints(left: Point, right: Point): number {
  return left.row === right.row ? left.column - right.column : left.row - right.row;
}

function pointsEqual(left: Point, right: Point): boolean {
  return comparePoints(left, right) === 0;
}

function containsPointInclusive(node: Node, point: Point): boolean {
  return comparePoints(node.startPosition, point) <= 0
    && comparePoints(point, node.endPosition) <= 0;
}

/** Returns the deepest node using the editor's left-affine caret semantics. */
export function getCurrentNodeAtPoint(root: Node, point: Point): Node {
  for (const child of root.children) {
    if (containsPointInclusive(child, point)) {
      return getCurrentNodeAtPoint(child, point);
    }
  }
  return root;
}

function isRecoverableMissingExecutableCloser(node: Node): boolean {
  const parent = node.parent;
  return node.isMissing
    && closingDelimiterTypes.has(node.type)
    && parent !== null
    && executableRedirectPayloadBoundaries.has(parent.type)
    && parent.lastChild?.equals(node) === true;
}

function hasUnrecoverableMissingNodeAtPoint(node: Node, point: Point): boolean {
  if (!containsPointInclusive(node, point)) {
    return false;
  }
  if (
    node.isMissing
    && pointsEqual(node.startPosition, point)
    && !isRecoverableMissingExecutableCloser(node)
  ) {
    return true;
  }
  return node.children.some(child => hasUnrecoverableMissingNodeAtPoint(child, point));
}

function hasRealClosingDelimiter(node: Node): boolean {
  const lastChild = node.lastChild;
  return lastChild !== null
    && !lastChild.isMissing
    && closingDelimiterTypes.has(lastChild.type)
    && pointsEqual(lastChild.endPosition, node.endPosition);
}

function executableScopeContainsCaret(node: Node, point: Point): boolean {
  return !pointsEqual(node.endPosition, point) || !hasRealClosingDelimiter(node);
}

export function getProviderSuppressionReasonsAtPoint(
  root: Node,
  point: Point,
): ProviderSuppressionReason[] {
  const reasons = new Set<ProviderSuppressionReason>();
  if (hasUnrecoverableMissingNodeAtPoint(root, point)) {
    reasons.add('MISSING');
  }

  let node: Node | null = getCurrentNodeAtPoint(root, point);
  let insideExecutableRedirectPayload = false;
  while (node) {
    if (node.isError) {
      reasons.add('ERROR');
    }
    if (node.isMissing && !isRecoverableMissingExecutableCloser(node)) {
      reasons.add('MISSING');
    }
    if (
      executableRedirectPayloadBoundaries.has(node.type)
      && executableScopeContainsCaret(node, point)
    ) {
      insideExecutableRedirectPayload = true;
    }
    if (
      providerSuppressedNodeTypes.has(node.type)
      && (!insideExecutableRedirectPayload || node.type === 'heredoc_redirect')
    ) {
      reasons.add(node.type as ProviderSuppressionReason);
    }
    node = node.parent;
  }
  return [...reasons];
}

function commandNodeFrom(node: Node): Node | undefined {
  let current: Node | null = node;
  while (current) {
    if (current.type === 'command') {
      return current;
    }
    if (nestedCommandScopeBoundaries.has(current.type)) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

export function getContextCommandNodeAtPoint(root: Node, point: Point): Node | undefined {
  return commandNodeFrom(getCurrentNodeAtPoint(root, point));
}

function closedScopeEndsAtPoint(node: Node, point: Point): boolean {
  return nestedCommandScopeBoundaries.has(node.type)
    && pointsEqual(node.endPosition, point)
    && hasRealClosingDelimiter(node);
}

/**
 * Resolves completion ownership without re-entering a nested scope whose real
 * closing delimiter ends at the caret.
 */
export function getCompletionCommandNodeAtPoint(root: Node, point: Point): Node | undefined {
  const currentNode = getCurrentNodeAtPoint(root, point);
  if (isCommandTokenNode(currentNode)) {
    return commandNodeFrom(currentNode);
  }

  let node: Node | null = currentNode;
  let crossedClosedScope = false;
  while (node) {
    if (node.type === 'command') {
      return crossedClosedScope ? node : undefined;
    }
    if (nestedCommandScopeBoundaries.has(node.type)) {
      if (!closedScopeEndsAtPoint(node, point)) {
        return undefined;
      }
      crossedClosedScope = true;
    }
    node = node.parent;
  }
  return undefined;
}

function isOpeningDelimiterAtPoint(root: Node, point: Point): boolean {
  const node = getCurrentNodeAtPoint(root, point);
  const parent = node.parent;
  return parent !== null
    && nestedCommandScopeBoundaries.has(parent.type)
    && openingDelimiterTypes.has(node.type)
    && node.startIndex === parent.startIndex;
}

function previousPoint(document: LineTextProvider, point: Point): Point | undefined {
  if (point.column > 0) {
    return { row: point.row, column: point.column - 1 };
  }
  if (point.row === 0) {
    return undefined;
  }

  const previousLineIndex = point.row - 1;
  const previousLine = document.lineAt(previousLineIndex).text.trimEnd();
  if (!previousLine.endsWith('\\')) {
    return undefined;
  }
  return { row: previousLineIndex, column: previousLine.length - 1 };
}

export function resolveCompletionAnchor(
  document: LineTextProvider,
  root: Node,
  caret: Point,
): CompletionAnchor {
  let point = caret;

  while (true) {
    const currentNode = getCurrentNodeAtPoint(root, point);
    const moved = !pointsEqual(point, caret);
    const suppressionReasons = getProviderSuppressionReasonsAtPoint(root, point);
    if (suppressionReasons.length > 0) {
      return {
        point,
        commandNode: getContextCommandNodeAtPoint(root, point),
        moved,
        touchingCommandToken: false,
      };
    }
    if (isOpeningDelimiterAtPoint(root, point)) {
      return { point, commandNode: undefined, moved, touchingCommandToken: false };
    }
    if (completionWalkbackBoundaryTypes.has(currentNode.type)) {
      return { point, commandNode: undefined, moved, touchingCommandToken: false };
    }

    const commandNode = getCompletionCommandNodeAtPoint(root, point);
    if (commandNode) {
      return {
        point,
        commandNode,
        moved,
        touchingCommandToken: !moved && isCommandTokenNode(currentNode),
      };
    }

    const previous = previousPoint(document, point);
    if (!previous) {
      return { point, commandNode: undefined, moved, touchingCommandToken: false };
    }
    point = previous;
  }
}
