import * as assert from 'assert';
import {
  requestUnknownCommandScanConsent,
  unknownCommandScanConsentVersion,
  type UnknownCommandScanConsentChoice,
  type UnknownCommandScanConsentDependencies,
} from '../../scanConsent';

interface ConsentFixture {
  dependencies: UnknownCommandScanConsentDependencies;
  prompts: number;
  recordedVersions: Array<number | undefined>;
  updates: boolean[];
}

function fixture(options: {
  choice?: UnknownCommandScanConsentChoice;
  configuredValue?: boolean;
  promptedVersion?: number;
} = {}): ConsentFixture {
  const recordedVersions: Array<number | undefined> = [];
  const updates: boolean[] = [];
  const result: ConsentFixture = {
    prompts: 0,
    recordedVersions,
    updates,
    dependencies: {
      configuredValue: () => options.configuredValue,
      promptedVersion: () => options.promptedVersion,
      recordPromptedVersion: async version => {
        recordedVersions.push(version);
      },
      prompt: async () => {
        result.prompts += 1;
        return options.choice;
      },
      updateConfiguredValue: async enabled => {
        updates.push(enabled);
      },
    },
  };
  return result;
}

suite('Unknown command scan consent', () => {
  test('preserves an explicit setting without prompting', async () => {
    for (const configuredValue of [false, true]) {
      const consent = fixture({ configuredValue });
      assert.strictEqual(
        await requestUnknownCommandScanConsent(consent.dependencies),
        'configured',
      );
      assert.strictEqual(consent.prompts, 0);
      assert.deepStrictEqual(consent.updates, []);
      assert.deepStrictEqual(consent.recordedVersions, [unknownCommandScanConsentVersion]);
    }
  });

  test('does not repeat the current consent prompt', async () => {
    const consent = fixture({ promptedVersion: unknownCommandScanConsentVersion });
    assert.strictEqual(
      await requestUnknownCommandScanConsent(consent.dependencies),
      'already-prompted',
    );
    assert.strictEqual(consent.prompts, 0);
    assert.deepStrictEqual(consent.recordedVersions, []);
    assert.deepStrictEqual(consent.updates, []);
  });

  test('enables scans only after explicit consent', async () => {
    const consent = fixture({ choice: 'enable' });
    assert.strictEqual(
      await requestUnknownCommandScanConsent(consent.dependencies),
      'enabled',
    );
    assert.strictEqual(consent.prompts, 1);
    assert.deepStrictEqual(consent.recordedVersions, [unknownCommandScanConsentVersion]);
    assert.deepStrictEqual(consent.updates, [true]);
  });

  test('persists an explicit refusal', async () => {
    const consent = fixture({ choice: 'keep-disabled' });
    assert.strictEqual(
      await requestUnknownCommandScanConsent(consent.dependencies),
      'kept-disabled',
    );
    assert.strictEqual(consent.prompts, 1);
    assert.deepStrictEqual(consent.recordedVersions, [unknownCommandScanConsentVersion]);
    assert.deepStrictEqual(consent.updates, [false]);
  });

  test('keeps the default without writing a setting when dismissed', async () => {
    const consent = fixture();
    assert.strictEqual(
      await requestUnknownCommandScanConsent(consent.dependencies),
      'dismissed',
    );
    assert.strictEqual(consent.prompts, 1);
    assert.deepStrictEqual(consent.recordedVersions, [unknownCommandScanConsentVersion]);
    assert.deepStrictEqual(consent.updates, []);
  });

  test('does not overwrite a setting changed while the prompt is open', async () => {
    for (const scenario of [
      { choice: 'enable' as const, configuredValue: false },
      { choice: 'keep-disabled' as const, configuredValue: true },
    ]) {
      let configuredValue: boolean | undefined;
      let resolvePrompt: (choice: UnknownCommandScanConsentChoice) => void = () => {
        assert.fail('prompt resolver was not initialized');
      };
      const prompt = new Promise<UnknownCommandScanConsentChoice>(resolve => {
        resolvePrompt = resolve;
      });
      const recordedVersions: Array<number | undefined> = [];
      const updates: boolean[] = [];
      const request = requestUnknownCommandScanConsent({
        configuredValue: () => configuredValue,
        promptedVersion: () => undefined,
        recordPromptedVersion: async version => {
          recordedVersions.push(version);
        },
        prompt: () => prompt,
        updateConfiguredValue: async enabled => {
          updates.push(enabled);
        },
      });

      await new Promise<void>(resolve => setImmediate(resolve));
      configuredValue = scenario.configuredValue;
      resolvePrompt(scenario.choice);

      assert.strictEqual(await request, 'configured-during-prompt');
      assert.deepStrictEqual(recordedVersions, [unknownCommandScanConsentVersion]);
      assert.deepStrictEqual(updates, []);
    }
  });

  test('allows a later activation to retry when the prompt fails', async () => {
    const failure = new Error('prompt failed');
    const consent = fixture();
    consent.dependencies.prompt = async () => {
      throw failure;
    };

    await assert.rejects(
      requestUnknownCommandScanConsent(consent.dependencies),
      error => error === failure,
    );
    assert.deepStrictEqual(consent.recordedVersions, [
      unknownCommandScanConsentVersion,
      undefined,
    ]);
    assert.deepStrictEqual(consent.updates, []);
  });

  test('allows a later activation to retry when the setting update fails', async () => {
    const failure = new Error('setting update failed');
    const consent = fixture({ choice: 'enable' });
    consent.dependencies.updateConfiguredValue = async () => {
      throw failure;
    };

    await assert.rejects(
      requestUnknownCommandScanConsent(consent.dependencies),
      error => error === failure,
    );
    assert.deepStrictEqual(consent.recordedVersions, [
      unknownCommandScanConsentVersion,
      undefined,
    ]);
  });
});
