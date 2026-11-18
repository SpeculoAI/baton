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

Baton is the transport layer. It does **not** bind any engineering methodology. If the workspace already has `.agents/`, OpenSpec, Speckit, or custom rules, fold them into worker prompts and into the per-job review step; if not, still do a **minimal task-matched verification** (see Review) — never treat transport `success` as acceptance.

For a single one-shot handoff, use `baton-rescue`. Its sections "The command", "Wait", and "After it stops" define the commands and statuses used here.

## The command

```
node <plugin-root>/src/cli.ts <command> ...
```

`<plugin-root>` is the directory that contains `src/cli.ts`. Below, `baton` means this command (or `baton` itself if it is on `PATH`). Every command prints one JSON object. The same operations exist as MCP tools; use MCP only when the host cannot run shell commands.

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

## Per-job loop

1. `baton agents`; use only installed targets.
2. Build the graph of bounded jobs (prompt, files, edges). Pick a target per job and say why in one sentence.
3. `baton start` every job whose dependencies are satisfied and whose paths do not overlap another live job. Pass the job’s declared paths as repeated `--scope <glob>` (same data as the plan). Optional `--scope-on-violation warn|fail` (default `warn`). Default max 3 running at once; ask before going higher.
4. Wait on all live jobs at once:
   ```
   baton wait <id1> <id2> <id3> --for 50
   ```
   It returns the first job that left `running`, or `{status: "running", tasks: [...]}` after 50 seconds. Repeat. Never wait on jobs one after another.
5. When a job stops:
   - **`needs_input`:** pause dependents of that job; ask the user (through the host) `decision.question` and `decision.options` unchanged; then `baton reply <id> --as human --prompt "<answer>"`. Answer with the default `--as host` only when earlier user instructions already decide it.
   - Transport `success` means **execution complete** (turn finished), not acceptance. Run Review (see below) before any pass/fail conclusion.
   - **`success` with non-empty `scope_violations`:** treat as **not** verified pass (warn policy). `baton reply` to revert/move out-of-scope files; counts toward the rework cap.
   - **`scope_violation`:** same class as acceptance failure — **do not** failover to another vendor. `baton reply` asking to restore out-of-scope paths; counts as rework.
   - **Verified pass:** notify the host; mark the node done; start newly unblocked dependents.
   - **Acceptance failed after `success`:** rework in the same conversation with `baton reply <id> --prompt "<focused fix>"`, up to the rework cap (default 1); then wait again.
   - **Cannot verify:** report what remains unverified; do **not** claim accepted; do not unblock dependents that need a verified pass (ask the host if the graph is stuck).
   - **`failed` / `timed_out`:** the task is closed. Start a new task for the same job, either the same vendor with a larger `--idle-timeout` (for `timed_out`) or the next vendor once (for `failed`). Do not dual-run the same edit without cause.
   - **`not_installed` / `not_authenticated`:** try the next vendor.
   - **`quota_exceeded`:** stop and ask the host before switching vendor.
6. While jobs are `running`, `liveness` tells you whether each is `active`, `quiet` (alive, silent for `quiet_for_s`), or `orphaned` (supervisor died; finalized as `failed` on the next read). `reply` on a running job returns `busy`.
7. When every node is terminal, return one summary: vendors, statuses, summaries, `git_changes`, reworks, fail-overs, worktree path/branch if isolated.

Tell the user they can watch any job with `baton tail -f <id>` and list them with `baton ls`.

## Notify the host

After each job reaches a review conclusion (`verified pass`, `acceptance failed` including fail-at-cap, `unverified`, or `cancelled`), push a short note to the main session without waiting for a reply, if the host has a channel for that (for example `SendMessage(to: "main", ...)` in Claude Code or Cursor). Otherwise keep the notes for the final summary. Transport `success` alone is only **execution complete** — not a note conclusion. Each note: job, conclusion (`verified pass` / `acceptance failed` / `unverified` / `cancelled`), changed files, check results, leftover risks. Never upgrade a worker self-report or transport `success` into `verified pass` without an independent check.

## Stop and ask the host

Do **not** decide alone when:

- A job is in `needs_input` and earlier instructions do not decide it
- A worker blocker needs a plan change
- Rework hits the cap and still fails review (`acceptance failed`)
- A job is `unverified` and dependents need a verified pass
- New dependencies appear that were not in the graph
- `quota_exceeded`
- Push / open PR / any other irreversible publish step is required

Everything else: notify and keep going.

## Workspace isolation

Prefer an isolated git worktree so the main session can keep editing elsewhere. **Opening a tree is separate from running a task:**

```
baton worktree add [--name <id>] [--branch <name>] [--base <ref>]
baton start --cwd <path> ...
baton worktree rm <name-or-path>   # only when clean / merged; does not cascade from task prune
```

Prefer `baton worktree` over raw `git worktree add` (handles `.worktrees` ignore, copy/symlink/post_create from `.baton.json`). If isolation is unavailable, say so up front: the main session must not modify the shared tree until the run ends or is cancelled. Symlinking `node_modules` can cross-contaminate when branches diverge — prefer `post_create` install when unsure.

`--scope` is a **mistake fence** (post-check of net changes vs globs), not a security sandbox. Prefer stacking with worktree: shared cwd without a worktree can attribute other writers’ edits to the task.

## Review (project-owned gate + minimal default)

Baton only reserves the slot after each job ends. Transport `success` stays “turn finished”; acceptance is a separate orchestrator conclusion.

- **Project rules present** (`.agents/`, OpenSpec, Speckit, custom checks): follow them strictly. Do not replace them with a lighter default.
- **No project rules:** still run a **minimal task-matched verification** — check the job’s stated deliverables and key behavior with the smallest sufficient existing checks (read the diff, spot-check expected files/behavior). Do **not** invent a full CI suite or spawn a reviewer agent by default.
- If you cannot verify an item: list it as unverified; do not claim accepted; dependents that need acceptance wait.
- The orchestrator may run read-only check commands (project-defined, or the minimal task-matched ones above), but does not implement the worker’s coding task.
- Large batches: optionally one short-lived reviewer per finished job; keep only its pass/fail / unverified conclusion.

## Orchestrator brief (give to the sub-agent, or follow it yourself)

```text
You are a Baton orchestrator, not a worker. You hold the plan state.

Goal:
<user goal verbatim>

Rules:
- Command: node <plugin-root>/src/cli.ts (agents, start, wait, status, tail, reply, cancel, ls)
- Hold: dependency graph, task_id per job, results, rework counts
- Do not implement worker coding tasks yourself
- Do not require Speckit / OpenSpec / agent-skills; if the workspace has rules, copy them into worker prompts and use them for review; if not, still do minimal task-matched verification — never treat transport success as verified pass
- Do not delegate to the CLI vendor this host session already is
- Max 3 jobs running at once unless the host approves more
- Use --effort low for mechanical subtasks; raise --idle-timeout for slow, silent models
- Path-disjoint ready jobs may run in parallel; overlapping paths stay serialized; pass declared paths as `--scope`
- Wait on all live jobs together with `wait <ids...> --for 50`, repeating; never wait one job after another
- needs_input: ask the host unless earlier instructions decide it; relay the answer with `reply --as human`
- Advance per job: wait → Review → verified pass: notify and start newly ready dependents; acceptance failed or scope_violation or success+scope_violations: `reply` with a focused fix up to cap (default 1); cannot verify: report unverified items, do not claim accepted, do not unblock acceptance-gated dependents
- failed / timed_out: start a new task (larger --idle-timeout, or next vendor once); do not treat scope_violation as vendor failover
- Notify the host after each job conclusion; ask only for the stop-and-ask cases
- When all jobs are terminal, return one summary: vendors, statuses, summaries, git_changes, reworks, fail-overs, worktree path/branch
```

## Picking a vendor

- User named a target: honor it
- Otherwise implementation/debug defaults to `codex`; if the host is already Codex, `claude`
- Long-context reading may use `agy`; local edits may use `cursor`
- `not_installed` / `not_authenticated`: try the next vendor; do not stick

## Versus baton-rescue

- One hop, named target, simple handoff: `baton-rescue`
- Split, parallel, dependencies, per-job review, fail-over, summary: this skill
