# Plan: install 时同步宿主插件

Spec: `SPEC-host-plugin-sync.md` · Tasks: `tasks/todo-host-sync.md` · Issue: #93

## 方案

### 1. 何时补跑 update（spec New Behavior 第 1 条的定法）

**选「判定为 already installed 时补跑该宿主的 `update` 步骤」，不选无条件补跑。**

- 全新安装路径不变，不引入新的失败点。无条件补跑时，例如 gemini 的 `extensions update baton` 在刚装好、已是最新时是否返回 0，没法实测（本机 `gemini` 是 aisw 包装函数）。
- 复用 `runInstall` 里已有的 `/already installed/i` 判定，不新增文案匹配。
- 风险：某宿主对已装插件重跑 install 返回 exit 0、不报 already installed，却没有刷新到新版，这种情况会被漏掉。T0 逐个宿主实测；实测命中这种情况时，给该宿主加一个 `refresh: true` 一类的标记，install 后无条件补跑，并在计划里补记，不改其他宿主。
- `agy` 的 `update` 和 `install` 是同一条命令。已安装时再跑一遍 update 没有意义，跳过（update 步骤与 install 步骤相同时不补跑），依据 T0 结果决定 agy 是否需要特殊处理。

T0 确认：Claude 返回 0 仍可能报告 `already installed`，判定需覆盖该情况。Codex 的 Git 市场重装返回 0，未报告 `already installed` 且仍为 0.6.0，按预案单独标记，成功安装后固定补跑 update。Antigravity 重跑 install 已换成 0.8.0，保留相同步骤去重。Cursor 隔离配置下缺少认证，Gemini 沿用样例，暂无证据为两者增加例外。实测记录见规格。

### 2. `runInstall` 改动（`src/install.ts`）

- 宿主循环里，install 步骤命中 already installed 后，接着顺序执行 `commandsFor(id, "update")`。失败时设置 `error`，结果行 `ok: false`。
- note：命中且 update 成功时为 `already installed, updated`（替换 `already installed, skipped`）。
- 记录：「install 步骤成功或已安装」就记入 `installed.json`，与补跑的 update 是否成功无关（spec 第 3 条）。现在只记 `ok` 的宿主，需要把「已装上」和「最终 ok」分开。
- dry-run：`planInstall` 在 `action === "install"` 时把 update 步骤附在 `commands` 末尾，与 install 步骤不同才附加。实际运行仍只在命中时执行；文档写明 dry-run 列出的是「可能执行」的命令。
- 结果顶层 `note`：非 dry-run、`action` 为 install 或 update、至少一个宿主 `ok` 时，设为 `Restart open agent sessions to load the updated skills and MCP.`。
- 结果顶层 `warnings`：`action === "update"`、没传 `--only`、已记录宿主为空时，设为 `["no recorded hosts; run \`baton install\` to install the plugin into agent CLIs"]`。npm 全局步骤照常执行，exit 0。

### 3. 输出（`src/cli.ts`、`src/install-ui.ts`）

- 非 TTY：JSON 自然带上 `note` / `warnings`，不需要改。
- TTY：结束时用 `p.log.warn` 打印 `warnings`，用 `p.log.info` 打印 `note`，放在 `summarizeResult` 那一行附近。

### 4. 文档

- `docs/reference.md:132` 现在写着「重跑 install 会把插件更新到最新」，代码与此不符；改完后这句才成立，保留并补一句「需重开会话」。
- README（中英）与 reference（中英）的安装/升级段补充：只用 `npm i -g` 升级 CLI 不会更新宿主插件，请用 `baton update`；升级后重开 agent 会话。

## 依赖与顺序

T0（实测）→ T1（install 补跑 update 与记录）→ T2（note / warnings 与 TTY 输出）→ T3（文档）→ T4（端到端复现 + 全量测试 + PR）。

T1 和 T2 都改 `src/install.ts`，按顺序做。T3 可在 T2 之后与 T4 的准备并行。

## 风险

| 风险 | 缓解 |
|---|---|
| 某宿主重装旧插件时 exit 0、不刷新 | T0 实测；命中的宿主单独标记，install 后无条件补跑 |
| 补跑 update 让 `baton install` 变慢 | 只在已安装时补跑；全新安装不受影响 |
| 改动 `already installed, skipped` 断言 | 属于预期的行为变更，PR 里说明 |
| T0 需要动宿主配置 | 全部用隔离目录（`CLAUDE_CONFIG_DIR`、`CODEX_HOME` 等）和本地市场 checkout；没有隔离手段的宿主，先问用户再在真实配置上测 |

## 检查点

- T1 后：`npm test` 通过，新单测覆盖已安装→update 成功/失败两条路径。
- T2 后：`npm test` 通过；`baton update --dry-run` 和非 dry-run 的 JSON 结构手工看一次。
- T4：隔离环境 Claude 0.6.0 → 0.8.0 端到端复现通过（spec Success Criteria 1）。
