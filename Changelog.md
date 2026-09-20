# Changelog

## [Unreleased]

### Security

- **macOS CLI sessions are now confined to their launch directory by default.**
  Claudette re-executes under a Seatbelt workspace profile before loading
  application code; persistent state, temp files, and dev-server logs move below
  `.claudette/` in that workspace. A minimal trusted launcher brokers Bash over a
  private authenticated Node IPC channel and applies exactly one stricter Bash
  profile per command. It independently validates workspace/cwd, denies outside
  file access, signals outside the command's own process tree, Apple Events, and non-loopback
  networking, strips credential-like variables, and enforces wrappers, timeout,
  cancellation, and output caps. These protections remain active under `--yolo`.
  `CLAUDETTE_TOOL_ENV_ALLOW` names deliberate environment exceptions, while
  `CLAUDETTE_WORKSPACE_SANDBOX=0` is an explicit unsafe opt-out.
- **Outbound model Bash networking now has an explicit scoped opt-in.** The
  macOS default remains loopback-only, including under `--yolo`. Launching with
  `--network` (or `CLAUDETTE_BASH_NETWORK=1`) removes only the Bash egress denial;
  workspace filesystem confinement, cwd validation, signal/AppleEvent denial,
  credential scrubbing, timeouts, and the authenticated broker remain enforced.
  Exact macOS resolver socket/config reads make DNS work without exposing a host
  directory. Startup and `/config` make the elevated network mode visible.
- **Remote web access now requires an explicit security boundary.** A non-loopback
  bind is rejected without a bearer token and exact Host allowlist. API requests
  enforce the token plus Host/Origin checks, responses use a restrictive CSP, and
  request/report/session inputs are bounded and schema-validated.
- **A symlink inside the workspace could read and write outside it.** `guardPath`
  compared relative paths, which catches `../etc/passwd` but not
  `ln -s /etc/passwd notes.txt` — that link is lexically innocent, and
  `read_file notes.txt` walked straight out. The real path is now resolved and
  re-checked, including for files that do not exist yet (`write_file` creates
  them), so a new file is validated as strictly as an existing one.
- **`glob` no longer touches a shell.** It ran `bash -c 'shopt -s globstar;
  files=($1); …'` with the model-controlled pattern as a positional parameter.
  That was careful, and it still meant an auto-approved tool handing
  attacker-influenced text to a shell. The matcher walks the tree directly now,
  prunes `node_modules`/`.git` during the walk rather than filtering afterwards,
  and omits symlinks that leave the workspace.
- **The unauthenticated server accepted unbounded request bodies.** Capped at 1 MB
  (`CLAUDETTE_MAX_BODY_BYTES`), answering 413 rather than resetting the connection,
  and malformed JSON is a 400 instead of a 500.
- **A file you asked Claudette to read could run shell commands with no
  permission prompt.** `handleMessage` scanned the prompt for a benchmark escape
  hatch ("Call bash with EXACTLY this command…") and ran whatever followed
  through `executeTool` directly, skipping `checkPermission` entirely. It scanned
  the **@file-expanded** prompt, so the sentence only had to appear inside a file
  you inlined. Reproduced end to end: a `notes.md` containing that sentence, with
  the prompt `please summarize @notes.md`, executed the command before any model
  request. The shortcut is gone; the two benchmark tasks that leaned on it
  (`count-lines-tool`, `extract-print-help`) are now written as real task
  descriptions, which is what their judge rubrics always claimed to score.
- **"Always allow" on one bash command authorised every later command.**
  `needsApproval` built a per-command `bash:<cmd>` key, but `checkPermission`
  stored the bare tool name — so answering `a` to `rm -rf build` silently
  approved every command for the rest of the session. Bash approvals are now
  scoped to the exact command (`permissionKey`), and the prompt says which.

### Changed

- **Foreground Bash cancellation and deadlines stop the POSIX command group.**
  A spawn-based helper fixes orphaned children and commands that ignored SIGTERM
  then falsely reported success after their deadline. Successful intentional
  background commands keep their lifecycle. Failed output is now capped,
  capture-limit errors identify their cause, Unicode truncation preserves emoji,
  and timeout overrides cannot round down to a disabled deadline.

- **Verification commands now enforce their results.** Type checking uses a
  locked development-only compiler and strict public API consumer checks;
  declarations now include the supported `maxTotalChars` trimming option.
  Native Node 22/24 coverage enforces 70% lines and 60% branches, including in
  Node 24 CI. Test discovery avoids shell globs, clears inherited nested-run
  state, and propagates failures and interruption. CI no longer masks compiler
  or dependency-audit failures.

- **Persistence now preserves newer state under concurrent saves.** Direct saves
  supersede older debounced snapshots; session and transcript publications run
  in order per session, and flushes wait for in-flight work. Archive names remain
  unique when timestamps collide. Transcript queue eviction publishes its latest
  view, instruction caching detects ancestor/file/boundary changes, and atomic
  writes support long legal filenames. Fourteen regressions passed across three
  full runtime suites and 60 filesystem stress configurations.
- **Provider streams now handle framing, interruption and failures consistently.**
  Ollama, Anthropic and OpenAI-compatible adapters share UTF-8/SSE framing,
  release response readers, surface streamed errors and malformed records,
  reject premature EOF, and stop processing buffered text after cancellation.
  A separate streaming suite covers packet boundaries, Unicode, tool arguments,
  large replies and concurrency. `scripts/stress-streams.mjs` runs reproducible
  finite or continuous batches across seeds, memory limits and environments.
- **Tool activity is quieter and separate from conversation text.** Interactive
  prompts and assistant replies no longer interleave with a permanent row for
  every routine inspection. A dedicated `Tools` block combines consecutive
  successful reads, listings, globs, and searches into one counted summary,
  while Bash, writes, edits, approvals, and failures remain explicit. Derived
  transcripts use the same separation and omit successful routine result bodies;
  exact provider message history remains in session JSON for safe resumes.
  Persisted traces compact completed exploration lifecycles without changing
  usage call counts.
- **Automatic model selection now starts with the cross-platform benchmark
  winners.** When installed and live, Ollama Cloud Kimi K2.7 Code and DeepSeek
  V4 Pro lead the shared CLI/library/browser/eval/rotation order, followed by
  the other models that scored at least 8/11. Existing provider fallbacks remain
  available, explicit model choices still win, and missing tags are never pulled.

### Fixed

- **Stress testing closed more verification and sandbox gaps.** Discovery through
  package wrappers, pytest addopts/environment settings, and Make dry runs no
  longer verifies an edit; redirecting output to `/dev/null` no longer creates a
  false edit. Metadata-only access to the `/etc` alias lets nested macOS login
  shells load already-readable system profiles without contaminating worker logs.
  Added generated edge cases, clipboard failure tests, and an opt-in native
  clipboard/CLI harness that preserves the original clipboard in memory.
- **Reviews distinguish test discovery from verification.** Bash results label
  pytest collection coverage and masked checker exit statuses as inconclusive;
  collection, help, version, and dry-run commands cannot satisfy the verification
  gate. Shared CLI/library/eval instructions require findings grounded in inspected
  code and existing configuration, distinguish statement counts from file lengths,
  and discourage lowering quality gates to accommodate incomplete checks. A new
  read-only review eval checks these mistakes against a seeded boundary defect.
- **Disk SQLite and mypy caches work in macOS home-directory workspaces.**
  Strict Bash now permits metadata reads of `/Users`, which SQLite needs while
  resolving workspace paths. Directory listings, outside reads/writes, and
  network restrictions remain unchanged.
- **Repeated failures cannot evade the guard by changing arguments.** Three
  matching terminal Bash exceptions now request a final evidence-based answer;
  successful edits/checks and user steering reset the counter. This prevents
  dozens of ineffective variations of the same SQLite or tooling failure.
- **Blocker explanations no longer trigger impossible verification loops.**
  Once tools are disabled, the verification gate accepts the final explanation.
  Removing only known Python/tool caches no longer counts as a source edit.
- **Bash pipelines preserve failing exit statuses.** `pipefail` is enabled for
  direct and brokered Bash so filtering test output through `head` or `tail`
  cannot silently turn a failing check into a successful tool result.
- **Library streams stop their work when callers stop reading.** Streams start
  on first iteration, abort on early exit, and wait for provider/tool cleanup.
  Reusable agents remain busy through cancellation and honor their default
  AbortSignal; abandoned streams leave conversation history unchanged.
- **Verification follows edits within compound Bash commands.** A passing check
  after an edit in the same command now satisfies the gate; a later edit, even
  in a command that exits with an error, invalidates previous checks. Environment
  prefixes, Python `compileall`, and dependency audits are recognized without
  treating ordinary generated artifacts as source edits.
- **Syntax checks no longer silently pass on broken JavaScript.** `npm run lint`
  and CI check every tracked or new, non-ignored JS/MJS/CJS file, preserve errors
  across files, and handle paths with spaces and deleted tracked files.
- **Tab completion no longer crashes on Node 24.** The promise-based readline
  interface now receives an async completer that returns its tuple instead of a
  callback-style function that returned `undefined` and triggered an internal
  destructuring `TypeError` on Tab.
- **Sandboxed builds can manage their own worker processes.** The signal rule
  now allows a command to terminate children in its inherited sandbox while
  continuing to deny the launcher parent and unrelated processes. This fixes
  Next.js production builds that crashed with `kill EPERM` during worker cleanup.
- **Background-server logs now use a canonical private control path.** A launch
  from macOS's `/tmp` spelling could serve traffic while Seatbelt rejected log
  creation under the canonical `/private/tmp` workspace, leaving the returned
  path absent and output attached to `/dev/null`. Claudette validates the
  non-symlink control directory, creates/redirection-checks the log inside the
  strict profile, and fails closed if logging cannot be established.
- **Model-issued Bash now uses an existing workspace Python virtualenv.** A
  canonical, non-symlink `.venv` or `venv` is placed on `PATH` and exposed as
  `VIRTUAL_ENV` before commands run, including inside the strict macOS sandbox.
  PEP 668 `externally-managed-environment` failures now explicitly explain that
  system-Python protection is not evidence of a read-only workspace and direct
  the agent to the project virtualenv. The loopback-only network boundary is
  unchanged.
- **Xcode-backed tools now work inside the strict macOS Bash sandbox.** The
  launcher resolves and canonicalizes the system-selected developer root before
  Seatbelt starts, grants read-only access to that one Xcode/Command Line Tools
  tree (never all of `/Applications`), and removes inherited `DEVELOPER_DIR`.
  Sandboxed tools use private workspace-local `HOME`/`TMPDIR` directories and
  can read system entropy devices, while outside writes, host-temp writes,
  external networking, unrelated signals, and Apple Events remain denied.
- **Cross-platform benchmark copies no longer parse macOS metadata as data.**
  Eval cases, YAML/JSON tasks, eval summaries, and leaderboard reports accept
  only visible regular files with supported extensions, ignoring AppleDouble
  `._*` sidecars and extension-shaped directories. CLI table tests also strip
  terminal control codes instead of depending on ambient `NO_COLOR`.
- **Model Bash no longer fails before execution under the macOS workspace
  sandbox.** Applying a restrictive `sandbox-exec` inside the already sandboxed
  CLI failed with status 71 (`sandbox_apply: Operation not permitted`), and a
  first broker revision placed its socket under inaccessible `/tmp`. Direct
  parent/child IPC removes the filesystem socket and nested Seatbelt composition.
  Real sandboxed CLI coverage now exercises local `wc`, `cat`, Python, Node, npm,
  loopback, outside access, external network, process signaling, Apple Events,
  secret scrubbing, cancellation, broker death, and all CLI modes.
- **The agent now stops after the second identical failed tool call.** Required
  tool arguments throw consistently, unoffered tools are paired with an error
  without execution, remaining calls are paired/cancelled at the failure limit,
  and the next response must explain the blocker with tools disabled. The prompt
  carries the same continuation rule across `/model` switches.
- **Pipelines and masked commands no longer satisfy the verification gate.** A
  failing test followed by `|| true`, piped through another command, run in the
  background, or hidden before `; echo done` cannot be recorded as verification.
- **Harbor benchmark installs are reproducible.** The adapter pins Harbor 0.22.0,
  NVM v0.40.2 (with a checked installer hash), and Node 22.23.2; it requires a
  full Claudette commit SHA and rejects unknown provider prefixes instead of
  silently treating them as local Ollama models.
- **Browser chat no longer maintains a second agent and session engine.** Web
  turns run through the shared `runAgent()` with an empty tool list, while CRUD,
  transcripts, and context expansion use the shared private persistence and
  workspace guards. Tool-shaped browser output remains inert text.

- **Cached input tokens were not counted, so a long session under-reported its
  cost by orders of magnitude.** Anthropic's `input_tokens` is the *uncached*
  remainder, while OpenAI-compatible providers put the whole input in
  `prompt_tokens` — and prompt caching is on by default here. The adapter read
  `input_tokens` alone and called it the total: a five-case eval run against
  `anthropic/claude-opus-5` reported 52 input tokens, and the live API said 371
  for a single request the adapter was scoring at 2. `promptTokens` is now the
  true total for both families, with the cache split carried alongside so
  `estimateCost` prices a read at 0.1x and a write at 1.25x instead of billing
  both as fresh input.
- **A retry could fire instantly, three times, and give up inside a second.**
  Backoff used full jitter — uniform over `[0, exponential]` — so an unlucky
  draw waited ~0ms. It is half jitter now, and a connection-level failure
  (nothing answering the socket, as against a 429 that answered) starts from a
  3s base rather than 500ms. Found when Ollama auto-updated itself mid-run,
  SIGTERMed its own server, and took 8.4s to come back; the whole retry budget
  had expired long before. Sub-second waits also printed as "in 0s", which read
  as "it never waited at all".
- **A failed run threw away the provider error.** `runAgent` caught it, emitted
  it, and returned a result that did not carry it — so a batch runner reported
  "agent run failed after 1 iterations" with no way to tell a dead credit
  balance from a bad model. The failed result carries the error now.
- **Ctrl+C now interrupts a running tool, not just the model request.** The abort
  controller was created per model request and cleared before tools ran, so during
  the long part of a turn — a `npm run build` that hangs — nothing was listening
  and Ctrl+C killed the process instead. One controller now spans the turn and is
  threaded into `execFile`/`fetch`. An interrupted command says so, rather than
  claiming it timed out and sending the model off to tune `CLAUDETTE_BASH_TIMEOUT`.
- **Two concurrent turns on one web session silently lost one of them.** Both
  loaded the session, both appended, and the slower save clobbered the faster.
  The second request gets 409 now, and the slot is claimed synchronously — checking
  before the first `await` left a window where both passed.
- Closing the browser tab used to leave the provider call running to completion,
  billed and discarded; it is aborted with the response.
- `executeTool` rejected `signal: null`. `execFile` validates that option as
  AbortSignal-or-undefined, so a caller with no signal to give (the eval harness)
  broke every command before it ran.
- **The exact-bash shortcut poisoned sessions on OpenAI-compatible providers.**
  Both its branches appended a `role: 'tool'` message with no preceding
  `tool_calls`; OpenAI and Azure reject the entire request with *"messages with
  role 'tool' must be a response to a preceeding message with 'tool_calls'"*. The
  failure branch died inside its own recovery loop, and the success branch left
  the bad message in `session.messages` so the **next** prompt in that session
  400'd. Removed at the source, and `dropOrphanToolMessages` now strips orphans
  from every outbound payload so sessions written by older builds still resume.
  Stored history keeps them.
- **`--json-ipc` dropped every prompt after the first.** The loop advertises
  `{"type":"ready"}` each turn, but `rl.question()` only listens while awaited —
  lines emitted during a turn reached nobody and were discarded, then `rlClosed`
  ended the loop. Two piped prompts ran one turn; with stdin redirected from a
  file, even the first was lost. A `createLineQueue` buffers every line, EOF is a
  value rather than a rejection, and `ready` is no longer advertised into a closed
  stream. Single-shot piping (the Harbor adapter) is unaffected.
- Compaction no longer destroys the conversation. `/compact` and auto-compaction
  replaced `session.messages` with a summary, and the transcript is regenerated
  from that array — so the original was gone from both places. The full history is
  archived to `data/sessions/archive/` first, and the path is printed.
- Session writes are atomic (temp file + rename). A crash mid-write left a
  truncated JSON that `JSON.parse` rejects, making the session unloadable and
  silently dropping it from `/sessions`. Sessions are written after every tool
  result during a turn, so the window was not theoretical.
- A rate limit or transient 5xx no longer throws away the whole turn. Provider
  calls retry with exponential backoff plus jitter, honouring `Retry-After`
  (`CLAUDETTE_MAX_RETRIES`, default 2). Retries stop once bytes have streamed, so
  visible output is never duplicated, and a bad model slug or missing key still
  fails on the first attempt instead of three times slower.
- A hung provider no longer hangs forever. A stall watchdog aborts a request that
  sends nothing for `CLAUDETTE_STALL_TIMEOUT` (default 300s, `0` disables) and
  reports it as an actionable error — deliberately not an `AbortError`, which the
  agent loop reads as "the user pressed Ctrl+C" and would have recorded a real
  failure as a clean cancellation.
- Transcripts are throttled instead of rewritten after every tool result. A
  150-iteration turn re-serialised the whole growing transcript 150 times; it is
  derived data, so it now writes at most every 2s and is flushed exactly at turn
  end and on exit (`CLAUDETTE_TRANSCRIPT_THROTTLE`).

### Added

- **`/copy` copies the last assistant message to the clipboard.** Preserves raw
  Markdown, Unicode, and line breaks; supports macOS, Windows, and Linux desktop
  clipboard utilities, with clear empty-history and unavailable-clipboard messages.
  Listed in `/help` and Tab completion.

- `bench/eval-summary.js` — rebuilds `bench/BAKEOFF.md` (a ranked model table
  plus a per-case coverage matrix) from the eval reports on disk, keyed on the
  latest result per model *and* case, since a bake-off gets run in pieces. The
  first bake-off's table was kept in a session scratchpad and was gone by the
  next session, while the reports it came from sat in `bench/runs/evals`
  untouched. The reports stay gitignored; the summary is committed.
- Four eval cases that separate models rather than checking they can call a tool:
  `multi-file-rename` (rename a symbol across three files, not just its
  definition), `fix-failing-test` (run it, read the error, fix the source,
  re-run — `test.sh` writes `.passed` only on a green run, so "it passes now" is
  checkable rather than taken on the agent's word), `already-correct` (the file
  is already right; the pass condition is not editing it), and `ambiguous-anchor`
  (a non-unique `str_replace` anchor that has to be recovered from).
- `CLAUDETTE_NUM_CTX` — Ollama's context window was hardcoded to 32k, so models
  advertising far more (qwen3.6 exposes 256k) had no way to use it. Still defaults
  to 32k, because Ollama's own default of 4096 truncates an agent loop immediately.
- `claudette -p "…"` — headless one-shot mode. Prints the reply and nothing else
  (no banner, spinner, or cost footer), so it pipes cleanly, and exits non-zero
  when the turn fails.
- `claudette --continue` / `--resume <id>` — reattach to the newest or a named
  session at launch, instead of starting cold and typing `/resume`.
- `Tab` completion for slash commands and `@paths`. readline supports a
  `completer` and one was never passed, so Tab did nothing.
- CI (`.github/workflows/ci.yml`) on Node 20/22/24, plus `npm test` and
  `npm run test:offline` — a 240-test suite existed and nothing ran it.

### Changed

- **`bench/evals.js` no longer replays cached responses by default** (`--cache`
  opts in; `--no-cache` still parses). The cache is right while writing a case
  and wrong while comparing models: a replayed call reports the tokens recorded
  whenever it was captured and a near-zero duration, so a model with cache
  entries reads as both cheaper and faster than one being measured for real. It
  also masked the token-accounting fix above — the same case kept reporting 4
  input tokens after the bug was gone, and 3,651 once the cache was off. The
  mode is printed with the run and recorded in the report.
- **Eval cases can assert more than "the right tool was called".** `files` takes
  `excludes` and `absent` alongside `includes` (a rewrite that lands the asked-for
  change but drops the rest of the file now fails), and `expect.maxToolCalls` is
  an efficiency budget — with several models passing everything, correctness ties
  break on whether the answer was reached or brute-forced.
- `AGENTS.md` is the single source for agent conventions; `CLAUDE.md` and
  `GEMINI.md` point at it. Three near-identical copies had already drifted — one
  said trim history to 50 rows, another 20, and `GEMINI.md` never carried the
  commit-attribution rule at all.
- Removed the legacy `.persist/` state directory (superseded by `PERSIST.md`; it
  still described the project as "Ollama Code Console" at a path that no longer
  exists), the orphaned `cli.js`, and the unused `workspace/` fixtures.
- **The agent loop is now `src/agent-runner.js`, shared by everything.** It lived
  inside `chat.js`, tangled with readline and the spinner, so `bench/evals.js`
  carried a second, simpler copy and the browser had none. Every behaviour added
  to the CLI — the re-read guard, the action nudge, the verification gate, payload
  trimming — was invisible to the harness measuring it, so the benchmark scored a
  different agent than the one that ships. `runAgent()` has no terminal in it;
  callers supply rendering, permissions, and persistence through hooks. The CLI is
  now a shell around it, and the eval harness runs the real loop. The text
  tool-call parser moved to `src/tool-call-parser.js` for the same reason.

### Tests

- The live-provider suite was unrunnable, not "environment-dependent". Thirteen
  tests hardcoded `llama3.2:latest`; they now discover an installed Ollama model
  (preferring one that advertises tool support) and skip with a reason when none
  is available.
- The `normalizeArgs` tests asserted against an inlined **copy** of the alias
  tables, spawned in a subprocess — a real parser bug could never fail them. They
  import the shipping function now.
- New coverage for the extracted runner, retry/backoff/stall behaviour, tab
  completion, atomic writes, and the compaction archive.

### Fixed (earlier, same release)

- Recoverable tool errors now guide the model instead of repeating. Across real
  sessions 13% of tool calls errored, dominated by three recoverable mistakes —
  file-not-found (59×), missing/empty path (38×), and path-outside-workspace
  (31×). These now return actionable messages ("don't guess paths — run list_dir
  / search_code", "use a path relative to the workspace root") so the model
  self-corrects rather than retrying the same bad call. `patch_file` now gives the
  same recovery hints `str_replace` already had (nearest-line hint on a missing
  old_str, "put updated text in new_str" on a no-op patch, "make it unique" on a
  multi-match), and a blank `bash` command gives a clear error instead of the
  shell's cryptic "-c: option requires an argument".
- `list_dir`, `search_code`, and `grep` with an empty/blank path now target the
  workspace root instead of throwing "Missing required 'path'" — a live nano run
  repeated the same empty-path `search_code` five times in a row on this bug.
- `bash` timeout is configurable and more generous (30s → 120s default,
  `CLAUDETTE_BASH_TIMEOUT`); the timeout error now explains how to recover and
  that long-running servers (`next dev`) can't run in the foreground.
- Piped/automated input is no longer dropped or crashed on EOF. `echo "…" |
  claudette` could lose its last line (the prompt arrived in the same chunk as
  EOF, before the coalesce window flushed), and if stdin closed mid-turn,
  `rl.resume()` threw "readline was closed" and killed the turn. The idle reader
  now flushes a buffered line on close, the loop exits cleanly on EOF, and the
  mid-turn `rl.resume()` is guarded. (Surfaced while live-testing the nudge.)
- A turn that fails because the model id is wrong now says so. The usage log
  showed turns dying instantly (`tools=0, in=0`) on typo'd slugs
  (`openrouter/openai/gpt-54-mini`) behind a generic "Stream error" — and the
  same typo getting retried. `explainStreamError` detects model-not-found errors
  and points at the slug / `/models`.
- Pasting a multi-line block at the **idle prompt** no longer fragments into one
  prompt (or slash-command) per line. readline emits a `line` event per newline;
  a rapid burst is now coalesced into a single submission (`createBurstReader`),
  so a pasted stack trace / build log arrives as one message. (The in-turn paste
  path was already fixed; this closes the idle-prompt gap.)
- Echoed terminal artifacts no longer leak into a captured prompt. A real session
  logged `cont  ⎿ Wrote 1335 chars …` — a typed "cont" plus an echoed tool-result
  line. `sanitizeUserInput` strips ANSI escapes and cuts a single typed line at
  the ⏺/⎿ render glyphs (multi-line pastes are kept whole).
- Usage-dataset quality: a user-cancelled turn (Ctrl+C) now records
  `status: "cancelled"` instead of `"failed"`, and the GPT-5 family
  (`gpt-5`/`-mini`/`-nano`) is priced, so the cost meter and usage log no longer
  report `$0.00` for the models you actually run.
- Pasting a multi-line block while the agent works no longer fragments into one
  queued follow-up per line. Bracketed paste mode is enabled during a turn and a
  pasted block is coalesced into a single follow-up (`createInputAssembler`).

### Changed
- Action-forcing nudge for the agent loop. The re-read guard made flailing cheap
  but didn't stop it — a live gpt-5-nano turn still read the same files dozens of
  times with zero edits. After N consecutive read-only tool calls with no edit or
  command (default 15, `CLAUDETTE_ACT_NUDGE`, 0 disables), a firm steering line is
  appended to the last tool result telling the model to act; it re-arms every N.
  A *failed* action (e.g. a no-op patch) does not reset the streak — it isn't
  progress. Verified live: nudge fired at 3 reads → model immediately made the edit.
- Curbed agent over-exploration — the real cause of slow, often-cancelled turns.
  Session transcripts showed a turn making **128 tool calls, not editing until
  call #109**, with **69% of file reads being redundant re-reads** (one file read
  23×). Two changes: (1) a **per-turn re-read guard** in `read_file` — an
  identical read of an unchanged file returns a short pointer instead of re-sending
  the contents (a changed file or a new line range still reads normally); (2) the
  system prompt now tells the agent to explore only as much as the task needs, not
  re-read files it already read this turn, and to act once it understands the code.
  (Also: the system prompt identified itself as "Ollama Code" → now "Claudette".)
- Default tool-iteration cap raised 50 → 150 (`--max-iterations` /
  `CLAUDETTE_MAX_ITERATIONS` still override). Usage logs showed real turns hitting
  the 50 cap mid-task and forcing repeated "continue" prompts; the higher cap is
  safe now that context management bounds per-iteration token growth.

### Added
- Verification gate — a turn that edited files can't finish without proving the
  result works. A real Sonnet run "completed cleanly" (11 edits, $2.55) but left
  the site broken because it never ran a build. Now, before the agent ends a turn
  in which it edited, it must have run a passing build/typecheck/test
  (`looksLikeVerification` recognizes them, dev servers excluded); otherwise the
  loop pushes it to run one and fix failures (capped at 2 nudges/turn,
  `CLAUDETTE_VERIFY_GATE=0` to disable). The system prompt now also makes "verify
  before claiming done" explicit. Verified live: the gate fires even when the
  model is told to skip verification.
- Realtime token/cost readout on the working spinner (à la Claude Code). While the
  agent runs, the spinner shows cumulative `↑input ↓output · $cost · iter N/max`,
  updated after every model request from the turn's trace metrics —
  `↑3.2k ↓381 · $0.0003 · iter 3/150`. Off under `--json-ipc`. (`setUsageStatus`
  in ui.js, `formatTokens` in cost.js.)
- Context management to curb token blowup (a real session hit 1M+ input tokens in
  a single turn from ~30 accumulated file reads re-sent every iteration).
  **Tool-output trimming**: old, large tool results are collapsed to a placeholder
  in the model payload — keeping the most recent ~6 full — so a long tool loop
  stops re-sending every read; stored history is untouched (`trimToolOutputs`).
  **Re-read guard** (`readCache`): `read_file` short-circuits an identical
  unchanged re-read, and caps repeated reads of the *same* unchanged file across
  different line ranges (a live nano run read one file ~12× and never edited).
  **Auto-compaction**: when prior history passes ~60k tokens
  (`CLAUDETTE_COMPACT_TOKENS`) it's summarized before the next turn
  (`CLAUDETTE_AUTO_COMPACT=0` to disable). Prompt history is no longer written
  under the test runner. The per-turn usage log (`data/usage/usage.jsonl`) now
  records `iterations`, `hitToolCap`, and `compacted` so the effect of these
  controls on input-token growth is measurable from the dataset.
- See your follow-ups while the agent works. In an auto-approve TTY session, typed
  input is now echoed on a managed bottom row (it was blind before) — streamed
  output is routed above it so the two don't collide, and typing pauses the
  spinner. (`updateLiveInput`/`printAboveLive` in `ui.js`, assembler `onChange`.)
- Persistent per-directory prompt history. Re-entering the TUI in the same
  directory restores what you typed there — **up-arrow recalls prior-session
  prompts** like a normal shell (newest-first, consecutive dups skipped). Stored
  under `data/history/` keyed by the absolute cwd (gitignored). (`src/history.js`)
- VS Code Default Dark+ palette, brightened for terminal readability. The CLI/TUI
  colors mirror VS Code's default dark theme (purple, blue, teal, function yellow,
  string orange, error red) with higher luminance so text reads clearly on common
  terminal backgrounds, via 24-bit truecolor (`src/ui.js`); `NO_COLOR` is honored
  and the exact codes are exported as `palette`.
- The CLI/TUI now also loads a **`CLAUDETTE.md`** project-instructions file,
  walked up the directory tree alongside `CLAUDE.md` (innermost wins; a level's
  `CLAUDETTE.md` comes after its `CLAUDE.md` so it can augment/override) — for
  Claudette-specific guidance on a directory or session.
- Token-spend usage log. Every completed turn appends a flat JSONL record to
  `data/usage/usage.jsonl` — model, prompt/completion/total tokens, estimated
  cost, duration, tool-call count, prompt, status — a ready-made dataset for
  studying and improving token efficiency. On by default; `CLAUDETTE_USAGE_LOG=0`
  to disable, `CLAUDETTE_USAGE_DIR` to relocate. (`src/usage.js`; gitignored.)
- Queued follow-ups (mid-run steering). In an auto-approve TTY session you can
  **type while the agent works**; submitted lines go into a visible FIFO queue
  (`/queue`, `/queue clear`) instead of starting a second loop, and are delivered
  as one combined steering message at the next safe boundary (after a model
  response and its tool calls, before the next request) — keeping exactly one
  agent loop per session. `src/input.js` (`InputController`) is unit-tested.
  Phase 1: live capture is gated to auto-approve TTY (a normal turn needs stdin
  for permission prompts); echo/redraw and approval-mode input come next.
- Configurable agent-loop cap. The per-turn tool-iteration limit is now **50** by
  default (was a hard **20** that cut off large multi-file builds mid-task) and
  configurable via `--max-iterations N` / `CLAUDETTE_MAX_ITERATIONS`. On reaching
  it, an interactive session offers to keep going instead of silently stopping,
  and the stop message says how to continue or raise the limit.
- Cost controls. **Prompt caching** for Anthropic — native and via OpenRouter
  (`src/llm-config.js` + ephemeral cache breakpoints on the system prompt and the
  conversation tail; on by default, `CLAUDETTE_PROMPT_CACHE=0` to disable) — so the
  stable prefix isn't re-billed at full input price on every tool iteration / turn.
  **Sane `max_tokens`** default (16k; `CLAUDETTE_MAX_TOKENS`) on the OpenAI-
  compatible transport, so OpenRouter no longer reserves the model max (65k) per
  call (the cause of spurious `402`s). **Bash output cap** before it enters context
  (`CLAUDETTE_BASH_OUTPUT_CHARS`, default 16k, head+tail) so one large dump isn't
  re-sent every iteration. **Live cost meter**: per-turn `~$` in the assistant
  footer and an accurate `/cost` summary from real per-turn token metrics
  (`src/cost.js`; override prices with `CLAUDETTE_PRICES`). Tool-call lines now show
  one clean label (`Read`, not `Read [read_file]`).
- Per-turn session tracing in the CLI/TUI. A shared tracer (`src/trace.js`) records
  each turn into `session.turns[]` — status, model, expanded `@files`, token/
  duration metrics, and an ordered event log (`input_received` →
  `system_prompt_built` → `model_request_started` → `tool_call`/`tool_result` … →
  `assistant_completed`/`assistant_failed`). The web server was refactored onto the
  same tracer, so a past CLI session is now as debuggable as a server one. +offline
  regression test.
- Benchmark harness upgrades. **Request caching** (default-on, `--no-cache`):
  `provider.chatStream` hashes each request (model/messages/tools/effort, order-
  independent, callbacks excluded) into `bench/runs/.cache/` so re-runs and
  re-judging are free; writes are atomic (temp + rename) and a corrupt/missing
  entry degrades to a live call with a stderr warning instead of crashing.
  **Structured JSON IPC**: the harness drives `claudette.js --json-ipc`, which
  emits a pure JSONL event stream (`ready`/`turn`/`delta`/`tool_call`/
  `tool_result`/`assistant`/`done`/`error`) with no spinner/markdown/banner
  leakage, replacing terminal-glyph scraping. **YAML task definitions**
  (`bench/tasks/*.yaml`): a lossless YAML subset loader (`bench/tasks.js`) stores
  multi-line prompts as literal `|-` blocks, so exact-reproduction `str_replace`
  anchors are preserved byte-for-byte. +offline tests for all three (parser
  round-trip, cache key/atomicity/corruption, and the end-to-end IPC protocol).
- First-run setup via a gitignored `.env`: a zero-dependency loader (`src/env.js`)
  autoloads `.env` (package root → cwd → `~/.config/claudette`) before any module
  reads `process.env`; a real shell var always wins. Ships `.env.example`
  cataloging every provider key, and the "no models" message now walks you through
  `cp .env.example .env` + OpenRouter.
- Multi-provider model layer addressed `provider/model` (LiteLLM / terminal-bench
  style). New backends: OpenAI, DeepSeek, Groq, HuggingFace (bespoke modules) plus
  a provider catalog (`src/providers.js`) for OpenRouter, Together, Fireworks,
  Google Gemini, xAI Grok, Mistral, Cohere, and Perplexity — all sharing one
  OpenAI-compatible Chat Completions transport. Cloud models work with no local
  Ollama; OpenRouter reaches every major provider with a single key.
- Explicit CLI git workflow commands for feature branching, saving, publishing, and fast-forward updates.
- Benchmark harness support for multi-task model matrix runs from a single command.

### Changed
- Model addressing moved from the `anthropic:` colon prefix to canonical
  `provider/model` slashes (the `anthropic:` colon form is still accepted; bare
  names and `ollama/` route to local Ollama).
- `OPENAI_BASE_URL` / `OPENAI_API_BASE` no longer fall through to the Ollama base
  resolver — `OPENAI_BASE_URL` now configures the OpenAI provider. Use
  `OLLAMA_BASE_URL` / `OLLAMA_HOST` for Ollama.
- Benchmark credential fail-fast generalized from Anthropic to any cloud provider.
- `str_replace` failures now return targeted hints so models can retry with exact snippets copied from the file.

### Fixed
- Benchmark runs now wait for the CLI to finish task execution before sending `/exit`.
- Text-parsed `grep`-style tool calls are normalized to `search_code` so verification searches work reliably.
