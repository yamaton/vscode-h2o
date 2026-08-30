export const unknownCommandScanConsentStateKey = 'unknownCommandScanConsentPromptVersion';
export const unknownCommandScanConsentVersion = 1;

export type UnknownCommandScanConsentChoice = 'enable' | 'keep-disabled' | undefined;

export type UnknownCommandScanConsentResult =
  | 'already-prompted'
  | 'configured'
  | 'configured-during-prompt'
  | 'dismissed'
  | 'enabled'
  | 'kept-disabled';

export interface UnknownCommandScanConsentDependencies {
  configuredValue(): boolean | undefined;
  promptedVersion(): number | undefined;
  recordPromptedVersion(version: number | undefined): PromiseLike<void>;
  prompt(): PromiseLike<UnknownCommandScanConsentChoice>;
  updateConfiguredValue(enabled: boolean): PromiseLike<void>;
}

export async function requestUnknownCommandScanConsent(
  dependencies: UnknownCommandScanConsentDependencies,
): Promise<UnknownCommandScanConsentResult> {
  if (dependencies.configuredValue() !== undefined) {
    await dependencies.recordPromptedVersion(unknownCommandScanConsentVersion);
    return 'configured';
  }

  if ((dependencies.promptedVersion() ?? 0) >= unknownCommandScanConsentVersion) {
    return 'already-prompted';
  }

  // Record before opening the notification so later activations do not offer
  // the same machine-level choice again. A dismissal intentionally leaves the
  // safe default in place.
  await dependencies.recordPromptedVersion(unknownCommandScanConsentVersion);
  try {
    const choice = await dependencies.prompt();
    if (choice === undefined) {
      return 'dismissed';
    }

    // A setting changed while the notification was open is newer than the
    // notification choice and must not be overwritten by that stale choice.
    if (dependencies.configuredValue() !== undefined) {
      return 'configured-during-prompt';
    }

    if (choice === 'enable') {
      await dependencies.updateConfiguredValue(true);
      return 'enabled';
    }
    await dependencies.updateConfiguredValue(false);
    return 'kept-disabled';
  } catch (error) {
    // A failed notification or configuration write did not complete setup.
    // Remove the marker so a later activation can offer the choice again.
    await dependencies.recordPromptedVersion(undefined);
    throw error;
  }
}
