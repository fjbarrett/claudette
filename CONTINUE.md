# CONTINUE

## Commit checkpoint (2026-09-20, Muse Code session)

- Landed the dirty tree as 3 local commits on feature/review-hardening
  (NOT pushed): 26d65f1 tooling/gates, e0ed6ec functional core, docs
  commit. Each code commit was verified in an isolated worktree before
  landing (C1: 334 pass/0 fail/2 skips; C2: 540 pass/0 fail/2 skips;
  lint + typecheck clean, 20 bench tasks validate).
- Full dirty-tree verification at session start: npm run lint 58 files
  clean; npm test 542 total / 540 pass / 0 fail / 2 live skips.
- Continuous stress loop is DEAD: no process matching stress-streams or
  the recorded PID 80600; artifact root no longer lists. Decide whether
  to restart it or close the continuous-testing goal.
- SE3 app-identity question still unanswered; no app build/install done.
- Next TODO in order: project-scale eval matrix (Kimi/DeepSeek first),
  then MCP client, subagents Phase 2+, persisted permissions,
  Terminal-Bench 10-20 task slice, benchmark rebaseline, verify-grep to
  real tests, Windows port.
- 2026-09-20: verify-grep TODO started (38dfb09, NOT pushed).
  count-lines-tool + extract-print-help assert behavior; echo-cheats
  fail the new checks and passed the old greps. Remaining grep tasks
  (edit-two-timeouts, session-error-handling, add-status-endpoint,
  health-check-script, project scaffolds) still to convert. Eval-matrix
  TODO blocked: no local Ollama daemon; needs cloud auth + farm.

## Active objectives (2026-09-05)

- Continue Claudette testing indefinitely across varied inputs/environments until the user stops or redirects; persistent goal remains active. Do not mark complete just for a testing checkpoint.
- Latest user steering: updated build missing on SE3. App clarification is still unanswered. Connected iPhone SE3 device9BAAC8CE-F98B-5909-B57C-7AD036BE0CBD; Claudette is a Node CLI with no iOS project. Developer apps observed: Caption Crunch(build14), Command, Insight(build1), Keep(build1), Namespace(build1), tru|med. No app build/install performed. Await app identity, then build/install within existing authorization; don't install an arbitrary app.
- Branch feature/review-hardening. Preserve all pre-existing dirty files and the user's running Scanner CLI/session/source. No commits made/requested.

## Completed latest checkpoint: shell lifecycle

- Added src/bash-process.js, updated src/tools.js, added14 regressions in test/shell.test.js. Foreground execution now uses spawn because Node execFile does not forward detached. POSIX commands own a process group; abort, deadline and output overflow kill that group with SIGKILL. Stop reason persists independently of eventual exit status. Explicit successful background commands retain their lifecycle. Windows only terminates the direct child; native Windows/Linux still unverified.
- Reproduced7 failures before fixes: orphaned children on abort/timeout, a SIGTERM-ignoring foreground command falsely succeeding after deadline, uncapped failed output250027chars, lost capture-limit reason, malformed truncated emoji, and fractional timeout0 disabling deadline.
- Capture remains bounded at2MiB per stdout/stderr. Failed output now honors text cap; capture-limit errors identify their cause; truncation preserves surrogate pairs; timeout overrides clamp to1..2147483647ms.
- Tests additionally cover byte-split UTF8,128 Unicode budgets,12 timeout values,8 simultaneous captures, unrelated sibling isolation, strict macOS broker cancellation, pre-abort no writes, intentional background survival, missing executable and external signal causes.
- FINAL FULL: Node20.20.2 has533total/530pass/3skip; Node22.23.2 and Node24.18.0 have533total/531pass/2skip; all zero failures. Node20 extra skip is unsupported positive coverage in tooling tests. Native coverage79.79% lines/76.59% branches/78.20% functions. New helper97.22% lines/81.82% branches/100% functions.
- Matrix36 configurations (Node20/22/24, heap64/128/256MiB, pool1/8, normal/zero-filled buffers, UTC/C or Asia-Tokyo/Japanese locale) passed all504 shell test executions. Three configurations at once.
- Syntax57 modules, strict public type check and whitespace pass. Packed runtime modules byte-identical; isolated package public Bash API smoke passed. Docker read-only probe found daemon unavailable; no Docker/power settings changed.
- Report docs/testing-shell-2026-09-05.md; Changelog and PERSIST updated, history50 rows. No commits. All one-shot sessions closed.
- New evidence: shell-before.log, shell-after.log (execFile-detached attempt still leaked), shell-spawn-after.log, shell-expanded.log, shell-node20-full.log, shell-node22-full.log, shell-node24-coverage.log, shell-matrix.json and shell-matrix/, shell-package/. Baseline originals in shell-baseline/.

## Previous verification tooling checkpoint

- scripts/run-tests.mjs handles portable discovery/environment, failure/cancellation status, Node22/24 coverage thresholds70%lines/60%branches. test:split aliases full suite; live clears inherited skip flag.
- Pinned dev-only TypeScript7.0.2 + lockfile; tsconfig.types.json and test/types/api.ts check strict public declarations/consumer contract. Corrected maxTotalChars declaration. Runtime zero-dependency.
- Both npm launcher and stress coordinator clear NODE_TEST_CONTEXT, which previously caused nested test files to be skipped with exit0. Seven tooling regressions cover failure/empty-suite/coverage/cancellation/environment and coordinator fail-fast.
- Fresh dev/prod installs, injected invalid TypeScript exit1 and packed consumer compilation passed. Report docs/testing-tooling-2026-09-05.md. GitHub Actions/native Windows/Linux were not executed here.

## Continuous testing and retained failure

- Original run exec68643/PID75702 is CLOSED, exit1. continuous/ contains1251 passing batches(2,502,000 generated cases) then failed batch1252, seed4228604849, heap128MiB, Europe/Berlin/de_DE.UTF-8. All2000 generated cases passed; separate HTTP cancellation test timed out after~130s against15s limit.
- Host pmset log shows Sleep10:38:40 Arizona → DarkWake10:40:52 (132s), coinciding with failed batch. Strong evidence of suspension-associated timeout; no assertions/timeouts weakened. Exact seed/environment replay32/32 passed in1.17s.60 repeats across Node20/22/24 and pools1/4 passed360 cancellation scenarios. Preserve original failure and power log.
- CURRENT LOOP: exec session18062, PID80600; continuous-02/ and continuous-02.log below artifact root. Last verified 712 batches / 1424000 generated cases, zero failures, process live. Starts seed4228604849,2000 cases/batch, heap128/256/512MiB and4 TZ/locales. Stop with SIGTERM only when appropriate; new script marker cleanup doesn't alter existing loop whose parent didn't inherit that marker.
- All one-shot verification exec sessions are closed. Goal remains active.

## Prior checkpoints and evidence

- Artifact root: /var/folders/xn/5987rxq95wjbb6mvn_m06l1c0000gn/T/claudette-ongoing-vf7haq54
- Latest logs: tooling-node20-complete.log, tooling-node22-complete.log, tooling-coverage-complete.log, tooling-all-complete.log, tooling-install-results.json. Pre-fix: coverage-script-before.log, types-before.log, tooling-first.log, stress-context-before.log, stress-context-regression-before.log. Cancellation: continuous/batch-001252.log, continuous-failure-replay.log, continuous-failure-power.log, cancellation-repeats.json.
- Prior filesystem: docs/testing-filesystem-2026-09-05.md; instruction-cache freshness, ordered session/transcript persistence, archive uniqueness, bounded atomic temp basenames.14 regressions,60 configurations/840 executions passed; prior full510pass/2skip all3 Nodes.
- Prior streaming: docs/testing-streams-2026-09-05.md;32 tests for UTF8/framing/errors/EOF/cleanup/cancellation, deterministic and seeded cases. MiniMax2/3 and GLMFlash0/3 live Unicode strict cases retained as model-format failures.
- Prior broad review: docs/testing-2026-09-05.md and /var/folders/xn/5987rxq95wjbb6mvn_m06l1c0000gn/T/claudette-stress-c15tc805. Scanner638pass/17skip/82.87%;139 source files preserved. Native /copy6cases passed with original clipboard restored. Do not repeat unchanged Scanner.

## Tool-call log and next steps

- This goal turn is progress: revalidated continuous process, inspected/snapshotted shell code, added real-process regressions and retained seven pre-fix failures.
- Initial execFile detached attempt fixed6/8; inspected installed Node source proving detached was discarded. Replaced only foreground capture/lifecycle with spawn helper; all14 expanded regressions passed including strict broker isolation.
- Full Node20/22/24 and36 runtime/heap/pool/buffer configurations passed. Verified packaged runtime, types, syntax and whitespace; updated reports/history. All one-shot sessions are closed.
- Final call records fresh continuous PID/count evidence and current handoff. Goal remains active, stream loop continues. Next: revalidate loop, then expand remaining shell diagnostics/broker failure scenarios or native platform verification with concrete new cases. Do not rerun unchanged suites without a reason. SE3 remains pending app clarification; avoid repeating the same unanswered question.

- New goal turn: previous turn made progress through shell lifecycle fixes and verified runtime/matrix/package results. Next: revalidate continuous process and inspect/test broker exception, disconnect, cancellation and concurrency paths with isolated IPC fixtures.
- Continuous PID80600 verified live at741batches/1482000cases. Broker currently invokes execute before Promise.resolve can catch a synchronous throw, and client.close rejects callers without sending cancellations. Next: reproduce these with focused tests plus concurrent/disconnect/schema stress.
- Added6 broker tests covering synchronous throws,32-command client close,96 mixed/reordered outcomes,48-command disconnect,40 malformed field variants and active duplicate IDs. Pre-fix session48212 active; next collect exact failures before targeted fixes.
- Broker baseline4pass/2fail confirms uncaught synchronous executor exception and32 commands left active after client.close. Next: contain invocation failures without changing dispatch timing, normalize results inside rejection handling, and cancel pending command IDs on client close.
- Both broker fixes pass all6 tests. Next: verify production IPC with forked processes, synchronous/async/conversion failures, client-close cancellation acknowledged before disconnect, and aborted handshakes.
- Expanded broker suite to9 tests including72 mixed outcomes over real fork IPC,24 client-close cancellations while transport stays connected, and pre-handshake abort. Command exited0; next verify reported execution counts and ensure forked actors actually ran rather than inherited-test skipping.

## Auths integration (separate task, 2026-09-09)

- Auths will add an optional `execute` callback to the exported `runAgent` so its research tools use the existing loop with a scoped executor. Default Claudette tools remain unchanged. Existing dirty work and continuous testing are preserved. Next call applies that two-line extension; verification lives in `/Users/frank/Code/auths/tests/ai.test.ts`.

- Auths executor hook is applied and its integration tests pass: custom tool dispatch, unoffered-shell rejection, URL/repository boundaries, cancellation and cloud-only routing. Local app completed a DO/VPN capture through Claudette. Next: commit only the two executor lines; all pre-existing dirty changes and the ongoing test task remain untouched.

- Auths hook committed and pushed as b2607bf on feature/review-hardening. Only the optional executor parameter and dispatch line were staged; all earlier dirty changes remain. Auths stores its integration tests and independent model comparison in its own repo.
