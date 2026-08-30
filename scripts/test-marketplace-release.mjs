import assert from 'node:assert/strict';
import {
  marketplacePublishArguments,
  missingMarketplaceTargets,
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

const expectedTargets = ['alpine-x64', 'linux-x64'];
const marketplaceResult = (...versions) => ({
  versions: versions.map(([version, targetPlatform]) => ({ version, targetPlatform })),
});

assert.deepStrictEqual(
  missingMarketplaceTargets(
    marketplaceResult(
      ['0.3.1', 'alpine-x64'],
      ['0.3.0', 'linux-x64'],
      ['0.3.1', 'unrelated-target'],
    ),
    '0.3.1',
    expectedTargets,
  ),
  ['linux-x64'],
);
assert.deepStrictEqual(
  missingMarketplaceTargets(
    marketplaceResult(['0.3.1', 'linux-x64'], ['0.3.1', 'alpine-x64']),
    '0.3.1',
    expectedTargets,
  ),
  [],
);
assert.throws(
  () => missingMarketplaceTargets({}, '0.3.1', expectedTargets),
  /must contain versions/,
);
assert.throws(
  () => missingMarketplaceTargets(marketplaceResult(), '0.3.1', ['linux-x64', 'linux-x64']),
  /must be unique/,
);

let currentTime = 0;
const delays = [];
let inspections = 0;
const pollResult = await waitForMarketplaceTargets({
  inspect: () => {
    inspections += 1;
    return inspections === 1
      ? marketplaceResult(['0.3.1', 'alpine-x64'])
      : marketplaceResult(['0.3.1', 'alpine-x64'], ['0.3.1', 'linux-x64']);
  },
  version: '0.3.1',
  expectedTargets,
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

currentTime = 0;
inspections = 0;
const transientResult = await waitForMarketplaceTargets({
  inspect: () => {
    inspections += 1;
    if (inspections === 1) {
      throw new Error('controlled Marketplace outage');
    }
    return marketplaceResult(['0.3.1', 'alpine-x64'], ['0.3.1', 'linux-x64']);
  },
  version: '0.3.1',
  expectedTargets,
  timeoutMs: 30,
  intervalMs: 10,
  now: () => currentTime,
  delay: async milliseconds => {
    currentTime += milliseconds;
  },
});
assert.deepStrictEqual(transientResult, { attempts: 2, elapsedMs: 10 });

currentTime = 0;
await assert.rejects(
  waitForMarketplaceTargets({
    inspect: () => marketplaceResult(['0.3.1', 'alpine-x64']),
    version: '0.3.1',
    expectedTargets,
    timeoutMs: 20,
    intervalMs: 10,
    now: () => currentTime,
    delay: async milliseconds => {
      currentTime += milliseconds;
    },
  }),
  /did not expose 0\.3\.1 for linux-x64 within 20 ms/,
);

console.log('Marketplace release checks passed.');
