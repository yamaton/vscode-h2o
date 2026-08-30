export const requiredExtensionFiles = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/bin/h2o',
  'extension/bin/profile.sb',
  'extension/bin/wrap-h2o',
  'extension/changelog.md',
  'extension/images/animal_chara_computer_penguin.png',
  'extension/images/debug.svg',
  'extension/images/demo-autocomplete.gif',
  'extension/images/demo-mouseover.gif',
  'extension/images/vscode-h2o-completion.gif',
  'extension/images/vscode-h2o-hover.gif',
  'extension/images/vscode-shell-command-explorer.png',
  'extension/LICENSE.txt',
  'extension/out/analyzer.js',
  'extension/out/cacheFetcher.js',
  'extension/out/cacheStorage.js',
  'extension/out/cancellable.js',
  'extension/out/command.js',
  'extension/out/commandExplorer.js',
  'extension/out/commandResolver.js',
  'extension/out/completionTarget.js',
  'extension/out/debugView.js',
  'extension/out/extension.js',
  'extension/out/h2oRunner.js',
  'extension/out/parserLanguage.js',
  'extension/out/providerContext.js',
  'extension/out/providerPerformance.js',
  'extension/out/treeCache.js',
  'extension/out/utils.js',
  'extension/package.json',
  'extension/readme.md',
  'extension/tree-sitter-bash.wasm',
];

const generatedExtensionFiles = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/bin/h2o',
];

export function sourceFileToExtensionPath(sourceFile) {
  const normalized = sourceFile.replaceAll('\\', '/');
  switch (normalized) {
    case 'CHANGELOG.md':
      return 'extension/changelog.md';
    case 'LICENSE':
      return 'extension/LICENSE.txt';
    case 'README.md':
      return 'extension/readme.md';
    default:
      return `extension/${normalized}`;
  }
}

export function packagedExtensionFiles(sourceFiles) {
  return [...new Set([
    ...generatedExtensionFiles,
    ...sourceFiles.map(sourceFileToExtensionPath),
  ])].sort();
}

export function compareExtensionFileContract(packagedFiles, contractFiles = requiredExtensionFiles) {
  const packaged = new Set(packagedFiles);
  const contracted = new Set(contractFiles);

  return {
    unlistedPackagedFiles: [...packaged].filter((file) => !contracted.has(file)).sort(),
    missingPackagedFiles: [...contracted].filter((file) => !packaged.has(file)).sort(),
  };
}
