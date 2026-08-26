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

interface CommandInvocation {
  name: string;
  arguments: string[];
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

  const args: string[] = [];
  let node = commandNameNode.nextNamedSibling;
  while (node) {
    args.push(node.text);
    node = node.nextNamedSibling;
  }
  return { name: commandNameNode.text, arguments: args };
}

export function getCommandName(commandNode: SyntaxNode | null | undefined): string | undefined {
  return getCommandInvocation(commandNode)?.name;
}

export function getCommandArguments(commandNode: SyntaxNode | null | undefined): string[] {
  return getCommandInvocation(commandNode)?.arguments ?? [];
}
