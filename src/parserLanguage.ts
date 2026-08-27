import * as path from 'path';
import * as Parser from 'web-tree-sitter';

export type LanguageLoader = (wasmPath: string) => Promise<Parser.Language>;

/**
 * Coalesces language loads by canonical path for the lifetime of this process.
 *
 * Successful and failed promises are both retained. web-tree-sitter cannot
 * unload a language side module, so retrying a partially failed load could
 * only add more process-lifetime allocations.
 */
export function createCachedLanguageLoader(loadLanguage: LanguageLoader): LanguageLoader {
  const languageLoads = new Map<string, Promise<Parser.Language>>();

  return wasmPath => {
    const canonicalPath = path.resolve(wasmPath);
    let languageLoad = languageLoads.get(canonicalPath);

    if (!languageLoad) {
      languageLoad = Promise.resolve().then(() => loadLanguage(canonicalPath));
      languageLoads.set(canonicalPath, languageLoad);
    }

    return languageLoad;
  };
}

export const loadLanguageOnce = createCachedLanguageLoader(async wasmPath => {
  await Parser.init();
  return Parser.Language.load(wasmPath);
});
