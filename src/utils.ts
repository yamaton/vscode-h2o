// Format tldr pages by cleaning tldr-specific notations {{path/to/file}}
// as well as removing the title starting with '#'.
export function formatTldr(text: string): string {
  const s = text.replace(/{{(.*?)}}/g, "$1");
  const formatted = s.split("\n").filter((line: string) => !line.trimStart().startsWith("#")).join("\n").trimStart();
  return formatted;
}
