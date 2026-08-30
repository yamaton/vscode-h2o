import assert from 'node:assert/strict';

const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export function marketplacePublishArguments(packagePaths) {
  assert.ok(packagePaths.length > 0, 'at least one VSIX package is required');
  return [
    '--no-install',
    'vsce',
    'publish',
    '--skip-duplicate',
    '--packagePath',
    ...packagePaths,
  ];
}

export function missingMarketplaceTargets(showResult, version, expectedTargets) {
  assert.match(version, versionPattern, 'Marketplace version must be an unprefixed semantic version');
  assert.ok(Array.isArray(expectedTargets) && expectedTargets.length > 0, 'at least one Marketplace target is required');
  assert.strictEqual(
    new Set(expectedTargets).size,
    expectedTargets.length,
    'Marketplace targets must be unique',
  );
  assert.ok(Array.isArray(showResult?.versions), 'Marketplace response must contain versions');

  const publishedTargets = new Set(
    showResult.versions
      .filter(entry => entry?.version === version && typeof entry.targetPlatform === 'string')
      .map(entry => entry.targetPlatform),
  );
  return expectedTargets.filter(target => !publishedTargets.has(target));
}

export async function waitForMarketplaceTargets({
  inspect,
  version,
  expectedTargets,
  timeoutMs,
  intervalMs,
  now = Date.now,
  delay,
  onAttempt = () => {},
}) {
  assert.strictEqual(typeof inspect, 'function', 'Marketplace inspector is required');
  assert.strictEqual(typeof delay, 'function', 'Marketplace polling delay is required');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Marketplace timeout must be positive');
  assert.ok(Number.isSafeInteger(intervalMs) && intervalMs > 0, 'Marketplace interval must be positive');

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let missingTargets = [...expectedTargets];
  let lastError;

  while (now() < deadline) {
    attempts += 1;
    try {
      const showResult = await inspect();
      missingTargets = missingMarketplaceTargets(showResult, version, expectedTargets);
      lastError = undefined;
      onAttempt({ attempts, elapsedMs: now() - startedAt, missingTargets, error: undefined });
      if (missingTargets.length === 0) {
        return { attempts, elapsedMs: now() - startedAt };
      }
    } catch (error) {
      lastError = error;
      onAttempt({ attempts, elapsedMs: now() - startedAt, missingTargets, error });
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      break;
    }
    await delay(Math.min(intervalMs, remainingMs));
  }

  const lastErrorSuffix = lastError instanceof Error ? ` Last query failed: ${lastError.message}` : '';
  throw new Error(
    `Marketplace did not expose ${version} for ${missingTargets.join(', ')} within ${timeoutMs} ms.${lastErrorSuffix}`,
  );
}
