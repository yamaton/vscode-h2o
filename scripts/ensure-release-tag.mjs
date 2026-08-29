import assert from 'node:assert/strict';
import { releaseTagAction } from './lib/release-tag.mjs';

const [tag, commitSha] = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';

assert.match(repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'GITHUB_REPOSITORY is invalid');
assert.ok(token, 'GH_TOKEN is required to create a release tag');

async function request(method, path, body) {
  const response = await fetch(`${apiUrl}/repos/${repository}/${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

async function readReference() {
  const response = await request('GET', `git/ref/tags/${encodeURIComponent(tag)}`);
  if (response.status === 404) {
    return null;
  }
  assert.strictEqual(response.status, 200, `GitHub tag lookup failed with HTTP ${response.status}`);
  return response.body;
}

function responseDescription(response) {
  const message = typeof response.body?.message === 'string' ? `: ${response.body.message}` : '';
  return `HTTP ${response.status}${message}`;
}

let reference = await readReference();
if (releaseTagAction(tag, commitSha, reference) === 'exists') {
  console.log(`Release tag ${tag} already points to ${commitSha}.`);
  process.exit(0);
}

const created = await request('POST', 'git/refs', {
  ref: `refs/tags/${tag}`,
  sha: commitSha,
});
if (created.status === 422) {
  reference = await readReference();
  assert.ok(
    reference,
    `GitHub rejected release tag creation with ${responseDescription(created)}, and refs/tags/${tag} does not exist`,
  );
  assert.strictEqual(releaseTagAction(tag, commitSha, reference), 'exists');
  console.log(`Release tag ${tag} was created concurrently at ${commitSha}.`);
} else {
  assert.strictEqual(created.status, 201, `GitHub tag creation failed with ${responseDescription(created)}`);
  releaseTagAction(tag, commitSha, created.body);
  console.log(`Created release tag ${tag} at ${commitSha}.`);
}
