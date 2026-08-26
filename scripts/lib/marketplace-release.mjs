import assert from 'node:assert/strict';

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
