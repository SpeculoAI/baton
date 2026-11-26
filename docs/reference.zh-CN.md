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

这条命令会把 `baton` 装成全局命令，并把插件装进你选中的 agent。在 TTY 下，`install` / `update` / `uninstall` 会走简短交互（安装时多选、进度、✓/✗），**不再**额外打印 JSON，看退出码即可。脚本 / 非 TTY 仍会在 stdout 输出一个 JSON 对象。`--only <agent>` 可重复（`claude`、`codex`、`cursor`、`agy`、`gemini`），`--force` 重装，`--dry-run` 只打印命令。以后更新：

```bash
npx @speculoai/baton@latest update
```

用 `npx @speculoai/baton uninstall` 从这些 CLI 里卸掉插件。全局命令不会被删，需要的话用 `npm uninstall -g @speculoai/baton`。

### rulesync 初始化（可选）

在 TTY 下插件装完后（未带 `--only`、`--dry-run`），`install` 会推荐安装 [rulesync](https://github.com/dyoshikawa/rulesync)，让各个 agent 共用同一套规则、MCP、skills 和 hooks。Baton 不依赖它。同一流程也可以单独运行：

```bash
baton rules init [--install project|global|skip] [--source claudecode|codexcli|cursor | --template]
                 [--targets <agent>[,<agent>]] [--yes] [--dry-run]
```

1. 找不到 rulesync 时（先查项目 `node_modules/.bin`，再查 PATH）让你选择：装到项目（`npm i -D rulesync`，仅当 git 根目录有 `package.json`）、全局（`npm i -g rulesync`）或跳过。npm 执行完会再检测一次，仍找不到就说明原因并结束。
2. 不在 git 仓库时只安装不初始化；已有 `.rulesync/` 时提示已初始化并结束。
3. 已有规则文件（`CLAUDE.md`、`AGENTS.md`、`.cursor/rules`）时，选择从其中一个导入，或从空模板开始。Baton 会清掉 rulesync 模板自带的示例（Codex `:danger-full-access` 配置、示例 MCP 服务器、示例 hook），并删掉内容为空的 MCP/hooks 源文件，避免把你已有的文件清空。`CLAUDE.local.md` 不会被导入。
4. 没有 `rulesync.jsonc` 时由 Baton 写入：`targets` 取自你的 agent（`claude`→`claudecode`、`codex`→`codexcli`、`cursor`→`cursor`、`agy`→`antigravity-cli`），`features` 为 `rules, mcp, subagents, skills, hooks`（不含 `permissions`，它会改写 Codex 的审批设置），`delete: false`。
5. 生成前先预览 `rulesync generate`，按覆盖 / 删除 / 修改设置项 / 新建分组，并标出未纳入 git 或有未提交改动的文件；确认后（或 `--yes`）才执行。取消时保留 `.rulesync/` 和 `rulesync.jsonc`，你可以修改后自己运行 `npx rulesync generate`。

非 TTY 下从不提问：缺 rulesync 时需传 `--install`，已有规则文件时需传 `--source` 或 `--template`（否则返回 `status: "needs_input"`，退出码 1）；不带 `--yes` 时结果为 `status: "previewed"`。`install --rulesync project|global|skip` 预先回答安装问题，并让非 TTY 的 install 也执行这一步；结果放在 `rulesync` 字段里，不影响 install 的退出码。

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

所有命令都只输出一个 JSON 对象（`tail`、`result`、`diff` 和帮助除外），出错时退出码非 0。`baton` 是 `@speculoai/baton` 提供的全局命令。`baton --help` 列出全部命令；`baton <命令> -h` / `--help` 以纯文本输出该命令的选项、默认值和示例，退出码为 0。

```bash
baton agents
baton start --target <codex|claude|cursor|agy> [--prompt <text> | stdin] [--file <p>...] [--effort low|medium|high|ultra]
            [--model <id>] [--idle-timeout <秒>] [--max-duration <秒>] [--cwd <dir>]
            [--scope <glob> ...] [--scope-on-violation warn|fail]
            [--mode readonly|write] [--allow-weak] [--isolate] [--allow-dirty]
            [--rules check|pointer|off] [--check "<cmd>"]
baton status <id>
baton wait <id>... [--for <秒> | --until-done]  # 默认 --for 50；--until-done 阻塞到任一任务离开 running
baton result <id> [--turn <n>]        # 纯文本：已结束轮次（默认最新）agent 的完整最终回答，不含过程记录
baton diff <id> [--stat]              # 纯文本：--isolate 任务的净改动（patch 或 diffstat）
baton apply <id> [--remove]           # 把 --isolate 任务的改动做成源仓库当前分支上的一个本地 commit；不 push
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

- `--effort` 映射到各家原生参数：Codex `-c model_reasoning_effort=...`；Claude/Agy `--effort`（`ultra` 映射为 `max`）。Cursor 没有独立的 effort 参数（`cursor-agent` 拒绝 `<id>[effort=...]`），`--target cursor --effort` 会在 `start` 时直接报错；请改选名称自带档位的模型（`cursor-agent --list-models`，如 `gpt-5.3-codex-high`）。
- `--model <id>`（Cursor、Codex 与 Claude；Agy 会报错）：按任务指定模型，写入 meta，`reply` 延续。Codex 在 `exec` 和 `exec resume` 上都传 `-m <id>`（可与 `--effort` 同用）。Claude 每一轮都传 `--model <id>`，因为只带 `--resume` 会回落到默认模型；`sonnet` / `opus` 等别名原样传入，可与 `--effort` 同用。Cursor 原样传 `--model <id>`；与 `--effort` 同时使用会报错。`status` 含 `model`（请求）与 `model_argv`（传给 CLI 的参数）；这不是 provider 确认的“实际模型”。
- `--idle-timeout` 默认 600：连续这么久没有任何输出字节才停掉。`--max-duration` 默认不限。两者都按单轮计时，`reply` 开新一轮时重新计时。
- **`--mode readonly|write`（默认 `write`）：** 映射到各家只读参数（Codex `--sandbox read-only`、Claude `--permission-mode plan`、Cursor `--mode ask`、Agy `--mode plan`）。写入 meta，`reply` 延续。每轮结束后若有净变更，会把干净的 `success` 升为 `readonly_violation`。无映射的目标默认拒绝，需显式 `--allow-weak`。**兼容性：** 新增终态 `readonly_violation`。
  - **macOS + Codex 只读：** Codex 自带的 Seatbelt 沙箱禁止写 `/tmp`，Apple 的 `/usr/bin/git` shim 会打印 `couldn't create cache file '/tmp/xcrun_db-…' (errno=Operation not permitted)`，且每次调用多花约 2 秒重新解析工具链。git 命令本身仍以 0 退出、输出正确。Baton 改不了 Codex 的沙箱规则；想去掉这些噪音，就让 worker 的 PATH 先找到真实的 git（Homebrew 的 `/opt/homebrew/bin/git`，或 `xcrun -f git` 所在目录）。
- **`--isolate` / `--allow-dirty`（仅 write）：** `--isolate` 从 `HEAD` 创建名为 `task-<id8>` 的 worktree（分支 `baton/task-<id8>`），在其中运行任务，并把 `worktree.path` / `worktree.branch` / `worktree.source_cwd` 记入任务。`reply` 在同一 worktree 继续；从源目录执行 `ls` 仍能看到该任务；`worktree.base_sha` 记录 worktree 的起点 commit。worker 的改动留在 worktree 里，直到用 `baton apply`（见下）收回；Baton 不会 push，也不开 PR。在脏工作区上原地 write 会返回 `dirty_worktree` 与 `dirty_paths`，除非传入 `--allow-dirty`。两者不能并用，也不能与 `--mode readonly` 并用。手动流程仍可用：先 `baton worktree add`，再 `baton start --cwd <path>`。默认目录 `.worktrees/`（必要时写入 `.gitignore`，见 `worktree.gitignore_updated`）；可选 `.baton.json` 配置 `copy` / `symlink` / `post_create` / `rulesync`（布尔，默认开启）。软链 `node_modules` 在分支依赖不一致时可能互相污染，必要时改用 `post_create` 独立安装。新 worktree 里若有 `.rulesync/` 且能找到 `rulesync`，`worktree add` / `--isolate` 会在其中运行 `rulesync generate`，并报告 `rules.missing` / `rules.dirtied`。建议先在主仓库生成并提交 rulesync 输出，避免 worktree 一开始就脏。
- **`baton diff <id> [--stat]` / `baton apply <id> [--remove]`（仅 `--isolate` 任务）：** *净改动*指 worktree 自 `base_sha` 以来的全部改动——worker 的提交、未提交的修改和新文件——排除 Baton 自己放入的文件（`.baton-worktree.json`、`.baton.json` 的 `copy` / `symlink` 条目）以及 `.gitignore` 忽略的文件。计算在临时 index 中进行，不碰 worktree 自己的 index、分支和文件。没有 `base_sha` 的旧任务用 `git merge-base <branch> HEAD` 推算。
  - `diff` 以纯文本输出净改动（`--stat` 输出 diffstat）；没有改动时输出为空；任务运行中也可查看。
  - `apply` 把净改动做成**一个 commit**（标题 `baton(<target>): <summary 第一行>`，trailer `Baton-Task: <id>` / `Baton-Target: <target>`，使用你的 git 身份），再 `git cherry-pick` 到源仓库的**当前分支**。这是三方合并：分支往前走了也能收回，只有同一处被改才冲突。只在本地 commit，不 push，不开 PR。撤回用 `git revert <commit>`（未 push 时也可 `git reset --soft HEAD~1`）。返回 `{ task_id, status: "applied", repo, commit, files, removed }`；净改动为空时返回 `status: "nothing_to_apply"`。
  - 以下情况 `apply` 拒绝且不改动任何东西：任务仍在运行；源仓库处于 merge / rebase / cherry-pick / revert 中；暂存区有内容；源仓库里有未提交或未跟踪的文件与任务改动的路径重叠（报错中列出）；cherry-pick 冲突（已 abort，列出冲突文件）。不重叠的未提交或未跟踪文件不受影响，也不会进入 commit。
  - `--remove` 只在 apply 成功或 `nothing_to_apply` 之后删除 worktree 和分支；被拒绝时不删除。删除失败不影响已完成的 apply，返回 `removed: false` 和 `warning`。
- **`--scope`（可选）：** 可重复，glob 相对任务 `cwd`。每轮结束后对照**任务起点净变更**（自 baseline HEAD 起的提交 ∪ 工作区 digest 差分）。`--scope-on-violation warn`（默认）保留原终态并写 `scope_violations` + `warning`；`fail` 会把干净的 `success` 升为 `scope_violation`。这是**防失误**，不是沙箱：忽略文件、仓外写入、共享 cwd 并发改动是已知盲区——建议与 `--isolate` 叠用。带 `--scope` 时 cwd 必须是 git 仓库。**兼容性：** 新增终态 `scope_violation` 及可选 `scope_*` 字段。
- **`--rules check|pointer|off`（默认 `check`）：** 从任务 `cwd` 向上扫到 git 根，发现项目规则文件，写入 `meta.rules`（`found`、`unseen`、`pointer_injected`）。`check` 不改执行者 prompt；`pointer` 在首轮 prompt 前插入英文“请先读这些文件”提示（仅针对目标原生不会加载的条目；`reply` 不再注入）；`off` 完全关闭。仓库有 `.rulesync/` 时还会写 `rules.rulesync`：读取 `rulesync.jsonc`（及 `rulesync.local.jsonc`），报告目标是否在配置内以及 `mcp`/`hooks` 加载关卡，再由 supervisor 运行整个项目的 `rulesync generate --check`（不传 `--targets`/`--features`），结果为 `in_sync` / `stale` / `error` / `skipped`。任何失败都不阻断任务。Baton 不会用 `npx` 安装 rulesync，也不会在用户主工作目录里写入 rulesync 生成物。
- **`--check "<cmd>"`（可选）：** 验收命令，由 Baton 在每一轮以 `success` 结束后亲自运行（排在 readonly / scope 检查之后），host 不必再跑一遍。以 `/bin/sh -c "<cmd>"` 在任务 `cwd` 运行（`--isolate` 时为 worktree），环境与执行者相同，单独进程组；多条命令用 `&&` 连接。`reply` 沿用。结果写在 turn 和 meta（最近一轮）的 `check`：`command`、`status`（`passed` / `failed` / `timed_out`）、`exit_code`、`duration_ms`、`output_tail`（最后 4000 字符，已脱敏）；完整输出在 `raw/<n>.check.log`。`passed` 保持 `success`；`failed` 或 `timed_out` 时本轮终态为 `check_failed`，摘要为 `check_failed: exit <code>`（超时为 `check_failed: timed out`），后接输出尾部；可以 `reply`，下一轮结束后再跑一次。连续 `--idle-timeout` 秒无输出即停止 check；`--max-duration` 只管执行者。check 期间 `cancel` 得到 `cancelled`。本轮不是 `success` 时不运行。check 结束前任务保持 `running`。`--isolate` 的 worktree 默认没有依赖，需要用 `.baton.json` 的 `post_create` 安装。**客户端注意：** 新增终态 `check_failed` 和可选 meta 字段 `check`。

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
| `check_failed` | `--check` 命令失败或超时，见 `check`；可 `reply` |
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

若已有 `stop_reason` 为 `idle` 或 `max_duration`，这次读取收成 `timed_out`，摘要为 `Timed out: idle.` 或 `Timed out: max_duration.`。`cancelled` 收成 `cancelled` / `Cancelled.`，返回视图不带 `liveness`。没有 `stop_reason` 时仍补写 `failed`。

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
| `delegate_task` | `start`（参数 `target_agent`、`prompt`、`files`、`reasoning_effort`、`model`、`idle_timeout_seconds`、`max_duration_seconds`、`cwd`、`scope`、`scope_on_violation`、`mode`、`allow_weak`、`isolate`、`allow_dirty`、`rules`、`check`） |
| `task_status` | `status` |
| `task_wait` | `wait`（参数 `task_ids`、`wait_seconds`，默认 50，上限 55；等待期间每 15 秒发一次进度通知） |
| `task_result` | `result`（参数 `task_id`、`turn`；返回含 `final_message` 的 JSON） |
| `task_diff` | `diff`（参数 `task_id`、`stat`；返回 `{ task_id, diff }`） |
| `task_apply` | `apply`（参数 `task_id`、`remove`） |
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
  raw/<n>.check.log  第 n 轮 --check 命令的输出
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
