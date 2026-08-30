import { fileURLToPath } from 'node:url';

import vsce from '@vscode/vsce';

import {
  compareExtensionFileContract,
  packagedExtensionFiles,
} from './lib/vsix-file-contract.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceFiles = await vsce.listFiles({
  cwd: projectRoot,
  packageManager: vsce.PackageManager.None,
});
const extensionFiles = packagedExtensionFiles(sourceFiles);
const { unlistedPackagedFiles, missingPackagedFiles } = compareExtensionFileContract(extensionFiles);

if (unlistedPackagedFiles.length === 0 && missingPackagedFiles.length === 0) {
  console.log(`VSIX file preflight passed for ${extensionFiles.length} extension files.`);
} else {
  const summary = 'Packaged extension files and the VSIX allowlist differ.';
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.error(`::warning file=scripts/lib/vsix-file-contract.mjs,title=VSIX file contract::${summary}`);
  }
  console.error(`WARNING: ${summary}`);
  for (const file of unlistedPackagedFiles) {
    console.error(`  Add to requiredExtensionFiles: ${file}`);
  }
  for (const file of missingPackagedFiles) {
    console.error(`  Remove from requiredExtensionFiles or restore the packaged file: ${file}`);
  }
  process.exitCode = 1;
}
