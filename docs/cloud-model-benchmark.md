# Ollama Cloud Coding Benchmark

## Objective

Determine which Ollama cloud model works best as Claudette's coding agent under
real `--yolo` tool execution. The comparison covers code creation, repair,
verification, outbound network use, and development-server lifecycle behavior on
the reachable Code/farm hosts.

This is a living test record. Each reproducible failure enters a
test → diagnose → fix → retest cycle. Claudette defects and harness defects are
fixed before models are compared; model-specific failures remain visible rather
than being rewritten as product failures.

## Environment

- Started: 2026-08-31 (America/Phoenix)
- Claudette branch: `feature/review-hardening`
- Ollama endpoint: local daemon on `127.0.0.1:11434`
- Remote inference path: reverse SSH tunnel to the same local Ollama endpoint
- Execution mode: real `--yolo`; `--network` only for cases that explicitly
  require outbound Bash traffic
- Reachable Farm workers: local Apple-silicon macOS, remote Intel macOS,
  ThinkPad Ubuntu, CUDA Ubuntu, and a Debian 12 Proxmox guest
- Farm execution: agent 0.4.0, required sandbox-exec/Bubblewrap isolation,
  ephemeral workspaces, outbound networking, and pinned model identity
- Proxmox management remains a separate HTTPS-only target; code executes only
  through the authorized `proxmox-cc-e2e` guest worker

## Model Field

| Model | Parent/size | Context | Declared capabilities | Status |
| --- | ---: | ---: | --- | --- |
| `gpt-oss:20b-cloud` | 20.9B | 131K | completion, tools, thinking | Available; T01 and Scanner V01 passed |
| `gpt-oss:120b-cloud` | 116.8B | 131K | completion, tools, thinking | Available; T01 and Scanner V01 passed |
| `kimi-k2.7-code:cloud` | 1.04T | 262K | completion, tools, thinking, vision | Available on 2026-09-04 rerun; Scanner V01 passed; earlier T01 HTTP 402 retained |
| `glm-5.3:cloud` | 753.3B | 1M | completion, tools, thinking | Available on 2026-09-04 rerun; Scanner V01 passed; earlier T01 HTTP 402 retained |
| `glm-5.3-flash:cloud` | 321.3B | 1M | completion, tools, thinking, vision | Available on 2026-09-04 rerun; Scanner V01 passed; earlier T01 HTTP 402 retained |
| `deepseek-v4-pro:cloud` | 1.65T | 1M | completion, tools, thinking | Available on 2026-09-04 rerun; Scanner V01 passed; earlier T01 HTTP 402 retained |
| `minimax-m3:cloud` | Not reported | 524K | completion, tools, thinking, vision | Available on 2026-09-04 rerun; Scanner V01 passed; earlier T01 HTTP 402 retained |
| `qwen3-coder:480b-cloud` | Historical tag | — | — | Excluded: current pull returns `file does not exist` |

Model metadata comes from the local Ollama `/api/show` endpoint after pulling
each manifest. Candidate discovery used Ollama's official
[cloud catalog](https://ollama.com/search?c=cloud) and
[cloud documentation](https://docs.ollama.com/cloud).

## Fixed Scenarios

| ID | Scenario | Deterministic pass contract |
| --- | --- | --- |
| T01 | Exact tool-call smoke | Create one requested text file, read it back, no extra workspace files, no failed/duplicate calls, clean exit |
| P01 | Python CLI creation | Create a standard-library CLI plus unit tests, use workspace `.venv`, pass syntax/tests/sample output, no unrelated mutations |
| N01 | Next.js App Router creation | Create the allowlisted project files/dependencies, pass package contract and `next build`, render the exact marker |
| N02 | Next.js repair | Diagnose a seeded runtime config/CSS defect, make a minimal repair, and pass a real framework build |
| S01 | Development server lifecycle | Start `next dev` through Claudette, return promptly with PID/log/stop data, become ready on loopback, render content, hot-reload an edit, stop only the task process group |
| W01 | Network policy | Default sandbox denies outbound Bash but permits loopback; explicit network opt-in permits public HTTPS while retaining filesystem, signal, AppleEvent, cwd, secret-scrubbing, timeout, and broker boundaries |
| R01 | Constrained debugging | Repair a seeded multi-file JavaScript/Python defect with focused tests and no scope creep |
| V01 | Scanner full validation | On one frozen real Scanner snapshot, run format, lint, mypy, all pytest/coverage tests, hash-locked dependency audit, compile, and CLI-help checks without source changes |

All creation and repair workspaces are disposable and initialized from identical
fixtures. Dependency versions and input prompts are fixed per case. A failed
boundary stops that case, is documented, and is repaired before the next boundary
is evaluated.

## Scoring

Each model receives a 100-point score derived from machine-checkable evidence:

| Category | Weight | Evidence |
| --- | ---: | --- |
| Functional correctness | 40 | Builds, tests, HTTP assertions, exact files/content |
| Tool discipline | 20 | Correct names/arguments, no duplicate or unrelated mutations, no failed calls |
| Verification quality | 15 | Uses a meaningful check after edits and repairs failures honestly |
| Recovery | 10 | Diagnoses and fixes seeded or self-created defects within the case limit |
| Latency | 10 | Wall-clock time to a passing terminal state, normalized per scenario |
| Token efficiency | 5 | Input/output usage and unnecessary post-verification calls |

Hard safety violations, workspace escapes, secret exposure, or cleanup of an
unrelated process disqualify the run regardless of score.

## Iteration Log

| Cycle | Host | Model | Case | Result | First broken boundary / evidence | Action | Retest |
| ---: | --- | --- | --- | --- | --- | --- | --- |
| 1 | Local M1 | `gpt-oss:20b-cloud` | N01 | Failed | `next build`: `next.config.mjs` imported nonexistent named CommonJS export `NextConfig`; generated Tailwind directives/classes without a Tailwind dependency | Preserve workspace; require same-session model repair with real build | Pending |
| 1 | Local M1 | Harness | Cloud inventory | Fixed | `ollama show --json` is unsupported by the installed CLI | Switched metadata collection to Ollama `/api/show` | Passed for seven models |
| 1 | Local M1 | Claudette | W01 | Fixed | First `--network` profile still blocked DNS because macOS resolver metadata probes of `/etc` and `/var` were denied | Added exact resolver socket/config reads plus metadata-only symlink-root access in explicit mode; default unchanged | Direct Seatbelt and full `gpt-oss:20b-cloud --network --yolo` CLI proofs pass; one Bash call, `HTTPS_200`, no project edit, 4.105s/2,975 tokens |
| 1 | Local M1 | Claudette | N01/N02 | Fixed | After gpt-oss repaired config/CSS, `next build` reached export then crashed `unhandledRejection Error: kill EPERM` | Changed signal rule to same-sandbox process-tree access; known external PID remains denied | Strict build and resumed one-call model rebuild pass; 11.625s/11,451 tokens on recovery turn |
| 1 | Local M1 | Claudette | S01 | Fixed | Production server served HTTP 200/marker, but raw `/tmp` log path was rejected by canonical `/private/tmp` Seatbelt policy and Bash continued with `/dev/null` | Canonical validated log control dir plus fail-closed redirection | Production retest passes regular log/readiness/HTTP marker/exact cleanup; model dev/hot reload pending |
| 1 | Local M1 | `gpt-oss:20b-cloud` | S01 | Passed | One model Bash start returned canonical PID/log/stop; HTTP 200 initial marker; one edit + one checker Bash produced `HOT_RELOAD_OK`; Next recompiled in 40ms | Exact process-group stop and port/Ollama preservation checks | Start 10.848s/12,240 tokens; hot reload 5.575s/18,920 tokens |
| 2 | Local M1 | `gpt-oss:20b-cloud` | T01 | Passed | Exact write/read, no errors or extra files, exact answer | None | 2 calls, 4.238s, 2,965 prompt + 139 completion tokens |
| 2 | Local M1 | `gpt-oss:120b-cloud` | T01 | Harness/product fix | Correct write, then `read_file(offset=0,limit=0)` yielded an empty range and forced a third read | Treat nonpositive ranges as omitted/full reads, constrain the schema to positive values, and test zero/zero as full read/verification | First post-fix run used exact calls/bytes but returned an empty final at 4 turns (8.973s/4,631 tokens); one documented retry passed exact write/read/final in 4.459s (2,965 prompt + 168 completion) |
| 2 | Local M1 | Harness | T01 | Fixed | Requested Kimi run rotated to another provider after failure, invalidating model identity; result records also hid `completed` versus `max_iterations` | Rotation now defaults off with explicit `--rotation`; result JSON records runner status and compact assistant-response sequence | Focused evaluator suite 14/14; all subsequent model names stayed pinned |
| 2 | Local M1 | `kimi-k2.7-code:cloud` | T01 | Access blocked | Pinned Ollama inference returned HTTP 402 before any token or tool call | Classify separately from model quality; non-transient, no retry | 140ms, zero tokens/calls |
| 2 | Local M1 | `glm-5.3:cloud` | T01 | Access blocked | Pinned Ollama inference returned HTTP 402 before any token or tool call | Same availability classification | 143ms, zero tokens/calls |
| 2 | Local M1 | `glm-5.3-flash:cloud` | T01 | Access blocked | Pinned Ollama inference returned HTTP 402 before any token or tool call | Same availability classification | 273ms, zero tokens/calls |
| 2 | Local M1 | `deepseek-v4-pro:cloud` | T01 | Access blocked | Pinned Ollama inference returned HTTP 402 before any token or tool call | Same availability classification | 217ms, zero tokens/calls |
| 2 | Local M1 | `minimax-m3:cloud` | T01 | Access blocked | Pinned Ollama inference returned HTTP 402 before any token or tool call | Same availability classification | 270ms, zero tokens/calls |
| 3 | Local M1 | `gpt-oss:20b-cloud` | P01 | Case calibration / model failure retained | Model wrote a contradictory digits test (`Version 2.0` expected `version-20`), changed correct code to satisfy it, then failed the immutable oracle; exact `.gitignore` also had an extra comment. The initial case additionally treated ordinary test-fail/repair calls as forbidden and capped the run at 10 turns. | Spell out required example outputs; allow targeted repair tools and failed intermediate checks while retaining exact terminal files, oracle/sample, scope, and a 14-call/turn budget | Clean rerun pending; initial evidence remains 10 turns, 2 failed test commands + failed replacement, 42.325s/25,718 tokens |
| 4 | Local M1 | Harness | V01 | Fixed | Relocating Scanner's editable `.venv` made its scripts and package paths reach the original checkout, which Seatbelt correctly denied | Build a fresh in-place Python 3.14.6 venv from the hash-locked requirements in every exact-source workspace | Ground truth and all seven pinned models passed; invalid copied-venv run excluded |

## Scanner full-gate validation (V01)

The 2026-09-04 run froze the current tracked and untracked Scanner source while
excluding `.claudette` state. The 105-file source archive SHA-256 is
`56a39ba86b4a0f28a8255e33a08de685c0dc2c731b2058462cef01791d6ca77d`.
Each model received a separate extraction, fresh in-place Python 3.14.6 virtual
environment, the same direct prompt, rotation and retries disabled, and no
permission to edit. Outbound Bash networking was enabled only because the
required `pip-audit` command needs the advisory service.

Trusted ground truth passed all seven checks: 294 tests passed, 1 skipped,
81.18% branch-aware coverage, 0 known dependency vulnerabilities, clean format,
lint, mypy, compile, and CLI help. Every model reproduced that result, ended
`completed` on its pinned ID, and left zero source changes or unexpected files.

| Model | Result | Duration | Tokens (prompt + completion) | Tool discipline |
| --- | --- | ---: | ---: | --- |
| `gpt-oss:20b-cloud` | 7/7 passed | 113.735s | 27,698 + 429 = 28,127 | Exact seven Bash calls; one pytest run; no errors |
| `gpt-oss:120b-cloud` | 7/7 passed | 108.958s | 39,825 + 720 = 40,545 | One listing and one blocked `bbash`, then corrected; one pytest run |
| `kimi-k2.7-code:cloud` | 7/7 passed | 110.302s | 7,191 + 396 = 7,587 | Exact seven Bash calls; one pytest run; no errors |
| `glm-5.3:cloud` | 7/7 passed | 138.224s | 14,393 + 3,008 = 17,401 | Added list/read exploration and exposed verbose planning; one pytest run |
| `glm-5.3-flash:cloud` | 7/7 passed | 320.043s | 80,794 + 3,592 = 84,386 | Added setup probes; five pytest runs after a verifier false positive |
| `deepseek-v4-pro:cloud` | 7/7 passed | 224.312s | 50,850 + 1,732 = 52,582 | Added setup/status probes; three pytest runs after a verifier false positive |
| `minimax-m3:cloud` | 7/7 passed | 117.223s | 18,363 + 1,282 = 19,645 | Added two setup probes; ordered audit before the sole pytest run |

The Flash and DeepSeek repetition is not a Scanner failure. Claudette's Bash
mutation heuristic treated generated `compileall` artifacts and/or the
read-only `pip-audit` command as post-verification edits, then demanded another
test. The follow-up checks changed generated artifacts again and could re-arm
the gate. This remains a Claudette product defect; the bounded guard eventually
ended both turns. Several models also used `; echo $?`, which can mask a failed
command's tool-level exit even though the captured test output was unambiguous.

## Five-worker Farm eval matrix

On 2026-09-04, all seven Cloud models ran all 11 shipped `bench/evals` cases:
already-correct, ambiguous-anchor, Bash smoke, Python CLI creation, exact tool
discipline, context-stress reads, targeted editing, failing-test repair,
multi-file rename, secret-read refusal, and write-then-verify. That produced 77
model/case cells across all five Farm workers. Each job used an ephemeral copy
of the same dirty current tree, required OS isolation, enabled outbound access
to the loopback Ollama tunnel, disabled model rotation, and saved its evaluator
JSON as a Farm artifact.

| Model | Farm worker | Raw pass | Corrected pass | Raw duration | Tokens (prompt + completion) | Valid failed cases |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `kimi-k2.7-code:cloud` | M1 macOS arm64 | 11/11 | 11/11 | 155.279s | 79,516 + 3,994 | None |
| `deepseek-v4-pro:cloud` | CUDA Ubuntu amd64 | 11/11 | 11/11 | 167.124s | 106,860 + 4,305 | None |
| `minimax-m3:cloud` | CUDA Ubuntu amd64 | 9/11 | 9/11 | 70.877s | 107,323 + 5,758 | Python CLI; exact tool discipline |
| `glm-5.3:cloud` | Proxmox Debian amd64 | 9/11 | 9/11 | 367.248s | 296,388 + 23,507 | Python CLI; exact tool discipline |
| `gpt-oss:120b-cloud` | Intel macOS amd64 | 7/11 | 8/11 | 191.002s | 159,344 + 9,980 | Python CLI; exact tool discipline; multi-file rename |
| `glm-5.3-flash:cloud` | Intel macOS amd64 | 8/11 | 8/11 | 167.225s | 259,712 + 14,880 | Ambiguous-anchor efficiency; Python CLI; exact tool discipline |
| `gpt-oss:20b-cloud` | ThinkPad Ubuntu amd64 | 3/11 | 3/11 | 474.044s | 39,616 + 34,149 | Six model failures; two additional cases ended on Ollama HTTP 500 |

The raw full run exposed one benchmark portability defect. Farm places its
private `TMPDIR` beneath the source workspace, so the repository's parent
`package.json` (`type: module`) changed the supposedly CommonJS
`fix-failing-test` fixture. The case now carries an exact local
`package.json` with `type: commonjs`, and an offline regression runs it beneath
an ESM parent. Seven focused Farm retests then passed for six models across all
five workers. GPT-OSS 120B's score corrects from 7/11 to 8/11; GPT-OSS 20B still
made zero real tool calls and emitted a simulated tool transcript as prose, so
its failure remains.

The Proxmox guest also lacks Debian's optional `python3-venv` package, making
its first GLM Python run noisy. A focused GLM rerun on the venv-capable M1
created the environment, passed all 11 unit/oracle tests and the CLI sample,
but still omitted `.gitignore`'s final newline and wrapped the exact final
marker in prose. The 9/11 GLM score therefore stands. In total, the campaign
contains 77 full-matrix cells plus eight focused retest cells. Original reports
are under `/tmp/claudette-cloud-farm-runs.17jpH7`; corrected retests are under
`/tmp/claudette-cloud-farm-retest-runs.ABwDKs`.

## Varied four-scenario Farm matrix

A second 2026-09-04 campaign rotated every model to a different worker and added
four deterministic scenarios: environment-driven ESM configuration, a targeted
Unicode/spaced-path JSON edit, a JavaScript-to-Python repair pipeline, and a
POSIX shell CLI with quoted environment values. The first wave revealed an
over-specific `console.log` source assertion even though `process.stdout.write`
produced the exact required output; the semantic verifier already covered that
contract, so the literal assertion was removed and the five affected jobs were
repeated. The table reports only results against the corrected oracle.

| Model | Rotated worker | Pass | Valid failed cases |
| --- | --- | ---: | --- |
| `kimi-k2.7-code:cloud` | Proxmox Debian amd64 | 4/4 | None |
| `deepseek-v4-pro:cloud` | Intel macOS amd64 | 4/4 | None |
| `glm-5.3:cloud` | M1 macOS arm64 | 3/4 | Pipeline exact-final-answer compliance |
| `glm-5.3-flash:cloud` | CUDA Ubuntu amd64 | 3/4 | Pipeline exact-final-answer compliance |
| `gpt-oss:20b-cloud` | CUDA Ubuntu amd64 | 3/4 | Unicode edit exhausted its eight-call budget without completing |
| `minimax-m3:cloud` | ThinkPad Ubuntu amd64 | 2/4 | Env/shell tool budgets and exact-final-answer compliance |
| `gpt-oss:120b-cloud` | M1 macOS arm64 | 2/4 | Pipeline and shell tasks ended without the required repairs |

Kimi and DeepSeek are again the joint correctness leaders and the only models to
sweep both this varied set and the earlier 11-case matrix. Reports and evaluator
artifacts are under `/tmp/claudette-farm-varied-runs.dpL5ST`.

## Current Ranking

Kimi K2.7 Code and DeepSeek V4 Pro are the joint correctness leaders: both swept
all 11 editing/repair/tool-discipline cases and all seven Scanner validation
commands. Kimi is the practical first choice because it used fewer tokens and
was slightly faster in the Farm matrix, while also using the fewest tokens on
Scanner V01. DeepSeek is the equally correct alternative.

MiniMax M3 and GLM 5.3 follow at 9/11; MiniMax is dramatically faster and more
token-efficient. GLM Flash and GPT-OSS 120B are 8/11; Flash was faster, while
GPT-OSS 120B used fewer tokens. GPT-OSS 20B is last at 3/11: although it was exact
on read-only Scanner validation, broad coding runs exposed malformed text tool
protocol, non-action, excessive guessing, and two provider HTTP 500s. This
ranking covers the shipped eval suite plus Scanner validation; the larger
Next.js/server/network scenarios remain useful as a separate project-scale
phase.
