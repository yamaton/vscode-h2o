import * as vscode from 'vscode';

// Format tldr pages by cleaning tldr-specific notations {{path/to/file}}
// as well as removing the title starting with '#'.
export function formatTldr(text: string | undefined): string {
  if (!text || !text.length) {
    return "";
  }
  const s = text.replace(/{{(.*?)}}/g, "$1");
  const formatted = s.split("\n").filter((line: string) => !line.trimStart().startsWith("#")).join("\n").trimStart();
  return `\n\n${formatted}`;
}

// Format usage
export function formatUsage(text: string | undefined): string {
  if (!text || !text.trim().length) {
    return "";
  }
  const trimmed = text.trim();
  const xs = trimmed.split("\n");
  const formatted = (xs.length === 1) ?
    `Usage: \`${trimmed}\`` :
    `Usage:\n\n${xs.map(x => '     ' + x).join("\n")}\n\n`;
    console.log(formatted);
  return `\n\n${formatted}`;
}

// Format description
export function formatDescription(text: string): string {
  const trimmed = text.trim();
  return `\n\n${trimmed}`;
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
