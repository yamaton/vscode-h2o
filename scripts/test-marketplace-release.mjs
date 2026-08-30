import assert from 'node:assert/strict';
import {
  marketplacePublishArguments,
  marketplaceTargetMismatches,
  waitForMarketplaceTargets,
} from './lib/marketplace-release.mjs';

const packages = [
  '/release/vscode-h2o-alpine-x64.vsix',
  '/release/vscode-h2o-linux-x64.vsix',
];

assert.deepStrictEqual(
  marketplacePublishArguments(packages),
  [
    '--no-install',
    'vsce',
    'publish',
    '--skip-duplicate',
    '--packagePath',
    ...packages,
  ],
);
assert.throws(() => marketplacePublishArguments([]), /at least one VSIX package/);

const alpineHash = 'a'.repeat(64);
const linuxHash = 'b'.repeat(64);
const unexpectedHash = 'c'.repeat(64);
const expectedPackages = [
  { target: 'alpine-x64', sha256: alpineHash },
  { target: 'linux-x64', sha256: linuxHash },
];
const marketplaceResult = (...versions) => ({
  versions: versions.map(([version, targetPlatform, sha256]) => ({
    version,
    targetPlatform,
    properties: sha256 === undefined ? [] : [{
      key: 'Microsoft.VisualStudio.Services.VsixSha256',
      value: sha256,
    }],
  })),
});

assert.deepStrictEqual(
  marketplaceTargetMismatches(
    marketplaceResult(
      ['0.3.1', 'alpine-x64', alpineHash],
      ['0.3.0', 'linux-x64', linuxHash],
      ['0.3.1', 'unrelated-target', unexpectedHash],
    ),
    '0.3.1',
    expectedPackages,
  ),
  [{ target: 'linux-x64', sha256: linuxHash, actualSha256: null, reason: 'missing' }],
);
assert.deepStrictEqual(
  marketplaceTargetMismatches(
    marketplaceResult(
      ['0.3.1', 'linux-x64', unexpectedHash],
      ['0.3.1', 'alpine-x64', alpineHash],
    ),
    '0.3.1',
    expectedPackages,
  ),
  [{ target: 'linux-x64', sha256: linuxHash, actualSha256: unexpectedHash, reason: 'sha256' }],
);
assert.deepStrictEqual(
  marketplaceTargetMismatches(
    marketplaceResult(
      ['0.3.1', 'linux-x64', linuxHash],
      ['0.3.1', 'alpine-x64', alpineHash],
    ),
    '0.3.1',
    expectedPackages,
  ),
  [],
);
assert.throws(
  () => marketplaceTargetMismatches({}, '0.3.1', expectedPackages),
  /must contain versions/,
);
assert.throws(
  () => marketplaceTargetMismatches(marketplaceResult(), '0.3.1', [
    { target: 'linux-x64', sha256: linuxHash },
    { target: 'linux-x64', sha256: linuxHash },
  ]),
  /must be unique/,
);
assert.throws(
  () => marketplaceTargetMismatches(marketplaceResult(), '0.3.1', [
    { target: 'linux-x64', sha256: 'not-a-sha256' },
  ]),
  /must be lowercase hexadecimal/,
);

let currentTime = 0;
const delays = [];
const queryTimeouts = [];
let inspections = 0;
const pollResult = await waitForMarketplaceTargets({
  inspect: ({ timeoutMs }) => {
    queryTimeouts.push(timeoutMs);
    inspections += 1;
    return inspections === 1
      ? marketplaceResult(['0.3.1', 'alpine-x64', alpineHash])
      : marketplaceResult(
        ['0.3.1', 'alpine-x64', alpineHash],
        ['0.3.1', 'linux-x64', linuxHash],
      );
  },
  version: '0.3.1',
  expectedPackages,
  timeoutMs: 30,
  intervalMs: 10,
  now: () => currentTime,
  delay: async milliseconds => {
    delays.push(milliseconds);
    currentTime += milliseconds;
  },
});
assert.deepStrictEqual(pollResult, { attempts: 2, elapsedMs: 10 });
assert.deepStrictEqual(delays, [10]);
assert.deepStrictEqual(queryTimeouts, [30, 20]);

currentTime = 0;
inspections = 0;
const transientResult = await waitForMarketplaceTargets({
  inspect: () => {
    inspections += 1;
    if (inspections === 1) {
      throw new Error('controlled Marketplace outage');
    }
    return marketplaceResult(
      ['0.3.1', 'alpine-x64', alpineHash],
      ['0.3.1', 'linux-x64', linuxHash],
    );
  },
  version: '0.3.1',
  expectedPackages,
  timeoutMs: 30,
  intervalMs: 10,
  now: () => currentTime,
  delay: async milliseconds => {
    currentTime += milliseconds;
  },
});
assert.deepStrictEqual(transientResult, { attempts: 2, elapsedMs: 10 });

currentTime = 0;
const deadlineQueryTimeouts = [];
await assert.rejects(
  waitForMarketplaceTargets({
    inspect: ({ timeoutMs }) => {
      deadlineQueryTimeouts.push(timeoutMs);
      return marketplaceResult(
        ['0.3.1', 'alpine-x64', alpineHash],
        ['0.3.1', 'linux-x64', unexpectedHash],
      );
    },
    version: '0.3.1',
    expectedPackages,
    timeoutMs: 20,
    intervalMs: 10,
    now: () => currentTime,
    delay: async milliseconds => {
      currentTime += milliseconds;
    },
  }),
  /did not expose 0\.3\.1 with verified VSIX hashes for linux-x64 \(SHA-256/,
);
assert.deepStrictEqual(deadlineQueryTimeouts, [20, 10]);

console.log('Marketplace release checks passed.');
