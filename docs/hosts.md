# Host manifests

These files live at fixed paths because each host looks for them there. Do not move them without verifying a real install from a branch.

| File | Host | Role |
|---|---|---|
| `.claude-plugin/plugin.json` | Claude Code | Plugin metadata |
| `.claude-plugin/marketplace.json` | Claude Code | Marketplace entry (`baton@speculoai`) |
| `.codex-plugin/plugin.json` | Codex CLI / Codex App | Plugin metadata; points at `.codex-mcp.json` |
| `.codex-mcp.json` | Codex (via plugin) | MCP server config (`baton mcp`) |
| `.cursor-plugin/plugin.json` | Cursor Agent CLI | Plugin metadata; points at `.cursor-mcp.json` |
| `.cursor-mcp.json` | Cursor (via plugin) | MCP server config |
| `.agents/plugins/marketplace.json` | Codex marketplace listing | Marketplace catalog entry |
| `.mcp.json` | Claude Code / generic MCP | Root MCP config used by some hosts |
| `mcp_config.json` | Legacy / generic clients | Same MCP payload as `.mcp.json` |
| `plugin.json` | Shared plugin metadata | Name, version, description |
| `gemini-extension.json` | Gemini CLI / Antigravity | Extension install + MCP |

The MCP JSON files are intentionally identical:

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

`npx @speculoai/baton install` registers the marketplace/plugin for each detected host and installs the global `baton` command. Skills under `skills/` are loaded by hosts that support skills (Claude Code, Codex, Cursor, Antigravity, Gemini).

When changing a path referenced by another manifest (for example moving `.codex-mcp.json`), update the pointer and verify with a real install before merging.
