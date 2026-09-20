# Shell lifecycle and output testing — 2026-09-05

This checkpoint extends the [verification tooling campaign](testing-tooling-2026-09-05.md)
to real shell processes, cancellation, deadlines, output pressure, and encoding.
Tests use disposable directories and bounded fixture processes with PID cleanup.
Existing user changes and running Scanner sessions are preserved.

## Reproduced defects

The first eight tests produced seven failures before fixes:

- Cancellation and timeout killed the shell but left its child running.
- A foreground process that ignored SIGTERM exceeded its deadline, then exited
  successfully. The tool incorrectly reported success after the timeout.
- Failed commands bypassed output truncation: a configured 1,000-character limit
  returned an error containing 250,027 characters.
- Exceeding the 2 MiB capture limit lost the reason for termination and returned
  the captured data as the error message.
- Truncation could split a UTF-16 surrogate pair, producing malformed emoji text.
- A positive fractional timeout such as `0.5` milliseconds rounded down to zero,
  silently disabling the deadline.

An initial attempt to add `detached` to `execFile` did not fix child cleanup.
Inspection of the installed Node implementation confirmed that `execFile` does
not forward that option to `spawn`. This failed attempt is retained in the logs.

## Changes

`src/bash-process.js` now owns foreground process execution through `spawn`.
On POSIX systems, each command gets its own process group. Cancellation, timeout,
and capture-limit termination send SIGKILL to that group. The stop reason is
recorded separately from the eventual exit status, so a late successful exit
cannot erase a deadline failure.

The helper retains a maximum of 2 MiB per output stream and decodes UTF-8 after
capturing the byte chunks. `src/tools.js` caps both successful and failed output,
identifies capture-limit failures, and preserves complete surrogate pairs at
truncation boundaries. Timeout overrides are bounded to 1–2,147,483,647 ms.

Forceful cancellation/deadlines do not run command signal-cleanup handlers.
Explicitly backgrounded successful commands retain their requested lifecycle;
the tests verify they survive normal completion. Descendants that deliberately
create a new session/process group are outside this group-based cleanup contract.
The stricter macOS sandbox profile and broker capability boundaries are unchanged.

## Verification

| Check | Result |
| --- | --- |
| Focused shell suite | 14 passed |
| Runtime/heap/pool/buffer matrix | 36 configurations × 14 tests; all 504 passed |
| Full Node 20.20.2 | 530 passed, zero failed, three documented skips |
| Full Node 22.23.2 | 531 passed, zero failed, two live skips |
| Full Node 24.18.0 with coverage | 531 passed, zero failed, two live skips |
| Native coverage of loaded files | 79.79% lines, 76.59% branches, 78.20% functions |
| New process helper coverage | 97.22% lines, 81.82% branches, 100% functions |
| Syntax and public API types | 57 JavaScript modules and strict declaration checks passed |
| Packed runtime | Source bytes match; isolated public Bash API smoke passed |

The shell suite also verifies UTF-8 split into individual writes, 128 small
Unicode truncation cases, 12 timeout values, eight simultaneous captures,
cancellation isolation between siblings, strict macOS broker cancellation,
pre-abort prevention of file writes, intentional background survival, executable
launch errors, and distinguishing external signals from timeouts.

The 36 configurations combine Node 20/22/24, heap limits of 64/128/256 MiB,
worker pools of 1/8, and normal/zero-filled-buffer execution. Locale and timezone
vary between C/UTC and Japanese/Asia-Tokyo. Three configurations run concurrently.
At this checkpoint the restarted streaming loop had passed 668 batches and
1,336,000 generated cases; `continuous-02/results.jsonl` contains newer counts.

Results are from macOS arm64. A read-only Docker probe found no running daemon;
no Docker or power settings were changed. Native Linux/Windows execution was not
performed in this checkpoint. The Windows helper currently terminates its direct
child; this report does not claim Windows process-tree cleanup. Loaded-source
coverage does not measure every browser file or every subprocess execution.

## Reproduce

```sh
NODE_ENV=test node --test test/shell.test.js
NODE_ENV=test UV_THREADPOOL_SIZE=1 node --max-old-space-size=64 --zero-fill-buffers --test test/shell.test.js
npm test
npm run coverage
```

Artifacts are under
`/var/folders/xn/5987rxq95wjbb6mvn_m06l1c0000gn/T/claudette-ongoing-vf7haq54`:
`shell-before.log`, `shell-after.log`, `shell-spawn-after.log`,
`shell-expanded.log`, `shell-node20-full.log`, `shell-node22-full.log`,
`shell-node24-coverage.log`, `shell-matrix.json`, `shell-matrix/`, and
`shell-package/`. Continuous streaming evidence remains in `continuous-02/`;
the earlier suspension-associated failure in `continuous/` remains intact.
