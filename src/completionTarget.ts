import type { Node, Point } from 'web-tree-sitter';
import {
  CommandWord,
  getCommandInvocationToPosition,
} from './analyzer';

export interface CommandNameCompletionContext {
  word: CommandWord;
  atWordEnd: boolean;
}

export type CompletionLookupTarget =
  | { kind: 'command-name'; context: CommandNameCompletionContext }
  | { kind: 'command-spec' }
  | { kind: 'none' };

function comparePoints(left: Point, right: Point): number {
  return left.row === right.row ? left.column - right.column : left.row - right.row;
}

function containsPosition(word: CommandWord, position: Point): boolean {
  return comparePoints(word.startPosition, position) <= 0
    && comparePoints(position, word.endPosition) <= 0;
}

function completionContext(
  word: CommandWord,
  position: Point,
): CommandNameCompletionContext | undefined {
  if (
    word.startPosition.row !== position.row
    || word.endPosition.row !== position.row
    || !containsPosition(word, position)
  ) {
    return undefined;
  }

  return {
    word,
    atWordEnd: comparePoints(position, word.endPosition) === 0,
  };
}

export function getCompletionLookupTarget(
  commandNode: Node | null | undefined,
  position: Point,
): CompletionLookupTarget {
  const invocation = getCommandInvocationToPosition(commandNode, position, true);
  if (invocation) {
    const effectiveContext = completionContext(invocation.name, position);
    if (effectiveContext) {
      return effectiveContext.atWordEnd
        ? { kind: 'command-name', context: effectiveContext }
        : { kind: 'none' };
    }
    return comparePoints(position, invocation.name.startPosition) < 0
      ? { kind: 'none' }
      : { kind: 'command-spec' };
  }

  // A standalone transparent wrapper (for example `sudo|`) has no effective
  // command name yet, but its syntax-level name remains a valid completion
  // target.
  const syntaxName = commandNode?.childForFieldName('name');
  if (!syntaxName) {
    return { kind: 'command-spec' };
  }
  const syntaxContext = completionContext({
    text: syntaxName.text,
    startPosition: syntaxName.startPosition,
    endPosition: syntaxName.endPosition,
  }, position);
  if (!syntaxContext) {
    return { kind: 'command-spec' };
  }
  return syntaxContext.atWordEnd
    ? { kind: 'command-name', context: syntaxContext }
    : { kind: 'none' };
}
