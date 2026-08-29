import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { planRelease, releaseTagAction, verifyReleaseMetadata } from './lib/release-tag.mjs';

const manifest = { name: 'vscode-h2o', version: '0.2.16' };
const lockfile = {
  name: 'vscode-h2o',
  version: '0.2.16',
  packages: { '': { name: 'vscode-h2o', version: '0.2.16' } },
};
const commitSha = '1'.repeat(40);

verifyReleaseMetadata('0.2.16', commitSha, manifest, lockfile);
assert.deepStrictEqual(planRelease({ name: 'vscode-h2o', version: '0.2.15' }, manifest, lockfile), {
  release: true,
  version: '0.2.16',
});
assert.deepStrictEqual(planRelease(manifest, manifest, lockfile), {
  release: false,
  version: '0.2.16',
});
assert.deepStrictEqual(
  planRelease(
    { name: 'vscode-h2o', version: '999999999999999999999.2.15' },
    { ...manifest, version: '999999999999999999999.2.16' },
    {
      ...lockfile,
      version: '999999999999999999999.2.16',
      packages: { '': { name: 'vscode-h2o', version: '999999999999999999999.2.16' } },
    },
  ),
  { release: true, version: '999999999999999999999.2.16' },
);
assert.throws(() => verifyReleaseMetadata('v0.2.16', commitSha, manifest, lockfile), /unprefixed semantic version/);
assert.throws(() => verifyReleaseMetadata('0.2.15', commitSha, manifest, lockfile), /differs from package.json/);
assert.throws(
  () => verifyReleaseMetadata('0.2.16', commitSha, manifest, { ...lockfile, version: '0.2.15' }),
  /top-level version is stale/,
);
assert.throws(
  () => verifyReleaseMetadata('0.2.16', commitSha, manifest, {
    ...lockfile,
    packages: { '': { name: 'another-extension', version: '0.2.16' } },
  }),
  /root package name is stale/,
);
assert.throws(
  () => verifyReleaseMetadata('0.2.16', commitSha, manifest, {
    ...lockfile,
    packages: { '': { name: 'vscode-h2o', version: '0.2.15' } },
  }),
  /root version is stale/,
);
assert.throws(
  () => planRelease({ name: 'vscode-h2o', version: '0.2.17' }, manifest, lockfile),
  /must increase from 0\.2\.17 to 0\.2\.16/,
);
assert.throws(
  () => planRelease({ name: 'another-extension', version: '0.2.15' }, manifest, lockfile),
  /package name changed/,
);
assert.throws(
  () => planRelease({ name: 'vscode-h2o', version: 'v0.2.15' }, manifest, lockfile),
  /previous package\.json version must be an unprefixed semantic version/,
);
assert.strictEqual(releaseTagAction('0.2.16', commitSha, null), 'create');
assert.strictEqual(
  releaseTagAction('0.2.16', commitSha, {
    ref: 'refs/tags/0.2.16',
    object: { type: 'commit', sha: commitSha },
  }),
  'exists',
);
assert.throws(
  () => releaseTagAction('0.2.16', commitSha, {
    ref: 'refs/tags/0.2.16',
    object: { type: 'commit', sha: '2'.repeat(40) },
  }),
  /already points to another commit/,
);
assert.throws(
  () => releaseTagAction('0.2.16', commitSha, {
    ref: 'refs/tags/0.2.16',
    object: { type: 'tag', sha: commitSha },
  }),
  /must point directly to a commit/,
);

const ensureReleaseTagScript = fileURLToPath(new URL('ensure-release-tag.mjs', import.meta.url));
const tagReference = {
  ref: 'refs/tags/0.2.16',
  object: { type: 'commit', sha: commitSha },
};

async function runEnsureReleaseTag(responses) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();

    const next = responses.shift();
    assert.ok(next, `unexpected request: ${request.method} ${request.url}`);
    response.writeHead(next.status, {
      Connection: 'close',
      'Content-Type': 'application/json',
    });
    response.end(JSON.stringify(next.body));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const child = spawn(process.execPath, [ensureReleaseTagScript, '0.2.16', commitSha], {
      env: {
        ...process.env,
        GH_TOKEN: 'test-token',
        GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        GITHUB_REPOSITORY: 'test/repository',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    const [exitCode] = await once(child, 'close');
    return { exitCode, requests, stderr, stdout };
  } finally {
    server.close();
    await once(server, 'close');
  }
}

const rejectedTag = await runEnsureReleaseTag([
  { status: 404, body: { message: 'Not Found' } },
  { status: 422, body: { message: 'Ruleset rejected the tag' } },
  { status: 404, body: { message: 'Not Found' } },
]);
assert.notStrictEqual(rejectedTag.exitCode, 0);
assert.deepStrictEqual(rejectedTag.requests.map(request => request.split(' ')[0]), ['GET', 'POST', 'GET']);
assert.match(rejectedTag.stderr, /Ruleset rejected the tag/);
assert.doesNotMatch(rejectedTag.stdout, /created concurrently/);

const concurrentTag = await runEnsureReleaseTag([
  { status: 404, body: { message: 'Not Found' } },
  { status: 422, body: { message: 'Reference already exists' } },
  { status: 200, body: tagReference },
]);
assert.strictEqual(concurrentTag.exitCode, 0, concurrentTag.stderr);
assert.match(concurrentTag.stdout, /created concurrently/);

console.log('Release tag checks passed.');
