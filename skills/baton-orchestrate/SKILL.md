---
name: baton-orchestrate
description: >-
  Runs several bounded jobs across local agent CLIs through the baton CLI:
  holds the dependency graph, dispatches ready jobs, advances each job as it
  finishes, reviews, reworks in the same conversation, and returns a summary.
  Use for multi-job distribution with or without dependencies — not for a
  single named one-shot rescue (use baton-rescue). Process-agnostic; do not
  require agent-skills, Speckit, or OpenSpec.
---

# Baton Orchestrate

One orchestrator holds the plan: dependency graph, `task_id` per job, results, and rework counts. Workers are the local CLIs. Every job runs in its own detached process with state on disk under `~/.baton`, so jobs survive the orchestrator, this session, or an MCP restart.

Baton is the transport layer. It does **not** bind any engineering methodology. If the workspace already has `.agents/`, OpenSpec, Speckit, or custom rules, fold them into implementation briefs and the per-job review step; if not, still do a **minimal task-matched verification** (see Review) — never treat transport `success` as acceptance.

For a single one-shot handoff, use `baton-rescue`. Its sections "The command", "Wait", and "After it stops" define the commands and statuses used here.

## The command

Call it as `baton <command> ...`. If `baton` is not on PATH, run `/baton:setup` and stop. Every command prints one JSON object. The same operations exist as MCP tools; use MCP only when the host cannot run shell commands.

This skill expects baton **0.8.2** or newer. Run `baton version` once before the first job. If it prints an older version, or the MCP tools lack `task_diff` / `task_apply`, stop and tell the user to run `npm install -g @speculoai/baton@latest` and start a new session. Do not try flags the old CLI does not know.

## Who orchestrates

- If the host can run a background sub-agent, the orchestrator may run there so the main session stays free. Give it the brief below.
- Otherwise the main session runs the loop itself. Nothing in baton requires a sub-agent.

Orchestration stays on the host side. Do not ask a baton worker to dispatch others (`BATON_DELEGATION` refuses it).

## When to use

Use when:

- The user wants distribution, orchestration, multiple CLIs, or several bounded jobs
- Jobs have dependencies, or the project expects a review gate between dependent jobs
- One goal may need fail-over or rework after a bad run

Do not use (prefer `baton-rescue` or stay in the host):

- The user already named one vendor and wants a single hop
- One or two small edits, explaining a diff, or a question

## Handoff brief

Use this template for worker prompts. Tag known facts with their source. Tools hint is optional.

```text
Goal: <one bounded outcome>
Done when: <observable acceptance criteria>
Known facts: <tagged facts already available>
Already ruled out: <approaches or causes already ruled out>
Change points: <paths and line ranges>
Constraints: <allowed paths and limits>
Tools hint: If you have codegraph available, prefer it over repeated grep.
```

| Source tag | Worker action |
| --- | --- |
| `[read <path>:<lines>]` | Use the source the host just read directly. |
| `[ran <cmd>]` | Use the host's command result directly. |
| `[user]` | Use the user's explicit statement directly. Stop and ask if it conflicts with what you see. |
| `[mem <source>]` | Verify the past record before relying on it. |
| `[codegraph]` | Verify the indexed finding before relying on it. |
| `[guess]` | Verify the host's hypothesis before relying on it. |

- Share only what you already know. For locations you have not identified, write "not located by host".
- Pass change points and required interfaces as `--file path:start-end`. Leave out copied background code.
- Give only locations for sensitive values, such as `NPM_TOKEN` in `.env`. Baton saves the brief verbatim in `turns/<n>.json`.
- Keep every Tools hint conditional. The worker's environment determines which tools it has.
- Pass executable Done when criteria as `--check` and allowed paths as `--scope`.
- Use `reply` first for follow-ups, rework, and questions about the same work. For a resumable task, start a new one only when the work moves to a different area, the conversation context is contaminated, or you need an independent perspective.
- For independent reviews and adversarial checks, give only the goal and scope. Omit the host's conclusions.

## Per-job loop

1. `baton agents`; use only installed targets.
2. Build the graph of bounded jobs (prompt, files, edges). Pick a target per job and say why in one sentence.
3. `baton start` every job whose dependencies are satisfied and whose paths do not overlap another live job. Use the [Handoff brief](#handoff-brief) template for its prompt and follow the independent review exception. Pass the job’s declared paths as repeated `--scope <glob>` (same data as the plan). Optional `--scope-on-violation warn|fail` (default `warn`). Review-only jobs: `--mode readonly`. When the project has an existing acceptance command (typecheck, unit tests), pass it as `--check "<cmd>"` so Baton runs it after each successful turn. For Cursor, Codex or Claude, pass `--model <id>` when the user names a model or the job needs a specific one. Default max 3 running at once; ask before going higher.
4. Wait on all live jobs at once. If the host can run a background shell and wake this session when it exits, start once and end the current turn:
   ```
   baton wait <id1> <id2> <id3> --until-done
   ```
   Otherwise (sync shell only, or MCP `task_wait`):
   ```
   baton wait <id1> <id2> <id3> --for 50
   ```
   It returns the first job that left `running`, or `{status: "running", tasks: [...]}` after 50 seconds. Repeat. Never wait on jobs one after another.
5. When a job stops:
   - **`needs_input`:** pause dependents of that job; ask the user (through the host) `decision.question` and `decision.options` unchanged; then `baton reply <id> --as human --prompt "<answer>"`. Answer with the default `--as host` only when earlier user instructions already decide it.
   - Transport `success` means **execution complete** (turn finished), not acceptance. Run Review (see below) before any pass/fail conclusion. `summary` is one line; read the full answer with `baton result <id>` (not `tail`).
   - **`success` with non-empty `scope_violations`:** treat as **not** verified pass (warn policy). `baton reply` to revert/move out-of-scope files; counts toward the rework cap.
   - **`scope_violation` / `readonly_violation`:** same class as acceptance failure — **do not** failover to another vendor. `baton reply` asking to restore paths; counts as rework.
   - **`check_failed`:** the `--check` command failed or timed out. Same class as acceptance failure — **do not** failover. `baton reply` with the key lines of `check.output_tail` as the focused fix; counts as rework. The next turn runs the check again.
   - **Verified pass:** notify the host; mark the node done; start newly unblocked dependents.
   - **Acceptance failed after `success`:** rework in the same conversation with `baton reply <id> --prompt "<focused fix>"`, up to the rework cap (default 1); then wait again.
   - **Cannot verify:** report what remains unverified; do **not** claim accepted; do not unblock dependents that need a verified pass (ask the host if the graph is stuck).
   - **`failed` / `timed_out`:** the task is closed. Start a new task for the same job, either the same vendor with a larger `--idle-timeout` (for `timed_out`) or the next vendor once (for `failed`). Do not dual-run the same edit without cause.
   - **`not_installed`:** try the next vendor.
   - **`not_authenticated`:** when the task has a session, ask the host to arrange sign-in and use `baton reply` once authentication is restored. If there is no session, try the next vendor.
   - **`quota_exceeded`:** relay `summary`, including any reset time. Wait for quota to reset, then use `baton reply` when the task has a session. Ask the host before switching vendor.
6. While jobs are `running`, `liveness` tells you whether each is `active`, `quiet` (alive, silent for `quiet_for_s`), or `orphaned` (supervisor died; finalized as `failed` on the next read). `reply` on a running job returns `busy`.
7. When every node is terminal, return one summary: vendors, statuses, summaries, `git_changes`, reworks, fail-overs, worktree path/branch if isolated.

Tell the user they can watch any job with `baton tail -f <id>` and list them with `baton ls`. If baton itself misbehaves (crash, stuck state, MCP error, doc mismatch), run `baton report [task_id]`, show the redacted output to the user, and ask before submitting an issue (never run `--submit` or `gh issue create` silently).

## Notify the host

After each job reaches a review conclusion (`verified pass`, `acceptance failed` including fail-at-cap, `unverified`, or `cancelled`), push a short note to the main session without waiting for a reply, if the host has a channel for that (for example `SendMessage(to: "main", ...)` in Claude Code or Cursor). Otherwise keep the notes for the final summary. Transport `success` alone is only **execution complete** — not a note conclusion. Each note: job, conclusion (`verified pass` / `acceptance failed` / `unverified` / `cancelled`), changed files, check results, leftover risks. Never upgrade a worker self-report or transport `success` into `verified pass` without an independent check.

## Stop and ask the host

Do **not** decide alone when:

- A job is in `needs_input` and earlier instructions do not decide it
- A worker blocker needs a plan change
- Rework hits the cap and still fails review (`acceptance failed`)
- A job is `unverified` and dependents need a verified pass
- New dependencies appear that were not in the graph
- A job hits `quota_exceeded` and switching vendors is under consideration
- Push / open PR / any other irreversible publish step is required

Everything else: notify and keep going.

## Workspace isolation

For write jobs in a git repo, pass `--isolate` on each `baton start` so the job runs in a fresh worktree from `HEAD`. `status` / `wait` report `worktree.path` and `worktree.branch`. Changes stay in that worktree until applied. Review them with `baton diff <id> --stat` (full patch without `--stat`) instead of running git in the worktree yourself. Once a job passes review, bring it back with `baton apply <id> --remove` **only when the user agreed, or asked up front for accepted jobs to be applied**: it creates one local commit on the user's current branch (never pushes) and deletes the worktree and branch. Tell the user the commit sha and that `git revert <sha>` undoes it. If `apply` refuses (staged changes, overlapping uncommitted files, conflict, operation in progress), relay the reason and paths; do not merge another way. Apply jobs one at a time. If `worktree.gitignore_updated` is true, remind them to commit `.gitignore`.

```
baton start --isolate --target <t> --prompt "<handoff brief>" ...
baton diff <id> --stat             # what the job changed
baton apply <id> --remove          # with the user's consent: one local commit, then remove the worktree
baton worktree rm <name-or-path> [-f|--force]  # clean/merged by default; --force discards dirty/unmerged (user consent only); does not cascade from task prune
```

`--isolate` uses the same `.baton.json` `copy` / `symlink` / `post_create` as `baton worktree add`. Manual `worktree add` then `start --cwd` still works; prefer `--isolate` for new jobs. In-place write on a dirty tree returns `dirty_worktree` — ask the host before `--allow-dirty`. If isolation is unavailable, say so up front: the main session must not modify the shared tree until the run ends or is cancelled. Symlinking `node_modules` can cross-contaminate when branches diverge — prefer `post_create` install when unsure. In a pnpm workspace, add `.baton.json` with `"post_create": ["pnpm install --offline --frozen-lockfile"]` so each worktree gets its own `node_modules`; otherwise a worker's pnpm run can rewrite the main repo's `node_modules/.bin` to point into the worktree. If `apply --remove` or `worktree rm` returns a `warning` about `node_modules/.bin`, relay it: the user must run `pnpm install --force` in the main repo.

`--scope` is a **mistake fence** (post-check of net changes vs globs), not a security sandbox. Prefer stacking with `--isolate`: shared cwd without isolation can attribute other writers’ edits to the task.

## Review (project-owned gate + minimal default)

Baton only reserves the slot after each job ends. Transport `success` stays “turn finished”; acceptance is a separate orchestrator conclusion.

- If `rules.unseen` is non-empty, `rules.rulesync.status` is `stale`, `target_configured` is `false`, or `gates` is non-empty, tell the user before treating the job as reviewed.
- **Project rules present** (`.agents/`, OpenSpec, Speckit, custom checks): follow them strictly. Do not replace them with a lighter default.
- **No project rules:** still run a **minimal task-matched verification** — check the job’s stated deliverables and key behavior with the smallest sufficient existing checks (read the diff, spot-check expected files/behavior). Do **not** invent a full CI suite or spawn a reviewer agent by default.
- If you cannot verify an item: list it as unverified; do not claim accepted; dependents that need acceptance wait.
- **`check.status` is `passed`:** Baton ran that command itself in the task cwd after the turn — treat it as independently verified and **do not re-run the same command**. Review only the diff and what the command does not cover.
- The orchestrator may run read-only check commands (project-defined, or the minimal task-matched ones above) that `--check` did not already cover, but does not implement the worker’s coding task.
- Large batches: optionally one short-lived reviewer per finished job; keep only its pass/fail / unverified conclusion.

## Orchestrator brief (give to the sub-agent, or follow it yourself)

```text
You are a Baton orchestrator, not a worker. You hold the plan state.

Goal:
<user goal verbatim>

Rules:
- Command: baton (agents, start, wait, status, result, tail, reply, cancel, ls, worktree)
- Hold: dependency graph, task_id per job, results, rework counts
- Do not implement worker coding tasks yourself
- Use the Handoff brief template in the baton-orchestrate skill for each worker prompt. For independent reviews and adversarial checks, give only the goal and scope. Omit the host's conclusions.
- Do not require Speckit / OpenSpec / agent-skills; if the workspace has rules, include them in implementation briefs and use them for review; if not, still do minimal task-matched verification — never treat transport success as verified pass
- Do not delegate to the CLI vendor this host session already is
- Max 3 jobs running at once unless the host approves more
- Use --effort low for mechanical subtasks; raise --idle-timeout for slow, silent models
- For Cursor, Codex or Claude, pass --model <id> when the user names a model or the job needs a specific one; never pass --effort to Cursor (it errors) — pick a tier-specific id from `cursor-agent --list-models` instead
- Prefer `start --isolate` per write job; review with `baton diff --stat`; `baton apply --remove` only with the user's consent; on `dirty_worktree` ask before `--allow-dirty`
- Path-disjoint ready jobs may run in parallel; overlapping paths stay serialized; pass declared paths as `--scope`
- Review-only jobs: `--mode readonly`
- Pass the project's acceptance command as --check "<cmd>"; a passed check counts as verified — do not re-run it; check_failed means rework, not failover
- Prefer background `wait <ids...> --until-done` when the host wakes on shell exit; else `wait <ids...> --for 50` repeating; never wait one job after another
- needs_input: ask the host unless earlier instructions decide it; relay the answer with `reply --as human`
- quota_exceeded or not_authenticated: wait for quota to reset or have the host arrange sign-in, then `reply` when the task has a session
- Advance per job: wait → Review → verified pass: notify and start newly ready dependents; acceptance failed or scope_violation or readonly_violation or success+scope_violations: `reply` with a focused fix up to cap (default 1); cannot verify: report unverified items, do not claim accepted, do not unblock acceptance-gated dependents
- failed / timed_out: start a new task (larger --idle-timeout, or next vendor once); do not treat scope_violation or readonly_violation as vendor failover
- Notify the host after each job conclusion; ask only for the stop-and-ask cases
- When all jobs are terminal, return one summary: vendors, statuses, summaries, git_changes, reworks, fail-overs, worktree path/branch
```

## Picking a vendor

- User named a target: honor it
- Otherwise implementation/debug defaults to `codex`; if the host is already Codex, `claude`
- Long-context reading may use `agy`; local edits may use `cursor`
- `not_installed`, or `not_authenticated` without a session: try the next vendor

## Versus baton-rescue

- One hop, named target, simple handoff: `baton-rescue`
- Split, parallel, dependencies, per-job review, fail-over, summary: this skill
