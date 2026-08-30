import assert from 'node:assert/strict';

const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const vsixSha256Property = 'Microsoft.VisualStudio.Services.VsixSha256';

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

function validateExpectedPackages(expectedPackages) {
  assert.ok(
    Array.isArray(expectedPackages) && expectedPackages.length > 0,
    'at least one Marketplace package is required',
  );
  for (const expectedPackage of expectedPackages) {
    assert.ok(
      typeof expectedPackage?.target === 'string' && expectedPackage.target.length > 0,
      'Marketplace package target must be a non-empty string',
    );
    assert.match(
      expectedPackage.sha256,
      sha256Pattern,
      `Marketplace package SHA-256 for ${expectedPackage.target} must be lowercase hexadecimal`,
    );
  }
  assert.strictEqual(
    new Set(expectedPackages.map(expectedPackage => expectedPackage.target)).size,
    expectedPackages.length,
    'Marketplace package targets must be unique',
  );
}

export function marketplaceTargetMismatches(showResult, version, expectedPackages) {
  assert.match(version, versionPattern, 'Marketplace version must be an unprefixed semantic version');
  validateExpectedPackages(expectedPackages);
  assert.ok(Array.isArray(showResult?.versions), 'Marketplace response must contain versions');

  return expectedPackages.flatMap(expectedPackage => {
    const publishedPackages = showResult.versions.filter(
      entry => entry?.version === version && entry.targetPlatform === expectedPackage.target,
    );
    if (publishedPackages.length === 0) {
      return [{ ...expectedPackage, actualSha256: null, reason: 'missing' }];
    }

    const publishedHashes = publishedPackages.flatMap(entry => {
      if (!Array.isArray(entry.properties)) {
        return [];
      }
      return entry.properties
        .filter(property => property?.key === vsixSha256Property && typeof property.value === 'string')
        .map(property => property.value);
    });
    if (publishedHashes.includes(expectedPackage.sha256)) {
      return [];
    }
    return [{
      ...expectedPackage,
      actualSha256: publishedHashes[0] ?? null,
      reason: 'sha256',
    }];
  });
}

function describeMismatches(mismatches) {
  return mismatches.map(mismatch => {
    if (mismatch.reason === 'missing') {
      return `${mismatch.target} (missing)`;
    }
    return `${mismatch.target} (SHA-256 ${mismatch.actualSha256 ?? 'unavailable'}, expected ${mismatch.sha256})`;
  }).join(', ');
}

export async function waitForMarketplaceTargets({
  inspect,
  version,
  expectedPackages,
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
  marketplaceTargetMismatches({ versions: [] }, version, expectedPackages);

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let mismatches = expectedPackages.map(expectedPackage => ({
    ...expectedPackage,
    actualSha256: null,
    reason: 'missing',
  }));
  let lastError;

  while (now() < deadline) {
    const queryTimeoutMs = deadline - now();
    if (queryTimeoutMs <= 0) {
      break;
    }
    attempts += 1;
    try {
      const showResult = await inspect({ timeoutMs: queryTimeoutMs });
      mismatches = marketplaceTargetMismatches(showResult, version, expectedPackages);
      lastError = undefined;
      onAttempt({ attempts, elapsedMs: now() - startedAt, mismatches, error: undefined });
      if (mismatches.length === 0) {
        return { attempts, elapsedMs: now() - startedAt };
      }
    } catch (error) {
      lastError = error;
      onAttempt({ attempts, elapsedMs: now() - startedAt, mismatches, error });
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      break;
    }
    await delay(Math.min(intervalMs, remainingMs));
  }

  const lastErrorSuffix = lastError instanceof Error ? ` Last query failed: ${lastError.message}` : '';
  throw new Error(
    `Marketplace did not expose ${version} with verified VSIX hashes for ${describeMismatches(mismatches)} within ${timeoutMs} ms.${lastErrorSuffix}`,
  );
}
