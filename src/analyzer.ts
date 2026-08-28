import { Node, Point } from 'web-tree-sitter';

const transparentCommandWrappers = new Set(['sudo', 'nohup']);
const environmentAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/;

type NextCommandArgument = (node: Node) => Node | null;

function skipEnvironmentAssignments(
  node: Node | null,
  nextCommandArgument: NextCommandArgument,
): Node | null {
  while (node && environmentAssignment.test(node.text)) {
    node = nextCommandArgument(node);
  }
  return node;
}

function getSudoCommandNode(
  nameNode: Node,
  nextCommandArgument: NextCommandArgument,
): Node | null {
  let node = skipEnvironmentAssignments(nextCommandArgument(nameNode), nextCommandArgument);

  if (node?.text === '-u') {
    const user = nextCommandArgument(node);
    if (!user || user.text.startsWith('-')) {
      return null;
    }
    node = skipEnvironmentAssignments(nextCommandArgument(user), nextCommandArgument);
  }

  if (node?.text.startsWith('-') && node.text !== '-') {
    // tree-sitter-bash cannot distinguish sudo option arguments, action modes,
    // and the wrapped command. Only cross an option list at an explicit boundary.
    while (node && node.text !== '--') {
      node = nextCommandArgument(node);
    }
    node = node ? nextCommandArgument(node) : null;
  }

  return skipEnvironmentAssignments(node, nextCommandArgument);
}

function getNohupCommandNode(
  nameNode: Node,
  nextCommandArgument: NextCommandArgument,
): Node | null {
  const node = nextCommandArgument(nameNode);
  if (node?.text === '--') {
    return nextCommandArgument(node);
  }
  if (node?.text.startsWith('-')) {
    return null;
  }
  return node;
}

function getWrappedCommandNode(
  nameNode: Node,
  nextCommandArgument: NextCommandArgument,
): Node | null {
  let node: Node | null = nameNode;
  while (node && transparentCommandWrappers.has(node.text)) {
    node = node.text === 'sudo'
      ? getSudoCommandNode(node, nextCommandArgument)
      : getNohupCommandNode(node, nextCommandArgument);
  }
  return node;
}

export interface CommandWord {
  text: string;
  startPosition: Point;
  endPosition: Point;
}

export interface CommandInvocation {
  name: CommandWord;
  arguments: CommandWord[];
}

function getCommandInvocation(commandNode: Node | null | undefined): CommandInvocation | undefined {
  if (commandNode?.type !== 'command') {
    return undefined;
  }

  const nameNode = commandNode.childForFieldName('name');
  if (!nameNode) {
    return undefined;
  }

  const argumentNodes = commandNode.childrenForFieldName('argument');
  const argumentIndexById = new Map(argumentNodes.map((node, index) => [node.id, index]));
  const nextCommandArgument: NextCommandArgument = node => {
    const index = argumentIndexById.get(node.id);
    if (index !== undefined) {
      return argumentNodes[index + 1] ?? null;
    }
    return node.equals(nameNode) ? argumentNodes[0] ?? null : null;
  };

  const commandNameNode = getWrappedCommandNode(nameNode, nextCommandArgument);
  if (!commandNameNode) {
    return undefined;
  }

  const commandNameArgumentIndex = argumentIndexById.get(commandNameNode.id);
  const firstArgumentIndex = commandNameArgumentIndex === undefined
    ? 0
    : commandNameArgumentIndex + 1;
  const args: CommandWord[] = argumentNodes.slice(firstArgumentIndex).map(node => ({
    text: node.text,
    startPosition: node.startPosition,
    endPosition: node.endPosition,
  }));
  return {
    name: {
      text: commandNameNode.text,
      startPosition: commandNameNode.startPosition,
      endPosition: commandNameNode.endPosition,
    },
    arguments: args,
  };
}

/**
 * Returns whether a syntax node belongs to a command name or argument field.
 * Concrete token node types are deliberately ignored because tree-sitter-bash
 * refines them (for example, `word` into `number` or `concatenation`).
 */
export function isCommandTokenNode(node: Node): boolean {
  let child = node;
  let parent = child.parent;
  while (parent) {
    if (parent.type === 'command') {
      if (parent.childForFieldName('name')?.equals(child)) {
        return true;
      }
      return parent.childrenForFieldName('argument').some(argument => argument.equals(child));
    }
    if (
      parent.type === 'command_substitution'
      || parent.type === 'process_substitution'
      || parent.type === 'subshell'
    ) {
      return false;
    }
    child = parent;
    parent = child.parent;
  }
  return false;
}

function comparePoints(left: Point, right: Point): number {
  return left.row === right.row ? left.column - right.column : left.row - right.row;
}

export function getCommandName(commandNode: Node | null | undefined): string | undefined {
  return getCommandInvocation(commandNode)?.name.text;
}

export function getCommandArguments(commandNode: Node | null | undefined): string[] {
  return getCommandInvocation(commandNode)?.arguments.map(argument => argument.text) ?? [];
}

/**
 * Returns an invocation limited to the requested position. A completion request
 * excludes the argument being edited, while a hover request includes it.
 */
export function getCommandInvocationToPosition(
  commandNode: Node | null | undefined,
  position: Point,
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
