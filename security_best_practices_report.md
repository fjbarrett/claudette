# Comprehensive Code and Security Review

**Completed:** 2026-08-31  
**Scope:** CLI, public library API, shared agent loop, provider transports and
rotation, model tools, persistence, local HTTP server/browser UI, benchmark
harness, Harbor adapter, package metadata, and tests.  
**Outcome:** All 15 findings from the 2026-08-28 review were remediated and
covered by regression tests. The production macOS nested-Seatbelt Bash failure
and the subsequent `/tmp` broker bootstrap failure were also fixed.

## Final architecture

### macOS workspace and Bash isolation

The trusted launcher remains outside Seatbelt and starts the main Claudette
process inside a workspace-only profile. It attaches a minimal Bash executor to
the child through Node's private parent/child IPC channel. A random 256-bit
channel capability authenticates the ready/request/cancel protocol.

The sandboxed process can submit only a bounded command, request id, and cwd. It
cannot select an executable, profile, environment, workspace, or arbitrary path.
The launcher independently canonicalizes the workspace and cwd, scrubs inherited
credentials, prepares fixed npm/npx wrappers, and runs every model command under
exactly one `buildBashSandboxProfile()`.

This avoids both prohibited designs:

- no nested `sandbox-exec` application;
- no broker socket in `/tmp` or the model-writable workspace;
- no direct unsandboxed Bash fallback from the confined child;
- no disabling the outer workspace profile, including under `--yolo`.

The Bash profile keeps workspace-only read/write access, working-directory
confinement, loopback-only networking, process-signal isolation, Apple Event
denial, credential scrubbing, wrappers, cancellation, timeouts, and output caps.
Disconnect/error/exit abort active commands and release IPC references so no
orphan child or socket remains.

### Shared agent and persistence path

CLI, library, evals, and browser chat now use `runAgent()`. Browser turns pass an
empty tool list, so tool-shaped model text remains text. Browser session CRUD
delegates to the same private atomic session/transcript store and shared context
expansion used elsewhere; the HTTP layer remains an authenticated NDJSON adapter.

## Finding resolution

| ID | Original risk | Resolution |
| --- | --- | --- |
| CR-01 | Workspace `.env` controlled approval/provider endpoints | Implicit cwd `.env` loading was removed; only explicit/trusted configuration is accepted. |
| CR-02 | Library defaulted to allow-all tools and shell | Library capabilities, project instructions, and `@file` expansion now default off; Bash needs a separate explicit opt-in. |
| CR-03 | Hidden `grep` bypassed the workspace | Hidden dispatch/approval was removed and the runner rejects every tool not offered in the request. |
| CR-04 | Web expansion/static symlink escapes | Server and tools share canonical, symlink-aware workspace guards and bounded expansion. |
| CR-05 | Stored XSS in benchmark reports | Reports are schema-normalized, derived values use safe DOM rendering, and responses carry CSP/security headers. |
| CR-06 | Web server lacked an access/origin boundary | Exact Host/port and Origin/fetch-metadata checks apply; configured bearer auth is constant-time, and non-loopback binds require token plus allowlist. JSON schemas/body limits and no-store headers are enforced. |
| CR-07 | Sensitive state used ambient filesystem modes | State directories/files are explicitly `0700`/`0600`; atomic/debounced failures are handled and surfaced. |
| CR-08 | `fetch_url` could re-resolve DNS and buffer forever | Every A/AAAA answer is validated, the connection is pinned per hop, redirects are revalidated, and deadline/byte/content limits apply before buffering. |
| CR-09 | Reusable streamed agents lost history/fallback state | `send()`/`stream()` serialize access, commit the result/model identically, and abort on early iterator closure. |
| CR-10 | Cancellation left unmatched tool calls | Every declared call receives a result; unstarted calls are paired as cancelled/denied before the turn ends. |
| CR-11 | Browser bypassed shared agent/session/context code | Browser turns now use `runAgent(tools: [])`, shared expansion, and shared session persistence. |
| CR-12 | Argument errors looked like successful tools | Required-argument failures throw and are recorded as errors. A second identical failed call stops tools and forces a blocker explanation. |
| CR-13 | Public types omitted real statuses/events | Runtime statuses and event unions include repetition, max-iteration, completion-nudge, and tool-failure-limit states. |
| CR-14 | Harbor aliases silently routed to Ollama | Supported aliases map explicitly; unknown prefixes fail before credential lookup or execution. |
| CR-15 | Harbor install used mutable/unverified inputs | Harbor 0.22.0, NVM v0.40.2 plus installer SHA-256, and Node 22.23.2 are pinned; Claudette requires a full 40-character commit SHA. |

## Additional correctness fixes

- Provider-wide cooldown prevents automatic A → B → A bounce; rotation defaults
  to at most two switches and never replays after output begins.
- Pipelines, fallback masking, background commands, and later sequential commands
  cannot falsely satisfy the verification gate.
- Repeated failed tools, unoffered tools, cancellation, repetition, and iteration
  caps preserve message pairing and honest trace/JSON-IPC terminal statuses.
- Remote server inputs, static files, benchmark payloads, and session writes are
  bounded and validated; provider calls abort when the client disconnects.

## Verification

- Complete hermetic suite: **418 tests; 416 passed, 0 failed, 2 intentionally
  skipped live-Ollama cases**.
- Real macOS sandboxed JSON-IPC CLI: `wc`, `cat`, Python, Node, and npm succeed;
  outside reads/writes, external networking, parent signaling, Apple Events, and
  secret inheritance fail; loopback succeeds; `--yolo` keeps every boundary.
- Interactive, one-shot, and JSON-IPC brokered Bash modes pass.
- Broker unit coverage rejects malformed/environment-injecting requests, forwards
  cancellation, and fails cleanly on broker death.
- Configured server coverage proves missing/wrong bearer tokens fail, a valid
  token succeeds, and forged Host/cross-origin requests still fail.
- Shared browser-runner coverage proves tools are absent, tool-shaped output is
  inert, history persists, and the trace completes.
- Harbor source contracts, all changed JavaScript/Python syntax, `git diff --check`,
  and `npm pack --dry-run` pass.

## Remaining limitations

- The two live-provider/Ollama stress cases were not run by the hermetic suite;
  provider behavior was covered with local mock servers. Run `npm run test:live`
  with an installed Ollama model for that optional coverage.
- Seatbelt is macOS-specific. The library's explicit `allowShell` option remains
  an unsandboxed host capability outside the sandboxed CLI; applications handling
  untrusted prompts should use a container/VM or leave it disabled.
- Loopback-only model Bash intentionally cannot download packages from the
  internet. Dependencies must already exist or be supplied through a trusted
  workflow.
- Automatic model rotation necessarily resends the full conversation to each
  attempted provider. Use manual `/model` switching and keep the cap at 2 when
  cost or provider disclosure matters.
