# ccunpacked.dev Feature Audit

Source audited: https://ccunpacked.dev/  
Analysis date shown on the site: March 31, 2026

Inspection depth:
- Landing page content
- Expandable section payloads extracted from Astro bundles:
  - `/_astro/QueryLoopViz.B7aL0sQx.js`
  - `/_astro/ArchitectureExplorer.rgItpRGe.js`
  - `/_astro/ToolGrid.BPOFfeGU.js`
  - `/_astro/CommandExplorer.MPiqsZJj.js`
  - `/_astro/HiddenFeatures.BliHVrP8.js`

## What the site highlights

`ccunpacked.dev` is structured around five product areas:

1. `The Agent Loop`
   Input -> message assembly -> history -> system prompt -> API -> token accounting -> tool decision -> loop -> render -> hooks -> await.
2. `Architecture Explorer`
   A browsable source-tree explorer grouped by areas like tools, commands, UI, hooks, services, and skills.
3. `Tool System`
   A categorized tool catalog:
   File operations, execution, search/fetch, agents/tasks, planning, MCP, system, and experimental.
4. `Command Catalog`
   A large slash-command surface across setup, workflow, review/git, diagnostics, and experimental features.
5. `Hidden Features`
   Feature-flagged or unreleased ideas: Buddy, Kairos, UltraPlan, Coordinator Mode, Bridge, Daemon Mode, UDS Inbox, Auto-Dream.

## Expanded section details

### Agent loop

The site's expandable `Agent Loop` section resolves to these concrete steps:

1. `User Input`
   Input comes from Ink `TextInput`, or piped `stdin` in non-interactive mode.
2. `Message Creation`
   `createUserMessage()` wraps content into Anthropic message format with role, content blocks, and attachments.
3. `History Append`
   The user message is appended to the in-memory conversation array.
4. `System Prompt Assembly`
   The prompt is assembled from `CLAUDE.md`, tool definitions, context, and persistent memory.
5. `API Streaming`
   Requests stream through the Anthropic SDK over `SSE`.
6. `Token Parsing`
   Tokens are rendered immediately as they arrive.
7. `Tool Detection`
   Tool blocks are resolved, permission-checked, and can run in parallel.
8. `Tool Execution Loop`
   Tool outputs are appended to history and the API is called again.
9. `Response Rendering`
   Final markdown and code are rendered through Ink/Yoga.
10. `Post-Sampling Hooks`
   Auto-compaction, memory extraction, and optional dream mode run after completion.
11. `Await Next Input`
   The REPL idles for the next message and handles `Ctrl+C` gracefully.

Implementation implication for this repo:
- You already have steps `1-9` in simplified form.
- The highest-value missing pieces are explicit traceability, token accounting, hook stages, and better loop-state visibility in the browser.

### Architecture explorer

The expandable architecture view gives more precise subsystem ideas than the landing page summary:

- `utils`
  564 files. Includes permissions, bash safety analysis, model selection, plugin lifecycle, swarm logic, and computer-use helpers.
- `commands`
  189 files. The note in the site says this covers `95` command implementations.
- `tools`
  184 files. The site says `42` built-in tools plus `11` feature-gated tools registered in `tools.ts`.
- `services`
  130 files. Includes `mcp`, API clients, compaction, analytics, `lsp`, OAuth, and a streaming tool executor.
- `bridge`
  31 files. Remote-control infrastructure with permission sync, `JWT` auth, and `WebSocket` transport.
- `buddy`
  6 files. Terminal pet / easter egg.
- `tasks`
  12 files. Background task management for sub-agents.
- `memdir`
  8 files. Persistent memory storage across sessions.

Implementation implication for this repo:
- If you want your app to feel closer to the site, a good IA for your own explorer is:
  `UI`, `CLI`, `Server`, `Tools`, `Sessions`, `Context`, `Automation`, `Memory`.

### Tool system

The expandable tool cards add exact behavior worth copying into this repo's design.

High-value tool behaviors:

- `FileRead`
  Supports line ranges and handles text/binary reading with permission boundaries.
- `FileEdit`
  Requires a unique exact match for targeted replacement.
- `FileWrite`
  Full-file writes, not patch semantics.
- `Glob`
  Workspace glob search with `.gitignore` awareness.
- `Grep`
  Regex search with include filters and file:line output.
- `Bash`
  Runs in the user shell with destructive-command safety analysis.
- `WebFetch`
  Fetches a URL, converts HTML to markdown, then runs a small model prompt over that content.
- `WebSearch`
  Structured web search when current information is needed.
- `Agent`
  Spawns an independent sub-agent with its own context.
- `SendMessage`
  Cross-agent communication through Unix domain sockets.
- `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` / `TaskStop`
  First-class background task system.
- `EnterPlanMode` / `ExitPlanMode`
  Explicit planning lifecycle before execution.
- `EnterWorktree` / `ExitWorktree`
  Safe experimentation in git worktrees.
- `ListMcpResources` / `ReadMcpResource` / `McpAuth`
  MCP integration is modeled as a core tool category.
- `TodoWrite`
  Persistent structured to-do tracking.
- `Skill`
  Specialized behavior loaded from `SKILL.md`.
- `Snip`
  Context trimming / compaction.
- `LSP`
  Type info, definitions, references, diagnostics.
- `Monitor`
  Streams events from background processes.

Implementation implication for this repo:
- Immediate additions that map well to your codebase:
  `patch_file`, `list_dir`, `search_code` via `rg`, `fetch_url`, `todo_write`, `plan_mode`, and later `task_*`.

### Command catalog

The expandable command cards reveal which commands are substantial versus stubs.

Commands with directly reusable product ideas:

- `/init`
  Scans the repo and generates a project instruction file.
- `/permissions`
  Uses a three-layer permission model: `deny`, `check`, `prompt`.
- `/doctor`
  Runs health checks on API connectivity, auth, git, shell, and project setup.
- `/compact`
  Replaces full history with a summary when context gets large.
- `/memory`
  Manages persistent memory files across user, project, and session scope.
- `/context`
  Visualizes context usage.
- `/plan`
  Toggles plan mode and can resume saved plans.
- `/files`
  Lists files currently in context with token counts and staleness.
- `/tasks`
  Manages background tasks and parallel work.
- `/review`
  Uses GitHub PR data and structured review categories.
- `/commit`
  Generates commit messages from changes.
- `/diff`
  Shows working-tree and per-turn diffs.
- `/status`, `/stats`, `/cost`, `/usage`
  Observability and usage reporting.
- `/debug-tool-call`
  Replays a previous tool call with inputs, raw output, timing, and errors.
- `/sandbox`
  Configures command sandboxing.
- `/plugin`, `/reload-plugins`, `/mcp`
  Extension model is first class.
- `/btw`
  Side-question workflow while the main task continues.
- `/rename`
  Rename the session explicitly.

Commands the site marks as disabled or hidden:
- `/onboarding`, `/autofix-pr`, `/ctx_viz`, `/perf-issue`, `/teleport`, `/good-claude`, `/env`, `/bughunter`, and several other diagnostics.

Implementation implication for this repo:
- Your current command set is minimal. The best next tranche is:
  `/status`, `/doctor`, `/tools`, `/context`, `/files`, `/plan`, `/review`, `/rename`.

### Hidden features

The expandable hidden-feature cards include technical details and source-file references:

- `Buddy`
  Terminal pet with sprites, animations, speech bubbles, personality traits, and rarity tiers.
- `Kairos`
  Memory consolidation between sessions plus proactive background actions via `SleepTool`.
- `UltraPlan`
  Long-running deep planning sessions with progress polling.
- `Coordinator Mode`
  Lead agent decomposes tasks and spawns workers in isolated git worktrees.
- `Bridge`
  Remote control from phone/browser with `WebSocket` permission sync and `JWT` auth.
- `Daemon Mode`
  Background sessions via `tmux`.
- `UDS Inbox`
  Session-to-session messaging over Unix domain sockets.
- `Auto-Dream`
  Post-session review that extracts durable memory into `memdir/`.

The site also marks relationships between them:
- `Kairos <-> Auto-Dream`
  Memory system.
- `Daemon Mode <-> UDS Inbox`
  Background execution.
- `Coordinator Mode <-> UltraPlan`
  Multi-agent planning.
- `Bridge <-> Daemon Mode`
  Remote plus persistence.

Implementation implication for this repo:
- The realistic subset to copy is `Auto-Dream-lite`, `Daemon/background jobs`, and eventually `Coordinator-lite`.

## Current app baseline

This repo already has a smaller version of the same core idea:

- Browser app with sessions, model picker, streamed assistant output, and `@file` expansion.
- Local CLI with a real agent loop in [src/chat.js](/home/frank/Code/test/src/chat.js).
- Tool calling in [src/tools.js](/home/frank/Code/test/src/tools.js) with `bash`, `read_file`, `write_file`, `str_replace`, `glob`, and `grep`.
- Session persistence and a simple Ollama-backed chat server in [server.js](/home/frank/Code/test/server.js).

The app is closest to the `Agent Loop` section already. The biggest gaps are introspection, tool breadth, slash-command breadth, and multi-agent/planning features.

## Gap analysis

### 1. Agent loop visibility

Site feature:
- The site makes the execution lifecycle explicit and inspectable step by step.

Current repo:
- The lifecycle exists in code, but the browser UI only shows streamed text plus file expansion metadata.

Implementation targets:
- Add evented agent-loop tracing in the CLI and server.
- Persist per-turn trace events such as `input_received`, `files_expanded`, `system_prompt_built`, `model_request_started`, `tool_called`, `tool_result`, `assistant_completed`.
- Render a timeline panel in the browser for each message turn.
- Show token counts, iteration count, and elapsed time.

Recommended priority: `P0`

### 2. Architecture explorer

Site feature:
- A navigable map of the codebase organized by subsystem.

Current repo:
- No repo explorer or architecture view in the app.

Implementation targets:
- Add a file-tree API rooted at the workspace.
- Group files into product buckets such as `UI`, `Server`, `CLI`, `Tools`, `Sessions`, `Context`.
- Add a browser sidebar tab for architecture exploration.
- Show file summaries, line counts, and quick-open previews.

Recommended priority: `P2`

### 3. Tool system expansion

Site feature:
- Broad tool coverage, especially around search/fetch, planning, MCP, and agents.

Current repo:
- Only six tools, all local and single-agent.

Implementation targets:
- Add `list_dir` or `tree` style browsing for cleaner directory exploration.
- Add `fetch_url` for non-browser HTTP fetches.
- Add structured `search_code` backed by `rg` instead of plain `grep`.
- Add `patch_file` so the model can make more controlled edits than `write_file` and `str_replace`.
- Add notebook or markdown-aware editing later if needed.
- Introduce a tool registry with categories and JSON schemas surfaced in the UI.

Recommended priority: `P0`

### 4. Slash-command surface

Site feature:
- Commands are a major part of the product, not a thin helper layer.

Current repo:
- `/help`, `/new`, `/models`, `/model`, `/sessions`, `/use`, `/clear`.

Implementation targets:
- Session/workflow: `/status`, `/cwd`, `/context`, `/files`, `/summary`, `/rename`.
- Tooling: `/tools`, `/tool <name>`, `/permissions`.
- Planning: `/plan`, `/todos`, `/review`.
- Diagnostics: `/stats`, `/usage`, `/env`, `/debug-tool-call`.
- Browser parity for common CLI commands.

Recommended priority: `P1`

### 5. Planning mode

Site feature:
- Dedicated planning behavior and plan verification appear as first-class capabilities.

Current repo:
- No explicit plan mode, task list, or verification loop.

Implementation targets:
- Add a plan state machine to sessions.
- Support `plan` items with statuses like `pending`, `in_progress`, `done`.
- Let the assistant switch between planning and execution modes.
- Display the current plan in the browser and CLI.

Recommended priority: `P1`

### 6. Multi-agent orchestration

Site feature:
- Agents/tasks/teams/coordinator mode are central to the advanced story.

Current repo:
- Single agent only.

Implementation targets:
- Start with lightweight subtask spawning inside one process.
- Represent child tasks as isolated session branches.
- Add a simple coordinator that can issue subtasks and merge outputs.
- Delay true worktree isolation until the local tool model is reliable.

Recommended priority: `P2`

### 7. MCP and integrations

Site feature:
- MCP resources and auth are part of the core tool model.

Current repo:
- No integration layer beyond Ollama.

Implementation targets:
- Define an MCP adapter interface.
- Start with read-only MCP listing and resource reads.
- Surface external resources in the same tool registry as local tools.

Recommended priority: `P2`

### 8. Hidden-feature equivalents worth copying

Most of the site's hidden features are too large for this codebase right now. The practical ones are:

- `Daemon/background session mode`
  Run long tasks detached and let the browser poll status.
- `Bridge`
  Expose browser approval flows for CLI tool calls.
- `Kairos-lite`
  Summarize closed sessions into compact memory notes.

Recommended priority: `P3`

## Best next features for this repo

If the goal is to make this app feel meaningfully closer to what `ccunpacked.dev` describes, the highest-leverage sequence is:

1. `Agent trace timeline`
   This makes the existing loop legible and differentiates the app immediately.
2. `Tool registry + better local tools`
   Add `patch_file`, `search_code`, `list_dir`, and `fetch_url`.
3. `Plan mode`
   Introduce visible plans and task statuses before attempting multi-agent work.
4. `Command expansion`
   Add `/status`, `/tools`, `/plan`, `/context`, `/review`.
5. `Background jobs`
   Support longer-running actions and status polling.

## Concrete backlog

### P0

- Instrument the agent loop in [src/chat.js](/home/frank/Code/test/src/chat.js) and server streaming in [server.js](/home/frank/Code/test/server.js).
- Add trace event persistence to session JSON.
- Extend [src/tools.js](/home/frank/Code/test/src/tools.js) with `patch_file`, `search_code`, `list_dir`, and `fetch_url`.
- Add a browser transcript sidebar or drawer for per-turn trace details in [public/index.html](/home/frank/Code/test/public/index.html) and [public/app.js](/home/frank/Code/test/public/app.js).

### P1

- Add plan-mode session state and rendering.
- Expand slash commands in [src/chat.js](/home/frank/Code/test/src/chat.js).
- Add status and tool metadata endpoints in [server.js](/home/frank/Code/test/server.js).

### P2

- Add architecture explorer APIs and UI.
- Add basic subtask orchestration and child sessions.
- Add MCP adapter scaffolding.

### P3

- Add background task execution and polling.
- Add session memory compaction.
- Add remote approval flows.

## Notes

- The site is an unofficial analysis artifact, not a product spec. It is useful as a feature map, but some details may be incomplete or outdated.
- The page itself states it is based on public source analysis and may contain mistakes or stale details.
