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

## On Every Conversation Start

Before responding to the user:

1. Read `PERSIST.md` — all persistent state. Create from template if missing (see **New File Template**).
2. Read `README.md` only if project purpose is unclear from PERSIST.md.
3. Read relevant repo files based on context above (skip `venv/`, `__pycache__/`, `.git/`, and cache/build directories).

## After Every Significant Request

After completing any request that meaningfully changes the project:

- Append a row to the **History** section of `PERSIST.md` in this format: `| YYYY-MM-DD | <AgentName> | <one-line description> |`
  Only log significant actions — skip trivial queries or repeated lookups. **Trim to the 50 most recent rows** after appending.
- Update the **Context** section only if project structure or purpose changed. Overwrite stale lines rather than appending.

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
