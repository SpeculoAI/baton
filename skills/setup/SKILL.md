---
name: setup
description: >-
  Ensure the baton command is on PATH so skills and MCP can call it. Use when
  the user runs /baton:setup, when baton is not found, or when a GUI host
  cannot see the npm global bin.
---

# Baton Setup

The runtime comes from the npm package `@speculoai/baton`. A marketplace install does not put `baton` on PATH. This skill checks the command and installs it globally when it is missing.

Baton needs **Node.js >= 20.17**. If Node is older, stop and tell the user to upgrade. Do not run npm inside the plugin directory or inside the user's project.

## Check

```bash
baton version
```

If this prints `{"version":"..."}`, show the version and stop. Do not reinstall.

If the shell reports that `baton` is missing, ask once. Use AskUserQuestion when it exists. Put install first:

- `Install the baton command (Recommended)`
- `Skip for now`

If they skip, stop. If they install:

```bash
npm install -g @speculoai/baton
baton version
```

Show the version. Do not start MCP yourself.

## GUI hosts

Apps launched from the Dock, such as the Cursor IDE, often do not inherit an nvm or volta PATH. If `baton version` works in a terminal but MCP cannot start, put the absolute path from `command -v baton` into that app's MCP config as `command`, with args `["mcp"]`.

## After the command works

Reload the plugin (new session) so MCP picks up tools. Then:

- One bounded handoff → `baton-rescue` (supports `--scope`, `worktree add` then `start --cwd`, Cursor `--model`)
- Several jobs / dependencies / review → `baton-orchestrate`
