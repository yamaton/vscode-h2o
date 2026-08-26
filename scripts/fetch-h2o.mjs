import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  loadH2oLock,
  validateArchiveEntries,
  verifyBinary,
  verifyExtractedBinary,
  verifyFile,
  verifyImmutableRelease,
} from './lib/h2o-release.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const lock = loadH2oLock(path.join(projectRoot, 'h2o.lock.json'));

function usage() {
  return `Usage: node scripts/fetch-h2o.mjs (--target <target> ... | --all) [--output-dir <directory>]

Available targets:
${Object.keys(lock.assets).map((target) => `  ${target}`).join('\n')}`;
}

function parseArguments(args) {
  const targets = [];
  let outputDir = path.join(projectRoot, 'artifacts', 'h2o');
  let all = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--target') {
      const target = args[index + 1];
      assert.ok(target, '--target requires a value');
      targets.push(target);
      index += 1;
    } else if (argument === '--output-dir') {
      const directory = args[index + 1];
      assert.ok(directory, '--output-dir requires a value');
      outputDir = path.resolve(projectRoot, directory);
      index += 1;
    } else if (argument === '--all') {
      all = true;
    } else if (argument === '--help' || argument === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  assert.ok(!(all && targets.length > 0), 'use either --all or --target, not both');
  const selected = all ? Object.keys(lock.assets) : [...new Set(targets)];
  assert.ok(selected.length > 0, 'at least one --target or --all is required');
  for (const target of selected) {
    assert.ok(lock.assets[target], `target is not present in h2o.lock.json: ${target}`);
  }
  return { targets: selected, outputDir };
}

function downloadAndExtract(target, outputDir) {
  const asset = lock.assets[target];
  const targetDirectory = path.join(outputDir, target);
  const destination = path.join(targetDirectory, 'h2o');
  if (existsSync(destination)) {
    verifyBinary(destination, target, asset);
    console.log(`Reused verified ${target} at ${path.relative(projectRoot, destination)}.`);
    return;
  }

  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'vscode-h2o-release-'));
  try {
    execFileSync(
      'gh',
      ['release', 'download', lock.tag, '--repo', lock.repository, '--pattern', asset.archive, '--dir', temporaryDirectory],
      { stdio: 'inherit' },
    );
    const archivePath = path.join(temporaryDirectory, asset.archive);
    verifyFile(archivePath, asset.archiveSize, asset.archiveSha256, asset.archive);
    execFileSync(
      'gh',
      ['release', 'verify-asset', lock.tag, archivePath, '--repo', lock.repository],
      { stdio: 'inherit' },
    );

    const entries = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
    validateArchiveEntries(entries, asset.binary);
    execFileSync('tar', ['-xzf', archivePath, '-C', temporaryDirectory, '--', asset.binary]);

    const extractedPath = path.join(temporaryDirectory, asset.binary);
    verifyExtractedBinary(extractedPath, target, asset);

    mkdirSync(targetDirectory, { recursive: true });
    copyFileSync(extractedPath, destination);
    chmodSync(destination, 0o755);
    console.log(`Prepared ${target} at ${path.relative(projectRoot, destination)}.`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const { targets, outputDir } = parseArguments(process.argv.slice(2));
verifyImmutableRelease(lock);
for (const target of targets) {
  downloadAndExtract(target, outputDir);
}
