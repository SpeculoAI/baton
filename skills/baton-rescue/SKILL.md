---
name: baton-rescue
description: >-
  Hands a bounded coding task to another local agent CLI (codex, claude,
  cursor, agy) through the baton CLI, waits in bounded steps, answers its
  questions, and relays the result. Use proactively when implementation,
  debugging, or a second pass should run in another agent environment, when
  the user says rescue or asks to hand work to Codex, Claude, Agy, or Cursor,
  and when a baton task is waiting in needs_input.
---

# Baton Rescue

Hand one bounded piece of work to another local CLI. The work runs in its own detached process with its state on disk under `~/.baton`, so it survives this session, an MCP restart, or a closed terminal. You drive it with short shell commands. Do not finish the work yourself.

For splitting into several jobs, dependencies, or fail-over: use `baton-orchestrate`.

## The command

Every command prints one JSON object. Call it as `baton <command> ...`. If `baton` is not on PATH, run `/baton:setup` and stop.

The same operations also exist as MCP tools (`delegate_task`, `task_wait`, `task_result`, `task_diff`, `task_apply`, `task_reply`, `task_status`, `task_cancel`, `task_list`, `list_agents`). Use MCP only when the host cannot run shell commands; the behavior is identical.

## When to delegate

Delegate:

- An implementation, a debug pass, or a second try in another agent environment
- The user says rescue, hand off, or names another vendor

Stay in the current session:

- One or two small edits, explaining the current diff, or answering a question
- `baton agents` fails or lists nothing installed: tell the user, then stop

## Who to send it to

If the user names a target, use it: `codex`, `claude`, `cursor`, `agy`.

If not named, use `codex`. If the current session is already Codex, use `claude`. Never delegate to the vendor you are already running as. Say which target you picked before you start.

## Start

```
baton start --target <t> --prompt "<self-contained task>" [--file <path>...] [--effort low|medium|high|ultra] [--model <id>] [--idle-timeout <s>] [--max-duration <s>] [--cwd <dir>] [--scope <glob>...] [--scope-on-violation warn|fail] [--mode readonly|write] [--isolate] [--allow-dirty] [--rules check|pointer|off] [--check "<cmd>"]
```

- The prompt states done criteria and which files to look at. Long prompts can come on stdin instead of `--prompt`.
- `--effort low` suits mechanical subtasks; it maps to each CLI's native flag.
- `--model <id>` (Cursor, Codex and Claude): per-task model; kept across `reply`. Codex gets `-m <id>` and still takes `--effort`. Claude takes an id or alias (`sonnet`, `opus`) and still takes `--effort`. Cursor does not accept `--effort` at all (with or without `--model`): choose a tier-specific id from `cursor-agent --list-models` (e.g. `gpt-5.3-codex-high`) instead. Agy errors on `--model`.
- `--idle-timeout` (default 600) stops the job only after that many seconds with no output at all. There is no total time cap unless you pass `--max-duration`. Raise `--idle-timeout` for models that think silently for a long time.
- **Write jobs in a git repo: use `--isolate` by default.** It creates a worktree from `HEAD` (so the worker does **not** see uncommitted edits), runs there, and records `worktree.path` / `worktree.branch`. Tell the user which you picked and why. Skip `--isolate` only when the user asked for in-place, or the task is a small, explicitly scoped edit on a clean tree. Manual `baton worktree add` then `start --cwd` still works; prefer `--isolate` for new work.
- **After an `--isolate` job:** review with `baton diff <task_id> --stat` (full patch without `--stat`), not by running git in the worktree. Bring the change back with `baton apply <task_id> --remove` **only when the user agrees** (or asked up front): it makes one local commit on their current branch, never pushes, and deletes the worktree. Tell them the commit sha and that `git revert <sha>` undoes it. If `apply` refuses, relay the reason and listed paths; do not merge another way.
- In-place write on a dirty tree returns `dirty_worktree` with `dirty_paths`. Relay the paths and ask the user to choose `--isolate` or `--allow-dirty`. Do **not** pick `--allow-dirty` on your own.
- Optional `--scope`: post-check mistake fence (not a sandbox); prefer with `--isolate`.
- Optional `--check "<cmd>"`: the project's acceptance command (typecheck, unit tests; chain with `&&`). Baton runs it in the task cwd (the worktree under `--isolate`) after each turn that ends in `success`, and records `check` (`status`, `exit_code`, `output_tail`). A `passed` check is an independent result: do **not** re-run that command yourself. Under `--isolate`, dependencies need `.baton.json` `post_create`.
- Review / read-only jobs: pass `--mode readonly` (default `write`). Kept across `reply`. Dirty tree after a readonly turn becomes `readonly_violation`. Never combine `--isolate` / `--allow-dirty` with readonly. On macOS, Codex readonly workers using `/usr/bin/git` log `xcrun_db … Operation not permitted`; the git output is still valid — do not treat it as a failure.
- After `status` / `wait`, if `rules.unseen` is non-empty, `rules.rulesync.status` is `stale`, `target_configured` is `false`, or `gates` is non-empty, tell the user (optionally suggest `--rules pointer` or running `rulesync generate`).
- It returns at once with `task_id` and `status: "running"`. Keep the `task_id`. Tell the user they can watch live with `baton tail -f <task_id>`.

## Wait

If the host can run a background shell and wake this session when it exits, start once and end the current turn:

```
baton wait <task_id> --until-done
```

Otherwise (sync shell only, or MCP `task_wait`):

```
baton wait <task_id> --for 50
```

Returns as soon as the job leaves `running`, or after 50 seconds with the `running` view. Repeat until it is not `running`. Each short call avoids host tool timeouts. Do not pass `--for` with `--until-done`.

While `running`, read `liveness`:

- `active`: output in the last 60s. Keep waiting.
- `quiet`: alive but silent for `quiet_for_s` seconds. Usually thinking; keep waiting. Use `baton tail <task_id>` to see the last events.
- `orphaned`: the supervisor died. The next read finalizes it as `failed`.

## After it stops

- `success`: if `scope_violations` is non-empty (warn policy), treat as **not** done — `baton reply` to revert/move those paths; do not switch vendor. Otherwise tell the user `summary` and the turn's `git_changes` (`summary` is one line; for the full answer — e.g. review findings — run `baton result <task_id>`, not `tail`); do not redo those edits. If the job used `--isolate`, also tell them `worktree.path` and `worktree.branch`: changes are **uncommitted** in that worktree; reviewing, committing, and merging stay with the user; clean up with `baton worktree rm` when done. If `worktree.gitignore_updated` is true, remind them to commit `.gitignore`.
- `dirty_worktree`: in-place write refused. Relay `dirty_paths` and ask the user to choose `--isolate` or `--allow-dirty`; do not choose `--allow-dirty` yourself.
- `scope_violation`: out-of-scope edits under `--scope-on-violation fail`. `baton reply` asking to restore those paths; do not switch vendor.
- `readonly_violation`: `--mode readonly` but the tree changed. `baton reply` asking to restore; do not switch vendor.
- `check_failed`: the `--check` command failed or timed out (see `check.output_tail`). `baton reply` with the key failure lines as the fix request; do not switch vendor. The next turn runs the check again.
- `needs_input`: the worker asked `decision.question` with `decision.options`. Ask the user unchanged and wait. Then:
  ```
  baton reply <task_id> --as human --prompt "<the user's answer>"
  ```
  Answer it yourself (default `--as host`) only when the user's earlier instructions already decide it. Every turn, its author, and its prompt are recorded under `turns/`, so this is visible later. Then wait again.
- `failed`, `not_authenticated`, `cancelled`: relay `summary`, then stop.
- `quota_exceeded`: relay `summary` and stop. Do not switch vendor on your own.
- `timed_out`: relay `summary` (it says `idle` or `max_duration`). The task is closed; if the user wants another try, `baton start` again with a larger `--idle-timeout`.
- `not_installed`: say so and stop.

`baton reply` works after `success`, `needs_input`, `scope_violation`, `readonly_violation`, or `check_failed` for a follow-up in the same conversation. While the job is `running`, `reply` returns `busy`; wait first.

## Other commands

- `baton status <task_id>`: one look, no waiting.
- `baton result <task_id> [--turn <n>]`: plain-text full final message of a finished turn (default latest); no tool-call transcript.
- `baton diff <task_id> [--stat]` / `baton apply <task_id> [--remove]`: review and bring back an `--isolate` job (see Write jobs above).
- `baton tail <task_id> [-f] [--raw]`: readable event log; `-f` follows until the job stops.
- `baton cancel <task_id>`: stop it (kills the whole process group). Use when the user wants to stop.
- `baton ls [--all]`: jobs for this directory (or all), newest first.
- `baton report [task_id]`: generate a redacted diagnostic report and GitHub issue link. Only use when baton itself misbehaves (crash, stuck state, MCP error, doc mismatch) — show the report to the user and ask before running `--submit` or filing an issue.
