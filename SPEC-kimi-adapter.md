# Spec: Kimi Code CLI adapter — V1

Status: approved（2026-11-26）
Plan: `tasks/plan-kimi.md` · Tasks: `tasks/todo-kimi.md`

## Objective

让 baton 能把任务委派给 Moonshot 的 Kimi Code CLI（`kimi`），用法与现有的 codex、claude、cursor、agy 一致：`baton start --target kimi`、`wait`、`reply`、`cancel`、`--isolate`、`--check` 都能用。

**用户**：本机装了 `kimi` 的开发者，想让 Claude Code、Codex 等宿主把一部分活交给 Kimi 做。

**做法**：新增 `src/adapters/kimi.ts`，在注册表和所有枚举 target 的地方加上 `kimi`。运行时其余部分（supervisor、tasks、worktree、scope、check、rulesync-setup）不改；rulesync 的 target 映射直接取 adapter 的 `rules.rulesyncTarget`。

## T0 实测结果（2026-11-26，macOS arm64，`kimi` 2.8.0，原生 Mach-O 程序）

除注明「文档」的条目外，都是用真实 `kimi` 实测的结果。

### 调用与输入

- **非交互调用**：`kimi -p <prompt> --output-format stream-json`。stdout 每行一个 JSON；思考过程、工具进度、警告和错误都写到 stderr。
- **stdin 不可用**：
  - `-p -` 会把 `-` 当成提示词；
  - `-p ""` 报 `Prompt cannot be empty.`；
  - 不带 `-p` 时报 `Output format is only supported in prompt mode.`；
  - 文档里也没有 `--input-format`。
  - 结论：**提示词只能走 argv。**
- **权限**：`-p` 固定按 auto 权限运行，不弹审批（文档：「Regular file operations and shell commands are allowed automatically」）。它不能和 `--yolo`、`--auto`、`--plan` 同时用，实测报 `Cannot combine --prompt with --plan.`。

### 输出格式

实测样例：

```
{"role":"meta","type":"system.version","version":"2.8.0"}
{"role":"assistant","content":"…","tool_calls":[{"type":"function","id":"tool_x","function":{"name":"Bash","arguments":"{\"command\":\"echo hi\"}"}}]}
{"role":"tool","tool_call_id":"tool_x","content":"hi\n"}
{"role":"tool","tool_call_id":"tool_y","content":"ls: /nonexistent_dir_xyz: No such file or directory\nCommand failed with exit code: 1."}
{"role":"assistant","content":"DONE"}
{"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>","command":"kimi -r session_<uuid>","content":"…"}
```

- 同一条 `assistant` 行可以同时带 `content` 和 `tool_calls`。
- `tool` 行没有成功/失败字段。Bash 失败时，content 以 `Command failed with exit code: <n>.` 结尾。
- 会话 id 只在最后一行（`session.resume_hint`）给出，而且只有 turn 正常结束才有。

### 续接与模型

- `kimi -S <session_id> -p <prompt>` 可用，能正确回忆上一轮内容；含 `& | > ^ " %` 的多行提示词经 argv 逐字节到达。
- `-S` 和 `-m` 可以同时用，而且续接时 `-m` 生效。验证方法：对一个正常会话续接时带 `-m kimi-code/k3`，会话的 `wire.jsonl` 显示这一轮请求的是 `k3`（本账号无权限，返回 403）；再带 `-m kimi-code/kimi-for-coding` 续接，正常完成。
- `-m` 给了未配置的模型：exit 1，报 `Model "<x>" is not configured in config.toml.`。

### 只读

- `--agent explore` 能在首轮限制为只读：没有写文件的工具，实测拒绝创建文件。
- 但这种会话用 `-S <id> -p` 续接，三次实测都失败，exit 1。根因是 kimi 自身的 bug，会话 `wire.jsonl` 记录为 `provider.api_error`：`unload_tools at message position 8: tool "Agent" is not declared or has already been unloaded`（HTTP 400）。
- `--agent` 不能和 `-S` 同时用（`Cannot combine --agent/--agent-file with --session/--continue …`）。
- **所以 reply 走不通，V1 不用 `--agent explore`。**

### 错误与退出码

- **未登录**：exit 1，stderr 为 `error: failed to run prompt: No model configured. Run \`kimi\` and use /login to sign in, then retry; …`。
- **服务端错误**（订阅无权限 403、上面的 400 等）：exit 1，stdout 只有 `system.version` 一行。stderr 只有笼统的 `error: failed to run prompt: Prompt turn ended with reason: failed` 和 `See log: <path>`，具体原因只记在 `~/.kimi-code/sessions/…/wire.jsonl` 和 kimi 自己的日志里。
- **退出码**（文档）：0 完成；1 参数错误、认证未就绪或执行出错；4 会话被其他进程占用。

### 规则、MCP 与 rulesync

- **规则文件**：项目根（最近的含 `.git` 的目录）到 cwd 路径上的每一级，都会读该级的 `AGENTS.md` 和 `.kimi-code/AGENTS.md`；实测 cwd 在子目录时四个文件全部读到。不读 `CLAUDE.md`。全局规则（文档）为 `~/.kimi-code/AGENTS.md`、`~/.agents/AGENTS.md`。
- **项目 MCP**：`.kimi-code/mcp.json`。工作区未被信任时，`-p` 跳过项目 MCP，stderr 提示：
  ```
  Warning: this folder is not trusted; skipped 1 project-level MCP server: <name> (stdio: …).
    Run `kimi` here and choose "Trust this folder", or set KIMI_CODE_TRUST_WORKSPACE=1, to enable them.
  ```
  设 `KIMI_CODE_TRUST_WORKSPACE=1` 后实测能加载。
- **rulesync 43.16.0 有 `kimi-code` target**（另有 `kimi-code-plugin`）。各 feature 的生成位置：
  - rules → `.kimi-code/AGENTS.md`
  - mcp → `.kimi-code/mcp.json`
  - subagents → `.kimi-code/agents/<name>.md`
  - skills → `.kimi-code/skills/<name>/SKILL.md`
  - hooks 只支持全局，项目级报 `supports the feature 'hooks' only in global scope … Skipping.`

### 其他

- **思考强度**：没有命令行参数。只有 config 里的 `[thinking] effort`，以及环境变量 `KIMI_MODEL_THINKING_EFFORT`（仅 kimi provider，文档）。
- **插件**（文档）：只能在 TUI 里用 `/plugins install` 安装，没有非交互的 CLI 子命令。
- **Windows 安装形态**：
  - 官方 `install.ps1`（读源码确认）：下载原生程序 `kimi-code-win32-<arch>`，并校验 SHA256；装到 `%USERPROFILE%\.kimi-code\bin\kimi.exe`，把该目录加进用户 PATH；不生成 `.cmd` 或 `.ps1` 包装。
  - npm 包 `@moonshot-ai/kimi-code`（`npm view` 确认）：`bin` 是 `{ kimi: 'dist/main.mjs' }`，所以 Windows 上用 npm 装出来是 `kimi.cmd` shim。
  - 两种形态都还没在 Windows 真机上跑过。

## 关键决策

- **K1 提示词走 argv。** 这是 `SPEC-native-windows.md` 中 D2 回退的第一个实际用户。
  - POSIX，以及 Windows 上解析到 `.exe`/`.com`（官方安装就是这种）：提示词放进 argv。Windows 上命令行超过 32767 字符时，启动前直接报错。
  - Windows 上解析到 `.cmd`/`.bat`（npm 安装），且提示词含换行或 `cmd.exe` 元字符（`& | < > ^ % ! " ( )`）：启动前直接报错，提示改用官方安装（`install.ps1`）。不静默截断。
  - `buildPrompt` 每轮都会追加多行的 `OUTPUT_CONTRACT`，所以 npm 装的 `kimi.cmd` 在 Windows 上每次启动都会报错，等于不支持；docs 要写明 Windows 只支持官方安装。
  - 这条检查与具体 CLI 无关，放在 `src/adapters/common.ts`，由 kimi 的 `build()` 调用。`build()` 抛出的错误已由 `src/supervisor.ts` 的 try 捕获，任务记为失败，不用新增错误通道。
- **K2 只读：`readonlyEnforcement` 不设（等同 `none`）。** `--mode readonly` 必须加 `--allow-weak`；跑完后由现有的 git 快照检查判定 `readonly_violation`。`--agent explore` 要等 kimi 修好续接 bug 再启用（见 Deferred）。
- **K3 续接与模型**：有 `sessionId` 时加 `-S <id>`；指定了 `model` 就每轮都传 `-m <model>`，并记到 `modelArg`。T0 已验证这个组合可用，且续接时 `-m` 生效。
- **K4 会话 id**：`sessionIdFrom` 只认 `role:"meta"`、`type:"session.resume_hint"` 的行。turn 中途被取消或超时就拿不到 id，下一次 reply 会开新会话；这一点在 docs 里写明（见 Open Questions 1）。
- **K5 `--effort`**：V1 不映射。传了就在 `SpawnSpec.warning` 里说明 kimi 不支持命令行设置思考强度，本轮照常运行。
- **K6 事件映射（`parseLine`）**：
  - `role:"meta"`：返回 `[]`（版本信息和续接提示不进事件流）。
  - `role:"assistant"`：每个 `tool_calls[]` 生成一个 `tool_call`，`name` 取 `function.name`，`detail` 取 `arguments` 里的 `command`/`path`/`file_path`，没有就用整段 `arguments`，经 redact 后截到 200 字符；`content` 非空时生成一个 `message`。
  - `role:"tool"`：生成 `tool_result`。content 以 `Command failed with exit code: <n>.` 结尾时 `ok: false`，否则 `ok: true`。`detail` 取 content，经 redact 后截到 200 字符。
  - 无法解析或不认识的行：返回 `null`，与现有 adapter 一致。
- **K7 认证失败识别**：关键词 `no model configured`、`use /login`。订阅无权限（403）这类服务端错误在 kimi 输出里分辨不出来，按普通失败处理；summary 里有 kimi 打印的 `See log: <path>`，可以据此去查。V1 不去读 kimi 的会话文件。
- **K8 规则、gate 与 rulesync**：
  - `rules.files = ["AGENTS.md", ".kimi-code/AGENTS.md"]`，`rulesyncTarget: "kimi-code"`。
  - `gates.mcp`：项目 `.kimi-code/mcp.json` 只有在工作区已被信任（或设置了 `KIMI_CODE_TRUST_WORKSPACE=1`）时才会在 `kimi -p` 下加载。baton 不替用户设这个环境变量。
  - `gates.hooks`：rulesync 只生成全局的 kimi hooks，项目级 hooks 不会生成。
- **K9 `baton install` 不加 kimi**：kimi 装插件只能走 TUI。

## Tech Stack

TypeScript，Node.js ESM，直接运行 `.ts`（`node src/cli.ts`），测试用 `node:test`。不新增依赖。

## Commands

```
Test:      npm test
Typecheck: npm run typecheck
Build:     npm run build
真机冒烟:  node src/cli.ts start --target kimi --prompt "…"
```

## Project Structure（本次改动）

```
src/adapters/kimi.ts       新增 adapter（K1–K8）
src/adapters/common.ts     argv 提示词的 Windows 安全检查（K1）
src/adapters/index.ts      注册 kimi
src/types.ts               Target 加 "kimi"
src/mcp.ts                 target_agent 枚举加 "kimi"；model 参数说明加 kimi
src/rules.ts               RULE_ENTRIES 加 .kimi-code/AGENTS.md；顺带修 basenameMatch（见下）
src/tasks.ts               只改 :126 支持 --model 的 target 白名单，加 kimi（K3 需要；2026-11-26 经用户同意）
src/usage.ts               --target 说明加 kimi
test/adapters.test.ts      build / parseLine / sessionIdFrom / isAuthFailure 单测
test/prompt-stdin.test.ts  kimi：POSIX 上提示词经 argv 逐字节到达；win32 加 .cmd 时报错
test/rules.test.ts         kimi 的规则文件与 gate
test/rulesync-setup.test.ts  kimi → kimi-code 映射
test/fake-cli/kimi(.cmd)   复用 fake.mjs 的入口脚本
test/fixtures/…            kimi stream-json 样例输出（按现有 fixture 约定放）
README.md / README.zh-CN.md / docs/reference*.md / skills/*/SKILL.md
                           target 列表、规则表、rulesync 映射、调用表各加 kimi
```

## Code Style

照 `src/adapters/agy.ts` 的结构写：模块内放 `AUTH` 常量、`parse`、`event` 小函数，导出一个 `Adapter` 对象；凡是实测得到的行为，都写一行注释标明日期和版本，例如：

```ts
// Verified 2026-11-26 (kimi 2.8.0): -p has no stdin form (`-p -` is taken literally), so the prompt goes in argv.
const args = ["-p", prompt, "--output-format", "stream-json"];
```

## Testing Strategy

- 单测（`test/adapters.test.ts`）：用 T0 的真实样例行覆盖 K6 的每个分支（含 `Command failed with exit code` 判为失败）、K4 和 K7；`build` 覆盖有无 `sessionId`、`model`、`reasoningEffort`。
- 集成（fake CLI）：
  - `start → wait → success`；
  - `reply` 带上 `-S <id>` 和 `-m <model>`；
  - POSIX 上提示词经 argv 逐字节到达（用 `prompt-stdin.test.ts` 里的 `PROMPT`）；
  - win32 CI 上 `kimi.cmd` 遇到多行提示词，任务失败且 summary 写明原因。
- `--mode readonly` 不加 `--allow-weak` 时报错，加了就能启动。
- 真机冒烟（macOS，手动）：用多行、含元字符的提示词跑一次 `baton start → wait → reply`，确认续接后上下文还在。

## Boundaries

- Always：实测得到的行为写注释并标日期和版本；不放宽现有测试的断言；三平台 CI 保持全绿。
- Ask first：改 `Adapter` 或 `SpawnSpec` 类型（例如为 K5 加 `env`）；动 supervisor 或 tasks 的通用逻辑；替用户设置 `KIMI_CODE_TRUST_WORKSPACE`；读取 kimi 的会话文件。
- Never：Windows 上让多行提示词经 `.cmd` 静默截断；在测试或 fixture 里放真实 token 或会话内容。

## Success Criteria

1. `baton agents` 能列出 `kimi`（装了就显示路径和 `--version` 输出的版本）。
2. `baton start --target kimi` → `wait` 得到 `success`，`baton result` 打印 kimi 最后一条回复；`reply` 续接同一会话，fake 测试断言 argv 里有 `-S <id>`，指定了 model 时还有 `-m <model>`。
3. 含换行和 `& | > < ^ " % !` 的提示词：POSIX 上逐字节到达；Windows 上 `.cmd` 形态启动前报错，错误里写明原因和改法。
4. `--mode readonly` 不带 `--allow-weak` 时报 `kimi cannot enforce read-only; add --allow-weak to allow it.`；带上后，写了文件就判 `readonly_violation`。
5. 未登录（`No model configured …`）判为 `not_authenticated`。
6. `--effort` 在 meta 里留下 warning，任务照常跑。
7. `baton start --rules check` 对 kimi 能报出各级 `AGENTS.md` 和 `.kimi-code/AGENTS.md`，并带上 MCP、hooks 两条 gate 提示；没有 `rulesync.jsonc` 时，baton 写出的 targets 里有 `kimi-code`。
8. `npm test` 在 macOS、Linux、Windows CI 全部通过，原有断言不放宽。
9. 真机冒烟（macOS）跑通一次，结果写回本 spec。
10. README、docs、skills 里所有列出 target 的地方都加上 kimi，且与实现一致。

## Out of Scope (Deferred)

- 用 `--agent explore` 实现只读：等 kimi 修好 `tool "Agent" is not declared` 续接 bug。
- `--effort` 经 `KIMI_MODEL_THINKING_EFFORT` 映射：要给 `SpawnSpec` 加 `env`，而且只对 kimi provider 生效。
- 服务端错误的具体原因：要读 `~/.kimi-code/sessions/…/wire.jsonl`，这依赖 kimi 的内部格式。
- `baton install` 给 kimi 装插件：kimi 没有非交互的插件安装命令；rulesync 的 `kimi-code-plugin` target 也留到那时再看。
- Windows 真机冒烟：和 #79 一起做。

## 实现中发现的问题（2026-11-26）

- `src/rules.ts` 的 `basenameMatch` 原先只比路径结尾，于是 `.agents/AGENTS.md`（main 上已有）会被 codex、cursor、claude 判成「会读」；加上 kimi 后 `.kimi-code/AGENTS.md` 也一样。经用户同意在本分支修复：去掉开头的 `../` 后必须与条目完全相等（commit `616a294`，附回归测试）。

## Resolved Questions（2026-11-26，用户确认）

1. turn 被取消或超时后拿不到会话 id，再 reply 会静默开新会话：接受，在 docs 里写明。
2. K2 接受：kimi 的只读只靠事后 git 检查判 `readonly_violation`，不自动回滚。
