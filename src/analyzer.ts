import * as Parser from 'web-tree-sitter';
import { SyntaxNode } from 'web-tree-sitter';

const transparentCommandWrappers = new Set(['sudo', 'nohup']);
const environmentAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/;

function skipEnvironmentAssignments(node: SyntaxNode | null): SyntaxNode | null {
  while (node && environmentAssignment.test(node.text)) {
    node = node.nextNamedSibling;
  }
  return node;
}

function getSudoCommandNode(nameNode: SyntaxNode): SyntaxNode | null {
  let node = skipEnvironmentAssignments(nameNode.nextNamedSibling);

  if (node?.text === '-u') {
    const user = node.nextNamedSibling;
    if (!user || user.text.startsWith('-')) {
      return null;
    }
    node = skipEnvironmentAssignments(user.nextNamedSibling);
  }

  if (node?.text.startsWith('-') && node.text !== '-') {
    // tree-sitter-bash cannot distinguish sudo option arguments, action modes,
    // and the wrapped command. Only cross an option list at an explicit boundary.
    while (node && node.text !== '--') {
      node = node.nextNamedSibling;
    }
    node = node?.nextNamedSibling ?? null;
  }

  return skipEnvironmentAssignments(node);
}

function getNohupCommandNode(nameNode: SyntaxNode): SyntaxNode | null {
  const node = nameNode.nextNamedSibling;
  if (node?.text === '--') {
    return node.nextNamedSibling;
  }
  if (node?.text.startsWith('-')) {
    return null;
  }
  return node;
}

function getWrappedCommandNode(nameNode: SyntaxNode): SyntaxNode | null {
  let node: SyntaxNode | null = nameNode;
  while (node && transparentCommandWrappers.has(node.text)) {
    node = node.text === 'sudo' ? getSudoCommandNode(node) : getNohupCommandNode(node);
  }
  return node;
}

export interface CommandWord {
  text: string;
  startPosition: Parser.Point;
  endPosition: Parser.Point;
}

export interface CommandInvocation {
  name: CommandWord;
  arguments: CommandWord[];
}

function getCommandInvocation(commandNode: SyntaxNode | null | undefined): CommandInvocation | undefined {
  if (commandNode?.type !== 'command') {
    return undefined;
  }

  const nameNode = commandNode.childForFieldName('name');
  if (!nameNode) {
    return undefined;
  }

  const commandNameNode = getWrappedCommandNode(nameNode);
  if (!commandNameNode) {
    return undefined;
  }

  const args: CommandWord[] = [];
  let node = commandNameNode.nextNamedSibling;
  while (node) {
    args.push({
      text: node.text,
      startPosition: node.startPosition,
      endPosition: node.endPosition,
    });
    node = node.nextNamedSibling;
  }
  return {
    name: {
      text: commandNameNode.text,
      startPosition: commandNameNode.startPosition,
      endPosition: commandNameNode.endPosition,
    },
    arguments: args,
  };
}

function comparePoints(left: Parser.Point, right: Parser.Point): number {
  return left.row === right.row ? left.column - right.column : left.row - right.row;
}

export function getCommandName(commandNode: SyntaxNode | null | undefined): string | undefined {
  return getCommandInvocation(commandNode)?.name.text;
}

export function getCommandArguments(commandNode: SyntaxNode | null | undefined): string[] {
  return getCommandInvocation(commandNode)?.arguments.map(argument => argument.text) ?? [];
}

/**
 * Returns an invocation limited to the cursor context. A completion request
 * excludes the argument being edited, while a hover request includes it.
 */
export function getCommandInvocationToPosition(
  commandNode: SyntaxNode | null | undefined,
  position: Parser.Point,
  includeArgumentAtPosition: boolean,
): CommandInvocation | undefined {
  const invocation = getCommandInvocation(commandNode);
  if (!invocation) {
    return undefined;
  }

  return {
    name: invocation.name,
    arguments: invocation.arguments.filter(argument => includeArgumentAtPosition
      ? comparePoints(argument.startPosition, position) <= 0
      : comparePoints(argument.endPosition, position) < 0),
  };
}
