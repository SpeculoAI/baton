# Spec: 交接上下文 — V1

Status: proposed

## Objective

让宿主（主要是通过 baton skill 或 MCP 调用的 agent）几乎不多花 token，就能把已经掌握的上下文完整、可信地交给子任务。子任务首轮从"冷启动重新探索"变成"直接动手"，结果质量不下降，效果可以用 baton 自己的数据量化。

**用户**：用 baton 把任务交给另一个本地 agent CLI 的宿主 agent，以及看成本和效果的人。

**现状证据**（2026-11-26，`~/.baton/tasks` 里 80 个有工具调用的任务，统计脚本按工具名和命令正则分类）：

| 指标 | 数值 |
|---|---|
| 首轮调用构成 | 6068 次：探索 60%、编辑 23%、验证 10% |
| 首次编辑前的调用数 | 中位 42，p75 68，最大 114 |
| 单任务输入 token 中位 | codex 2.0M、cursor 3.5M、agy 2.75M（缓存命中 93%～97%） |
| 输入与输出之比 | 约 100:1 |
| 重读 prompt 已点名文件 | 607/1322 次 read（46%） |
| 重新加载规则或 skill 文件 | 29 个任务、69 次 |
| `reply` 续轮对比首轮 | 调用数下降 80%～95%（如 135→13、87→3） |

典型例子：任务 `00e73c2d`（codex）的 prompt 写明了路径和"约 150-155 行"，子任务仍然全仓库跑 `rg`，还检查了 `.codegraph` 是否存在。

**根因**：
- 交接只传了一段 prompt。`buildPrompt`（`src/contract.ts:17`）只拼一行路径列表。
- skill 只要求写清"完成标准和看哪些文件"（`skills/baton-rescue/SKILL.md:48`）。
- 宿主已确认的事实、读过的代码、这些信息的可信度都没有交过去。
- baton 看不到成本：四个 adapter 都解析了终止事件，但丢掉了 usage（例如 `src/adapters/codex.ts:87` 对 `turn.completed` 直接返回空），也不区分调用类型。

## 关键决策

### 可观测（`handoff-metrics`）

- **D1 `tool_call` 增加 `kind`，shell 再增加 `intent`。**
  - `kind`：`"read" | "search" | "edit" | "shell" | "other"`。
  - `intent`：只在 `kind` 为 `"shell"` 时出现，取值 `"explore" | "verify"`，两类都不是时不写。
  - 每个 adapter 用一张工具名到 `kind` 的映射表，表里没有的名字一律记为 `other`。映射依据真实调用和 CLI 工具清单：

    | adapter | read | search | edit | shell |
    |---|---|---|---|---|
    | codex | — | — | `file_change` | `command_execution` |
    | claude | `Read` | `Grep`、`Glob`、`LS` | `Edit`、`MultiEdit`、`Write`、`NotebookEdit` | `Bash` |
    | cursor | `read` | `grep`、`glob` | `edit`、`delete` | `shell` |
    | agy | `read_file` | `grep_search`、`find_by_name`（CLI 清单） | `edit_file`、`write_file` | `run_command` |
    | kimi | `Read` | `Grep`、`Glob` | `Edit`、`Write` | `Bash` |

  - codex 所有的读取都经过 shell，所以 codex 的探索统计完全依赖 `intent`。
  - agy 的 `init.tools` 声明了 `grep_search`、`find_by_name`，T0 两轮未观察到这两个工具的 `tool_name`，实际走 `run_command` 执行 `rg` 和 `ls`。kimi 的 `Read`、`Grep`、`Glob`、`Bash` 来自 stdout 里的实际调用，`Edit`、`Write` 来自同一会话的 `llm.tools_snapshot`，只读探测未调用这两个编辑工具。
- **D2 shell 意图分类。** 在 `src/adapters/common.ts` 新增纯函数 `shellIntent(command)`，adapter 在截断 `detail` 到 200 字符**之前**、用完整命令调用它。规则：
  1. 剥掉外层包装 `/bin/zsh -lc '…'`、`bash -lc "…"`、`sh -c …`。
  2. 按 `&&`、`||`、`;`、`|`、换行切成若干段。
  3. 任一段的首个命令是测试、构建、检查类（`npm`、`pnpm`、`yarn`、`npx`、`node --test`、`vitest`、`jest`、`tsc`、`eslint`、`prettier`、`pytest`、`go test`、`cargo`、`make`），记为 `verify`。
  4. 否则，所有段都是只读命令（`rg`、`grep`、`cat`、`sed -n`、`head`、`tail`、`ls`、`find`、`fd`、`wc`、`nl`、`tree`、`stat`、`git status|log|show|diff|grep|ls-files|blame`、`codegraph`），记为 `explore`。
  5. 其他情况不写 `intent`。
  - 这是有意接受误差的启发式规则，测试里用一张命令到结果的表格固定下来。
- **D3 新增 `usage` 事件。**
  - 格式：`{ type: "usage", input, cached_input, output, reasoning?, raw }`。
  - `input` 是**含缓存的总输入**，`cached_input` 是其中走缓存读取的部分。`raw` 原样保存来源 usage 对象的顶层数值字段。
  - 归一规则：

    | adapter | 来源事件 | `input` | `cached_input` | `output` | `reasoning` |
    |---|---|---|---|---|---|
    | codex | `turn.completed.usage` | `input_tokens`（已含缓存） | `cached_input_tokens` | `output_tokens` | `reasoning_output_tokens` |
    | cursor | `result.usage` | `inputTokens + cacheReadTokens + cacheWriteTokens` | `cacheReadTokens` | `outputTokens` | `reasoningTokens` |
    | agy | `result.usage` | `input_tokens + cache_read_tokens` | `cache_read_tokens` | `output_tokens` | `thinking_tokens` |
    | claude | `result.usage` | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` | `cache_read_input_tokens` | `output_tokens` | `output_tokens_details.thinking_tokens`（存在时） |
    | kimi | `stream-json` 两轮均无 usage | — | — | — | — |

  - T0 首轮和续轮实测的 usage 口径：

    | adapter | 续轮终止 usage | 每轮 raw 日志里的 usage |
    |---|---|---|
    | codex | 会话累计。同一 thread 的两轮 `turn.completed.usage` 都与会话日志的 `total_token_usage` 一致 | 各 1 条终止 usage |
    | cursor | 本轮值 | 各 1 条终止 usage |
    | agy | 会话累计。续轮每个数值字段的终止值等于首轮终止值加续轮各 step 的该字段之和 | 各 1 条终止 usage，另有各 2 条 `step_update.usage` |
    | claude | 本轮值 | 各 1 条终止 usage，另有 7 条（首轮）和 2 条（续轮）`assistant.message.usage`，同一消息可重复出现 |
    | kimi | 无 usage | 两轮各 0 条，输出以 `session.resume_hint` 收尾 |

  - 只从表中指定的终止来源发 `usage` 事件。一个 turn 内若有多个终止 usage，**最后一个为准**。输出没有 usage 就不发事件，`stats` 里 kimi 的 token 指标为 null。
  - codex、agy 的新会话首轮直接使用终止值。同一会话续轮在 `summarizeEvents` 外做差分，按同一归一公式换算当前轮和上一轮的终止快照，再逐项计算 `input`、`cached_input`、`output`、`reasoning` 的差值。`raw` 保留当前轮的原始累计快照，供下轮取基线。缺失上一轮快照、计数回退或可选字段缺少任一轮的值时，相应差值视为未知。必填字段未知时不把该轮计入 token 统计。
  - `usage` 事件照常写进 `events.jsonl`，`baton tail` 显示为一行 `usage in=… cached=… out=…`。
- **D4 turn 汇总。** 新模块 `src/metrics.ts` 导出纯函数 `summarizeEvents(events)`，返回：

  ```ts
  type TurnActivity = {
    tool_calls: number;
    by_kind: { read: number; search: number; edit: number; shell: number; other: number };
    explore: number;           // read + search + shell 中 intent 为 explore 的
    verify: number;            // shell 中 intent 为 verify 的
    before_first_edit: number | null; // 第一次 edit 之前的调用数；整轮没有编辑时为 null
  };
  type TurnUsage = { input: number; cached_input: number; output: number; reasoning?: number; raw: Record<string, number> };
  ```

  - `Turn` 增加可选字段 `activity?: TurnActivity`、`usage?: TurnUsage`。
  - supervisor 在流式处理时，把当前 turn 的 `tool_call` 和 `usage` 事件收集到内存。turn 结束时调用 `summarizeEvents`，和 `git_changes` 在同一处写进 `turns/N.json`（`src/supervisor.ts:272` 附近）。
  - 走孤儿收尾路径（`status()`）的 turn 不写这两个字段，由 `stats` 回放补算。
- **D5 展示。** 任务终止后的视图（`finished()`，`src/tasks.ts` 中已经附带 `git_changes` 的那一处）同样附带当前 turn 的 `activity` 和 `usage`。所以 `baton status`、`baton wait`，以及 MCP 的 `task_status`、`task_wait` 自动都能看到。`baton result` 保持只输出纯文本，不变。
- **D6 新增 `baton stats`。**
  - 用法：`baton stats [--target <agent>] [--since <date>] [--all]`。
    - 范围：和 `baton ls` 一致，默认只统计当前 cwd 下的任务，`--all` 统计全部。
    - `--since` 接受 ISO 日期，或 `7d` 这类相对天数。
    - 输出 JSON，和其他数据类命令一致。顶层带 `schema_version: 1`、`generated_at`、`note`（口径说明）和 `targets`（按 target 分组的对象）。
  - 按 target 分组，输出以下指标：
    - `tasks`
    - `measured`：能算出 activity 的任务数
    - `first_turn.before_first_edit`：中位数、p75
    - `first_turn.explore_share`：Σexplore / Σtool_calls
    - `first_turn.input`、`first_turn.output`：中位数
    - `first_turn.cached_share`
    - `rework_rate`：turn ≥ 2 的任务占比
    - `check_failed_rate`：带 `--check` 的任务中，任一轮 check 失败的占比
  - **回放**：turn 记录里没有 `activity` 时，读取 `raw/N.stdout.log`，逐行交给该 target 的 `adapter.parseLine`，再调用同一个 `summarizeEvents`。raw 日志不存在（已被 prune）的任务计入 `tasks`，不计入 `measured`。
  - MCP 不新增对应工具（见 Out of Scope）。
  - 输出里带一行固定说明：各 CLI 的 usage 口径不同，只适合比较同一 CLI 改动前后的变化。

### 代码片段（`file-snippets`）

- **D7 语法 `--file <path>[:<start>[-<end>]]`。**
  - 解析顺序：
    1. 整个参数是一个存在的文件时，当作普通路径。
    2. 否则用行尾正则 `/:(\d+)(?:-(\d+))?$/` 拆出行号，前半段必须是存在的文件。
    
    这样兼容 Windows 盘符（`C:\a\b.ts:10-20`）和文件名本身带冒号的情况。
  - `:N` 等同于 `:N-N`。
  - 不带行号的 `--file`，行为和现在完全一样：只出现在 `Focus on these files` 列表里，不内联内容。
- **D8 校验在 `start()`/`reply()` 里同步完成。** 任何一项不通过都直接报错，不静默截断、不跳过：
  - 相对路径按 task cwd 解析。`--isolate` 时 task cwd 是 worktree，因此片段内容和子任务看到的一致。worktree 来自 HEAD，源目录里未提交的改动不会出现在片段中。
  - `realpathSync.native` 之后必须位于 cwd 的 realpath 之内，防止 `..` 和符号链接逃逸。
  - 必须是普通文件。前 8 KB 里出现 NUL 字节，视为二进制并拒绝。
  - 行号范围：`1 ≤ start ≤ end ≤ 文件行数`，报错信息里带上实际行数。
  - 限额：单段不超过 400 行，本轮所有片段合计不超过 64 KB。
  - **敏感文件拒绝**：按文件名匹配，不区分大小写，命中就拒绝读取，报错提示"在 prompt 里写明位置，由子任务自行读取"。名单：
    - `.env`、`.env.*`，但放行 `.env.example`、`.env.sample`、`.env.template`、`.env.dist`
    - `*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.jks`、`*.keystore`
    - `id_rsa*`、`id_dsa*`、`id_ecdsa*`、`id_ed25519*`
    - `.npmrc`、`.netrc`、`.pypirc`、`.pgpass`、`.git-credentials`、`credentials`、`credentials*.json`
    - 路径中含 `.ssh/`、`.aws/`、`.gnupg/` 段的文件
    
    只按文件名判断，不扫描内容：`redact()` 的正则会误伤 `token: string` 这类正常代码。
- **D9 渲染。**
  - 片段渲染成一段文本，接在宿主 prompt **之后**，开头写明 `Code excerpts (read by baton at task start; current content):`。
  - 每段格式：标题 `path:start-end`，下面是围栏代码块，不加行号前缀。围栏反引号的个数取 3 和"内容中最长连续反引号数 + 1"中的较大者。
  - 渲染结果写进 `turn.prompt`，和现有的 scope、rules pointer 前缀一致（`src/tasks.ts:219`），`turns/N.json` 记录的就是子任务实际看到的内容。`turn.files` 保留原始参数。
  - 最终 prompt 布局：

    ```
    [Focus on these files]   buildPrompt（supervisor，现有）
    [scope 前缀]             start（现有）
    [rules pointer]          start（现有）
    <宿主 prompt>
    [Code excerpts]          start/reply（新增，D9）
    [输入合约]               buildPrompt（新增，D11，检测到标签才注入）
    [输出合约]               buildPrompt（现有）
    ```
- **D10 三处入口。**
  - `baton start --file`。
  - `baton reply` 新增 `--file`（可重复）：片段渲染规则同上，不带行号的路径进入该轮的 Focus 列表。现在 `reply` 不写 `files`，supervisor 照常读 `turn.files`。
  - MCP：`delegate_task.files` 和 `task_reply` 新增的 `files` 采用同样语法，并更新描述。

### 交接简报（`handoff-brief`）

- **D11 来源标签和输入合约。**
  - 标签固定用英文字面量。简报正文用宿主自然使用的语言，标签可以混在中文正文里：

    | 标签 | 含义 | 子任务怎么处理 |
    |---|---|---|
    | `[read <path>:<lines>]` | 宿主交接时刚读过的源码 | 直接用 |
    | `[ran <cmd>]` | 宿主运行过的命令及其结果 | 直接用 |
    | `[user]` | 用户在对话里明确说的 | 直接用，有冲突时停下来问 |
    | `[mem <source>]` | 来自 hindsight 等记忆的过去记录 | 用之前先核对 |
    | `[codegraph]` | 来自代码索引的结构性结论（调用路径、影响面） | 用之前先核对 |
    | `[guess]` | 宿主的推测 | 必须核对 |

  - 检测正则：`/\[(read|ran|user|mem|codegraph|guess)\b[^\]\n]*\]/`。
  - `buildPrompt` 在本轮 prompt（含 reply）里检测到标签时，在输出合约之前注入输入合约（英文）：

    ```
    Facts in this prompt carry source tags.
    - [read …], [ran …], [user] and the code excerpts are current: use them directly and do not search the repository again to re-confirm them.
    - [mem …], [codegraph] and [guess] may be stale or wrong: verify them before relying on them.
    - If what you see contradicts a fact, stop and ask with BATON_DECISION.
    ```

  - 没有标签的 prompt 不受影响。
- **D12 skill 规则**，`baton-rescue` 和 `baton-orchestrate` 两份都写，用英文（`skills.test.ts` 要求 skill 里不出现汉字）：
  - **简报模板**：`Goal`、`Done when`、`Known facts`、`Already ruled out`、`Change points`、`Constraints`、可选的 `Tools hint`。
    - `Done when` 里能写成可执行命令的，用 `--check`。
    - 修改范围用 `--scope` 约束。
  - **只交已经知道的**：不为写简报专门去探索。宿主没有定位过的，写明"not located by host"。
  - **代码给坐标，不手抄**：要改的位置和必须看的接口用 `--file path:start-end`，不给背景代码。
  - **敏感值只写位置**：例如"registry 凭据在 `.env` 的 `NPM_TOKEN`"，绝不把值写进简报。简报会原样落盘到 `turns/N.json`。
  - **工具来源如实标注**：子 CLI 有没有 codegraph、hindsight 等工具由它自己的环境决定。`Tools hint` 只能写成条件句："If you have codegraph available, prefer it over repeated grep."
  - **续会话优先**：同一块工作的后续修改、返工、追问都用 `reply`。只有换了工作区域、会话上下文已被污染、或需要独立视角时才开新任务。
  - **评审例外**：独立评审、对抗性复核类任务只给目标和范围，不给宿主的结论，避免锚定。

## Tech Stack

- Node `>=20.17`，ESM，TypeScript。测试时 Node 直接运行 `.ts`（type stripping）。
- 不新增任何依赖。

## Commands

```
Test:      npm test                    # tsc --noEmit && node --test "test/**/*.test.ts"
Typecheck: npm run typecheck
Build:     npm run build
Dist:      node dist/cli.js stats --all
Run:       node src/cli.ts stats --all
```

## Project Structure

```
src/types.ts              ToolKind、TurnActivity、TurnUsage；EventData 增加 usage、tool_call 增加 kind/intent；Turn 增加 activity/usage
src/adapters/common.ts    shellIntent（D2）
src/adapters/*.ts         工具名映射到 kind（D1）、解析 usage（D3）
src/metrics.ts            summarizeEvents、stats 汇总与 raw 回放（D4/D6），新文件
src/supervisor.ts         收集本轮事件，turn 结束写 activity/usage（D4）
src/tasks.ts              finished() 附带 activity/usage（D5）；start/reply 解析、校验、渲染片段（D7–D10）；stats 入口
src/snippets.ts           片段解析、校验、敏感名单、渲染（D7–D9），新文件
src/contract.ts           标签检测与输入合约（D11）
src/tail.ts               usage 事件的显示
src/usage.ts, src/cli.ts  stats 命令；reply --file；--file 描述更新
src/mcp.ts                delegate_task/task_reply 的 files 描述与参数
skills/baton-rescue/SKILL.md, skills/baton-orchestrate/SKILL.md   D12
docs/reference.md, docs/reference.zh-CN.md, README*               新参数、stats、口径说明
test/fixtures/usage/      各 adapter 真实输出片段（从 ~/.baton/tasks/*/raw 摘取并脱敏）
```

## Code Style

延续现有风格：

- adapter 内就地写映射表，不新建抽象层。
- 纯函数和 IO 分开：`summarizeEvents`、`shellIntent`、`parseFileArg`、`renderExcerpts` 都是纯函数，IO 留在 `tasks.ts`/`metrics.ts` 的入口处。
- 注释只写代码看不出来的原因，一行英文。
- 走捷径的地方写 `shortcut: <限制>, <何时升级>`。

```ts
const KINDS: Record<string, ToolKind> = { read: "read", grep: "search", glob: "search", edit: "edit", delete: "edit", shell: "shell" };
// ...
const kind = KINDS[name] ?? "other";
const intent = kind === "shell" ? shellIntent(String(args.command ?? "")) : undefined;
return event({ type: "tool_call", name, kind, ...(intent ? { intent } : {}), detail });
```

## Testing Strategy

- 框架不变：`node:test` 和 `node:assert/strict`，测试放在 `test/*.test.ts`，假 CLI 用 `test/fake-cli/fake.mjs`。
- **adapter**：每家各一个真实输出 fixture，断言 `kind`、`intent`、`usage` 的归一结果，包括"多个 usage 以最后一个为准"。
- **`shellIntent`**：表格驱动，至少覆盖：
  - 外层包装
  - 复合命令
  - 管道
  - heredoc
  - 只读命令和写命令混在一起
  - 空命令
- **`summarizeEvents`**：覆盖没有编辑、首个调用就是编辑、各类计数。
- **supervisor 集成**：给 fake CLI 加一个输出工具调用和 usage 的模式。跑一次 start，断言 `turns/1.json` 里有 `activity`/`usage`，`status` 视图里也带上。
- **`stats`**：在临时 `BATON_HOME` 下构造任务目录。一部分任务有 `activity`，一部分只有 raw 日志，一部分两者都没有。断言分组、中位数、p75、`measured`、`--since`、`--target`、cwd 过滤。
- **片段**：
  - 解析：普通路径、`:N`、`:N-M`、Windows 盘符、文件名带冒号。
  - 校验：越界、`start > end`、超出 400 行、超出 64 KB、二进制、cwd 逃逸（`..` 和符号链接）、敏感名单（包括放行项）。
  - `--isolate` 时从 worktree 读。
  - 围栏转义。
  - reply 带 `--file`。
- **合约**：`contract.test.ts` 覆盖有标签和无标签两种情况，以及 reply 轮。
- **skill**：`skills.test.ts` 增加对模板章节名、标签名、"reply first"、评审例外的断言，保持不含汉字。
- **真实 CLI 冒烟**（手动，T0 和合并前各一次）：codex、cursor、agy、claude 各跑一次，确认 `usage` 和 `activity` 写进 turn，并且数值和 raw 日志对得上。

## Boundaries

- **Always**
  - 每个 PR 跑 `npm test`，三个平台的 CI 全绿。
  - 旧任务目录（没有新字段）在所有命令下照常可读。
  - 片段校验失败就同步报错。
  - 敏感文件名单命中就拒绝读取。
  - 新的启发式分类配表格测试。
- **Ask first**
  - 新增依赖。
  - 改变现有命令的输出结构：新增字段可以，删除或改名不行。
  - 调整 D8 的限额或敏感名单。
  - 给 MCP 增加 `stats` 工具。
- **Never**
  - 把敏感文件内容写进 prompt 或 `turns/N.json`。
  - 静默截断片段。
  - 不带行号时内联整个文件。
  - 为了让统计好看而修改历史任务数据。
  - 在 skill 里假设子 CLI 拥有某个工具。

## Success Criteria

**合并门槛**（每个模块的 PR 都要满足）：

1. `npm test` 在 ubuntu、macOS、Windows 上全部通过，Testing Strategy 里列出的用例都存在。
2. 对现有 `~/.baton`（只读）运行 `baton stats --all`，能回放出基线：
   - `measured` ≥ 75
   - codex、cursor、agy 三组都有数值
   - `first_turn.before_first_edit` 的中位数和统计脚本的结果（42）在同一量级
3. 真实 CLI 冒烟：codex、cursor、agy、claude 各一次，`turns/1.json` 的 `usage` 和 raw 日志里的原值换算一致，`activity.tool_calls` 和 `events.jsonl` 里的 `tool_call` 数一致。
4. `--file src/x.ts:10-20` 的片段原样出现在子任务收到的 prompt 里；`--file .env:1-3` 被拒绝，并且 `turns/` 下找不到该文件的内容。
5. 带标签的简报会注入输入合约，不带标签的 prompt 和改动前逐字节一致（`Focus` 和输出合约部分）。
6. `docs/reference*.md` 写明 `stats` 的口径说明、`--file` 行号语法、限额和敏感名单。

**效果目标**（上线后观察，不作为合并门槛）：启用简报的任务累计 ≥ 20 个之后，按 CLI 分组对比基线：

| 指标 | 基线 | 目标 |
|---|---|---|
| 首次编辑前调用数中位 | 42 | ≤ 20 |
| 首轮探索占比 | 60% | ≤ 40% |
| 首轮输入 token 中位 | codex 2.0M / cursor 3.5M / agy 2.75M | 各降 ≥ 30% |
| `rework_rate`、`check_failed_rate` | 基线值 | 不上升 |

前后两批任务的类型不同，只看趋势，不做精确归因。没达标时根据 `stats` 调整 skill 规则或限额。

## 交付拆分

能力图（每个模块会单独拆成模块 spec）：

| 模块 id | 内容 | 依赖 |
|---|---|---|
| `handoff-metrics` | D1–D6 | — |
| `file-snippets` | D7–D10 | — |
| `handoff-brief` | D11–D12 | `file-snippets`（skill 要引用 `--file` 行号语法） |

构建顺序：

0. **T0 验证（不写代码）**：claude 的 `result.usage` 字段、agy 的搜索类工具名、kimi 的工具名和 usage，以及各家续轮的 usage 语义。各跑两轮真实调用，结果回写 D1、D3。
1. **PR 1 `handoff-metrics`**：合并后先用 `stats` 记录基线。
2. **PR 2 `file-snippets`**。
3. **PR 3 `handoff-brief`**。
4. **复盘**：跑满 20 个以上任务后，用 `stats` 对照效果目标。

## Out of Scope (Deferred)

- **探测或安装子 CLI 的 MCP/工具**：属于宿主环境，baton 无权也无法保证。
- **探索成果自动回流**（子任务的 findings 自动注入下一个任务）：会过期、带噪声，可能误导后续任务。续会话加简报已经覆盖主要场景。
- **硬性探索步数预算**：baton 无法可靠地中途干预各家 CLI，误杀正常探索的代价比省下的 token 大。
- **跨 CLI 统一 token 计价**：各家口径不同。
- **简报做成 MCP 结构化参数**：先用模板加标签验证效果，宿主普遍不遵守时再升级。
- **MCP `stats` 工具**：宿主很少需要跨任务统计，有需求再加。
- **内容级敏感信息扫描**：误报太多。
- **`stats` 网页报告**：用户计划以后基于 `stats` 的 JSON 生成网页，V1 只保证 JSON 稳定。

## Open Questions

- T0 的待验证事实：claude usage 字段、agy 搜索工具名、kimi 工具名和 usage、各家续轮 usage 语义。

已决定（2026-11-26）：
- `stats` 只输出 JSON。以后要基于它生成网页，所以 JSON 结构按对外接口对待：字段只增不改名，带 `schema_version`。
