import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyReleaseMetadata } from './lib/release-tag.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const [tag, commitSha] = process.argv.slice(2);
const readJson = (file) => JSON.parse(readFileSync(path.join(projectRoot, file), 'utf8'));
const manifest = readJson('package.json');
const lockfile = readJson('package-lock.json');

verifyReleaseMetadata(tag, commitSha, manifest, lockfile);
console.log(`Verified release tag ${tag} at ${commitSha}.`);
