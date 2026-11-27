# Spec: install 时同步宿主插件 — V1

Status: implemented
Issue: #93
Plan: `tasks/plan-host-sync.md` · Tasks: `tasks/todo-host-sync.md`

## Objective

`baton install` 结束后，每个选中宿主的 baton 插件（skills + MCP 配置）都必须是插件市场的最新版，不管这个宿主之前是没装、装了旧版，还是已是最新。

**现状问题**：宿主已装旧版插件时，宿主的 install 命令返回 "already installed"，`runInstall` 把它记成 `already installed, skipped`（`src/install.ts:239`），插件停在旧版。CLI 已升级，宿主仍加载旧 skill，agent 按旧说明误判能力（#93：旧 `baton-rescue` 写 `--model` 仅 Cursor，实际 0.8.0 已支持 Codex/Claude）。全程无提示。

**用户**：用 `npx @speculoai/baton install` 或 `baton install` 安装/重装 baton 的开发者。

**原则**（用户 2026-11-26 确认）：只在 install 时处理宿主插件版本；其他命令（`start`、`mcp`、`update` 等）不做检测、不自动同步。不加 npm `postinstall`。

## 实测依据（2026-11-26，macOS，隔离宿主配置，本地市场从 `v0.6.0` 切到 `v0.8.0`）

用 `git clone` 建本地市场，依次检出 `v0.6.0`、`v0.8.0`。仅在隔离进程中用 Git URL 重写让宿主通过现有 Git 市场命令访问本地仓库。

| 宿主 | 重跑 install 退出码 | 含 `already installed` | 版本与关键输出 |
| --- | --- | --- | --- |
| Claude Code 2.1.332 | 0 | 是 | `Plugin "baton@speculoai" is already installed (scope: user)`，仍为 0.6.0。市场更新与插件更新均返回 0，`plugin list --json` 确认升至 0.8.0。 |
| Codex CLI 0.171.0 | 0 | 否 | ``Added plugin `baton` from marketplace `speculoai`.``，安装目录仍为 `…/baton/0.6.0`。市场 `upgrade` 与再次 `plugin add` 均返回 0，安装目录变为 `…/baton/0.8.0`。 |
| Cursor Agent 2026.11.22-e9042b2 | 0 | 否 | 市场登记在 Cursor 账号上（服务端），无法本地隔离；2026-11-27 在真实账号上重跑 `plugin marketplace add <REPO>`：`Fetching plugins from …` / `✓ Added marketplace speculoai (1 plugin)`，会重新索引，不产生重复条目。插件本体由用户在 Cursor 对话里 `/add-plugin` 安装，baton 管不到。 |
| Antigravity 1.5.18 | 0 | 否 | `Installed to …/plugins/baton (replaced existing installation)`，`plugin list` 确认从 0.6.0 升至 0.8.0。 |
| Gemini CLI 0.67.0 | 1 | 是 | 隔离 `HOME` + `~/.gitconfig` `insteadOf` 指向本地 clone：装 0.6.0 后重跑 `extensions install <REPO> --consent` → `Extension "baton" is already installed. Please uninstall it first.`，仍为 0.6.0。随后 `extensions update baton` **卡在交互提示**：Gemini 先下载 GitHub release，失败后问 `Would you like to attempt to install via "git clone" instead? [Y/n]`；`update` 没有 `--consent`，stdin 为 `/dev/null` 也不退出。本机失败原因：mihomo fake-ip 把 `api.github.com` 解析为 `198.18.0.51`，Gemini 的私有地址拦截报 `Access to blocked or private host`。正常 DNS 下 release 下载应成功，未验证。 |

结论：Claude 需要识别退出码为 0 的 `already installed`。Codex 命中计划中的例外，成功安装后固定补跑现有 update 步骤。Antigravity 的 install 已能刷新版本，且两组命令相同，只运行一次。Cursor 重跑 install 本身即刷新，无需例外。Gemini 沿用条件补跑；但 fake-ip 等环境下 `extensions update` 会卡在交互提示（`baton update` 原本就有此问题），见 Out of Scope。

## New Behavior

1. **install 后补跑 update**：`baton install` 对每个宿主，在 install 步骤成功或判定 "already installed" 后，执行该宿主 `HOSTS` 表里已有的 `update` 步骤。具体是无条件补跑，还是只在 already installed 时补跑，按 T0 实测结果在计划里定（取不依赖输出文案匹配、且全新安装不报错的那种）。
2. **结果标注**：原先 `note: "already installed, skipped"` 改为表明已更新（如 `already installed, updated`）。
3. **update 失败即失败**：补跑的 update 步骤失败时，该宿主 `ok: false` 并带 `error`，`exitCode` 为 1；宿主仍记入 `~/.baton/installed.json`（插件确实装着，以后 `baton update` 要覆盖它）。
4. **提示重开会话**：非 dry-run 的 install/update 只要有一个宿主成功，JSON 结果带一条提示（字段名见 Open Questions），内容为"重开已打开的 agent 会话以加载新的 skills 和 MCP"；TTY 输出同样打印。
5. **update 无记录时不再静默**：`baton update` 读到的已记录宿主为空时，结果带警告"no recorded hosts; run `baton install`"。不做宿主检测，npm 全局升级照常执行。
6. **dry-run**：`--dry-run` 的命令列表包含补跑的 update 步骤。
7. **`--force` 不变**：仍是 uninstall（soft）+ install；是否也补跑 update 随第 1 条一起定。

## Commands

```
Test:      npm test
Typecheck: npm run typecheck
Build:     npm run build
手工复现:   见「实测依据」，用隔离 CLAUDE_CONFIG_DIR + 本地市场 checkout
```

## Project Structure

- `src/install.ts`：`commandsFor` / `planInstall` / `runInstall`，本次主要改动处
- `src/cli.ts`、`src/install-ui.ts`：输出提示（第 4、5 条）
- `test/install.test.ts`：单测，沿用 `bins()` + `spawn` 桩
- `README.md`、`README.zh-CN.md`、`docs/reference.md`、`docs/reference.zh-CN.md`：安装/升级说明

## Code Style

沿用 `src/install.ts` 现有写法：`Step[]` 命令表 + `soft` 标记，结果行 `{ id, ok, note?, error? }`。不新增模块、不新增依赖。

## Testing Strategy

`node --test`，在 `test/install.test.ts` 用 `spawn` 桩记录调用序列：

- 已安装（桩返回 "already installed"）→ 断言随后执行了该宿主 update 步骤，结果 `ok: true`、note 为已更新。
- 已安装 + update 失败 → `ok: false`、`exitCode: 1`、宿主仍在 `installed.json`。
- 全新安装 → 结果与现在一致（或按第 1 条的定法多出 update 步骤且成功）。
- dry-run 命令列表含 update 步骤。
- `update` 无记录 → 结果含警告、仍执行 npm 全局命令。
- 有宿主成功 → 结果含重开会话提示；全部失败或 dry-run → 不含。

改已有断言（如 `note === "already installed, skipped"`）属于行为变更，在 PR 里说明。手工按「实测依据」复现一次 Claude 0.6.0 → 0.8.0。

## Boundaries

- Always：`npm test` 通过再提交；在 `.worktree/host-plugin-sync`（分支 `fix/host-plugin-sync`）里改。
- Ask first：修改 `HOSTS` 表里已有的宿主命令；改变 `exitCode` 语义（除第 3 条外）；动 skill 文本。
- Never：读写宿主私有文件（如 `~/.claude/plugins/installed_plugins.json`）；在 install/update 以外的命令里检测或同步插件；加 npm `postinstall`。

## Success Criteria

1. 隔离环境里 Claude 装 0.6.0、市场升到 0.8.0 后，`baton install --only claude --skip-global`（或等价调用）完成时 `claude plugin list --json` 显示 `0.8.0`，结果行 `ok: true`。
2. 上述 Testing Strategy 中各用例通过；`npm test` 全绿。
3. 全新安装的结果与退出码不回退。
4. README（中英）与 reference（中英）写明：只用 `npm i -g` 升级 CLI 不会更新宿主插件，请用 `baton update`，升级后需重开 agent 会话。

## Out of Scope (Deferred)

- 每次运行 baton 时检测版本差异并自动同步：用户决定只在 install 时处理。
- npm `postinstall` 钩子：pnpm 默认拦截，且在安装脚本里调别的 CLI 易出意外。
- 把插件版本钉到与 CLI 相同：宿主 update 拉的是市场最新（main），可能高于 CLI；属既有行为。
- install 后回查宿主实际安装版本：各宿主 list 命令不统一（`codex plugin list` 实测会卡住）。
- skill 内写版本并自检：用户判定不是 skill 的问题。
- Gemini `extensions update` 在 release 下载失败时卡在交互提示（fake-ip 代理环境可复现）：可改为宿主命令加超时，或 Gemini 改用 uninstall + `install --consent`，待定。

## Decisions（原 Open Questions，2026-11-26 用户确认）

1. 第 4 条提示放在结果顶层 `note` 字符串，不新增字段。
2. 第 5 条无记录时只警告，exit 0。
