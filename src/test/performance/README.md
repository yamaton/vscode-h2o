# Provider performance suite

The suite compares two independently built extension roots inside one GitHub
Actions job. Both arms use the target checkout's compiled performance harness,
so a harness change cannot silently change only one arm's measurement. Each arm
runs in fresh Extension Host processes, and the provider processes use a
counterbalanced order.

The default local invocation is an A/A noise measurement of the current build:

```sh
VSCODE_VERSION=1.135.0 VSCODE_TEST_NO_SANDBOX=1 npm run test:performance:ci
```

For an A/B comparison, build both roots first and provide their absolute paths:

```sh
VSCODE_H2O_PERFORMANCE_ARM_A_ROOT=/path/to/base \
VSCODE_H2O_PERFORMANCE_ARM_B_ROOT=/path/to/target \
VSCODE_VERSION=1.135.0 \
VSCODE_TEST_NO_SANDBOX=1 \
npm run test:performance:ci
```

The base extension must support the performance fixture and recorder protocol.
The CI workflow falls back to target A/A during the initial bootstrap when the
base commit does not yet provide `test:performance:ci`.

## Scenarios

- completion and hover cache hits;
- a deterministic completion cache miss that exercises queueing, validation,
  and snapshot persistence without invoking a network service or native H2O;
- completion after round-trip edits in 10 KiB, 100 KiB, and 1 MiB documents;
- cold activation with empty, generated general, and generated general-plus-bio
cache snapshots.

The generated activation snapshots reproduce the recorded command counts,
uncompressed JSON sizes, and gzip sizes without checking large data files into
the repository. Every timed operation records wall time and maximum event-loop
delay. Provider wall time and event-loop delay are compared using processes with
the recorder disabled; separate instrumented processes provide the internal
provider phases. All provider processes still use deterministic fixture I/O.
Cold activation uses fixture cache snapshots and starts the initial curated-fetch
state machine with a pending deterministic response, so no network timing enters
the result.

## Output and gating

The default output files are:

- `artifacts/provider-performance.json`;
- `artifacts/provider-performance-evaluation.json`;
- `artifacts/provider-performance-summary.md`.

`VSCODE_H2O_PERFORMANCE_GATE_MODE=shadow` reports threshold observations but
does not fail. `enforce` fails only when a blocking rule exceeds both its
absolute and relative limits. A/A runs never fail on thresholds.

The GitHub Actions job remains in shadow mode while hosted-runner noise is being
calibrated. p95 and maximum event-loop-delay rules are informational during this
period; they must not become blocking from a single contended observation.
The p50 and p95 comparisons use the median corresponding statistic across fresh
processes. A maximum comparison uses the largest process maximum, preserving a
single observed event-loop stall.
