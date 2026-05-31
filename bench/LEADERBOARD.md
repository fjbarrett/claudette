# Benchmark Leaderboard

Generated: 2026-04-18T14:20:25.424Z

Latest result per `(model, task)` from `bench/runs/reports/*.json`.

## Model Summary

| Model | Tasks | Avg Overall | Avg Hard | >=9 | 6-8.9 | <6 |
|-------|------:|------------:|---------:|----:|------:|---:|
| `deepseek-coder-v2:16b` | 15 | 8.7 | 9.3 | 11 | 2 | 2 |
| `qwen3.5:0.8b` | 6 | 8.3 | 8.3 | 5 | 0 | 1 |
| `qwen2.5-coder:14b` | 14 | 8.1 | 8.9 | 8 | 4 | 2 |
| `qwen2.5-coder:7b` | 3 | 5.8 | 6.9 | 0 | 1 | 2 |
| `gemma4:latest` | 8 | 5.2 | 5.2 | 1 | 1 | 6 |
| `gemma3:1b` | 3 | 3.9 | 3.9 | 0 | 0 | 3 |
| `qwen2.5-coder:32b` | 3 | 3.8 | 3.8 | 0 | 0 | 3 |
| `llama3:8b` | 6 | 3.7 | 3.7 | 0 | 0 | 6 |
| `llama3.2:1b` | 2 | 2.8 | 2.8 | 0 | 0 | 2 |

## Latest Scores By Task

| Task | `deepseek-coder-v2:16b` | `qwen3.5:0.8b` | `qwen2.5-coder:14b` | `qwen2.5-coder:7b` | `gemma4:latest` | `gemma3:1b` | `qwen2.5-coder:32b` | `llama3:8b` | `llama3.2:1b` |
|------|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `add-fetch-timeout` | 10.0 | 10.0 | 9.2 |  | 5.3 |  |  | 5.3 |  |
| `add-new-tool` | 8.9 | 9.5 | 8.9 |  | 4.5 | 4.5 |  | 3.5 | 3.5 |
| `add-no-color-flag` | 10.0 |  | 9.2 | 8.8 |  |  |  |  |  |
| `add-status-endpoint` | 10.0 |  | 6.0 |  |  |  |  |  |  |
| `admin-hardening` |  |  |  |  | 10.0 |  |  |  |  |
| `count-lines-tool` | 5.3 |  | 3.6 | 5.3 |  |  |  |  |  |
| `edit-two-timeouts` | 10.0 |  | 8.5 |  |  |  |  |  |  |
| `extract-print-help` | 4.0 |  | 3.2 | 3.2 |  |  |  |  |  |
| `fullstack-nextjs-postgres` | 9.2 |  |  |  |  |  |  |  |  |
| `health-check-script` | 10.0 |  | 8.8 |  |  |  |  |  |  |
| `limit-context-depth` | 9.2 | 10.0 | 9.2 |  | 5.3 |  |  | 5.3 |  |
| `permission-prompt-shortcut` |  |  |  |  | 7.0 |  |  |  |  |
| `session-error-handling` | 6.8 |  | 10.0 |  |  |  |  |  |  |
| `subdir-workflow` | 9.0 | 0.0 | 9.0 |  | 2.0 |  | 3.0 | 2.0 |  |
| `targeted-edit` | 9.2 | 10.0 | 9.2 |  | 5.3 | 5.3 | 5.3 | 5.3 |  |
| `tool-roundtrip-test` | 10.0 |  | 10.0 |  |  |  |  |  |  |
| `write-and-run` | 9.2 | 10.0 | 9.2 |  | 2.0 | 2.0 | 3.0 | 1.0 | 2.0 |

## Coverage Notes

- `deepseek-coder-v2:16b`: 15 tasks covered; latest low-score tasks: extract-print-help (4.0), count-lines-tool (5.3).
- `qwen3.5:0.8b`: 6 tasks covered; latest low-score tasks: subdir-workflow (0.0).
- `qwen2.5-coder:14b`: 14 tasks covered; latest low-score tasks: extract-print-help (3.2), count-lines-tool (3.6).
- `qwen2.5-coder:7b`: 3 tasks covered; latest low-score tasks: extract-print-help (3.2), count-lines-tool (5.3).
- `gemma4:latest`: 8 tasks covered; latest low-score tasks: subdir-workflow (2.0), write-and-run (2.0), add-new-tool (4.5).
- `gemma3:1b`: 3 tasks covered; latest low-score tasks: write-and-run (2.0), add-new-tool (4.5), targeted-edit (5.3).
- `qwen2.5-coder:32b`: 3 tasks covered; latest low-score tasks: subdir-workflow (3.0), write-and-run (3.0), targeted-edit (5.3).
- `llama3:8b`: 6 tasks covered; latest low-score tasks: write-and-run (1.0), subdir-workflow (2.0), add-new-tool (3.5).
- `llama3.2:1b`: 2 tasks covered; latest low-score tasks: write-and-run (2.0), add-new-tool (3.5).

## Source Reports

| Model | Task | Overall | Hard | Judge | Report |
|-------|------|--------:|-----:|------:|--------|
| `deepseek-coder-v2:16b` | `add-fetch-timeout` | 10.0 | 10.0 | n/a | `2026-04-17T22-18-33-522Z-add-fetch-timeout-deepseek-coder-v2-16b.json` |
| `deepseek-coder-v2:16b` | `add-new-tool` | 8.9 | 9.5 | 8 | `2026-04-17T22-19-19-903Z-add-new-tool-deepseek-coder-v2-16b.json` |
| `deepseek-coder-v2:16b` | `add-no-color-flag` | 10.0 | 10.0 | n/a | `2026-04-18T13-07-17-861Z-add-no-color-flag-deepseek-coder-v2-16b.json` |
| `deepseek-coder-v2:16b` | `add-status-endpoint` | 10.0 | 10.0 | n/a | `2026-04-17T22-35-56-457Z-add-status-endpoint-deepseek-coder-v2-16b.json` |
| `deepseek-coder-v2:16b` | `count-lines-tool` | 5.3 | 5.3 | n/a | `2026-04-18T13-00-04-890Z-count-lines-tool-deepseek-coder-v2-16b.json` |
| `deepseek-coder-v2:16b` | `edit-two-timeouts` | 10.0 | 10.0 | n/a | `2026-04-17T22-33-58-373Z-edit-two-timeouts-deepseek-coder-v2-16b.json` |
| `deepseek-coder-v2:16b` | `extract-print-help` | 4.0 | 5.3 | 2 | `2026-04-18T13-04-14-662Z-extract-print-help-deepseek-coder-v2-16b.json` |
| `deepseek-coder-v2:16b` | `fullstack-nextjs-postgres` | 9.2 | 10.0 | 8 | `2026-04-17T22-27-37-936Z-fullstack-nextjs-postgres-deepseek-coder-v2-16b.json` |
| `deepseek-coder-v2:16b` | `health-check-script` | 10.0 | 10.0 | n/a | `2026-04-17T22-39-33-084Z-health-check-script-deepseek-coder-v2-16b.json` |
| `deepseek-coder-v2:16b` | `limit-context-depth` | 9.2 | 10.0 | 8 | `2026-04-17T22-19-52-528Z-limit-context-depth-deepseek-coder-v2-16b.json` |
| `deepseek-coder-v2:16b` | `session-error-handling` | 6.8 | 10.0 | 2 | `2026-04-17T22-37-58-438Z-session-error-handling-deepseek-coder-v2-16b.json` |
| `deepseek-coder-v2:16b` | `subdir-workflow` | 9.0 | 9.7 | 8 | `2026-04-17T22-20-08-692Z-subdir-workflow-deepseek-coder-v2-16b.json` |
| `deepseek-coder-v2:16b` | `targeted-edit` | 9.2 | 10.0 | 8 | `2026-04-17T22-20-25-286Z-targeted-edit-deepseek-coder-v2-16b.json` |
| `deepseek-coder-v2:16b` | `tool-roundtrip-test` | 10.0 | 10.0 | n/a | `2026-04-18T00-21-43-088Z-tool-roundtrip-test-deepseek-coder-v2-16b.json` |
| `deepseek-coder-v2:16b` | `write-and-run` | 9.2 | 10.0 | 8 | `2026-04-17T22-20-31-833Z-write-and-run-deepseek-coder-v2-16b.json` |
| `gemma3:1b` | `add-new-tool` | 4.5 | 4.5 | n/a | `2026-04-17T17-00-34-217Z-add-new-tool-gemma3-1b.json` |
| `gemma3:1b` | `targeted-edit` | 5.3 | 5.3 | n/a | `2026-04-17T16-40-05-435Z-targeted-edit-gemma3-1b.json` |
| `gemma3:1b` | `write-and-run` | 2.0 | 2.0 | n/a | `2026-04-17T16-38-31-027Z-write-and-run-gemma3-1b.json` |
| `gemma4:latest` | `add-fetch-timeout` | 5.3 | 5.3 | n/a | `2026-04-17T16-35-39-762Z-add-fetch-timeout-gemma4-latest.json` |
| `gemma4:latest` | `add-new-tool` | 4.5 | 4.5 | n/a | `2026-04-17T16-35-40-852Z-add-new-tool-gemma4-latest.json` |
| `gemma4:latest` | `admin-hardening` | 10.0 | 10.0 | n/a | `2026-04-10T01-09-24-690Z-admin-hardening-gemma4-latest.json` |
| `gemma4:latest` | `limit-context-depth` | 5.3 | 5.3 | n/a | `2026-04-17T16-35-41-970Z-limit-context-depth-gemma4-latest.json` |
| `gemma4:latest` | `permission-prompt-shortcut` | 7.0 | 7.0 | n/a | `2026-04-10T01-13-08-379Z-permission-prompt-shortcut-gemma4-latest.json` |
| `gemma4:latest` | `subdir-workflow` | 2.0 | 2.0 | n/a | `2026-04-17T16-35-52-849Z-subdir-workflow-gemma4-latest.json` |
| `gemma4:latest` | `targeted-edit` | 5.3 | 5.3 | n/a | `2026-04-17T16-36-04-001Z-targeted-edit-gemma4-latest.json` |
| `gemma4:latest` | `write-and-run` | 2.0 | 2.0 | n/a | `2026-04-17T16-36-05-148Z-write-and-run-gemma4-latest.json` |
| `llama3:8b` | `add-fetch-timeout` | 5.3 | 5.3 | n/a | `2026-04-17T16-35-48-079Z-add-fetch-timeout-llama3-8b.json` |
| `llama3:8b` | `add-new-tool` | 3.5 | 3.5 | n/a | `2026-04-17T17-00-34-204Z-add-new-tool-llama3-8b.json` |
| `llama3:8b` | `limit-context-depth` | 5.3 | 5.3 | n/a | `2026-04-17T16-35-50-364Z-limit-context-depth-llama3-8b.json` |
| `llama3:8b` | `subdir-workflow` | 2.0 | 2.0 | n/a | `2026-04-17T16-36-01-731Z-subdir-workflow-llama3-8b.json` |
| `llama3:8b` | `targeted-edit` | 5.3 | 5.3 | n/a | `2026-04-17T16-36-13-041Z-targeted-edit-llama3-8b.json` |
| `llama3:8b` | `write-and-run` | 1.0 | 1.0 | n/a | `2026-04-17T16-46-13-112Z-write-and-run-llama3-8b.json` |
| `llama3.2:1b` | `add-new-tool` | 3.5 | 3.5 | n/a | `2026-04-17T17-00-34-210Z-add-new-tool-llama3.2-1b.json` |
| `llama3.2:1b` | `write-and-run` | 2.0 | 2.0 | n/a | `2026-04-17T16-38-31-021Z-write-and-run-llama3.2-1b.json` |
| `qwen2.5-coder:14b` | `add-fetch-timeout` | 9.2 | 10.0 | 8 | `2026-04-17T22-20-41-698Z-add-fetch-timeout-qwen2.5-coder-14b.json` |
| `qwen2.5-coder:14b` | `add-new-tool` | 8.9 | 9.5 | 8 | `2026-04-17T22-20-49-344Z-add-new-tool-qwen2.5-coder-14b.json` |
| `qwen2.5-coder:14b` | `add-no-color-flag` | 9.2 | 10.0 | 8 | `2026-04-18T13-08-54-837Z-add-no-color-flag-qwen2.5-coder-14b.json` |
| `qwen2.5-coder:14b` | `add-status-endpoint` | 6.0 | 6.0 | n/a | `2026-04-18T00-09-10-465Z-add-status-endpoint-qwen2.5-coder-14b.json` |
| `qwen2.5-coder:14b` | `count-lines-tool` | 3.6 | 5.3 | 1 | `2026-04-18T13-02-12-783Z-count-lines-tool-qwen2.5-coder-14b.json` |
| `qwen2.5-coder:14b` | `edit-two-timeouts` | 8.5 | 9.5 | 7 | `2026-04-18T00-06-40-065Z-edit-two-timeouts-qwen2.5-coder-14b.json` |
| `qwen2.5-coder:14b` | `extract-print-help` | 3.2 | 5.3 | 0 | `2026-04-18T13-06-13-155Z-extract-print-help-qwen2.5-coder-14b.json` |
| `qwen2.5-coder:14b` | `health-check-script` | 8.8 | 10.0 | 7 | `2026-04-18T00-13-03-857Z-health-check-script-qwen2.5-coder-14b.json` |
| `qwen2.5-coder:14b` | `limit-context-depth` | 9.2 | 10.0 | 8 | `2026-04-17T22-20-55-596Z-limit-context-depth-qwen2.5-coder-14b.json` |
| `qwen2.5-coder:14b` | `session-error-handling` | 10.0 | 10.0 | n/a | `2026-04-18T00-12-25-835Z-session-error-handling-qwen2.5-coder-14b.json` |
| `qwen2.5-coder:14b` | `subdir-workflow` | 9.0 | 9.7 | 8 | `2026-04-17T22-21-12-485Z-subdir-workflow-qwen2.5-coder-14b.json` |
| `qwen2.5-coder:14b` | `targeted-edit` | 9.2 | 10.0 | 8 | `2026-04-17T22-21-27-438Z-targeted-edit-qwen2.5-coder-14b.json` |
| `qwen2.5-coder:14b` | `tool-roundtrip-test` | 10.0 | 10.0 | n/a | `2026-04-18T00-18-17-570Z-tool-roundtrip-test-qwen2.5-coder-14b.json` |
| `qwen2.5-coder:14b` | `write-and-run` | 9.2 | 10.0 | 8 | `2026-04-17T22-21-34-197Z-write-and-run-qwen2.5-coder-14b.json` |
| `qwen2.5-coder:32b` | `subdir-workflow` | 3.0 | 3.0 | n/a | `2026-04-17T13-49-02-632Z-subdir-workflow-qwen2.5-coder-32b.json` |
| `qwen2.5-coder:32b` | `targeted-edit` | 5.3 | 5.3 | n/a | `2026-04-17T13-44-12-653Z-targeted-edit-qwen2.5-coder-32b.json` |
| `qwen2.5-coder:32b` | `write-and-run` | 3.0 | 3.0 | n/a | `2026-04-17T13-39-08-403Z-write-and-run-qwen2.5-coder-32b.json` |
| `qwen2.5-coder:7b` | `add-no-color-flag` | 8.8 | 10.0 | 7 | `2026-04-18T13-09-23-158Z-add-no-color-flag-qwen2.5-coder-7b.json` |
| `qwen2.5-coder:7b` | `count-lines-tool` | 5.3 | 5.3 | n/a | `2026-04-18T13-03-13-980Z-count-lines-tool-qwen2.5-coder-7b.json` |
| `qwen2.5-coder:7b` | `extract-print-help` | 3.2 | 5.3 | 0 | `2026-04-18T13-06-52-293Z-extract-print-help-qwen2.5-coder-7b.json` |
| `qwen3.5:0.8b` | `add-fetch-timeout` | 10.0 | 10.0 | n/a | `2026-04-17T19-11-47-752Z-add-fetch-timeout-qwen3.5-0.8b.json` |
| `qwen3.5:0.8b` | `add-new-tool` | 9.5 | 9.5 | n/a | `2026-04-17T19-12-33-934Z-add-new-tool-qwen3.5-0.8b.json` |
| `qwen3.5:0.8b` | `limit-context-depth` | 10.0 | 10.0 | n/a | `2026-04-17T19-13-20-241Z-limit-context-depth-qwen3.5-0.8b.json` |
| `qwen3.5:0.8b` | `subdir-workflow` | 0.0 | 0.0 | n/a | `2026-04-17T19-14-08-638Z-subdir-workflow-qwen3.5-0.8b.json` |
| `qwen3.5:0.8b` | `targeted-edit` | 10.0 | 10.0 | n/a | `2026-04-17T17-26-14-164Z-targeted-edit-qwen3.5-0.8b.json` |
| `qwen3.5:0.8b` | `write-and-run` | 10.0 | 10.0 | n/a | `2026-04-17T17-26-15-216Z-write-and-run-qwen3.5-0.8b.json` |
