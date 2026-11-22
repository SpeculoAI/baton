<h1 align="center">Baton</h1>

<p align="center">
  <strong>Pass the task to the agent next door.</strong>
</p>

<p align="center">
  <a href="https://github.com/SpeculoAI/baton/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/SpeculoAI/baton/ci.yml?branch=main&style=flat-square&label=CI" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@speculoai/baton"><img src="https://img.shields.io/npm/v/@speculoai/baton?style=flat-square&color=111111&label=npm" alt="npm"></a>
  <img src="https://img.shields.io/node/v/@speculoai/baton?style=flat-square&color=111111" alt="Node version">
  <img src="https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20Cursor%20%C2%B7%20Antigravity%20%C2%B7%20Gemini-111111?style=flat-square" alt="Hosts">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#before--after">Before/After</a> •
  <a href="#install">Install</a> •
  <a href="#use-it">Use it</a> •
  <a href="#how-it-works">How it works</a> •
  <a href="docs/reference.md">Full reference</a> •
  <a href="README.zh-CN.md">Chinese</a>
</p>

---

You're working in Claude Code. Codex is installed on the same laptop, logged in, already paid for, and sitting idle. Baton lets the agent you're talking to hand a bounded coding task to that other agent, keep an eye on it, answer its questions, and bring the result back.

**Any agent as host, any agent as worker.** No API keys, no server, no cloud. Every agent uses its own login and subscription.

Workers: `codex` (Codex CLI) · `claude` (Claude Code) · `cursor` (Cursor Agent CLI) · `agy` (Antigravity).

## Before / After

<table>
<tr>
<td width="50%">

### Without Baton

1. Open a second terminal and start `codex`.
2. Copy the task in, plus the context it needs.
3. Keep switching windows to check on it.
4. It asks "A or B?" and waits for you, possibly for hours.
5. Copy the result back into the first session and explain what changed.

</td>
<td width="50%">

### With Baton

> **You:** rescue this refactor to Codex.

The host starts the job, checks on it in short steps, passes Codex's "A or B?" to you, and then reports what Codex did and which files it changed. You never leave the session.

</td>
</tr>
</table>

## Install

```bash
npx @speculoai/baton install
```

It finds the agent CLIs on your machine, asks which ones should get the plugin, and installs the global `baton` command. It then offers to set up [rulesync](https://github.com/dyoshikawa/rulesync) for the current project (optional; rerun any time with `baton rules init`). Requires Node ≥ 20.17 and at least one supported agent CLI that is already logged in.

Check which workers Baton can see:

```bash
baton agents
```

Update everything later with `npx @speculoai/baton@latest update`. Flags (`--only`, `--force`, `--dry-run`), per-host manual installs, and MCP config for Claude Desktop, Windsurf, and Zed are covered in the [reference](docs/reference.md#installation).

## Use it

Just ask in plain language:

```text
rescue this failing test to codex
have claude review the diff, read-only
split the migration into three jobs and run them on codex and cursor
```

Behind the scenes, the host runs ordinary shell commands:

```bash
baton start --target codex --prompt "Fix the failing test in src/parser.ts"   # returns a task_id at once
baton wait <task_id> --for 50                                                  # repeats until the job stops
```

Want to see what the worker is doing? Run this in any terminal:

```bash
baton tail -f <task_id>
```

If no target is named, the task goes to `codex`, or to `claude` when you are already in Codex. Baton never delegates to the agent you are already using.

## What you get

| Skill | What it does |
|---|---|
| `baton-rescue` | Hands off one job, waits in short steps, passes the worker's questions to you, and reports the result. |
| `baton-orchestrate` | Runs several jobs with dependencies between them, reviews each one, retries, switches workers when one fails, and writes a summary. |
| `/baton:setup` | Puts the `baton` command on PATH if a marketplace install skipped it. |

| Command | What it does |
|---|---|
| `baton start` | Starts a job. Options include `--effort`, `--mode readonly`, `--scope <glob>`, `--rules check\|pointer\|off`, and `--cwd <worktree>`. |
| `baton wait` / `status` | Waits for the job to stop, or takes one look at it. |
| `baton tail [-f]` | Shows the live event stream as readable text. |
| `baton reply` | Continues the same conversation when the worker asks a question or you want a follow-up. |
| `baton cancel` / `ls` / `prune` | Stops a job, lists jobs, or deletes old ones. |
| `baton worktree add/ls/rm` | Gives a job its own git worktree so it doesn't touch your checkout. |
| `baton rules init` | Installs and initializes rulesync for the current project, previewing changes before writing. |
| `baton mcp` | Runs the same operations as an MCP server for hosts that can't run shell commands. |

Every command prints exactly one JSON object, so the host agent can read it reliably. See the [full flag list and statuses](docs/reference.md#command-line).

## How it works

```
Host agent ──shell──> baton start ──spawns a detached supervisor──> worker CLI (codex / claude / ...)
    │                     │ returns task_id at once                    │ streamed output → uniform events
    │                     ▼                                            │
    │             ~/.baton/tasks/<id>/  <──────── single writer ───────┘
    │                     ▲
    └──shell/MCP──> baton wait / status / tail / reply / cancel
```

- **Jobs outlive the host.** Each job runs under its own supervisor, so closing the session or the terminal, or restarting MCP, doesn't stop it. You can still read the result afterwards.
- **No total time limit.** A job is stopped only after 10 minutes with no output at all, so slow models can think for hours.
- **One event format.** Messages, tool calls, and errors from every CLI are converted to the same events, and `status` tells you whether the worker is working, quietly thinking, or dead.
- **Questions don't strand the job.** When the worker needs a decision, the job pauses at `needs_input`. `baton reply` resumes the same session and records who answered.
- **Guardrails, not a sandbox.** `--mode readonly` uses each CLI's own read-only mode and flags the job if files change anyway. `--scope` checks git changes against path patterns after each turn. Workers can't call Baton again, and credentials are redacted from the event log.

## FAQ

**Do I need API keys?**
No. Baton runs the CLIs you already have, with their existing logins.

**What happens if I close my host session mid-job?**
The job keeps running. Open a new session and run `baton ls` or `baton status <id>`.

**Is `--scope` a security boundary?**
No. It catches mistakes in files git can see. For real isolation, put the job in a `baton worktree`.

**Will the worker follow my project rules / environment?**
`baton status` reports `rules.unseen` (rule files the target does not load natively) and, if you use [rulesync](https://github.com/dyoshikawa/rulesync), whether generated configs are in sync. Pass `--rules pointer` to tell the worker to read unread rule files first. Prefer a shared `AGENTS.md` (and rulesync for MCP/skills/hooks across CLIs).

**Can Gemini CLI be a worker?**
Not yet. Gemini CLI works as a host.

**Where is the state?**
In `~/.baton/tasks/<id>/` (change it with `BATON_HOME`): `meta.json`, `events.jsonl`, one file per turn, and the raw logs. Nothing is deleted automatically.

## Development

```bash
npm install
npm test        # typecheck + node --test, using fake CLIs; no model quota spent
```

Changes land through pull requests only; see [CONTRIBUTING](.github/CONTRIBUTING.md) for the branch, PR, CI, and release workflow. Design notes are in [docs/architecture.md](docs/architecture.md) and [docs/hosts.md](docs/hosts.md). Upgrading from 0.3.x or earlier? See [the upgrade notes](docs/reference.md#upgrading-from-03x).

## License

[MIT](LICENSE)

---

<sub>Formerly **Agent-Plugin-Agent (APA)**. Old install strings no longer work; use `baton@speculoai`.</sub>
