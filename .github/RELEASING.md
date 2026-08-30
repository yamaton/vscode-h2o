# Releasing the extension

Marketplace publication is triggered when an increased extension version reaches `main`. Ordinary pushes and
dependency-only lockfile updates run the quality gate but never publish.

## One-time setup

1. Create a Visual Studio Marketplace token that can manage the `tetradresearch` publisher.
2. Create a GitHub Environment named `marketplace`, require a release maintainer's approval, and store the token there as `VSCE_PAT`.
3. Protect `main` and require the quality workflow checks before merging a version bump.
4. Add a tag ruleset for `*.*.*` that prevents updating or deleting an existing version tag.

The current workflow uses a Marketplace PAT. Azure DevOps global PATs retire on December 1, 2026, so migrate the
publish job to Microsoft Entra ID authentication before that date.

## Release procedure

1. Update `version` in both `package.json` and `package-lock.json` without creating a local tag. For example:

   ```sh
   npm version 0.3.0 --no-git-tag-version
   ```

2. Update `CHANGELOG.md` and submit the release changes through a pull request.
3. Merge the version bump after the quality gate passes.

The publish workflow verifies that the manifest and lockfile versions agree and increased from the previous `main`
commit. It then re-runs the complete quality workflow, downloads its seven verified platform-specific VSIX artifacts,
verifies them again, and waits for approval on the `marketplace` environment. After approval it verifies Marketplace
publishing rights, creates the immutable unprefixed version tag at the merged commit, publishes all targets together,
and confirms the new Marketplace version.

If publication partially succeeds because of a transient failure, re-run only the failed `publish` job. Publishing
skips packages already present at that version and continues with the missing targets, so this recovery uses the
original immutable tag and artifacts. Never move, delete, or recreate a version tag. If the artifacts have expired or
their contents need to change, release a new version instead.

Do not publish the same extension version manually or from another workflow; duplicate recovery assumes that every existing target came from the original run's verified artifacts.
