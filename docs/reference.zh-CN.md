# Baton 参考手册

[English](reference.md) | **简体中文**

完整手册：所有安装方式、参数、状态和底层调用规范。概览见 [README](../README.zh-CN.md)。

> **0.4.0 是破坏性升级**，见 [从 0.3.x 升级](#从-03x-升级)。0.3.0 的说明在 [从 0.2.x 升级](#从-02x-升级)。

---

## 目录

- [安装指南 (Installation)](#安装指南-installation)
- [验证安装](#验证安装)
- [使用方法](#使用方法)
  - [宿主内的技能](#宿主内的技能)
  - [命令行](#命令行)
  - [状态与存活判定](#状态与存活判定)
  - [停下提问与续轮 (needs_input / reply)](#停下提问与续轮-needs_input--reply)
  - [MCP 工具](#mcp-工具)
- [任务目录 ~/.baton](#任务目录-baton)
- [各平台底层调用规范](#各平台底层调用规范)
- [安全机制](#安全机制)
- [手工冒烟测试](#手工冒烟测试)
- [开发与单元测试](#开发与单元测试)
- [从 0.3.x 升级](#从-03x-升级)
- [从 0.2.x 升级](#从-02x-升级)

---

## 安装指南 (Installation)

```bash
npx @speculoai/baton install
```

这条命令会把 `baton` 装成全局命令，并把插件装进你选中的 agent。在 TTY 下，`install` / `update` / `uninstall` 会走简短交互（安装时多选、进度、✓/✗）；脚本请继续解析 stdout 上的 JSON。`--only <agent>` 可重复（`claude`、`codex`、`cursor`、`agy`、`gemini`），`--force` 重装，`--dry-run` 只打印命令。以后更新：

```bash
npx @speculoai/baton@latest update
```

用 `npx @speculoai/baton uninstall` 从这些 CLI 里卸掉插件。全局命令不会被删，需要的话用 `npm uninstall -g @speculoai/baton`。

下面各家的命令是同一套步骤，供手动安装。

### 前置要求

1. **Node.js** >= 20.17。
2. 本地已安装并登录至少一个受支持的 Agent CLI（`codex`、`claude`、`agy`、`cursor`）。
3. 通过插件市场安装不会把 `baton` 放进 PATH。运行 `/baton:setup`，或执行 `npm install -g @speculoai/baton`。
4. （可选）本地开发：
   ```bash
   git clone https://github.com/SpeculoAI/baton.git
   cd baton
   npm install
   npm run build
   ```

---

### Claude Code

Claude Code 原生支持通过插件市场进行扩展。

#### 远程一键安装（推荐）

在系统终端中运行：

```bash
claude plugin marketplace add https://github.com/SpeculoAI/baton
claude plugin install baton@speculoai
```

或者在已开启的 `claude` 交互终端内直接输入 Slash 命令：

```text
/plugin marketplace add https://github.com/SpeculoAI/baton
/plugin install baton@speculoai
```

#### 本地克隆安装

在克隆好的 `baton` 目录下执行：

```bash
claude plugin marketplace add .
claude plugin install baton@speculoai
```

---

### Antigravity (agy)

Antigravity 原生支持插件系统与技能自动加载。

#### 远程一键安装（推荐）

在终端中直接运行：

```bash
agy plugin install https://github.com/SpeculoAI/baton
```

#### 本地克隆安装

在克隆好的 `baton` 目录下执行：

```bash
agy plugin install .
```

> **更新**：重新执行一次相同的安装指令即可覆盖更新到最新版本。

---

### Codex CLI

Codex 命令行支持通过插件体系注册并接入 MCP。

#### 终端命令安装

在系统终端中运行：

```bash
codex plugin marketplace add https://github.com/SpeculoAI/baton
codex plugin add baton@speculoai
```

#### 交互式安装

在 `codex` 交互界面中输入：

```text
/plugins
```

搜索 `baton`，然后选择 `Install Plugin`。

#### 本地克隆安装

在克隆好的 `baton` 目录下执行：

```bash
codex plugin marketplace add .
codex plugin add baton@speculoai
```

---

### Codex App

适用于 Codex 桌面客户端：

1. 打开 Codex App，点击左侧边栏的 **Plugins**。
2. 搜索 `Baton`（或点击添加自定义市场源：`https://github.com/SpeculoAI/baton`）。
3. 点击 **Install** 确认安装。

---

### Cursor (Agent CLI 与 IDE)

#### Cursor Agent CLI 终端安装

Cursor 官方 Agent CLI 支持直接添加 Git 地址：

```bash
agent plugin marketplace add https://github.com/SpeculoAI/baton
agent plugin install baton@speculoai
```

或者在 Cursor Agent 聊天框中输入：

```text
/add-plugin baton
```

#### Cursor IDE (MCP 模式配置)

如果你主要使用 Cursor 编辑器窗口，可将其作为 MCP 服务器挂载：

在项目根目录 `.cursor/mcp.json`（或全局 Cursor 设置中的 MCP 配置）中添加：

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

Gemini CLI 采用扩展（Extensions）系统。这里把 baton 装进 Gemini CLI 当宿主用；暂不支持把任务派给 gemini。

#### 远程安装

在终端中执行：

```bash
gemini extensions install https://github.com/SpeculoAI/baton --consent
```

#### 本地链接模式（推荐用于本地开发）

在克隆好的 `baton` 目录下执行：

```bash
gemini extensions link .
```

#### 扩展更新

```bash
gemini extensions update baton
```

---

### 通用 MCP 客户端 (Claude Desktop / Windsurf 等)

本仓库提供标准的 MCP Stdio 协议服务，可以接入任何兼容 MCP 的客户端（例如 Claude Desktop、Windsurf、Zed、Cline、Roo Code）。

在宿主的 MCP 配置文件中添加：

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

从 Dock 启动的应用常常拿不到 nvm 或 volta 的 PATH。如果终端里 `baton` 可用、MCP 却起不来，把 `command -v baton` 的绝对路径填进 `command`。

---

## 验证安装

```bash
baton agents
```

输出示例：

```json
{"agents":[{"id":"codex","installed":true,"bin":"/opt/homebrew/bin/codex","version":"codex-cli 0.167.0"},{"id":"claude","installed":true,"bin":"/Users/user/.local/bin/claude","version":"2.1.323 (Claude Code)"},{"id":"cursor","installed":true,"bin":"/Users/user/.local/bin/cursor-agent","version":"2026.11.11-043ef28"},{"id":"agy","installed":true,"bin":"/Users/user/.local/bin/agy","version":"1.5.6"}]}
```

只有 `installed: true` 的 Agent 才可以作为派工目标。

---

## 使用方法

### 宿主内的技能

安装插件后，宿主会加载三个技能：

- [skills/setup/SKILL.md](../skills/setup/SKILL.md)：`/baton:setup`，确认 `baton` 命令在 PATH 上
- [skills/baton-rescue/SKILL.md](../skills/baton-rescue/SKILL.md)：单跳派工，有界等待，转问或代答子 CLI 的问题
- [skills/baton-orchestrate/SKILL.md](../skills/baton-orchestrate/SKILL.md)：多单调度，持依赖图、逐单推进、审查、返工、换家、汇总（不绑定 Speckit / OpenSpec / agent-skills）

对宿主说"把这个重构 rescue 给 Codex 做"之类的话，宿主就会用 shell 调 `baton start`，再循环 `baton wait --for 50` 直到结束。技能只依赖 shell 命令，不要求宿主有后台子 Agent。

**路由规则**：用户指定了目标就用指定的；没指定时实现与排错默认派给 `codex`，当前会话本身是 Codex 时改派 `claude`；绝不派给自己。

### 命令行

所有命令都只输出一个 JSON 对象（`tail` 除外），出错时退出码非 0。`baton` 是 `@speculoai/baton` 提供的全局命令。

```bash
baton agents
baton start --target <codex|claude|cursor|agy> [--prompt <text> | stdin] [--file <p>...] [--effort low|medium|high|ultra]
            [--model <id>] [--idle-timeout <秒>] [--max-duration <秒>] [--cwd <dir>]
            [--scope <glob> ...] [--scope-on-violation warn|fail]
            [--mode readonly|write] [--allow-weak] [--isolate] [--allow-dirty]
            [--rules check|pointer|off]
baton status <id>
baton wait <id>... [--for <秒> | --until-done]  # 默认 --for 50；--until-done 阻塞到任一任务离开 running
baton tail <id> [-f] [--raw]          # 人读格式的事件；-f 跟到任务停下；--raw 输出 events.jsonl 原行
baton reply <id> [--prompt <text> | stdin] [--as host|human]   # scope_violation / readonly_violation 后也可续轮
baton cancel <id>
baton ls [--all]                      # 默认只列当前目录的任务，按更新时间倒序
baton prune --older <天数>            # 删除早于 N 天的非 running 任务目录（不级联删 worktree）
baton worktree add [--name <id>] [--branch <name>] [--base <ref>]
baton worktree ls
baton worktree rm <name-or-path>      # 脏或未合并则拒绝；干净则 remove + 删本地分支
baton mcp                             # 启动 MCP 服务（stdio）
```

- `--effort` 映射到各家原生参数：Codex `-c model_reasoning_effort=...`；Claude/Agy `--effort`（`ultra` 映射为 `max`）；Cursor 仅 effort 时 → `--model auto[effort=...]`。
- `--model <id>`（目前仅 Cursor）：按任务指定模型，写入 meta，`reply` 延续。Cursor 规则：仅 model → `--model <id>`；model+effort → `--model '<id>[effort=...]'`；若 id 已含档位（如 `grok-4.7-xhigh`）或已有括号再带 `--effort` 则报错。不会出现两个 `--model`。`status` 含 `model`（请求）与 `model_argv`（传给 CLI 的参数）；这不是 provider 确认的“实际模型”。
- `--idle-timeout` 默认 600：连续这么久没有任何输出字节才停掉。`--max-duration` 默认不限。两者都按单轮计时，`reply` 开新一轮时重新计时。
- **`--mode readonly|write`（默认 `write`）：** 映射到各家只读参数（Codex `--sandbox read-only`、Claude `--permission-mode plan`、Cursor `--mode ask`、Agy `--mode plan`）。写入 meta，`reply` 延续。每轮结束后若有净变更，会把干净的 `success` 升为 `readonly_violation`。无映射的目标默认拒绝，需显式 `--allow-weak`。**兼容性：** 新增终态 `readonly_violation`。
- **`--isolate` / `--allow-dirty`（仅 write）：** `--isolate` 从 `HEAD` 创建名为 `task-<id8>` 的 worktree（分支 `baton/task-<id8>`），在其中运行任务，并把 `worktree.path` / `worktree.branch` / `worktree.source_cwd` 记入任务。`reply` 在同一 worktree 继续；从源目录执行 `ls` 仍能看到该任务。改动保持未提交——Baton 不自动 commit、merge 或开 PR。在脏工作区上原地 write 会返回 `dirty_worktree` 与 `dirty_paths`，除非传入 `--allow-dirty`。两者不能并用，也不能与 `--mode readonly` 并用。手动流程仍可用：先 `baton worktree add`，再 `baton start --cwd <path>`。默认目录 `.worktrees/`（必要时写入 `.gitignore`，见 `worktree.gitignore_updated`）；可选 `.baton.json` 配置 `copy` / `symlink` / `post_create` / `rulesync`（布尔，默认开启）。软链 `node_modules` 在分支依赖不一致时可能互相污染，必要时改用 `post_create` 独立安装。新 worktree 里若有 `.rulesync/` 且能找到 `rulesync`，`worktree add` / `--isolate` 会在其中运行 `rulesync generate`，并报告 `rules.missing` / `rules.dirtied`。建议先在主仓库生成并提交 rulesync 输出，避免 worktree 一开始就脏。
- **`--scope`（可选）：** 可重复，glob 相对任务 `cwd`。每轮结束后对照**任务起点净变更**（自 baseline HEAD 起的提交 ∪ 工作区 digest 差分）。`--scope-on-violation warn`（默认）保留原终态并写 `scope_violations` + `warning`；`fail` 会把干净的 `success` 升为 `scope_violation`。这是**防失误**，不是沙箱：忽略文件、仓外写入、共享 cwd 并发改动是已知盲区——建议与 `--isolate` 叠用。带 `--scope` 时 cwd 必须是 git 仓库。**兼容性：** 新增终态 `scope_violation` 及可选 `scope_*` 字段。
- **`--rules check|pointer|off`（默认 `check`）：** 从任务 `cwd` 向上扫到 git 根，发现项目规则文件，写入 `meta.rules`（`found`、`unseen`、`pointer_injected`）。`check` 不改执行者 prompt；`pointer` 在首轮 prompt 前插入英文“请先读这些文件”提示（仅针对目标原生不会加载的条目；`reply` 不再注入）；`off` 完全关闭。仓库有 `.rulesync/` 时还会写 `rules.rulesync`：读取 `rulesync.jsonc`（及 `rulesync.local.jsonc`），报告目标是否在配置内以及 `mcp`/`hooks` 加载关卡，再由 supervisor 运行整个项目的 `rulesync generate --check`（不传 `--targets`/`--features`），结果为 `in_sync` / `stale` / `error` / `skipped`。任何失败都不阻断任务。Baton 不会用 `npx` 安装 rulesync，也不会在用户主工作目录里写入 rulesync 生成物。

### 各执行者原生规则文件与加载关卡（2026-11-21/22 核实）

| 目标 | 原生项目规则 | rulesync id | Baton 会提示的加载关卡 |
|---|---|---|---|
| `claude` | `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md`（仅当这三者都不存在时才读 `AGENTS.md`） | `claudecode` | Baton 走 `-p`，项目 `.mcp.json` 按文档会直接加载，不写 mcp 关卡 |
| `codex` | `AGENTS.md`、`AGENTS.override.md` | `codexcli` | 项目 `.codex/config.toml`（MCP）需要项目被信任；hooks 需要事先信任。baton worktree 是独立路径，不继承主仓库的 `trust_level` |
| `cursor` | `AGENTS.md`、`CLAUDE.md`、`.cursor/rules`、`.cursorrules` | `cursor` | 项目 MCP 需要 `--approve-mcps`（Baton 只传了 `--trust`） |
| `agy` | `AGENTS.md`、`GEMINI.md`、`.agents/*`、`.agent/rules` | `antigravity-cli` | 未调研 |

**已知限制：** Baton 不读 `~/.codex/config.toml`，因此检测不到 Codex 的 `project_doc_fallback_filenames` 与显式 `trust_level`（即便你配置了回退读 `CLAUDE.md`，仍可能报告为 `unseen`）。可用 `codex debug prompt-input` 自查实际加载的指令。用户级全局规则（如 `~/.claude/CLAUDE.md`）不在本版范围。

### 状态与存活判定

| `status` | 含义 |
|---|---|
| `running` | 还在跑，额外带 `liveness` 和 `quiet_for_s` |
| `needs_input` | 子 CLI 停下来提问，`decision` 里有 `question` 和 `options` |
| `success` | 本轮完成，带 `summary` 和本轮的 `git_changes`（warn 策略下仍可能有 `scope_violations`） |
| `scope_violation` | `--scope-on-violation fail` 下越界；可 `reply` |
| `readonly_violation` | `--mode readonly` 但工作区有净变更；可 `reply` |
| `failed` / `timed_out` / `cancelled` | 终态，不能再 `reply` |
| `not_authenticated` / `quota_exceeded` | 对方 CLI 没登录 / 额度用尽 |
| `not_installed` | `start` 时就返回，目标不在 `PATH` 里 |
| `dirty_worktree` | `start` 返回；脏工作区上拒绝原地 write——见 `dirty_paths`；改用 `--isolate` 或 `--allow-dirty` |

`running` 时的 `liveness`：

| `liveness` | 条件 |
|---|---|
| `active` | 60 秒内有输出 |
| `quiet` | 守护进程活着，但超过 60 秒没有输出（通常是在思考） |
| `orphaned` | 守护进程没了或心跳超过 30 秒未更新；下一次读会杀掉残留子进程并补写 `failed` |

### 停下提问与续轮 (needs_input / reply)

派工时 baton 会在 prompt 末尾附上输出约定：需要选择时用 `BATON_DECISION` 块提问，做完时用 `BATON_RESULT` 块总结。子 CLI 提问后任务进入 `needs_input`，进程正常退出。

```bash
baton reply <id> --as human --prompt "选 A"
```

- 在原会话上开下一轮。`--as human` 表示这是人说的话；主 Agent 依据用户先前指示代答时用默认的 `--as host`。
- `success` 之后也能 `reply` 追问。任务 `running` 时 `reply` 返回 `busy`。
- 每一轮的作者、输入和结果都记在 `turns/<n>.json`，事后可回看。

### MCP 工具

MCP 是同一套逻辑的薄壳，进程里不存任何任务状态，重启 MCP 不影响正在跑的任务：

| 工具 | 对应命令 |
|---|---|
| `list_agents` | `agents` |
| `delegate_task` | `start`（参数 `target_agent`、`prompt`、`files`、`reasoning_effort`、`idle_timeout_seconds`、`max_duration_seconds`、`cwd`、`scope`、`scope_on_violation`、`mode`、`allow_weak`、`isolate`、`allow_dirty`、`rules`） |
| `task_status` | `status` |
| `task_wait` | `wait`（参数 `task_ids`、`wait_seconds`，默认 50，上限 55；等待期间每 15 秒发一次进度通知） |
| `task_reply` | `reply`（参数 `task_id`、`prompt`、`as`） |
| `task_cancel` | `cancel` |
| `task_list` | `ls`（参数 `all`、`cwd`） |

---

## 任务目录 ~/.baton

根目录默认 `~/.baton`，可用 `BATON_HOME` 换位置。目录权限 `0700`，文件 `0600`（里面有 prompt 原文）。

```
~/.baton/tasks/<task_id>/
  meta.json          当前状态（原子写）
  events.jsonl       统一事件流
  turns/<n>.json     第 n 轮：作者、输入、结束状态、摘要、git_changes
  raw/<n>.stdout.log 第 n 轮子进程原始输出，不截断
  raw/<n>.stderr.log
```

任务目录不会自动清理，用 `baton prune --older <天数>` 手动清。

---

## 各平台底层调用规范

| Agent | 首次调用 | 续会话 | 说明 |
| :--- | :--- | :--- | :--- |
| **Codex** | `codex exec --json --color never --approve-for-me --skip-git-repo-check --cd <cwd> -` | `codex exec resume --json <thread_id> -` | write 用 `--approve-for-me`（与 `--sandbox` 互斥）；readonly 首轮用 `--sandbox read-only`；`exec resume` 无 sandbox 参数，也不接受 `--cd`、`--color` |
| **Claude Code** | `claude -p --output-format stream-json --verbose --permission-mode acceptEdits --permission-prompts none` | 追加 `--resume <session_id>` | readonly → `--permission-mode plan`；`stream-json` 在 `-p` 下必须配 `--verbose`；hook 事件不进事件流 |
| **Cursor** | `cursor-agent --print --force --trust --output-format stream-json --workspace <cwd>` | 追加 `--resume <session_id>` | readonly → `--mode ask`（去掉 `--force`，保留 `--trust`）；优先找 `cursor-agent`，再找 `agent`，不调用 IDE 的 `cursor` |
| **Antigravity (agy)** | `agy --print <prompt> --mode accept-edits --output-format stream-json` | 追加 `--conversation <id>` | readonly → `--mode plan`；回复是逐字增量，完整文本取自最终 `result` |

解析器认不出的输出行一律记为 `raw` 事件，不会丢。各家的真实输出样本在 `test/fixtures/`。

---

## 安全机制

1. **防递归 (`BATON_DELEGATION=1`)**：子进程环境里带这个变量，下游再调用 baton 会被直接拒绝。
2. **进程组隔离**：子 CLI 独立成进程组，超时和 `cancel` 会杀掉整组，包括它拉起的孙进程。
3. **凭据脱敏**：写进事件和摘要的文本先脱敏再截断；原始日志完整保留在受 `0600` 保护的 `raw/` 下。
4. **id 校验**：所有传入的 task id 先校验是 UUID，再拼路径。
5. **`--scope` 不是安全边界**：只事后检查 git 可见的净变更。被 ignore 的路径、仓外写入、共享 cwd 并发、orphaned（检查未跑）是已知盲区。
6. **脏工作区拦截**：git 仓库内原地 `--mode write` 若工作区有未提交改动，返回 `dirty_worktree`。改用 `--isolate` 或 `--allow-dirty`。
7. **write 模式自动批准**（未改；下表说明各执行者一旦进入 write 任务被允许做什么）：

| 执行者 | write 模式参数 | 效果 |
|---|---|---|
| Codex | `--approve-for-me` | 工作区可写沙箱；改文件与跑命令不再询问 |
| Claude Code | `--permission-mode acceptEdits --permission-prompts none` | 文件编辑自动接受 |
| Cursor | `--force --trust` | 命令与编辑无需确认 |
| Antigravity | `--mode accept-edits` | 编辑自动接受 |

---

## 手工冒烟测试

在一个独立的临时 Git 仓库里跑：

1. `baton agents`，确认目标 `installed: true`。
2. 发起一个会停下提问的任务：
   ```bash
   baton start --target codex --effort low --prompt "不要改文件。先停下来问我：选 A 还是 B，用 BATON_DECISION 格式，options: A | B。"
   ```
3. 另开一个终端 `baton tail -f <id>`，能实时看到事件。
4. `baton wait <id> --for 50` 直到返回 `needs_input`，`decision` 里是 A/B。
5. `baton reply <id> --as human --prompt "A。回复你选的字母后用 BATON_RESULT 结束。"`，再 `wait` 到 `success`，确认 `session_id` 与第一轮相同。

---

## 开发与单元测试

```bash
npm test          # tsc --noEmit + node --test，不消耗真实模型额度
npm run typecheck
```

集成测试用 `test/fake-cli/` 里的假 CLI 和临时 `BATON_HOME`，覆盖：父进程被杀后任务照常完成、空闲与总时长超时、取消杀整组、守护进程死亡后的孤儿判定、needs_input → reply 续会话、有界 wait、tail、ls/prune、MCP 重启后仍能读到任务。适配器测试用各家真实输出样本。

---

## 从 0.4.x 升级

- **破坏性变更：** git 仓库内原地 `--mode write` 遇到脏工作区时，现在返回 `dirty_worktree` 并以非 0 退出。请传 `--isolate`（在从 `HEAD` 新建的 worktree 里跑）或 `--allow-dirty`。readonly 任务不受影响。
- 新增参数 / MCP 字段：`--isolate` / `isolate`、`--allow-dirty` / `allow_dirty`。skill 对 git 仓库中的 write 任务默认使用 `--isolate`。
- 隔离任务会在 meta 里记录 `worktree`；改动保持未提交——Baton 不自动提交或合并。

## 从 0.3.x 升级

- 用 `npx @speculoai/baton install` 安装，用 `npx @speculoai/baton@latest update` 更新。插件 id 是 `baton@speculoai`。
- MCP 运行 `baton`，参数是 `["mcp"]`。`/baton:setup` 安装全局包，不再往插件目录里执行 npm。
- Node 要求改为 >= 20.17。发布包由 `tsc` 构建，市场安装不再需要 TypeScript 源码。

## 从 0.2.x 升级

- **Node 最低 20.17。** 源码是 TypeScript。安装后使用 `baton` 命令。
- 手工 MCP 配置的 `command` 为 `baton`，`args` 为 `["mcp"]`。
- CLI 去掉 `delegate`，改为 `start` + `wait` + `reply`；`wait` 用位置参数传 id。
- MCP 去掉 `delegate_task(session_id)` 续派和 `task_wait_any`：续轮用 `task_reply`，多单等待用 `task_wait(task_ids)`。
- `needs_decision` 改名 `needs_input`；`timeout_seconds`（上限 1800）改为 `idle_timeout_seconds` + `max_duration_seconds`，默认没有总时长上限。
- 任务状态从系统临时目录移到 `~/.baton`。
- **暂不支持 gemini 作为派工目标**（本机鉴权问题，无法验证）。Gemini CLI 作为宿主安装 baton 扩展不受影响。

---

曾用名：**Agent-Plugin-Agent (APA)**。更早的安装串已失效，请使用 `baton@speculoai`。
