# Filesystem and persistence stress tests — 2026-09-05

Continuous testing remains active. This checkpoint expands the
[streaming campaign](testing-streams-2026-09-05.md) into instruction freshness,
save ordering, archive preservation, transcript flushing, and filesystem faults.
All fixtures use disposable directories, including an isolated session data
directory. Existing project changes and the user's Scanner session are preserved.

## Demonstrated failures and changes

- **Stale project instructions:** the cache validated just one local file and
  ignored ancestor edits, file creation/deletion, and new nested Git boundaries.
  It now traverses ancestry each time and validates every contributing file's
  identity, size, modification time and change time. Symlink retargeting and
  transient read failures are also covered.
- **Old queued saves overwrote new explicit saves:** direct saves now update and
  flush the pending snapshot instead of racing its debounce timer.
- **Concurrent saves finished out of order:** publications are serialized per
  session, with inputs captured at invocation. A failed write does not poison
  newer saves or unrelated sessions; loading waits for an in-flight save.
- **Archive collisions:** 24 snapshots at an identical timestamp previously
  produced one archive path. Each archive now adds an independent UUID suffix.
- **Transcript flush races:** flushing previously returned while writes were
  active, and old writes could overwrite new views. Publications are ordered per
  session, and flushing waits for active work.
- **Transcript queue pressure:** more than 100 pending sessions previously
  discarded the oldest queued views. Eviction now publishes the latest view.
  The regression checks all 120 sessions after flushing.
- **Legal long filenames failed atomic writes:** appending the temporary suffix
  exceeded the component-name limit. Temporary files now use a bounded random
  basename in the same directory, preserving atomic publication.

Pre-fix failures are recorded in `filesystem-before.log`,
`filesystem-races-before.log`, `filesystem-transcript-before.log`,
`transcript-pressure-before.log`, and `long-path-before.log`.

## Verification

| Configuration | Result |
| --- | --- |
| Full Node 20.20.2, filesystem worker pool 1 | 510 passed, zero failed, two expected live skips |
| Full Node 22.23.2, filesystem worker pool 4 | 510 passed, zero failed, two expected live skips |
| Full Node 24.18.0, filesystem worker pool 16 | 510 passed, zero failed, two expected live skips |
| Focused filesystem suite | 14 tests passed |
| Repeated configuration matrix | 60 runs × 14 tests; all 840 passed |
| Atomic write fault injection | Partial write/ENOSPC, chmod/EACCES, rename/EACCES preserve prior content and remove temporary files |
| Concurrent publication | 80 writers and four readers observe only complete known JSON snapshots |
| Permissions and paths | Three umasks, Unicode/quotes/spaces, binary data, and a 245-character filename passed |
| Syntax and whitespace | 53 JavaScript modules and `git diff --check` passed |
| Coordinator failure injection | Exactly one failed batch retained; process exited 1 without retrying or hiding failure |

The 60-run matrix combines Node 20/22/24, worker pools 1/2/4/8/16,
and normal/JIT-disabled/zero-filled-buffer/disabled-prototype-access execution.
It uses `TZ=Asia/Tokyo` and `LANG=C`. Tests ran on macOS arm64; these results
do not claim native Windows/Linux filesystem coverage.

Focused instrumentation reports 95.82% line coverage for `session.js`.
This is coverage of this suite only, not the whole project. Existing tools,
provider, CLI, and sandbox tests also ran in the full matrix.

The independent streaming loop passed 433 batches / 866,000 generated cases at
this checkpoint and remains active. Its `results.jsonl` contains newer counts.

## Reproduce

```sh
NODE_ENV=test node --test test/filesystem.test.js
NODE_ENV=test UV_THREADPOOL_SIZE=1 node --jitless --test test/filesystem.test.js
UV_THREADPOOL_SIZE=16 fnm exec --using 24 npm test
```

Artifacts:
`/var/folders/xn/5987rxq95wjbb6mvn_m06l1c0000gn/T/claudette-ongoing-vf7haq54`.
The configuration matrix is `filesystem-matrix.json`, with individual logs in
`filesystem-matrix/`. Full runtime logs are `fs-node20-pool1.log`,
`fs-node22-pool4.log`, and `fs-node24-pool16.log`.
