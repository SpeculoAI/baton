# Spec：项目规则与环境透传（rules & environment propagation）

状态：草案 v2，待评审（v1 评审后扩大到“环境”，修正了 rulesync 检查方式）
范围：Baton 0.4.x 之后的下一个小版本

## 1. 目标（Objective）

### 问题

用户长期在某个宿主（例如 Claude Code）里开发，积累了一整套项目环境：规则（`CLAUDE.md`）、MCP 服务器、skills、subagents、hooks、permissions。通过 Baton 把任务派给另一个执行者 CLI 后，执行者只认**自己格式**的配置文件，可能看不到规则、用不上 MCP，写出不符合项目规范的代码。用户在派工时无从得知这件事。

### 定位

- **[rulesync](https://github.com/dyoshikawa/rulesync) 负责同步**：用户在 `.rulesync/` 里维护一份环境，rulesync 生成各家 CLI 的原生配置。
- **Baton 负责“派工时看得见”**：不翻译、不维护任何配置内容，只在派工和创建 worktree 时检测、报告，并在用户明确要求时做最小的兜底。
- 没装 rulesync 的用户，至少还能得到规则层面的检测和兜底。

### 要做的事

1. **规则发现**：派工时检测仓库里有哪些规则文件、目标执行者原生能读到哪些，把读不到的记录在任务状态里。不依赖 rulesync。
2. **规则兜底（显式开启）**：`--rules pointer` 时，在第一轮 prompt 里提示执行者先读它读不到的规则文件。
3. **rulesync 环境检查**：仓库使用 rulesync 时，派工前按用户自己的配置检查整个项目的生成文件是否同步，并报告目标执行者是否在 rulesync 的配置范围内。
4. **加载关卡提示**：rulesync 为目标执行者生成了 MCP 或 hooks 时，提示该 CLI 在非交互模式下可能不会加载它们，以及原因。
5. **worktree 生成**：`baton worktree add` 时在新 worktree 里运行 rulesync 生成环境文件，并报告缺失的规则文件和被改动的已提交文件。

### 用户故事

- 在 Claude Code 里派工给 Codex 时，我能在 `baton status` 里看到“`CLAUDE.md` 不会被 codex 读取”。
- 我可以加 `--rules pointer`，让 Codex 开工前先读 `CLAUDE.md`。
- 我改了 `.rulesync/mcp.jsonc` 却忘了运行 `generate`，派工后能在状态里看到“环境未同步”。
- 我的 `rulesync.jsonc` 没有配置 `codexcli`，派工给 codex 时能看到“rulesync 没有为 codex 生成环境”。
- rulesync 为 cursor 生成了 MCP 配置，派工给 cursor 时能看到“cursor 在非交互模式下默认不批准项目 MCP”。
- `baton worktree add` 创建的新 worktree 里环境文件是齐全的；如果生成过程改动了已提交的文件，我会被告知。
- 没装 rulesync、也不用 `--rules` 的用户，任何流程都不受影响。

## 2. 核实过的事实（Facts）

以下内容于 2026-11-21 对照官方文档或本机 CLI 帮助信息核实。各 CLI 迭代很快，表格是“尽力准确”。

### 2.1 各执行者原生读取的项目级规则文件

| 执行者 | 原生读取 | 备注 | rulesync 目标 ID |
|---|---|---|---|
| `claude` | `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md` | 路径上**没有**这三个文件时才读 `AGENTS.md`；`@path` 导入只有 Claude 会展开 | `claudecode` |
| `codex` | `AGENTS.md`、`AGENTS.override.md` | 用户可用 `project_doc_fallback_filenames` 追加文件名（本版不解析）；被显式标记为不信任的项目不加载项目级 `AGENTS.md`（见 2.4） | `codexcli` |
| `cursor` | `AGENTS.md`、`CLAUDE.md`、`.cursor/rules/**/*.mdc`、`.cursorrules` | 来源：[Cursor CLI 文档](https://cursor.com/docs/cli/using)、[Rules 文档](https://cursor.com/docs/rules) | `cursor` |
| `agy` | `AGENTS.md`、`GEMINI.md`、`.agents/AGENTS.md`、`.agents/GEMINI.md`、`.agents/rules/*.md`、`.agent/rules/*.md` | 来源：[Antigravity Rules 文档](https://antigravity.google/docs/rules/) | `antigravity-cli` |

### 2.2 rulesync 行为（来源：rulesync 仓库 `docs/reference/cli-commands.md`）

- `rulesync init` 生成的默认配置：`features` 为 `rules`、`mcp`、`subagents`、`skills`、`hooks`、`permissions`。也就是说，rulesync 用户同步的是**整个环境**，不只是规则。
- `generate --check`：等同于 `--dry-run`，未同步时退出码为 1，已同步为 0。
- `--targets`、`--features` **会覆盖** `rulesync.jsonc` 中的配置；不传时使用配置。如果指定一个配置里没有的目标，rulesync 会去比对从没生成过的文件，结果必然是“未同步”。
- 多个目标共用的文件（如 `AGENTS.md`）在 `--check` 时按完整配置比对，即使只指定了一个目标。**所以“按单个执行者检查”不成立**，只能检查整个项目。
- 配置文件为 `rulesync.jsonc`，旁边的 `rulesync.local.jsonc` 会覆盖它。`targets` 有数组和对象两种形式（对象形式里每个目标单独列 features），也可以是 `"*"`。
- 官方推荐全局安装（`npm install -g rulesync`），但项目也可能把它装成开发依赖（`node_modules/.bin/rulesync`）。
- rulesync 要求 Node ≥ 22.22，且版本迭代极快（2026 年 10 月内发布了 8 个大版本），因此**不作为 Baton 的依赖**。

### 2.3 非交互模式下的加载关卡（含 T0 实测，2026-11-22）

文件同步了，不等于子 Agent 加载了。规则文件写在那里就会被读取，但 MCP、hooks 这类会执行东西的配置，各家 CLI 都有信任或批准关卡：

| 执行者 | 关卡 | 状态 | Baton 现状 |
|---|---|---|---|
| `cursor` | 项目 MCP 需要批准；CLI 参数 `--approve-mcps` 默认关闭 | 已核实（本机 `cursor-agent --help`） | 只传了 `--trust`，没传 `--approve-mcps` |
| `codex` | 项目 `.codex/config.toml`（rulesync 把 Codex 的 MCP 写在这里）只对被信任的项目生效 | 已核实（[Codex 配置文档](https://learn.chatgpt.com/docs/config-file/config-basic)） | 未处理 |
| `codex` | hooks 需要事先被信任过；`codex exec` 有 `--dangerously-bypass-hook-trust` | 已核实（本机 0.166.0 `codex exec --help`） | 未处理 |
| `codex` | Baton worktree 是新绝对路径，**不**继承主仓库的 `trust_level` | **T0 实测**（见下） | worktree 路径通常不在 `projects` 表里 |
| `claude` | `-p` 模式跳过工作区信任确认 | 已核实（本机 `claude --help`） | — |
| `claude` | 项目 `.mcp.json` 在 **`-p` 下会直接加载**，不经批准提示 | **T0**：文档 + `claude mcp list`（见下）；模型调用因 OAuth 过期未做成 | 无需额外 flag |
| `agy` | 未调研 | 未知 | — |

**T0 复现结论：**

1. **Claude 项目 MCP（2026-11-22，claude 2.1.323）**
   - 在临时仓库写入 `.mcp.json` 后，`claude mcp list` 显示该服务器为 `Pending approval (run claude to approve)`——这是**交互**会话的关卡。
   - Anthropic 文档与可靠转述（[safeguard.sh, 2026-10-19](https://safeguard.sh/resources/blog/claude-code-mcp-json-why-a-cloned-repo-cannot-approve-its-servers)）写明：`-p` / Agent SDK / 云端等非交互模式**无法弹出批准提示，因此项目服务器会直接加载**；可用 `disabledMcpjsonServers`、`--setting-sources` 或 `--strict-mcp-config` 阻止。
   - 本机用 Baton 同款参数跑 `-p` 模型调用时，因 OAuth 会话过期未能实测工具可用性。adapter 的 `gates`：**不对 claude 的 mcp 写关卡**（Baton 走 `-p`，按文档会加载）。
2. **Codex worktree 信任（2026-11-22，codex-cli 0.166.0）**
   - 用隔离的 `CODEX_HOME` + `codex debug prompt-input`：主仓库路径标为 `trusted` 时，`AGENTS.md` 哨兵出现在 prompt 中。
   - 同一仓库的 **git worktree 是另一个绝对路径**：仅信任主路径、不把 worktree 写入 `projects` 时，worktree 里的 `AGENTS.md` **仍然加载**（未列入 ≠ untrusted）。
   - 把 worktree 路径显式写成 `trust_level = "untrusted"` 后，`AGENTS.md` **不再加载**（与官方行为一致）。
   - 因此：**Baton 新建的 worktree 默认会加载 `AGENTS.md`**，除非用户曾把该路径标为不信任。
   - 项目 MCP：在带真实登录的 `codex exec` 中，即使对主路径传入 `-c projects.<path>.trust_level="trusted"`，模型仍报告没有 `baton_t0` / `echo_token`；`codex mcp list` 也只列出用户级服务器。项目级 MCP 是否在 0.166.0 的 `codex exec` 下生效**未能实证**；文档仍写明项目 `.codex/` 仅对信任项目加载。adapter 继续对 `mcp` / `hooks` 写关卡提示，并注明 worktree 是独立路径、不会自动继承主仓库信任。

**本版不修改任何执行者的启动参数**：自动批准 MCP、绕过 hook 信任都属于放宽权限，需要单独决定。本版只把关卡写进 adapter 声明，在相关时提示。

### 2.4 Codex 的项目信任与 `AGENTS.md`

- **已确认（官方）**：[openai/codex#39837](https://github.com/openai/codex/pull/39837) 合并后，被显式设为 `trust_level = "untrusted"` 的项目不加载项目级 `AGENTS.md`；从未出现在配置里的项目不算“不信任”，`codex exec` 照常加载。
- **官方行为本身不稳定**：[openai/codex#41499](https://github.com/openai/codex/issues/41499)（未关闭）报告 0.150.1 中不信任项目的 `AGENTS.md` 仍被加载。
- **未能核实**：有[第三方文章](https://traversaal.ai/blog/codex-exec-trust-flag-cli-0169-untrusted-directories)称 0.169.0 起 `codex exec` 需要 `--trust` 才加载 `AGENTS.md`；本机 0.166.0 没有该参数。
- **本版处理**：不检测（需要读 `~/.codex/config.toml`）。reference 文档写明限制，并给出自查方法 `codex debug prompt-input`。

## 3. 设计（Design）

### 3.1 adapter 声明

`Adapter` 新增可选字段，纯数据，不执行任何逻辑：

```ts
export type EnvFeature = "mcp" | "hooks";

export type RuleSupport = {
  /** Rule paths relative to a directory level, e.g. "AGENTS.md", ".cursor/rules". */
  files: string[];
  /** Files read only when none of `unless` exists at the same level (Claude's AGENTS.md rule). */
  conditional?: { file: string; unless: string[] }[];
  /** rulesync target id; omit when rulesync has no matching target. */
  rulesyncTarget?: string;
  /** Why generated config for a feature may not load in Baton's non-interactive run. */
  gates?: Partial<Record<EnvFeature, string>>;
};

export type Adapter = {
  // ...existing fields
  rules?: RuleSupport;
};
```

四个 adapter 按 2.1 和 2.3 填写。`gates` 只写已核实的关卡；T0 实测后补充未核实的两项。

### 3.2 规则发现

新文件 `src/rules.ts`，纯函数为主。

- **扫描范围**：从任务 `cwd` 逐级向上到 git 仓库根目录；不是 git 仓库时只扫 `cwd`。不扫描 `cwd` 以下的子目录。
- **识别的文件**（所有 adapter 的并集）：`CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md`、`AGENTS.md`、`AGENTS.override.md`、`GEMINI.md`、`.agents/AGENTS.md`、`.agents/GEMINI.md`、`.agents/rules`、`.agent/rules`、`.cursor/rules`、`.cursorrules`。目录条目只要存在且非空即算存在。
- **覆盖计算**：`unseen = found − nativeReadable(target, found)`，Claude 的条件规则按同一层是否存在 `unless` 中的文件判断。
- 路径以相对 `cwd` 的形式记录，和现有 scope 路径一致。
- 规则目录保持目录级，不解析其中文件的 frontmatter（见第 11 节第 4 条）。

### 3.3 `--rules` 参数

`baton start` 新增 `--rules <mode>`，MCP 的 `baton_start` 新增同名 `rules` 字段。名字保留 `--rules`，文档说明它同时包含环境检查。

| 取值 | 规则发现 | rulesync 环境检查 | 注入 prompt |
|---|---|---|---|
| `check`（**默认**） | 是 | 是（满足条件时） | 否 |
| `pointer` | 是 | 是（满足条件时） | 是（`unseen` 非空时） |
| `off` | 否 | 否 | 否 |

- 默认 `check` 只读文件、不改 prompt，对现有派工行为没有影响。
- `reply` 不接受 `--rules`，沿用首轮结果，不再注入。

### 3.4 记录方式：`meta.rules`

`supervisor.ts` 每轮开头会覆盖 `meta.warning`，`reply` 也会删除它，所以使用独立字段：

```ts
export type RulesyncReport = {
  /** pending: start() wrote config info; the supervisor has not run --check yet. */
  status: "pending" | "in_sync" | "stale" | "error" | "skipped";
  detail?: string;                    // redacted, ≤ 200 chars
  /** null when rulesync.jsonc could not be parsed. */
  target_configured: boolean | null;
  /** Features rulesync.jsonc configures for this target; empty when unknown or not configured. */
  features: string[];
  /** Load-gate notes for configured features this target may not load (from Adapter.rules.gates). */
  gates: string[];
};

export type RulesReport = {
  mode: "check" | "pointer";
  found: string[];          // cwd-relative, sorted
  unseen: string[];         // subset of found the target will not read natively
  pointer_injected: boolean;
  rulesync?: RulesyncReport; // absent when the repo has no .rulesync/
};
// TaskMeta.rules?: RulesReport  (absent when --rules off)
```

`baton status` / `wait` 原样输出。

### 3.5 prompt 注入（仅 `--rules pointer`）

- 只在第一轮、且 `unseen` 非空时注入；位置在 scope 提示之后、用户 prompt 之前，最后仍由 `buildPrompt` 追加输出协议。
- 只写“去读哪些文件”，不内联文件内容。
- 文本为英文：

```text
This repository has project rules your CLI does not load automatically:
- ../../CLAUDE.md
- .cursor/rules/ (read the rule files that apply to the files you change)
Before editing, read each file above (and any files they reference with @path) and follow those rules.

```

### 3.6 rulesync 环境检查

**rulesync 可执行文件的查找顺序**（`start`、supervisor、worktree 共用同一个函数）：

1. `<git 仓库根目录>/node_modules/.bin/rulesync`（项目内安装）；
2. 对 worktree：主仓库根目录的 `node_modules/.bin/rulesync`（worktree 里通常没有 `node_modules`）；
3. `PATH` 上的 `rulesync`（复用 `which`）。

**绝不使用 `npx`**，避免下载和网络等待。

**阶段一：`start()` 中读配置（同步、只读文件，耗时可忽略）**

仓库根目录没有 `.rulesync/` 时不生成 `rulesync` 字段。有的话：

- 读取 `rulesync.jsonc`，再用 `rulesync.local.jsonc` 覆盖（浅合并顶层键）。用一个容错的 JSONC 解析：去掉字符串外的 `//`、`/* */` 注释和尾逗号后再 `JSON.parse`。解析失败时 `target_configured: null`、`features: []`，不报错。
- 计算目标执行者的 `rulesyncTarget` 是否被配置：数组形式时在列表里或列表含 `"*"`；对象形式时是对象的键。
- 计算该目标的 features：对象形式取它自己的列表，数组形式取顶层 `features`；`"*"` 展开为全部 features。
- `gates`：对 `features` 中出现的 `mcp`、`hooks`，取 adapter 的 `gates` 说明。
- 找不到 rulesync 可执行文件时，`status: "skipped"`，`detail` 写明原因；否则 `status: "pending"`。

**阶段二：supervisor 第一轮执行 `--check`**

- 条件：`meta.turn === 1`，`meta.rules.rulesync.status === "pending"`。
- 命令：`rulesync generate --check`，**不传 `--targets`、`--features`**，`cwd` 为仓库根目录。
- 使用**异步** `spawn`，超时 15 秒，环境变量带 `BATON_DELEGATION=1`。不能用同步调用：supervisor 靠心跳证明存活，同步调用会阻塞事件循环、让心跳停止。
- 调用位置：心跳计时器启动之后、空闲计时器和执行者启动之前，检查耗时不计入执行者的超时。
- 退出码 0 记为 `in_sync`，1 记为 `stale`；其他退出码、超时、启动失败记为 `error`，`detail` 取 stderr 前 200 字符并脱敏。
- **任何情况都不阻断任务**，不改变任务最终状态；`--check` 不写文件，不影响 `--scope` 和 `--mode readonly` 的 git 基线。

### 3.7 worktree 生成

在 `addWorktree` 中，`prepareWorktree`（处理 `copy` / `symlink`）之后、`post_create` 之前执行：

- 条件：新 worktree 根目录有 `.rulesync/`，能按 3.6 的顺序找到 rulesync，且 `.baton.json` 没有设置 `"worktree": { "rulesync": false }`（非布尔值按未设置处理）。
- 命令：`rulesync generate`，不带参数，完全遵循用户配置；`cwd` 为新 worktree，超时 60 秒。
- 失败**不**回滚 worktree，只在结果里报告。这与 `post_create` 失败会回滚不同，是有意为之：环境生成是增强功能，不应该让 worktree 创建失败。
- 生成后用 `git status --porcelain` 检查新 worktree 里**已提交文件**的改动（忽略未追踪文件），列入 `dirtied`。出现这种情况说明主仓库里的生成文件已经过期；文档建议先在主仓库生成并提交。
- 结果新增字段：

```ts
// WorktreeAddResult
rules?: {
  rulesync: "generated" | "skipped" | "error";
  detail?: string;
  /** Rule files present in the main repo root but missing in the new worktree after setup. */
  missing: string[];
  /** Tracked files that rulesync generate modified in the new worktree. */
  dirtied: string[];
};
```

- `missing`：主仓库根目录存在、新 worktree 里没有的规则文件（典型情况是被 gitignore 的 `CLAUDE.local.md`），只检查仓库根目录这一层，使用 3.2 的文件清单。

## 4. 命令（Commands）

开发与验证：

```bash
npm install
npm run typecheck          # tsc --noEmit
npm test                   # typecheck + node --test "test/**/*.test.ts"（worktree 测试需在沙箱外运行）
npm run build              # tsc -p tsconfig.build.json
```

用户可见接口：

```bash
baton start --target codex --rules pointer --prompt "..."   # 注入规则提示
baton start --target codex --rules off --prompt "..."       # 关闭全部检测
baton status <task_id>                                      # 输出包含 rules 字段
baton worktree add --name feat-x                            # 结果包含 rules 字段
```

`.baton.json`：

```json
{ "worktree": { "rulesync": false } }
```

## 5. 项目结构（Project Structure）

| 路径 | 改动 |
|---|---|
| `src/rules.ts` | **新增**：规则发现、覆盖计算、pointer 文本、rulesync 查找、JSONC 配置读取、`--check` 与 `generate` 调用封装 |
| `src/types.ts` | 新增 `EnvFeature`、`RuleSupport`、`RulesyncReport`、`RulesReport`；`Adapter.rules?`、`TaskMeta.rules?` |
| `src/adapters/{claude,codex,cursor,agy}.ts` | 各自补充 `rules` 声明 |
| `src/tasks.ts` | `StartInput.rules`；`start` 中做规则发现、读 rulesync 配置、pointer 注入 |
| `src/supervisor.ts` | 第一轮执行 `rulesync generate --check`，写入 `meta.rules.rulesync` |
| `src/cli.ts`、`src/mcp.ts` | 解析 `--rules` / `rules` 并校验取值 |
| `src/worktree.ts` | `.baton.json` 新字段；生成环境、`missing` 与 `dirtied` 检测 |
| `test/rules.test.ts`、`test/rules-start.test.ts` | **新增** |
| `test/fake-cli/rulesync` | **新增**假 rulesync，行为由环境变量控制 |
| `docs/reference.md`、`docs/reference.zh-CN.md` | `--rules`、`meta.rules`、`.baton.json` 新字段、各 CLI 规则与关卡表、已知限制 |
| `README.md`、`README.zh-CN.md` | FAQ 新增一条：如何让执行者用上项目环境（推荐 `AGENTS.md` 与 rulesync） |
| `skills/baton-rescue/SKILL.md`、`skills/baton-orchestrate/SKILL.md` | 只补一句：`rules.unseen` 非空、`rules.rulesync.status` 为 `stale`、`target_configured` 为 `false` 或 `gates` 非空时告知用户 |

## 6. 代码风格（Code Style）

沿用现有代码：ESM + TypeScript 源码直接被 `node` 运行、函数短小、注释只解释约束。示例风格参照 `src/scope.ts`：

```ts
/** Rule files the target will not load natively; paths are cwd-relative. */
export function unseenRules(found: string[], support: RuleSupport | undefined): string[] {
  if (!support) return found;
  return found.filter((rel) => !readsNatively(rel, found, support));
}
```

- 不新增任何运行时依赖（JSONC 用自写的容错解析）。
- 所有对外输出保持“一个 JSON 对象”的约定。
- 所有进入 `meta` 的外部文本（rulesync 的 stderr）先经过 `redact`。
- 仓库内代码、注释、英文文档保持英文（约定，不做测试强制）。

## 7. 测试策略（Testing Strategy）

框架：`node --test`，使用 `test/helpers.ts` 和 `test/fake-cli/`，不消耗模型额度。测试环境的 `PATH` 只有假 CLI 目录和 `/usr/bin:/bin`，本机真实的 rulesync 不会干扰测试。

**单元测试（`test/rules.test.ts`）**

- 发现：多层目录结构下 `found` 的内容和顺序；非 git 目录只扫 `cwd`；空的 `.cursor/rules` 不计入。
- 覆盖：四个 adapter 各一组用例；Claude 条件规则的两种情况。
- pointer 文本：`unseen` 为空时不生成；文件和目录的写法。
- JSONC 配置读取：带注释和尾逗号能解析；`rulesync.local.jsonc` 覆盖；数组形式、对象形式、`"*"` 三种 targets；解析失败返回 `null`。
- rulesync 查找顺序：项目内、主仓库、`PATH` 三级回退。

**集成测试（`test/rules-start.test.ts`）**

- 默认 `check`：prompt 与当前版本逐字一致（防回归）。
- `--rules pointer`：第一轮包含提示，`reply` 那一轮不包含。
- `--rules off`：没有 `meta.rules`。
- rulesync：假脚本返回 0、1、2 及卡住超时，分别得到 `in_sync`、`stale`、`error`、`error`，任务最终状态都是 `success`；断言假脚本收到的参数**只有** `generate --check`。
- rulesync 卡住期间，`status` 不会把任务判定为 supervisor 已退出。
- `rulesync.jsonc` 不包含目标时 `target_configured: false`；包含 `mcp` 且目标声明了关卡时 `gates` 非空。
- 没有 `.rulesync/` 时没有 `rulesync` 字段；有 `.rulesync/` 但找不到可执行文件时为 `skipped`，`start` 返回时为 `pending`。
- scope 联动：`--scope` 加 `--rules check` 时不产生越界报告。

**worktree（`test/worktree.test.ts`）**

- 有 `.rulesync/` 时调用了假 `rulesync generate`，结果为 `generated`；`"rulesync": false` 时为 `skipped`；假脚本返回非 0 时为 `error`，worktree 仍创建成功。
- 被 gitignore 的 `CLAUDE.local.md`：`missing` 包含它；在 `copy` 里配置后不包含。
- 假脚本改动一个已提交文件时，`dirtied` 列出它。

**MCP**：`test/mcp.test.ts` 补充 `rules` 参数的 schema 校验。

## 8. 边界（Boundaries）

- **始终**：所有检测和生成的失败都只记录、不阻断；默认不改 prompt；新增字段全部可选、向后兼容；提交前 `npm test` 通过。
- **先问再做**：新增运行时依赖；改变 `--rules` 默认值；修改执行者的启动参数（包括 `--approve-mcps`、`--dangerously-bypass-hook-trust`、`--trust` 等放宽权限的参数）；修改技能文档超出“补一句”的内容；读取用户主目录下的任何配置。
- **绝不**：把规则内容内联进 prompt；在用户工作目录（非 Baton 新建的 worktree）里运行 `rulesync generate` 或写任何文件；用 `npx` 下载 rulesync；给 `--check` 传 `--targets` 或 `--features`；运行 `rulesync generate --global`；修改用户的 `.rulesync/`、`rulesync.jsonc`、`rulesync.local.jsonc`。

## 9. 成功标准（Success Criteria）

1. 只有 `CLAUDE.md` 的仓库里，`start --target codex` 的 `rules.unseen` 包含 `CLAUDE.md`；派给 `cursor` 时 `unseen` 为空。
2. 不加 `--rules` 时，执行者收到的 prompt 与当前版本逐字相同。
3. `--rules pointer` 时，第一轮 prompt 包含 3.5 节的提示，后续 `reply` 不包含。
4. 有 `.rulesync/` 且能找到 rulesync 时，`rules.rulesync.status` 最终为 `in_sync` 或 `stale`，与项目整体 `rulesync generate --check` 的退出码一致；修改 `.rulesync/mcp.jsonc` 而不重新生成，也会得到 `stale`。
5. `rulesync.jsonc` 未配置目标执行者时 `target_configured` 为 `false`；为 cursor 配置了 `mcp` 时，派给 cursor 的任务 `gates` 包含 `--approve-mcps` 的说明。
6. rulesync 卡住或报错时，`baton start` 的返回时间不变，任务最终状态不受影响，也不会被误判为 supervisor 已退出。
7. `baton worktree add` 在有 `.rulesync/` 的仓库里会生成环境文件；生成失败时 worktree 仍创建成功；改动了已提交文件时 `dirtied` 列出它们。
8. 被 gitignore 的 `CLAUDE.local.md` 在新 worktree 中缺失时，`rules.missing` 列出它。
9. `npm test` 全部通过，新增测试覆盖第 7 节全部场景。

## 10. 不在本版范围（Non-goals）

- 配置格式之间的转换或合并（交给 rulesync）。
- 用户级环境（`~/.claude/CLAUDE.md`、用户级 skills 和 MCP 等），包括 `rulesync generate --global --check`。列为后续版本。
- 修改执行者启动参数来通过 MCP 或 hook 的加载关卡。本版只提示。
- 按单个执行者检查 rulesync 同步状态（原理上不成立，见 2.2）。
- 新增执行者（Gemini CLI、OpenCode 等）。adapter 声明已预留扩展方式。
- 读取 `~/.codex/config.toml`（`project_doc_fallback_filenames`、`trust_level`）。已知后果：用户若已配置 Codex 读 `CLAUDE.md`，它仍会被报告为 `unseen`。
- 规则目录内的细粒度判断。
- 大幅修改 `baton-rescue` / `baton-orchestrate` 的验收流程。

## 11. 已决事项（Decisions）

1. **英文检查测试**：已删除 `test/english.test.ts`，“仓库只用英文”改为约定，`.github/CONTRIBUTING.md` 已更新。
2. **Codex 回退文件名配置**：本版不做。
3. **Codex 项目信任**：见 2.4。Codex 升级到 0.169 及以上后，复核 `codex exec` 是否需要 `--trust`；若需要，是否默认传入要单独问（会同时放开项目 `.codex/config.toml` 和 MCP）。
4. **规则目录粒度**：保持目录级，理由是覆盖判断只需目录级信息、各家触发语义无法跨 CLI 对应、解析 frontmatter 会让 Baton 绑定各家格式。pointer 对目录给出“read the rule files that apply to the files you change”。
5. **rulesync 检查范围**（v2 新增）：检查整个项目，不传 `--targets`、`--features`，按用户配置检查全部 features；目标是否在配置内单独报告。
6. **加载关卡**（v2 新增）：只提示、不改启动参数；实现前先用本机 CLI 实测未核实的两项（T0）。
7. **用户级环境**（v2 新增）：本版不做，列为后续版本。
8. **其他**（v2 新增）：支持项目内安装的 rulesync；worktree 生成后报告被改动的已提交文件；参数名保留 `--rules`。

## 12. 待决问题（Open Questions）

无。T0 实测结果如果推翻 2.3 中的假设，再回到本节。
