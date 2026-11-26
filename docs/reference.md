# Baton reference

**English** | [Chinese](reference.zh-CN.md)

The full manual: every install path, flag, status, and calling convention. For the overview, see the [README](../README.md).

> **0.4.0 is a breaking release.** See [Upgrading from 0.3.x](#upgrading-from-03x). 0.3.0 notes are in [Upgrading from 0.2.x](#upgrading-from-02x).

---

## Table of Contents

- [Installation](#installation)
- [Verify Installation](#verify-installation)
- [Usage](#usage)
  - [Skills in the host](#skills-in-the-host)
  - [Command line](#command-line)
  - [Statuses and liveness](#statuses-and-liveness)
  - [Questions and follow-up turns (needs_input / reply)](#questions-and-follow-up-turns-needs_input--reply)
  - [MCP tools](#mcp-tools)
- [Task directory ~/.baton](#task-directory-baton)
- [Underlying Calling Conventions](#underlying-calling-conventions)
- [Safety](#safety)
  - [Windows notes](#windows-notes)
- [Manual Smoke Testing](#manual-smoke-testing)
- [Development & Testing](#development--testing)
- [Upgrading from 0.3.x](#upgrading-from-03x)
- [Upgrading from 0.2.x](#upgrading-from-02x)

---

## Installation

```bash
npx @speculoai/baton install
```

This installs the `baton` command globally and the plugin into the agent CLIs you select. In a TTY, `install` / `update` / `uninstall` show a short interactive flow (multi-select on install, progress, ✓/✗) and **do not** print the JSON blob — exit code is enough. Scripts and non-TTY runs still get one JSON object on stdout. `--only <agent>` is repeatable (`claude`, `codex`, `cursor`, `agy`, `gemini`), `--force` reinstalls, and `--dry-run` prints the commands. Update everything later with:

```bash
npx @speculoai/baton@latest update
```

Remove the plugin from those CLIs with `npx @speculoai/baton uninstall`. That leaves the global command; remove it with `npm uninstall -g @speculoai/baton`.

### rulesync setup (optional)

After the plugins install in a TTY (no `--only`, no `--dry-run`), `install` recommends [rulesync](https://github.com/dyoshikawa/rulesync) so your agents share one set of rules, MCP servers, skills and hooks. Baton never depends on it. The same flow runs on its own with:

```bash
baton rules init [--install project|global|skip] [--source claudecode|codexcli|cursor | --template]
                 [--targets <agent>[,<agent>]] [--yes] [--dry-run]
```

1. If rulesync is not found (project `node_modules/.bin`, then PATH), choose: install into the project (`npm i -D rulesync`, only when the git root has a `package.json`), globally (`npm i -g rulesync`), or skip. Baton checks again after npm and stops with the reason if rulesync is still missing.
2. Outside a git repo it only installs. If `.rulesync/` already exists it reports that and stops.
3. With existing rule files (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`) you pick one to import, or start from an empty template. Baton strips rulesync's template samples (a Codex `:danger-full-access` profile, demo MCP servers, a sample hook) and drops empty MCP/hooks sources so they do not blank your existing files. `CLAUDE.local.md` is never imported.
4. When `rulesync.jsonc` is absent Baton writes one: `targets` from your agents (`claude`→`claudecode`, `codex`→`codexcli`, `cursor`→`cursor`, `agy`→`antigravity-cli`), `features` `rules, mcp, subagents, skills, hooks` (not `permissions`, which rewrites Codex approval settings), and `delete: false`.
5. Baton previews `rulesync generate` grouped as overwrite / delete / changed settings / create, marking files that are not in git or have uncommitted changes, and applies it only after you confirm (or `--yes`). Declining keeps `.rulesync/` and `rulesync.jsonc` so you can edit them and run `npx rulesync generate` yourself.

Non-TTY runs never prompt: pass `--install` when rulesync is missing and `--source`/`--template` when rule files exist (otherwise `status: "needs_input"`, exit 1); without `--yes` the result is `status: "previewed"`. `install --rulesync project|global|skip` answers the install question up front and also enables the step in non-TTY runs; its result appears under `rulesync` and never changes the install exit code.

The per-host commands below are the same steps, run by hand.

### Prerequisites

1. **Supported platforms**: macOS, Linux, and native Windows 10/11 (PowerShell or cmd; WSL is treated as Linux).
2. **Node.js** >= 20.17.
3. At least one supported Agent CLI installed and logged in locally (`codex`, `claude`, `agy`, or `cursor`).
4. A marketplace install does not put `baton` on PATH. Run `/baton:setup`, or `npm install -g @speculoai/baton`.
5. (Optional) Local checkout:
   ```bash
   git clone https://github.com/SpeculoAI/baton.git
   cd baton
   npm install
   npm run build
   ```

---

### Claude Code

Claude Code supports plugins via its plugin marketplace.

#### Remote One-Click Install (Recommended)

Run directly in your system terminal:

```bash
claude plugin marketplace add https://github.com/SpeculoAI/baton
claude plugin install baton@speculoai
```

Or inside an active `claude` session using Slash commands:

```text
/plugin marketplace add https://github.com/SpeculoAI/baton
/plugin install baton@speculoai
```

#### Local Checkout Install

From inside your local `baton` directory:

```bash
claude plugin marketplace add .
claude plugin install baton@speculoai
```

---

### Antigravity (agy)

Antigravity natively discovers plugins and auto-loads their skills.

#### Remote One-Click Install (Recommended)

Run in your terminal:

```bash
agy plugin install https://github.com/SpeculoAI/baton
```

#### Local Checkout Install

From inside your local `baton` directory:

```bash
agy plugin install .
```

> **Update**: Re-running the same install command updates the plugin to the latest version.

---

### Codex CLI

Codex CLI supports adding plugin marketplaces and registering MCP tools.

#### Terminal Command Install

Run in your system terminal:

```bash
codex plugin marketplace add https://github.com/SpeculoAI/baton
codex plugin add baton@speculoai
```

#### Interactive TUI Install

Inside an interactive `codex` session:

```text
/plugins
```

Search for `baton` and select `Install Plugin`.

#### Local Checkout Install

From inside your local `baton` directory:

```bash
codex plugin marketplace add .
codex plugin add baton@speculoai
```

---

### Codex App

For the Codex desktop application:

1. Open Codex App and navigate to **Plugins** in the sidebar.
2. Search for `Baton` (or add custom marketplace source: `https://github.com/SpeculoAI/baton`).
3. Click **Install**.

---

### Cursor (Agent CLI & IDE)

#### Cursor Agent CLI Install

Cursor's official Agent CLI accepts Git repositories:

```bash
agent plugin marketplace add https://github.com/SpeculoAI/baton
agent plugin install baton@speculoai
```

Or in the Cursor Agent chat window:

```text
/add-plugin baton
```

#### Cursor IDE (MCP Mode)

If using the Cursor editor interface, configure it directly as an MCP server.

In your project's `.cursor/mcp.json` (or global Cursor MCP Settings):

```json
{
  "mcpServers": {
    "baton": {
      "command": "baton",
      "args": ["mcp"]
    }
  }
}
```

---

### Gemini CLI

Gemini CLI uses an extension system. This installs baton into Gemini CLI as the host; delegating tasks to gemini is not supported.

#### Remote Install

Run in your terminal:

```bash
gemini extensions install https://github.com/SpeculoAI/baton --consent
```

#### Local Link Mode (For development)

From inside your local `baton` directory:

```bash
gemini extensions link .
```

#### Update Extension

```bash
gemini extensions update baton
```

---

### Generic MCP Clients (Claude Desktop / Windsurf / etc.)

Baton exposes a standard Stdio MCP server compatible with any MCP client (including Claude Desktop, Windsurf, Zed, Cline, Roo Code).

Add the following to your client's MCP configuration JSON:

```json
{
  "mcpServers": {
    "baton": {
      "command": "baton",
      "args": ["mcp"]
    }
  }
}
```

Apps launched from the Dock often miss an nvm or volta PATH. If `baton` works in a terminal but MCP cannot start it, set `command` to the absolute path from `command -v baton`.

---

## Verify Installation

```bash
baton agents
```

Example output:

```json
{"agents":[{"id":"codex","installed":true,"bin":"/opt/homebrew/bin/codex","version":"codex-cli 0.167.0"},{"id":"claude","installed":true,"bin":"/Users/user/.local/bin/claude","version":"2.1.323 (Claude Code)"},{"id":"cursor","installed":true,"bin":"/Users/user/.local/bin/cursor-agent","version":"2026.11.11-043ef28"},{"id":"agy","installed":true,"bin":"/Users/user/.local/bin/agy","version":"1.5.6"}]}
```

Only agents with `installed: true` can be delegation targets.

---

## Usage

### Skills in the host

After installation the host loads three skills:

- [skills/setup/SKILL.md](../skills/setup/SKILL.md): `/baton:setup`, makes sure the `baton` command is on PATH
- [skills/baton-rescue/SKILL.md](../skills/baton-rescue/SKILL.md): one hop, bounded waiting, relays or answers the worker's questions
- [skills/baton-orchestrate/SKILL.md](../skills/baton-orchestrate/SKILL.md): several jobs with a dependency graph, per-job review, rework, fail-over, and a summary (does not require Speckit / OpenSpec / agent-skills)

Say something like "rescue this refactor to Codex" and the host runs `baton start` through its shell, then repeats `baton wait --for 50` until the job stops. The skills rely only on shell commands; they do not need the host to have background sub-agents.

**Routing**: use the target the user names. Otherwise implementation and debugging go to `codex`, or to `claude` when the current session is already Codex. Never delegate to yourself.

### Command line

Every command prints exactly one JSON object (except `tail`, `result`, `diff` and help) and exits non-zero on error. `baton` is the global command from `@speculoai/baton`. `baton --help` lists the commands; `baton <command> -h` / `--help` prints that command's options, defaults and examples as plain text and exits 0.

```bash
baton agents
baton start --target <codex|claude|cursor|agy> [--prompt <text> | stdin] [--file <p>...] [--effort low|medium|high|ultra]
            [--model <id>] [--idle-timeout <s>] [--max-duration <s>] [--cwd <dir>]
            [--scope <glob> ...] [--scope-on-violation warn|fail]
            [--mode readonly|write] [--allow-weak] [--isolate] [--allow-dirty]
            [--rules check|pointer|off] [--check "<cmd>"]
baton status <id>
baton wait <id>... [--for <s> | --until-done]  # default --for 50; --until-done blocks until a job leaves running
baton result <id> [--turn <n>]       # plain text: the agent's full final message of a finished turn (default latest), no transcript
baton diff <id> [--stat]             # plain text: net change of an --isolate task (patch, or diffstat)
baton apply <id> [--remove]          # --isolate task -> one local commit on the source repo's current branch; never pushes
baton tail <id> [-f] [--raw]         # readable events; -f follows until the job stops; --raw prints events.jsonl lines
baton reply <id> [--prompt <text> | stdin] [--as host|human]   # also after scope_violation / readonly_violation
baton cancel <id>
baton ls [--all]                     # jobs for the current directory by default, newest first
baton prune --older <days>           # delete non-running task dirs older than N days (does not remove worktrees)
baton worktree add [--name <id>] [--branch <name>] [--base <ref>]
baton worktree ls
baton worktree rm <name-or-path>     # refuses dirty/unmerged trees; remove + delete local branch when clean
baton report [id] [--title <t>] [--submit]  # plain text: redacted diagnostic report + GitHub issue URL (--submit uses gh or opens browser)
baton mcp                            # start the MCP server (stdio)
```

- `--effort` maps to each CLI's native flag: Codex `-c model_reasoning_effort=...`; Claude/Agy `--effort` (`ultra` becomes `max`). Cursor has no separate effort setting (`cursor-agent` rejects `<id>[effort=...]`), so `--target cursor --effort` fails at `start`; pick a model id that embeds the tier instead (`cursor-agent --list-models`, e.g. `gpt-5.3-codex-high`).
- `--model <id>` (Cursor, Codex and Claude; Agy errors): sets the requested model, stored on the task and kept across `reply`. Codex gets `-m <id>` on both `exec` and `exec resume` (combines with `--effort`). Claude gets `--model <id>` on every turn, because `--resume` alone falls back to the default model; aliases such as `sonnet` / `opus` pass through unchanged, and it combines with `--effort`. Cursor passes the id unchanged as `--model <id>`; combining it with `--effort` errors. `status` shows `model` (requested) and `model_argv` (passed to the CLI). That is not a provider-confirmed “actual model”.
- `--idle-timeout` defaults to 600: the job stops only after that many seconds without a single output byte. `--max-duration` is unlimited by default. Both apply per turn and restart on `reply`.
- **`--mode readonly|write` (default `write`):** maps to each CLI's read-only path (Codex `--sandbox read-only`, Claude `--permission-mode plan`, Cursor `--mode ask`, Agy `--mode plan`). Stored on the task and kept across `reply`. After each turn, dirty net changes upgrade a clean `success` to `readonly_violation`. Targets with no mapping fail unless `--allow-weak` is set. **Breaking note:** new terminal status `readonly_violation`.
  - **macOS + Codex readonly:** Codex's own Seatbelt sandbox blocks `/tmp`, so Apple's `/usr/bin/git` shim prints `couldn't create cache file '/tmp/xcrun_db-…' (errno=Operation not permitted)` and spends ~2 s per call re-resolving the toolchain. The git command still exits 0 with correct output. Baton cannot change Codex's sandbox profile; to avoid the noise, make sure the worker's PATH finds a real git first (Homebrew `/opt/homebrew/bin/git`, or the directory of `xcrun -f git`).
- **`--isolate` / `--allow-dirty` (write only):** `--isolate` creates a worktree named `task-<id8>` (branch `baton/task-<id8>`) from `HEAD`, runs the job there, and records `worktree.path` / `worktree.branch` / `worktree.source_cwd` on the task. `reply` continues in that tree; `ls` from the source directory still lists it, and `worktree.base_sha` records the commit the tree started from. The worker's changes stay in the worktree until you bring them back with `baton apply` (below); Baton never pushes or opens a PR. In-place write on a dirty tree (tracked or untracked, non-ignored) returns `dirty_worktree` with `dirty_paths` unless you pass `--allow-dirty`. Cannot combine with each other or with `--mode readonly`. Manual flow still works: `baton worktree add`, then `baton start --cwd <path>`. Default root is `.worktrees/` (appended to `.gitignore` if needed; see `worktree.gitignore_updated`). Optional `.baton.json` configures `copy` / `symlink` / `post_create` / `rulesync` (boolean, default on). Symlinking `node_modules` can cross-contaminate when branches diverge — prefer `post_create` installs when unsure. When the new worktree has `.rulesync/` and `rulesync` is on PATH (or in `node_modules/.bin`), `worktree add` / `--isolate` runs `rulesync generate` there and reports `rules.missing` / `rules.dirtied`. Prefer generating and committing rulesync outputs in the main repo first so worktrees stay clean.
- **`baton diff <id> [--stat]` / `baton apply <id> [--remove]` (`--isolate` tasks only):** the *net change* is everything in the worktree since `base_sha` — worker commits, uncommitted edits and new files — minus Baton's own files (`.baton-worktree.json`, `.baton.json` `copy` / `symlink` entries) and anything `.gitignore` ignores. It is computed in a temporary index, so the worktree's own index, branch and files are never touched. Tasks from older Baton without `base_sha` use `git merge-base <branch> HEAD`.
  - `diff` prints that change as plain text (`--stat` for a diffstat); empty when nothing changed; allowed while the task is running.
  - `apply` turns it into **one commit** (subject `baton(<target>): <summary line>`, trailers `Baton-Task: <id>` / `Baton-Target: <target>`, your git identity) and `git cherry-pick`s it onto the source repo's **current branch** — a three-way merge, so a branch that moved on still applies unless the same lines changed. It only commits locally: no push, no PR. Undo with `git revert <commit>` (or `git reset --soft HEAD~1` before pushing). Returns `{ task_id, status: "applied", repo, commit, files, removed }`, or `status: "nothing_to_apply"` when the net change is empty.
  - `apply` refuses, changing nothing, when: the task is running; the source repo is mid merge / rebase / cherry-pick / revert; the index has staged changes; an uncommitted or untracked file in the source overlaps a path the task changed (listed in the error); or the cherry-pick conflicts (aborted, conflicting paths listed). Unrelated uncommitted or untracked files are fine and stay out of the commit.
  - `--remove` deletes the worktree and its branch, but only after a successful apply or `nothing_to_apply`; never after a refusal. If removal fails the apply still stands, with `removed: false` and a `warning`.
- **`--scope` (optional):** repeatable globs relative to the task `cwd`, matched with [picomatch](https://github.com/micromatch/picomatch) and `dot: true`, so `dir/**` also covers dotfiles such as `dir/.env.example`; a bare directory path matches everything under it. After each turn, Baton checks **task-baseline net changes** (commits since start HEAD ∪ working-tree digest diff) against those globs. `--scope-on-violation warn` (default) keeps the transport status and sets `scope_violations` + `warning`; `fail` upgrades a clean `success` to `scope_violation`. This is a **mistake fence**, not a sandbox: ignored paths, non-git writes, and concurrent edits on a shared cwd are blind spots — prefer combining with `--isolate`. Requires a git repo when `--scope` is set. **Breaking note for clients:** new terminal status `scope_violation` (and optional `scope_*` meta fields).
- **`--rules check|pointer|off` (default `check`):** discovers project rule files from the task `cwd` up to the git root and records them on `meta.rules` (`found`, `unseen`, `pointer_injected`). `check` does not change the worker prompt. `pointer` prepends an English “read these files” block for entries the target does not load natively (first turn only; `reply` does not reinject). `off` skips discovery entirely. When the repo has `.rulesync/`, Baton also reports a `rules.rulesync` object: it reads `rulesync.jsonc` (+ `rulesync.local.jsonc`), notes whether the target’s rulesync id is configured and any load-gate notes for `mcp`/`hooks`, then the supervisor runs `rulesync generate --check` (whole project, no `--targets`/`--features`) and sets `status` to `in_sync` / `stale` / `error` / `skipped`. Failures never block the task. Baton never installs rulesync via `npx` and never writes rulesync outputs into the user’s main working tree.
- **`--check "<cmd>"` (optional):** an acceptance command Baton runs itself after every turn that ends in `success` (after the readonly / scope checks), so the host does not have to re-run it. It runs through the platform shell (`/bin/sh` on POSIX, `cmd.exe` on Windows) in the task `cwd` (the worktree under `--isolate`), with the worker's environment; chain several commands with `&&`. Kept across `reply`. The result is `check` on the turn and on meta (latest turn): `command`, `status` (`passed` / `failed` / `timed_out`), `exit_code`, `duration_ms`, `output_tail` (last 4000 chars, redacted); full output in `raw/<n>.check.log`. `passed` keeps `success`. `failed` or `timed_out` ends the turn as `check_failed` with summary `check_failed: exit <code>` (or `check_failed: timed out`) followed by the output tail; `reply` is allowed and the next turn runs the check again. The check stops after `--idle-timeout` seconds with no output; `--max-duration` applies only to the worker. `cancel` during the check gives `cancelled`. Not run when the turn did not end in `success`. The task stays `running` until the check ends. Under `--isolate` the worktree has no dependencies unless `.baton.json` `post_create` installs them. **Breaking note for clients:** new terminal status `check_failed` and optional `check` meta field.

### Native rule files and load gates (verified 2026-11-21/22)

| Target | Native project rules | rulesync id | Load gates Baton reports |
|---|---|---|---|
| `claude` | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` (and `AGENTS.md` only when none of those exist) | `claudecode` | none for MCP under Baton’s `-p` path (project `.mcp.json` loads without an approval prompt) |
| `codex` | `AGENTS.md`, `AGENTS.override.md` | `codexcli` | project `.codex/config.toml` MCP needs a trusted project path; hooks need persisted hook trust. A baton worktree is a separate path and does not inherit the main repo’s `trust_level`. |
| `cursor` | `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `.cursorrules` | `cursor` | project MCP needs `--approve-mcps` (Baton only passes `--trust`) |
| `agy` | `AGENTS.md`, `GEMINI.md`, `.agents/*`, `.agent/rules` | `antigravity-cli` | none surveyed |

**Known limits:** Baton does not read `~/.codex/config.toml`, so Codex `project_doc_fallback_filenames` and explicit `trust_level` are not detected (`CLAUDE.md` may be reported as `unseen` even if you configured a fallback). Self-check loaded Codex instructions with `codex debug prompt-input`. User-global rules (`~/.claude/CLAUDE.md`, etc.) are out of scope.

### Statuses and liveness

| `status` | Meaning |
|---|---|
| `running` | Still working; includes `liveness` and `quiet_for_s` |
| `needs_input` | The worker asked a question; `decision` holds `question` and `options` |
| `success` | Turn finished; includes `summary` and this turn's `git_changes` (still check `scope_violations` under warn) |
| `scope_violation` | Out-of-scope edits under `--scope-on-violation fail`; `reply` allowed |
| `readonly_violation` | `--mode readonly` but the tree changed; `reply` allowed |
| `check_failed` | The `--check` command failed or timed out; see `check`; `reply` allowed |
| `failed` / `timed_out` / `cancelled` | Terminal; cannot be replied to |
| `not_authenticated` / `quota_exceeded` | The target CLI is not logged in / out of quota |
| `not_installed` | Returned by `start`; the target is not on `PATH` |
| `dirty_worktree` | Returned by `start`; in-place write refused on a dirty tree — see `dirty_paths`; use `--isolate` or `--allow-dirty` |

`liveness` while `running`:

| `liveness` | Condition |
|---|---|
| `active` | Output within the last 60 seconds |
| `quiet` | Supervisor alive but silent for more than 60 seconds (usually thinking) |
| `orphaned` | Supervisor gone or heartbeat older than 30 seconds; the next read kills leftover processes and records `failed` |

If `stop_reason` is already `idle` or `max_duration`, that read finalizes as `timed_out` with summary `Timed out: idle.` or `Timed out: max_duration.`. `cancelled` finalizes as `cancelled` / `Cancelled.`, and the view has no `liveness`. With no `stop_reason`, it still records `failed`.

### Questions and follow-up turns (needs_input / reply)

Baton appends an output contract to every prompt: ask with a `BATON_DECISION` block when a choice is needed, finish with a `BATON_RESULT` block. When the worker asks, the task moves to `needs_input` and the worker process exits normally.

```bash
baton reply <id> --as human --prompt "A"
```

- Starts the next turn in the same conversation. `--as human` marks the words as the user's; the default `--as host` is for answers the host gives from the user's earlier instructions.
- `reply` also works after `success` for a follow-up. While the job is `running`, `reply` returns `busy`.
- Each turn's author, input, and result are stored in `turns/<n>.json`.

### MCP tools

MCP is a thin shell over the same logic. It keeps no task state, so restarting MCP does not affect running jobs:

| Tool | Command |
|---|---|
| `list_agents` | `agents` |
| `delegate_task` | `start` (`target_agent`, `prompt`, `files`, `reasoning_effort`, `model`, `idle_timeout_seconds`, `max_duration_seconds`, `cwd`, `scope`, `scope_on_violation`, `mode`, `allow_weak`, `isolate`, `allow_dirty`, `rules`, `check`) |
| `task_status` | `status` |
| `task_wait` | `wait` (`task_ids`, `wait_seconds` default 50, max 55; sends a progress notification every 15 seconds) |
| `task_result` | `result` (`task_id`, `turn`; returns JSON with `final_message`) |
| `task_diff` | `diff` (`task_id`, `stat`; returns `{ task_id, diff }`) |
| `task_apply` | `apply` (`task_id`, `remove`) |
| `task_reply` | `reply` (`task_id`, `prompt`, `as`) |
| `task_cancel` | `cancel` |
| `task_list` | `ls` (`all`, `cwd`) |

---

## Task directory ~/.baton

The root is `~/.baton` by default; set `BATON_HOME` to move it. On POSIX, directories are `0700` and files `0600` (they contain prompts); on Windows, POSIX mode bits do not apply and access relies on the user profile directory's ACL.

```
~/.baton/tasks/<task_id>/
  meta.json          current state (atomic writes)
  events.jsonl       uniform event stream
  turns/<n>.json     turn n: author, input, final status, summary, git_changes
  raw/<n>.stdout.log raw worker output for turn n, not truncated
  raw/<n>.stderr.log
  raw/<n>.check.log  output of the --check command for turn n
```

Task directories are never deleted automatically; use `baton prune --older <days>`.

---

## Underlying Calling Conventions

| Agent | First call | Resume | Notes |
| :--- | :--- | :--- | :--- |
| **Codex** | `codex exec --json --color never --approve-for-me --skip-git-repo-check --cd <cwd> -` | `codex exec resume --json <thread_id> -` | write uses `--approve-for-me` (conflicts with `--sandbox`); readonly first turn uses `--sandbox read-only`; `exec resume` has no sandbox flag and rejects `--cd` / `--color` |
| **Claude Code** | `claude -p --output-format stream-json --verbose --permission-mode acceptEdits --permission-prompts none` | add `--resume <session_id>` | readonly → `--permission-mode plan`; `stream-json` with `-p` requires `--verbose`; hook events stay out of the event stream |
| **Cursor** | `cursor-agent --print --force --trust --output-format stream-json --workspace <cwd>` | add `--resume <session_id>` | readonly → `--mode ask` (drops `--force`, keeps `--trust`); prefers `cursor-agent`, then `agent`; never the IDE's `cursor` |
| **Antigravity (agy)** | `agy --print= --mode accept-edits --input-format stream-json --output-format stream-json` (prompt via stdin) | add `--conversation <id>` | readonly → `--mode plan`; replies stream as deltas; the full text comes from the final `result` |

Any output line a parser does not recognize is kept as a `raw` event, never dropped. Real output samples for each CLI live in `test/fixtures/`.

---

## Safety

1. **No recursion (`BATON_DELEGATION=1`)**: set in the worker's environment; a downstream call into baton is refused.
2. **Process groups**: on POSIX each worker runs in its own process group so timeouts and `cancel` kill the whole group, grandchildren included. On Windows, Baton terminates trees with `taskkill /T /F` (plus a parent-PID sweep); see [Windows notes](#windows-notes).
3. **Credential redaction**: text written to events and summaries is redacted before truncation; full raw logs stay under `raw/`, protected by `0600` on POSIX (user-directory ACL on Windows).
4. **Id validation**: every task id is checked to be a UUID before it is used in a path.
5. **`--scope` is not a security boundary**: it only post-checks git-visible net changes. `.gitignore`d files, writes outside the repo, concurrent shared-cwd edits, and orphaned supervisors (check skipped) are known blind spots.
6. **Dirty-tree guard**: in-place `--mode write` in a git repo refuses when the working tree has uncommitted changes (`dirty_worktree`). Use `--isolate` or `--allow-dirty`.
7. **Write-mode auto-approval** (unchanged; this is what each worker is allowed to do once a write job starts):

| Worker | Write-mode flags | Effect |
|---|---|---|
| Codex | `--approve-for-me` | Workspace-write sandbox; edits and commands run without asking |
| Claude Code | `--permission-mode acceptEdits --permission-prompts none` | File edits are accepted automatically |
| Cursor | `--force --trust` | Commands and edits run without confirmation |
| Antigravity | `--mode accept-edits` | Edits are accepted automatically |

### Windows notes

Baton supports native Windows 10/11 (PowerShell and cmd; WSL is treated as Linux) with the following platform differences:

- **File permissions**: POSIX mode bits (`0700`/`0600` on `~/.baton`) do not take effect on Windows; task files and raw logs rely on the user profile directory's ACL.
- **Process-tree cleanup**: `cancel` and timeouts use `taskkill /T /F` (with a parent-PID fallback when a `.cmd` shim's `cmd.exe` has already exited). Because Windows process trees are walked by parent PID without a Job Object, grandchildren whose intermediate parent already exited may escape termination.
- **Shell commands (`--check` and `.baton.json` `post_create`)**: executed through `cmd.exe` (`shell: true`), not `/bin/sh`. Avoid POSIX-only shell syntax in cross-platform commands.
- **Worktree symlinks (`.baton.json` `symlink`)**: directory entries use NTFS junctions (no elevation required); file symlinks require Developer Mode or administrator rights — move file entries to `copy` if symlink creation fails with `EPERM`.

---

## Manual Smoke Testing

Use a separate throwaway Git repository:

1. `baton agents`; confirm the target shows `installed: true`.
2. Start a task that stops to ask:
   ```bash
   baton start --target codex --effort low --prompt "Do not edit files. Stop and ask me: A or B, using the BATON_DECISION format, options: A | B."
   ```
3. In another terminal, `baton tail -f <id>` shows events live.
4. Repeat `baton wait <id> --for 50` until it returns `needs_input` with A/B in `decision`.
5. `baton reply <id> --as human --prompt "A. Reply with the letter, then finish with BATON_RESULT."`, wait until `success`, and check that `session_id` matches turn 1.

---

## Development & Testing

```bash
npm test          # tsc --noEmit + node --test, no real model quota used
npm run typecheck
```

Integration tests use fake CLIs in `test/fake-cli/` and a temporary `BATON_HOME`. They cover: a task finishing after its parent is killed, idle and total timeouts, cancel killing the whole group, orphan detection after the supervisor dies, needs_input → reply on the same session, bounded wait, tail, ls/prune, and reading tasks after an MCP restart. Adapter tests use real output samples from each CLI.

---

## Upgrading from 0.4.x

- **Breaking:** in-place `--mode write` on a dirty git working tree now returns `dirty_worktree` and exits non-zero. Pass `--isolate` (run in a new worktree from `HEAD`) or `--allow-dirty` to proceed. Readonly jobs are unchanged.
- New flags / MCP params: `--isolate` / `isolate`, `--allow-dirty` / `allow_dirty`. Skills default write jobs in a git repo to `--isolate`.
- Isolated jobs record `worktree` on the task; changes stay uncommitted — Baton does not auto-commit or merge.

## Upgrading from 0.3.x

- Install and update with `npx @speculoai/baton install` and `npx @speculoai/baton@latest update`. The marketplace id is `baton@speculoai`.
- MCP runs `baton` with args `["mcp"]`. `/baton:setup` installs the global package instead of running npm inside the plugin directory.
- Node requirement is >= 20.17. The published package is built with `tsc`; a marketplace install no longer needs the TypeScript source.

## Upgrading from 0.2.x

- **Node 20.17 or newer.** The source is TypeScript. Published installs use the `baton` command.
- Hand-written MCP config uses `command: "baton"` and `args: ["mcp"]`.
- The CLI drops `delegate` in favor of `start` + `wait` + `reply`; `wait` takes ids as positional arguments.
- MCP drops `delegate_task(session_id)` continuation and `task_wait_any`: continue with `task_reply`, wait on several jobs with `task_wait(task_ids)`.
- `needs_decision` is now `needs_input`. `timeout_seconds` (capped at 1800) is replaced by `idle_timeout_seconds` + `max_duration_seconds`, with no total cap by default.
- Task state moved from the system temp directory to `~/.baton`.
- **gemini is not a delegation target for now** (it could not be verified because of a local auth problem). Installing baton as an extension inside Gemini CLI as the host still works.

---

Formerly named **Agent-Plugin-Agent (APA)**. Older install strings are no longer valid; use `baton@speculoai`.
