# Verification tooling stress tests — 2026-09-05

This checkpoint extends the [filesystem campaign](testing-filesystem-2026-09-05.md)
to test-command exit codes, coverage enforcement, public TypeScript declarations,
clean installations, and the published package. Continuous testing remains active.

## Demonstrated failures and changes

- `npm run coverage` returned success when `c8` was missing because its shell
  fallback swallowed the failure. The command now uses Node's built-in coverage
  with minimum 70% lines and 60% branches. Unsupported Node versions fail clearly.
- Type checking had no project configuration or installed compiler, and its shell
  fallback also accepted failure. A locked, development-only TypeScript 7.0.2
  compiler now checks strict public declarations and a compile-only consumer.
- The real compiler found that `trimToolOutputs` omitted its supported
  `maxTotalChars` option from the public declaration. The declaration is corrected.
- An inherited `NODE_TEST_CONTEXT` caused independent nested test runs to skip
  execution, sometimes returning success. Both the npm launcher and continuous
  coordinator now clear that internal marker. A disposable failing batch proved
  the coordinator returned success before this correction.
- Test discovery and environment setup now use JavaScript rather than shell
  assignments/globs. Failures, empty suites, and interruption retain failing exit
  statuses. The old `test:split` command now runs the same full suite.
- CI installs locked development tooling and preserves compiler/audit failures.
  Its Node 24 test job enforces coverage; Node 20/22 run the offline suite.

The seven tooling regressions use disposable projects, including a filename with
spaces, quotes, a dollar sign, and Japanese text. They cover environment overrides,
live selection, failed assertions, empty discovery, both sides of the coverage
threshold, SIGTERM propagation, and stopping the stress coordinator at its first
failed batch. Nested fixture coverage is isolated from the outer report.

## Verification

| Check | Result |
| --- | --- |
| Full Node 20.20.2 suite | 516 passed, zero failed, two live skips and one unsupported coverage skip |
| Full Node 22.23.2 suite | 517 passed, zero failed, two live skips |
| Full Node 24.18.0 coverage run | 517 passed, zero failed, two live skips |
| Tooling regressions | Seven passed on Node22/24; six passed and one explicit unsupported coverage skip on Node20 |
| Native coverage of loaded files | 79.66% lines, 76.40% branches, 77.95% functions |
| Real compiler on Node 20/22/24 | Passed |
| Fresh locked development install and type check | Passed |
| Injected invalid TypeScript consumer | Failed with exit 1 as required |
| Production-only clean install | Passed; zero runtime dependencies |
| Packed tarball installed into a separate consumer project | Public API consumer compiled successfully |
| Syntax and whitespace | 55 JavaScript modules and `git diff --check` passed |

Type checking covers the public declarations and consumer contract; it does not
claim strict checking of every JavaScript implementation. Coverage is Node's
loaded-file measurement, not a completeness claim for browser files or all
subprocess execution. Tests ran on macOS arm64; native Linux/Windows execution
and the updated GitHub Actions workflow were not run in this checkpoint.

## Continuous timeout investigation

The original loop completed 1,251 successful batches (2,502,000 generated cases).
Batch 1,252 passed its 2,000 generated cases, then timed out during the separate
real HTTP cancellation test. The original failed record and log remain intact.

- Recorded seed: `4228604849`; Node 24.18.0; 128 MiB heap; `Europe/Berlin` timezone;
  `de_DE.UTF-8` locale.
- The 15-second test timeout was reported after approximately 130 seconds.
- macOS recorded sleep at 10:38:40 Arizona time and a wake at 10:40:52: a
  132-second suspension coinciding with the failed batch.
- Exact seed/environment replay passed all 32 tests in 1.17 seconds; the HTTP
  cancellation case took 39.7 milliseconds.
- Sixty further cancellation runs passed across Node 20/22/24 and worker pools
  1/4: 360 cancellation scenarios in total.

This evidence strongly indicates a suspension-associated timeout. No timeout
threshold or assertion was weakened. A new continuous run resumes from the
recorded seed in `continuous-02/`; the original `continuous/` failure is preserved.

## Reproduce and inspect

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run coverage                 # Node 22 or 24
node --test test/tooling.test.js
node scripts/stress-streams.mjs --cases 2000 --seed 4228604849
```

Artifacts are below
`/var/folders/xn/5987rxq95wjbb6mvn_m06l1c0000gn/T/claudette-ongoing-vf7haq54`.
Relevant files: `coverage-script-before.log`, `types-before.log`,
`tooling-first.log`, `stress-context-before.log`,
`stress-context-regression-before.log`, `tooling-coverage-complete.log`,
`tooling-node20-complete.log`, `tooling-node22-complete.log`,
`tooling-install-results.json`, `continuous/batch-001252.log`,
`continuous-failure-replay.log`, `continuous-failure-power.log`, and
`cancellation-repeats.json`. The installed tarball consumer is in
`package consumer 日本語 '$/`.
