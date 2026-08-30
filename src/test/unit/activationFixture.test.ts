import * as assert from 'assert';

import {
  commandCacheSnapshotVersion,
  encodeCommandCacheSnapshot,
} from '../../cacheStorage';
import {
  createActivationFixtureSnapshot,
  type ActivationProfile,
} from '../performance/activationFixture';

interface ExpectedFixture {
  profile: ActivationProfile;
  commandCount: number;
  jsonBytes: number;
  referenceCompressedBytes: number;
}

const expectedFixtures: ExpectedFixture[] = [
  {
    profile: 'general',
    commandCount: 411,
    jsonBytes: 11_811_096,
    referenceCompressedBytes: 2_225_460,
  },
  {
    profile: 'general-bio',
    commandCount: 1017,
    jsonBytes: 20_283_379,
    referenceCompressedBytes: 3_665_887,
  },
];

suite('performance activation fixtures', () => {
  test('creates an empty snapshot without synthetic data', () => {
    const fixture = createActivationFixtureSnapshot('empty');
    assert.strictEqual(fixture.jsonBytes, 0);
    assert.deepStrictEqual(fixture.snapshot.commands, []);
  });

  for (const expected of expectedFixtures) {
    test(`reproduces the ${expected.profile} payload scale and compression`, async () => {
      const fixture = createActivationFixtureSnapshot(expected.profile);
      assert.strictEqual(fixture.snapshot.version, commandCacheSnapshotVersion);
      assert.strictEqual(fixture.snapshot.commands.length, expected.commandCount);
      assert.strictEqual(fixture.jsonBytes, expected.jsonBytes);
      assert.strictEqual(
        Buffer.byteLength(JSON.stringify(fixture.snapshot)),
        expected.jsonBytes,
      );
      const compressed = await encodeCommandCacheSnapshot(fixture.snapshot);
      const relativeDifference = Math.abs(
        compressed.length - expected.referenceCompressedBytes,
      ) / expected.referenceCompressedBytes;
      assert.ok(
        relativeDifference < 0.1,
        `${expected.profile} compressed size ${compressed.length} differs from reference `
          + `${expected.referenceCompressedBytes} by ${(relativeDifference * 100).toFixed(2)}%`,
      );
    });
  }
});
