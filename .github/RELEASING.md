# Releasing the extension

Marketplace publication is triggered only by a version tag. A push to `main` runs the quality gate but never publishes.

## One-time setup

1. Create a Visual Studio Marketplace token that can manage the `tetradresearch` publisher.
2. Create a GitHub Environment named `marketplace`, require a release maintainer's approval, and store the token there as `VSCE_PAT`.
3. Protect `main` and require the quality workflow checks before merging a version bump.
4. Add a tag ruleset for `*.*.*`. Limit creation to release maintainers and prevent version tags from being updated or deleted after creation.

## Release procedure

1. Update `version` in both `package.json` and `package-lock.json` through a pull request.
2. Merge the version bump after the quality gate passes.
3. Tag that commit with the exact version, without a `v` prefix, and push the tag. For example:

   ```sh
   git tag 0.2.16
   git push origin 0.2.16
   ```

The publish workflow rejects a tag that differs from either manifest version or does not point to a commit on `main`. It then re-runs the complete quality workflow, downloads its five verified platform-specific VSIX artifacts, verifies them again, waits for approval on the `marketplace` environment, and publishes them together.

If publication partially succeeds because of a transient failure, re-run only the failed `publish` job. Publishing skips packages already present at that version and continues with the missing targets, so this recovery must use the original immutable tag and artifacts. Never move, delete, or recreate a version tag. If the artifacts have expired or their contents need to change, release a new version instead.

Do not publish the same extension version manually or from another workflow; duplicate recovery assumes that every existing target came from the original run's verified artifacts.
