# Baton architecture

Baton is a local compute bridge: any agent CLI can be the **host**, and any other installed agent CLI can be the **worker**. The host hands a bounded coding task to a worker, watches it, answers its questions, and reads the result. There is no server and no extra API key; each worker uses its own login and subscription.

## Core design

```
Host agent ──shell──> baton start ──detached supervisor──> worker CLI
    │                     │ returns task_id at once         │ stream → events
    │                     ▼                                 │
    │             ~/.baton/tasks/<id>/  <── single writer ──┘
    │                     ▲
    └──shell/MCP──> baton wait / status / tail / reply / cancel
```

- **CLI + disk state + detached supervisor.** Task state lives under `~/.baton` (override with `BATON_HOME`). Closing the host session, restarting MCP, or closing the terminal does not stop the job.
- **MCP is a thin shell.** Every MCP tool calls the same functions as the CLI. MCP keeps no task state.
- **One writer per task.** Only the current supervisor writes `meta.json` and `events.jsonl`. Readers never write, except `cancel` and orphan finalization.
- **No total time cap by default.** Only an idle timeout (600s with no output). Optional `--max-duration` is per turn and resets on `reply`.
- **Turn-based interaction.** When the worker needs a choice, it emits a `BATON_DECISION` block, the process exits, and the task becomes `needs_input`. `baton reply` resumes the same session. Authors and prompts are stored under `turns/`.

## Task directory

```
~/.baton/tasks/<task_id>/
  meta.json          current state (atomic write)
  events.jsonl       uniform event stream
  turns/<n>.json     turn n: author, input, status, summary, git_changes
  raw/<n>.stdout.log raw worker stdout
  raw/<n>.stderr.log
  raw/<n>.check.log
```

Task ids are UUIDs; every id is validated before it is used in a path. Directories are `0700`, files `0600`. Nothing is deleted automatically; use `baton prune --older <days>`.

## Statuses and liveness

| Status | Meaning |
|---|---|
| `running` | In progress; includes `liveness` and `quiet_for_s` |
| `needs_input` | Worker asked a question; use `reply` |
| `success` | Turn finished |
| `scope_violation` / `readonly_violation` / `check_failed` | Post-check failed; `reply` allowed |
| `failed` / `timed_out` / `cancelled` | Terminal |
| `not_authenticated` / `quota_exceeded` / `not_installed` | Target CLI problem |

While `running`, `liveness` is `active` (output within 60s), `quiet` (alive but silent), or `orphaned` (supervisor gone; the next read finalizes as `failed`). If that meta already has `stop_reason` `idle` or `max_duration`, the read finalizes as `timed_out` with summary `Timed out: idle.` or `Timed out: max_duration.`. `stop_reason` `cancelled` finalizes as `cancelled` / `Cancelled.`. With no `stop_reason`, it still finalizes as `failed`.

## Workers and hosts

Delegation targets: `codex`, `claude`, `cursor`, `agy`. Gemini CLI works as a host (extension install) but is not a delegation target yet.

Each adapter maps Baton options onto the CLI's native flags (effort, read-only mode, stream format, resume). Unrecognized stream lines are kept as `raw` events, never dropped. Samples live in `test/fixtures/`.

Host install paths and which manifest each host reads are documented in [hosts.md](hosts.md).

## Safety

1. **No recursion:** workers get `BATON_DELEGATION=1`; a nested `baton start` is refused.
2. **Process groups:** timeouts and `cancel` kill the whole group (POSIX).
3. **Credential redaction:** events and summaries are redacted; full raw logs stay under `raw/` with `0600`.
4. **`--scope` is a mistake fence**, not a sandbox. Prefer a worktree for isolation.
5. **`--mode readonly`** maps to each CLI's read-only path and flags dirty trees after the turn.

## Tech stack

- TypeScript, Node ≥ 20.17 for published `dist/`; development and tests run `.ts` directly on Node ≥ 24.
- Runtime dependency: `@modelcontextprotocol/sdk`.
- Build: `tsc -p tsconfig.build.json` → `dist/`. Tests: `tsc --noEmit && node --test "test/**/*.test.ts"`.

## Related docs

- User overview: [README](../README.md)
- Full manual: [reference.md](reference.md)
- Host manifests: [hosts.md](hosts.md)
