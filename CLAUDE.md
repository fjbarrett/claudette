# agent-starter

Drop-in configuration for CLI AI agent sessions. Gives agents a single persistent file for history, context, commands, and tasks — loaded automatically at session start.

## Approach

- Think before acting. Read existing files before writing code.
- Be concise in output but thorough in reasoning.
- Prefer editing over rewriting whole files.
- Do not re-read files you have already read unless the file may have changed.
- Test your code before declaring done.
- No sycophantic openers or closing fluff.
- Keep solutions simple and direct.
- User instructions always override this file.

## File Storage

All persistent agent state is stored in `PERSIST.md` at the project root.
Active, in-progress handoff state is stored in `CONTINUE.md`.

## On Every Conversation Start

Before responding to the user:

1. Read `CONTINUE.md` if it exists. It is the authoritative handoff for an interrupted active task.
2. Read `PERSIST.md` — all persistent state. Create from template if missing (see **New File Template**).
3. Read `README.md` only if project purpose is unclear from PERSIST.md.
4. Read relevant repo files based on context above (skip `venv/`, `__pycache__/`, `.git/`, and cache/build directories).

## During Active Work

- Keep `CONTINUE.md` current with the active objective, branch/PR state, completed work, remaining steps, verification status, and any files that must be preserved.
- Update its tool-call log for every tool call: record the intended action before the call and its result on the next update.
- Also update the broader handoff after meaningful progress or before any likely interruption so a new CLI session can resume without reconstructing context.
- When the active task is complete, replace its contents with a short completed-state handoff or remove stale task details.

## After Every Significant Request

After completing any request that meaningfully changes the project:

- Append a row to the **History** section of `PERSIST.md` in this format: `| YYYY-MM-DD | <AgentName> | <one-line description> |`
  Only log significant actions — skip trivial queries or repeated lookups. **Trim to the 50 most recent rows** after appending.
- Update the **Context** section only if project structure or purpose changed. Overwrite stale lines rather than appending.

## Git Commits

Record the exact model(s) that authored the change in every commit message, so a
later debugging session can see which model wrote what. Add a trailer with the
precise model id/version (not a generic name), e.g.:

```
Model: claude-opus-4-8[1m]
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

If multiple models collaborated on one commit, list a trailer line for each.

## When Building Commands or Scripts

Add useful commands, flags, or invocations to the **Commands** section of `PERSIST.md` with a short description. Remove entries that are no longer valid.

## When Discussing New Features

Add new feature ideas or plans to the **TODO** section of `PERSIST.md` with enough detail to act on later. Remove completed or abandoned items.

## New File Template

When creating `PERSIST.md` for the first time, initialize it with the following sections:

```markdown
# PERSIST

---

## Context

**Last Updated:** YYYY-MM-DD
**Stage:** <current stage>
**Purpose:** <one line>
**Structure:**
<file tree>

---

## History

| Date | Agent | Action |
| ---- | ----- | ------ |

---

## Commands

| Command | Description |
| ------- | ----------- |

---

## TODO

**Outstanding Tasks:**

**Feature Ideas:**
```

## Token Efficiency

- Write entries in `PERSIST.md` as tightly as possible — one line per fact, no filler.
- Do not re-read files already in context.
- Prefer editing existing lines over appending when the information supersedes what's already there.
