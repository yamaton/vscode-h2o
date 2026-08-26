import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { h2oTargetForVsix, loadH2oLock } from './lib/h2o-release.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const lock = loadH2oLock(path.join(projectRoot, 'h2o.lock.json'));

function parseArguments(args) {
  assert.deepStrictEqual(args.slice(0, 1), ['--target'], 'Usage: node scripts/package-platform.mjs --target <target>');
  assert.strictEqual(args.length, 2, 'Usage: node scripts/package-platform.mjs --target <target>');
  return args[1];
}

function run(command, args) {
  execFileSync(command, args, { cwd: projectRoot, stdio: 'inherit' });
}

const vsixTarget = parseArguments(process.argv.slice(2));
const h2oTarget = h2oTargetForVsix(lock, vsixTarget);
const output = path.join(projectRoot, 'artifacts', `vscode-h2o-${vsixTarget}.vsix`);

run(process.execPath, [path.join(projectRoot, 'scripts/fetch-h2o.mjs'), '--target', h2oTarget]);
run(process.execPath, [path.join(projectRoot, 'scripts/stage-h2o-bundle.mjs'), vsixTarget]);
run(process.execPath, [path.join(projectRoot, 'scripts/verify-native.mjs'), vsixTarget]);
run('npx', ['--no-install', 'vsce', 'package', '--target', vsixTarget, '--out', output]);
run(process.execPath, [path.join(projectRoot, 'scripts/verify-vsix.mjs'), output, vsixTarget]);
