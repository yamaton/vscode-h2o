import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadH2oLock, requireH2oTargetForVsix, verifyBinary } from './lib/h2o-release.mjs';
import {
  loadGrammarLock,
  verifyGrammarArtifact,
  verifyGrammarRuntimeCompatibility,
} from './lib/tree-sitter-grammar.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const lock = loadH2oLock(path.join(projectRoot, 'h2o.lock.json'));
const grammarLock = loadGrammarLock(path.join(projectRoot, 'tree-sitter-bash.lock.json'));
const hostTarget = `${process.platform}-${process.arch}`;
const vsixTarget = process.argv[2] ?? hostTarget;
const h2oTarget = requireH2oTargetForVsix(lock, vsixTarget);
const binaryPath = 'bin/h2o';
const executable = path.join(projectRoot, binaryPath);
verifyBinary(executable, h2oTarget, lock.assets[h2oTarget]);
assert.notStrictEqual(statSync(executable).mode & 0o111, 0, `${binaryPath} must be executable`);

const wrapperPath = path.join(projectRoot, 'bin/wrap-h2o');
assert.notStrictEqual(statSync(wrapperPath).mode & 0o111, 0, 'bin/wrap-h2o must be executable');
const wrapper = readFileSync(wrapperPath, 'utf8');
assert.match(wrapper, /^#!\/bin\/sh\n/, 'bin/wrap-h2o must use the POSIX sh interpreter');

const wrapperSyntax = spawnSync('/bin/sh', ['-n', wrapperPath], { encoding: 'utf8', timeout: 5000 });
assert.strictEqual(wrapperSyntax.status, 0, `bin/wrap-h2o is not valid POSIX shell syntax: ${wrapperSyntax.stderr}`);

const sandboxProfile = readFileSync(path.join(projectRoot, 'bin/profile.sb'), 'utf8');
assert.strictEqual(
  sandboxProfile,
  `(version 1)
(allow default)
(deny file-write*)
(allow file-write*
    (literal "/dev/null")
    (literal "/dev/full"))
(deny network*)
`,
  'bin/profile.sb must restrict macOS write access to /dev/null and /dev/full',
);

const wrapperFixtureDir = mkdtempSync(path.join(tmpdir(), 'vscode-h2o-wrapper-'));
try {
  const mockH2o = path.join(wrapperFixtureDir, 'mock h2o');
  const mockCommand = path.join(wrapperFixtureDir, 'mock command');
  const mockUname = path.join(wrapperFixtureDir, 'uname');
  const mockBwrap = path.join(wrapperFixtureDir, 'bwrap');
  const mockSandboxExec = path.join(wrapperFixtureDir, 'sandbox-exec');
  const writeExecutable = (filePath, content) => {
    writeFileSync(filePath, `#!/bin/sh\n${content}`);
    chmodSync(filePath, 0o755);
  };
  writeExecutable(mockH2o, 'printf \'%s\\n\' "$@"\n');
  writeExecutable(mockCommand, 'exit 0\n');
  writeExecutable(mockUname, 'printf \'%s\\n\' TestOS\n');

  const wrapperRun = spawnSync(wrapperPath, [mockH2o, mockCommand], {
    encoding: 'utf8',
    env: { ...process.env, PATH: wrapperFixtureDir },
    timeout: 5000,
  });
  assert.strictEqual(wrapperRun.status, 0, `bin/wrap-h2o failed under POSIX sh: ${wrapperRun.stderr}`);
  assert.deepStrictEqual(
    wrapperRun.stdout.trim().split(/\r?\n/),
    ['--command', mockCommand, '--format', 'json'],
    'bin/wrap-h2o did not preserve H2O arguments',
  );
  assert.match(wrapperRun.stderr, /\[warn\] no sandbox running!/, 'bin/wrap-h2o did not use its fallback path');

  writeExecutable(mockUname, 'printf \'%s\\n\' Linux\n');
  writeExecutable(mockBwrap, 'printf \'%s\\n\' "$@"\n');
  const linuxRun = spawnSync(wrapperPath, [mockH2o, mockCommand], {
    encoding: 'utf8',
    env: { ...process.env, PATH: wrapperFixtureDir },
    timeout: 5000,
  });
  assert.strictEqual(linuxRun.status, 0, `bin/wrap-h2o failed in its Linux sandbox path: ${linuxRun.stderr}`);
  assert.deepStrictEqual(
    linuxRun.stdout.trim().split(/\r?\n/),
    [
      '--ro-bind', '/', '/', '--dev', '/dev', '--tmpfs', '/tmp', '--unshare-all', '--', mockH2o,
      '--command', mockCommand, '--format', 'json',
    ],
    'bin/wrap-h2o did not preserve bubblewrap arguments',
  );

  rmSync(mockBwrap);
  writeExecutable(mockUname, 'printf \'%s\\n\' Darwin\n');
  writeExecutable(mockSandboxExec, 'printf \'%s\\n\' "$@"\n');
  const macosRun = spawnSync(wrapperPath, [mockH2o, mockCommand], {
    encoding: 'utf8',
    env: { ...process.env, PATH: wrapperFixtureDir },
    timeout: 5000,
  });
  assert.strictEqual(macosRun.status, 0, `bin/wrap-h2o failed in its macOS sandbox path: ${macosRun.stderr}`);
  assert.deepStrictEqual(
    macosRun.stdout.trim().split(/\r?\n/),
    [
      '-f', path.join(projectRoot, 'bin/profile.sb'), '--', mockH2o,
      '--command', mockCommand, '--format', 'json',
    ],
    'bin/wrap-h2o did not preserve sandbox-exec arguments',
  );

  writeExecutable(mockUname, 'printf \'%s\\n\' TestOS\n');
  writeExecutable(mockH2o, 'printf \'%s\\n\' "$$"\n');
  const execRun = spawnSync(wrapperPath, [mockH2o, mockCommand], {
    encoding: 'utf8',
    env: { ...process.env, PATH: wrapperFixtureDir },
    timeout: 5000,
  });
  assert.strictEqual(Number(execRun.stdout.trim()), execRun.pid, 'bin/wrap-h2o must exec H2O in the wrapper process');

  writeExecutable(mockH2o, 'exit 42\n');
  const failedH2o = spawnSync(wrapperPath, [mockH2o, mockCommand], {
    encoding: 'utf8',
    env: { ...process.env, PATH: wrapperFixtureDir },
    timeout: 5000,
  });
  assert.strictEqual(failedH2o.status, 42, 'bin/wrap-h2o must preserve the H2O exit status');

  const missingCommand = spawnSync(wrapperPath, [mockH2o, path.join(wrapperFixtureDir, 'missing command')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: wrapperFixtureDir },
    timeout: 5000,
  });
  assert.strictEqual(missingCommand.status, 127, 'bin/wrap-h2o must reject unavailable commands');

  const missingArguments = spawnSync(wrapperPath, [], {
    encoding: 'utf8',
    env: { ...process.env, PATH: wrapperFixtureDir },
    timeout: 5000,
  });
  assert.strictEqual(missingArguments.status, 64, 'bin/wrap-h2o must reject missing arguments');
  assert.match(missingArguments.stderr, /^Usage: wrap-h2o /, 'bin/wrap-h2o must explain its required arguments');
} finally {
  rmSync(wrapperFixtureDir, { recursive: true, force: true });
}

const parserWasm = readFileSync(path.join(projectRoot, grammarLock.file));
verifyGrammarArtifact(parserWasm, grammarLock);
await verifyGrammarRuntimeCompatibility(parserWasm, grammarLock);

const runnable = vsixTarget === hostTarget || (vsixTarget === 'alpine-x64' && hostTarget === 'linux-x64');
if (runnable) {
  const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 });
  assert.strictEqual(version.status, 0, `${binaryPath} --version failed: ${version.stderr}`);
  assert.match(version.stdout, /^h2o [0-9]+\.[0-9]+\.[0-9]+/m, `${binaryPath} returned an invalid version`);

  const scan = spawnSync(wrapperPath, [executable, 'git'], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.strictEqual(scan.status, 0, `${binaryPath} could not scan git: ${scan.error?.message ?? scan.stderr}`);
  const command = JSON.parse(scan.stdout);
  assert.strictEqual(command.name, 'git', `${binaryPath} scanned the wrong command`);
  const optionCount = (command.options?.length ?? 0)
    + (command.subcommands ?? []).reduce((count, subcommand) => count + (subcommand.options?.length ?? 0), 0);
  assert.ok(optionCount > 0, `${binaryPath} emitted no git options`);
} else {
  console.log(`Native execution skipped for ${vsixTarget} on ${hostTarget}; content checks still passed.`);
}

console.log('Pinned native executable and tree-sitter grammar checks passed.');
