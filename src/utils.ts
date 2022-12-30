import * as vscode from 'vscode';

// Format tldr pages by cleaning tldr-specific notations {{path/to/file}}
// as well as removing the title starting with '#'.
export function formatTldr(text: string): string {
  const s = text.replace(/{{(.*?)}}/g, "$1");
  const formatted = s.split("\n").filter((line: string) => !line.trimStart().startsWith("#")).join("\n").trimStart();
  return formatted;
}


// check if string a is prefix of b
export function isPrefixOf(left: string, right: string): boolean {
  const lengthLeft = left.length;
  const lengthRight = right.length;
  if (lengthLeft > lengthRight) {
    return false;
  }
  return (left === right.substring(0, lengthLeft));
}


// get a string from CompletionItem.label type
export function getLabelString(compItemLabel: string | vscode.CompletionItemLabel): string {
  return (typeof compItemLabel === 'string') ? compItemLabel : compItemLabel.label;
}
