import { SyntaxNode } from 'web-tree-sitter';

const transparentCommandWrappers = new Set(['sudo', 'nohup']);

export function getCommandName(commandNode: SyntaxNode | null | undefined): string | undefined {
  if (commandNode?.type !== 'command') {
    return undefined;
  }

  const nameNode = commandNode.childForFieldName('name');
  if (!nameNode) {
    return undefined;
  }

  if (transparentCommandWrappers.has(nameNode.text)) {
    return nameNode.nextNamedSibling?.text;
  }
  return nameNode.text;
}
