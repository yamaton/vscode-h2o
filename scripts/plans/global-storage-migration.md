# Global Storage Migration Plan

## Status

Revised implementation plan for `codex/global-storage-cache`.

This revision incorporates the results of an isolated implementation prototype,
failure injection, real-data measurement, independent review, and VS Code
1.101.0 Extension Host tests. The branch implementation uses the yielding
level-1 gzip codec selected below.

As of 2026-08-28, the branch passes `npm run check:unit` (79 unit tests and
coverage gates), source-tree integration on VS Code 1.101.0 and 1.135.0 (17
extension tests plus the multi-process storage checks on each), VSIX content
verification, and packaged-VSIX activation on both versions.

## Objective

Move the command cache out of VS Code `Memento` and into
`ExtensionContext.globalStorageUri` so that large command data no longer uses
the extension-state database or its IPC path.

The command cache is global rather than workspace-specific, so
`globalStorageUri` is the intended location; `storageUri` is not used.

## Prototype evidence

The following observations were collected before finalizing this plan:

- In VS Code 1.101.0, `globalStorageUri` used the `vscode-userdata` scheme. A
  missing file reported `code: FileNotFound`, while a permission-denied read
  reported `code: NoPermissions`.
- After a permission-denied canonical read, writing and renaming a replacement
  was still possible once the relevant permissions allowed it. Therefore,
  treating every load error as an empty cache and continuing to persist can
  overwrite a valid but temporarily unreadable snapshot.
- A prototype that disabled persistence for the remainder of that session after
  a non-`FileNotFound` read failure kept newly fetched commands in memory while
  preserving the prior canonical snapshot.
- Failure injection against actual `workspace.fs` storage confirmed that a
  handled rename failure can delete its temporary file, and that a simultaneous
  cleanup failure must not replace the original write or rename error.
- Remote and local name-mismatch injections were rejected and produced zero
  stored commands. Actual bundled H2O output for `git` and `tar` passed the same
  schema and requested-name checks.
- For 1,017 real commands (20,283,354 bytes of JSON), `structuredClone` took
  119-155 ms and blocked the Extension Host event loop for 115-151 ms per
  snapshot capture. Recursively freezing validated command graphs once at
  ingress took 11.5-21.6 ms with 7-25 ms observed event-loop delay. The frozen
  graph rejected later mutation and preserved both queued snapshots in the
  injected race.
- Inspection of the current general-plus-bio payload found data beyond the
  original TypeScript model: 927 command `version` strings, 88
  `positionalArguments` arrays containing 158 entries, and one `__meta__`
  object. A counterfactual queued-save test against the real `adb`
  `positionalArguments` field reproduced snapshot mutation before generic
  recursive freezing. The implementation therefore preserves unknown
  JSON-compatible properties, validates the known schema, rejects cyclic or
  non-JSON-compatible values, and freezes the complete retained graph.
- The same 1,017-command data exposed costs outside snapshot capture. An
  independent VS Code 1.101.0 run measured a 620 ms initial save with 193 ms
  maximum event-loop delay, a 462 ms identical save with 180 ms delay, and a
  294 ms load with 113 ms delay. The gzip file was 2,890,811 bytes.
- Stage-level counterfactual runs identified synchronous `JSON.stringify` as a
  major save-side pause: 131-138 ms elapsed with 128-134 ms event-loop delay.
  A yielding streaming JSON-plus-gzip prototype reduced encoding delay to
  12-20 ms while increasing encoding wall time to 404-606 ms. Default
  compression retained the 2,890,811-byte output; level-1 compression produced
  3,665,855 bytes. Raw 20 MiB writes were slower and caused 102-186 ms delay,
  so merely removing gzip is not a responsive alternative.
- The selected implementation serializes one top-level command at a time into
  a level-1 gzip stream and yields after every eight commands. It also yields
  between inflate, UTF-8 conversion, parse, and batches of validation/freezing.
  Five final VS Code 1.101.0 runs gave these medians; parentheses contain the
  observed range. `lag` is maximum Extension Host event-loop delay in the
  measured operation.

  | Data | Operation | Batch level 6 | Yielding level 1 |
  | --- | --- | ---: | ---: |
  | general | first save | 411 ms / 89 ms lag | 338 ms (334-358) / 29 ms (27-32) lag |
  | general | load | 176 ms / 71 ms lag | 249 ms (233-258) / 63 ms (51-72) lag |
  | general | identical save | 273 ms / 90 ms lag | 211 ms (203-222) / 6 ms (5-21) lag |
  | general | real mutation save | 275 ms / 88 ms lag | 184 ms (178-197) / 5 ms (4-6) lag |
  | general + bio | first save | 609 ms / 185 ms lag | 523 ms (516-552) / 39 ms (37-46) lag |
  | general + bio | load | 291 ms / 123 ms lag | 381 ms (371-425) / 94 ms (88-101) lag |
  | general + bio | identical save | 483 ms / 193 ms lag | 362 ms (334-398) / 13 ms (10-14) lag |
  | general + bio | real mutation save | 490 ms / 177 ms lag | 335 ms (327-360) / 13 ms (11-14) lag |

  The general snapshot was 11,811,096 JSON bytes and 2,225,460 compressed
  bytes. The general-plus-bio snapshot was 20,283,379 JSON bytes and 3,665,887
  compressed bytes. Compared with batch level 6, the larger snapshot grows
  from about 2.89 MiB to 3.67 MiB, while remaining about 82% smaller than its
  JSON representation. The yielding codec reduces measured event-loop delay
  on every operation; its load wall time is higher because validation and
  freezing are interleaved with yields. These same-machine comparisons, not a
  machine-independent fixed millisecond threshold, are the selection basis.
- Deleting 129 legacy Memento keys containing approximately 6 MiB took 57 ms in
  the tested host. The logical values were deleted, but the SQLite file did not
  physically shrink during that experiment.
- The isolated prototype passed 71 unit tests and the repository's
  `npm run check:unit` gate, plus 17 integration tests on VS Code 1.101.0.
  The branch implementation expands the unit suite to cover unknown-field
  preservation and the real positional-argument race. Packaged-VSIX activation
  at both stable and 1.101.0 remains a release gate.

## Scope and accepted constraints

### In scope

- Persist one versioned, gzip-compressed command snapshot through
  `vscode.workspace.fs`.
- Restore the snapshot on Extension Host restart.
- Delete legacy Memento keys without reading their payloads.
- Avoid rewriting an unchanged snapshot during the automatic, non-forcing
  general-bundle fetch.
- Keep a previously written canonical snapshot isolated from an ordinary
  partial write by writing to a unique temporary URI before rename.
- Clean up the current operation's temporary file after a handled write or
  rename failure.
- Validate every external command-data ingress before it can enter the
  in-memory cache.
- Prevent a non-`FileNotFound` canonical read failure from causing a later
  session write to replace a snapshot that may still be valid.
- Make validated command graphs immutable once when they enter the cache, so a
  queued snapshot cannot change before serialization.
- Characterize full activation-load and mutation-save latency with real-data
  scale, compare batch and yielding behavior on the same host, and record the
  latency/storage-size tradeoff and codec decision before merge.

### Accepted constraints

- Separate Extension Hosts that write different in-memory snapshots at the
  same time use last-writer-wins semantics. This is acceptable because the
  data is a regenerable cache and non-general mutations are rare.
- `workspace.fs.rename` is not documented as atomic for every file-system
  provider. Temporary-write-then-rename is therefore a best-effort replacement
  protocol, not a product-level atomicity guarantee.
- A failed save is not retried by a later no-op operation. A later real cache
  mutation writes a full snapshot and repairs the persisted state; a restart
  can regenerate missing cache data.
- A hard process termination can leave a uniquely named temporary file behind.
  Such files are ignored by snapshot loading and are expected to be rare.
- After a non-`FileNotFound` canonical read failure, persistence is disabled for
  the rest of that Extension Host session. Commands may still be fetched and
  used in memory; a restart retries loading and restores normal persistence if
  the read succeeds.
- Legacy Memento deletion is best effort. A failed deletion is logged and
  retried on the next activation. An older extension process can recreate a
  legacy key after cleanup; this extension cannot prevent that external write.

### Out of scope

- Per-command files, storage locks, cross-process compare-and-swap, a pending
  mutation ledger, or a transactional database.
- Atomicity across an entire multi-window operation.
- Migration of cached command payloads from Memento.
- A startup scan for abandoned temporary files.
- Revalidating the entire snapshot again immediately before every encode after
  all ingress paths and cache invariants have already been validated.
- Retrying a failed canonical read or re-enabling persistence during the same
  Extension Host session.
- Changes to the download schedule, sandboxing, or other non-storage concerns.

## Storage format

The extension stores the following children below `globalStorageUri`:

```text
commands-v1.json.gz
commands-v1.<pid>.<uuid>.json.gz.tmp
```

The canonical file contains:

```ts
interface CommandCacheSnapshot {
  version: 1;
  commands: Command[];
}
```

The schema version is present in both the payload and canonical filename. A
future incompatible schema must use both a new payload version and a new
filename such as `commands-v2.json.gz`.

## Required behavior

### Activation and loading

1. Try to read `commands-v1.json.gz` through `workspace.fs`.
2. Treat `FileNotFound` as an empty cache with persistence enabled.
3. If the read fails for any other reason, warn, continue with an empty
   in-memory cache, and disable persistence for the rest of the session. The
   automatic general fetch may still populate memory but must not write a
   replacement snapshot in that session.
4. After a successful read, gunzip, parse, and validate the version, command
   schema, and unique top-level command names before constructing the in-memory
   `Map`.
5. If decoding or validation reports a corrupt or unsupported snapshot, warn
   and continue with an empty cache while leaving persistence enabled. The
   automatic general fetch may then regenerate it.
6. Keep read/transport failures distinguishable from decode/validation failures
   with an explicit storage error type rather than message matching.
7. Do not enumerate or load `*.tmp` files.
8. Delete legacy Memento keys after the snapshot load attempt. Obtain the keys
   with `Memento.keys()` and call `update(key, undefined)` without calling
   `get()` on the large values.

Legacy keys are:

- `h2oFetcher.cache.*`
- `h2oFetcher.registered.all`

Legacy deletion failures are logged without rejecting activation and are
retried naturally on the next activation because the keys remain present. One
cleanup-time large-state warning is acceptable. General data is downloaded
again automatically; users may explicitly reload bioinformatics or
experimental data if needed.

### External-data invariants

All data must satisfy the `Command` schema before insertion into the cache.

- Curated gzip bundles continue to use `decodeCommandBundle` and
  `validateCommands`.
- Experimental single-command downloads continue to validate the parsed
  command.
- Local H2O JSON output must also pass `validateCommands([value])` rather than
  relying on a TypeScript cast.
- Experimental and local results must be rejected when the requested name does
  not equal `command.name`; the mismatched result is neither returned as the
  requested command nor inserted into memory or persistent storage.
- `updateCache(key, command)` independently enforces `key === command.name` so
  future callers cannot bypass the ingress checks.
- After schema and name validation, reject cyclic and non-JSON-compatible
  values, preserve unknown JSON-compatible properties, and recursively freeze
  the complete command graph before inserting it into the `Map`. Restored
  snapshots pass through the same validation and freezing path.

With validated and frozen ingress plus the key/name invariant, the `Map`
guarantees unique persisted command names and immutable command graphs. A
second full validation or deep-clone pass before every encode is not required
for this change.

### Saving

1. Capture a new array of the current `Map` values when persistence is
   requested. Its command graphs are already recursively frozen at ingress;
   do not `structuredClone` the full cache for each save.
2. Serialize saves within one `CachingFetcher` using its instance-local
   `saveChain`.
3. Serialize top-level commands incrementally into a level-1 gzip stream,
   yielding after every eight commands.
4. Ensure `globalStorageUri` exists.
5. Generate a new temporary URI using the process ID and `randomUUID()`.
6. Write the complete compressed content to the temporary URI.
7. Rename it over `commands-v1.json.gz` with `{ overwrite: true }`.
8. If the temporary write or rename rejects, attempt to delete that operation's
   temporary URI. Ignore `FileNotFound`; log any other cleanup failure without
   replacing the original error, then rethrow the original error.

No claim is made that all providers preserve the old canonical file after
every possible rename failure. Missing or corrupt canonical data remains
recoverable because it is a cache.

### No-op persistence suppression

The following rules reduce routine writes without changing session behavior:

- A non-forcing general-bundle fetch persists only when it inserts at least one
  command into the in-memory `Map`.
- `markAvailable()` must run after the general bundle has been merged even when
  persistence is skipped, so command fetches waiting for the initial curated
  result are released.
- `unset(name)` skips persistence when the name is not present in the `Map`, but
  still adds the name to `removedNames`.
- `unsetAll(names)` skips persistence when it removes no entries, but still adds
  every requested name to `removedNames`.
- These `removedNames` updates must continue to prevent an in-flight initial
  general fetch from restoring a command removed during the current session.
- Explicit forcing retains the current simple behavior and requests one
  snapshot save, even if the fetched bundle happens to be identical or empty.

## Implementation tasks

### `src/cacheStorage.ts`

- Keep the versioned snapshot codec and validation helpers.
- Preserve unknown JSON-compatible fields while validating known command
  fields, and recursively freeze all retained enumerable JSON data.
- Strictly reject sparse arrays, accessors, symbols, and non-enumerable own
  properties when validating arbitrary JavaScript objects. Data produced
  immediately by `JSON.parse` uses a separate equivalent-schema freeze path,
  because parsing itself guarantees dense arrays and enumerable data
  properties and descriptor inspection measurably increases load latency.
- Use yielding top-level-command serialization with level-1 gzip. Yield during
  restored-data validation/freezing as well as around parse boundaries.
- Add `delete(uri)` to the injected file-system surface required by
  save-failure cleanup.
- Wrap decode and validation failures in a dedicated invalid-snapshot error so
  callers can distinguish regenerable content failure from read/transport
  failure.
- Wrap temporary write and rename in error handling that performs best-effort
  cleanup and rethrows the original error.
- Keep `FileNotFound` handling provider-neutral (`FileSystemError` name/code and
  Node-style `ENOENT` in tests).
- Do not add `readDirectory`, `stat`, a clock, or stale-file sweeping in this
  change.

### `src/cacheFetcher.ts`

- Preserve the in-memory `Map` and `saveChain`.
- Track whether persistence is enabled for the current session. Disable it
  after a non-`FileNotFound` read/transport failure, but not after a typed
  invalid-snapshot failure.
- Validate and recursively freeze restored, curated, experimental, and local
  command graphs before insertion.
- Reject local and experimental name mismatches and enforce the
  cache-key/`command.name` invariant again in `updateCache`.
- Capture snapshots as fresh arrays of already-frozen command references.
- Track whether a non-forcing bundle merge actually inserted a command and
  skip `persist()` when it did not.
- Preserve `markAvailable()` ordering independently of whether persistence is
  needed.
- Skip persistence for no-op `unset` and `unsetAll` while always updating
  `removedNames`.
- Preserve unconditional persistence for explicit force operations.

### `src/extension.ts`

- Construct storage from `context.globalStorageUri` and `vscode.workspace.fs`.
- Use `Uri.joinPath` for the canonical and unique temporary URIs.
- Keep initial general fetching asynchronous after snapshot initialization.

### Integration harness and CI

- Add a phase-based Extension Host driver, either by extending
  `src/test/runTest.ts` or as a dedicated storage integration driver. It must
  preserve one user-data and extensions profile across separate VS Code
  processes.
- Support phase setup and inspection outside the Extension Host so tests can
  seed canonical bytes and Memento state, change permissions, inspect file
  bytes and modification times, and verify temporary-file disposition between
  processes.
- Cover at least seed, first activation, process exit, restart, and final
  inspection phases. Do not treat repeated operations in one Extension Host as
  evidence of restart restoration.
- Change the Linux engine-floor CI entry from VS Code 1.101.2 to the declared
  minimum 1.101.0. Keep the stable-version entry.
- Activate the built VSIX at both stable and the declared 1.101.0 floor in CI,
  rather than relying only on source-tree integration at the floor.

### Documentation and packaging

- Document that command data is an on-disk, non-synced, regenerable cache.
- State that legacy cache contents are discarded rather than migrated.
- Add the storage change and its user-visible implications to the changelog.
- Do not describe the snapshot or replacement as universally atomic. Describe
  it as a versioned compressed snapshot replaced through a unique temporary
  file and best-effort overwrite rename.
- Keep `out/cacheStorage.js` in the VSIX contract and ensure source, tests, and
  this implementation plan are not packaged.

## Test plan

### Unit: snapshot codec and storage

- Round-trip a versioned gzip snapshot.
- Reject unsupported versions, invalid command shapes, and duplicate names.
- Preserve and recursively freeze known and unknown JSON-compatible fields;
  reject non-finite numbers, `BigInt`, cycles, sparse arrays, accessors, and
  non-JSON-compatible objects or own properties.
- Recognize missing files through VS Code `FileSystemError` code/name forms and
  Node-style `ENOENT`.
- Return no snapshot for `FileNotFound` but propagate other read failures.
- Wrap corrupt, unsupported, and schema-invalid content in the dedicated
  invalid-snapshot error without wrapping read failures.
- Verify the operation order: create directory, write unique temporary file,
  rename over canonical.
- On temporary-write failure, attempt temporary deletion and rethrow the write
  error.
- On rename failure, attempt temporary deletion and rethrow the rename error.
- When cleanup also fails, verify that the primary write/rename error remains
  the reported failure.
- Verify that overlapping calls use distinct temporary names. Do not assert
  which separate writer wins.

### Unit: `CachingFetcher`

- Load a valid persisted snapshot and regenerate after a typed corrupt-snapshot
  failure.
- After a non-`FileNotFound` read failure, allow in-memory use but perform zero
  saves and verify that a prior stored snapshot is unchanged.
- Delete legacy Memento keys without reading their values, tolerate individual
  deletion failures, and retry keys that remain on the next initialization.
- Serialize overlapping instance-local saves and continue after a rejected
  save.
- Validate local H2O JSON and refuse to return or persist malformed output.
- Reject local and experimental payloads whose names differ from the requested
  name, with zero in-memory or persistent insertion.
- Verify that validated command graphs are recursively frozen and that a
  mutation attempted after a queued persistence request cannot alter either
  queued snapshot.
- Exercise that race with at least three existing commands: delay the first
  save, remove one existing command, remove a second existing command while the
  first save is pending, attempt to mutate the retained command, and verify the
  two different queued memberships both retain the original command graph. Do
  not use a missing-command removal to create the second save because the final
  no-op rules suppress it.
- A cached non-forcing general fetch performs zero saves and still releases
  initial curated availability.
- A non-forcing general fetch with at least one missing command performs one
  save.
- An identical or empty explicit force performs one save.
- `unset` of a missing command performs zero saves but prevents an in-flight
  initial general fetch from restoring it.
- `unsetAll` with no existing targets performs zero saves and applies the same
  session removal semantics.
- A real mutation following a failed save writes a full current snapshot.

### VS Code integration

- Run on the minimum supported VS Code 1.101.0 and the current test version.
- Activate with actual `globalStorageUri`/`workspace.fs`, persist controlled
  commands, and read them back.
- Restart the Extension Host/profile and verify snapshot restoration.
- Inject a corrupt canonical file and verify activation continues and the
  automatic general path can regenerate a valid snapshot.
- Inject a non-`FileNotFound` canonical read failure, restore readability, and
  verify that later session mutations do not overwrite the prior snapshot.
- Inject rename failure with both successful and failed temporary cleanup;
  verify temporary-file disposition and preservation of the primary error.
- Inject local and experimental requested-name mismatches and verify zero
  stored commands.
- Exercise queued saves with a post-request mutation attempt and verify the
  persisted command remains unchanged.
- Verify that a second activation with a fully cached general bundle performs
  no snapshot write.
- Seed legacy Memento data, delete it without reading payloads, restart, and
  verify that the large-state warning does not continue.

### Performance characterization and codec decision

- Use both a general-only cache and a combined general-plus-bio cache. The
  latter must contain the real 1,017-command, approximately 20.3 MiB JSON data
  shape used by the prototype measurements.
- In the minimum supported Extension Host, measure full activation load, first
  save, identical-content save, and a real mutation save. Record wall time,
  maximum event-loop delay, JSON bytes, and compressed bytes.
- Measure stages separately: stringify or streaming encode, gzip, write,
  rename, read, gunzip, parse, and validation/freezing. Include warm-up and
  multiple samples; event-loop-delay results from a contended run must not be
  used as a single hard CI assertion.
- Compare the batch codec with the yielding streaming counterfactual on the
  same host and data. Record medians, observed ranges, and the
  wall-time/storage-size tradeoff in the implementation review. Do not turn
  host-dependent millisecond values into a hard CI threshold.
- Select the yielding level-1 codec because the reference comparison reduces
  maximum event-loop delay for first, identical, and mutation saves, and also
  reduces load delay despite its higher load wall time. Revisit worker-based
  encoding only if later same-machine regressions erase that advantage. Do not
  infer responsiveness solely from removal of `structuredClone`.

### Release verification

Run the repository-defined checks:

```text
npm run check:unit
npm run test:integration
npm run package:vsix
npm run verify:vsix
git diff --check
```

Also run the packaged VSIX smoke test and the integration suite on both VS Code
versions used by this branch.

## Acceptance criteria

- All legacy Memento keys observed by the current extension are absent after a
  successful cleanup activation. Deletion failures remain for retry, and keys
  written later by an older extension process are outside this guarantee.
- A valid snapshot survives Extension Host restart.
- A missing, corrupt, or unsupported snapshot does not prevent activation.
- A non-`FileNotFound` canonical read failure does not prevent activation and
  cannot cause that session to overwrite the unread snapshot.
- Routine activation with an already populated general cache causes no
  snapshot rewrite.
- A handled write or rename failure attempts to delete its temporary file. A
  successful cleanup leaves no temporary file; a cleanup failure is logged and
  never hides the primary error.
- Local, curated, experimental, and restored command data all satisfy the same
  schema and cache-key invariant, and their cached command graphs are
  recursively frozen.
- Existing completion, hover, explorer, explicit load, and removal behavior
  remains covered by unit and integration tests.
- The implementation review records repeatable minimum-version, real-data
  measurements and the codec tradeoff. The selected codec improves event-loop
  delay over the batch counterfactual on the same reference host without using
  a machine-dependent fixed CI threshold.
- Unit, integration, packaging, and packaged-smoke checks pass.

## Independent review disposition

Adopted:

- Separate storage-load recovery from unrelated cleanup failure. In the final
  scope this is achieved by omitting startup sweeping entirely.
- Distinguish an invalid snapshot from a non-`FileNotFound` read failure and
  disable persistence for the remainder of the session only in the latter case.
- Validate local H2O output and enforce key/name consistency.
- Reject name-mismatched local and experimental payloads rather than returning
  them for the current request.
- Freeze validated command graphs once at ingress and use shallow membership
  snapshots instead of deep-cloning the full cache for every save.
- Measure the complete save and load path, compare batch and yielding codecs,
  and use the same-host relative result plus the recorded size tradeoff instead
  of a machine-independent fixed event-loop-delay threshold.
- Add a multi-process, shared-profile integration driver and exercise the exact
  declared VS Code 1.101.0 floor in CI.
- Preserve real `version`, `positionalArguments`, and `__meta__` data and freeze
  the entire retained JSON graph; rejecting all unknown properties would drop
  data already present in the curated payload.
- Run the packaged-VSIX activation smoke at the declared VS Code 1.101.0 floor
  in CI in addition to the stable packaged smoke.
- Reject sparse arrays and accessor-backed values in the arbitrary-object
  validator so queued snapshots cannot change through a getter after capture.
  Keep descriptor inspection off the `JSON.parse`-proven path: a post-review,
  same-process alternating A/B comparison on the 1,017-command snapshot found
  no regression versus the pre-review codec, while applying descriptors to all
  parsed data had measurably regressed load latency.
- Recognize name-only VS Code missing-file errors as well as `code` and `ENOENT`
  representations, avoiding accidental session-wide persistence disablement on
  providers that omit `code`.
- Align changelog wording with the best-effort rename guarantee rather than
  calling the snapshot universally atomic.
- Make the queued-snapshot race use two real mutations so it remains valid once
  missing-command saves are suppressed.
- Preserve availability and `removedNames` semantics when skipping no-op saves.
- Treat temporary rename as best effort rather than a universal atomicity
  guarantee.
- Test primary-error preservation when cleanup fails.

Not adopted in this change:

- Per-command persistence, locks, or a pending mutation ledger: disproportionate
  to rare, regenerable cache updates.
- Startup stale-temp sweeping: ordinary failures clean their own temp and crash
  leftovers are harmless to loading.
- Full encode-time revalidation: ingress validation plus the Map invariant is
  sufficient for this scope.
- Per-save `structuredClone`: the measured Extension Host pause on the real
  1,017-command dataset is too large; ingress-time freezing establishes the
  required immutability at lower cost.
- Conditional suppression of explicit force saves: unconditional saving keeps
  the current behavior without adding deep-equality work.
- Exact JavaScript error-object identity as a product requirement: the primary
  failure must remain observable, but object identity is only an implementation
  detail.
