# Todo: 交接上下文

Source spec: `SPEC-handoff-context.md` · Plan: `tasks/plan.md`

通用验证命令：`npm test`（即 `tsc --noEmit && node --test "test/**/*.test.ts"`）。单个文件用 `node --test test/<name>.test.ts`。

## Phase 0: 验证

### Task 0: T0 真实 CLI 验证

**Description:** 不写代码，确认 spec 里还没坐实的四件事：
- claude `result.usage` 的字段名
- agy 搜索类工具的名字
- kimi（#92 新增的 adapter）的工具名和 usage，以及它的输出里是否带 usage
- 五家续轮的 usage 是本轮值还是会话累计值
- 每轮是否只有一个 usage 事件

结果回写 spec 的 D1、D3，并把真实输出片段沉淀成测试 fixture。

已经准备好的两轮只读探测任务（第 2 轮的 `readonly_violation` 是宿主同时改了工作区造成的，不影响数据）：claude `db2266e0-2e63-4ad9-a236-e6513fd47e00`、agy `f965f2fd-1b48-41f9-8807-410563c9e47b`、kimi `26cdef6b-16ee-4f8e-bf78-f93544262717`。raw 日志在 `~/.baton/tasks/<id>/raw/{1,2}.stdout.log`。

**Acceptance criteria:**
- [ ] spec D1 的 agy search 一列和 kimi 一行、D3 的 claude 和 kimi 两行改成实测值；D3 写明各家续轮的 usage 语义，需要差分修正的写出修正规则
- [ ] `test/fixtures/usage/{codex,cursor,agy,claude,kimi}.jsonl` 各包含至少一个 tool_call 行和终止 usage 行，已脱敏（不含路径里的用户名、token、提示词正文）

**Verification:**
- [ ] 读取三个探测任务的 `raw/1.stdout.log` 和 `raw/2.stdout.log`，比较两轮的 usage
- [ ] 从现有的 codex、cursor 多轮任务里比较 `raw/1` 和 `raw/2` 的 usage

**Dependencies:** None

**Files likely touched:**
- `SPEC-handoff-context.md`
- `test/fixtures/usage/*.jsonl`

**Estimated scope:** S

## Phase 1: handoff-metrics（PR 1）

### Task 1: 类型、`shellIntent`、`summarizeEvents`

**Description:** 先把纯函数和类型立住，后面的任务都用它们。内容包括：
- `ToolKind`、`TurnActivity`、`TurnUsage`
- `EventData` 增加 `usage`，`tool_call` 增加可选的 `kind`/`intent`
- `Turn` 增加可选的 `activity`/`usage`
- `shellIntent` 按 spec D2 实现
- `summarizeEvents` 按 spec D4 实现（若 Task 0 结论需要，加差分修正）

**Acceptance criteria:**
- [ ] `shellIntent` 的表格测试覆盖：外层包装、复合命令、管道、heredoc、只读和写命令混用、空命令
- [ ] `summarizeEvents` 覆盖：没有编辑（`before_first_edit` 为 null）、首个调用就是编辑、各类计数、多个 usage 以最后一个为准
- [ ] 所有新字段都是可选的，现有测试不改断言

**Verification:**
- [ ] `node --test test/metrics.test.ts`
- [ ] `npm run typecheck`

**Dependencies:** Task 0

**Files likely touched:**
- `src/types.ts`
- `src/adapters/common.ts`
- `src/metrics.ts`（新）
- `test/metrics.test.ts`（新）

**Estimated scope:** M

### Task 2: codex、cursor adapter 输出 kind/intent/usage

**Description:** codex 解析 `turn.completed.usage`，cursor 解析 `result.usage`，两家都按 spec D1 的映射表给 `tool_call` 填 `kind`，shell 类填 `intent`。`intent` 必须用截断前的完整命令计算。

**Acceptance criteria:**
- [ ] 用 Task 0 的 fixture 回放，`kind`/`intent` 和 usage 的归一值与 spec D1、D3 一致
- [ ] 映射表里没有的工具名（如 cursor 的 `mcp`、`webFetch`）记为 `other`
- [ ] 原有的 message/tool_result/error 事件输出不变

**Verification:**
- [ ] `node --test test/adapters.test.ts`

**Dependencies:** Task 1

**Files likely touched:**
- `src/adapters/codex.ts`
- `src/adapters/cursor.ts`
- `test/adapters.test.ts`

**Estimated scope:** S

### Task 3: claude、agy、kimi adapter 输出 kind/intent/usage

**Description:** 和 Task 2 相同，对象换成 claude（`result.usage`）、agy（`result.usage`）和 kimi。字段以 Task 0 的实测为准；kimi 没有 usage 时只做 `kind`/`intent`。

**Acceptance criteria:**
- [ ] 用 Task 0 的 fixture 回放，结果与 spec 一致
- [ ] claude 的 `Bash`、agy 的 `run_command`、kimi 的 shell 工具带 `intent`
- [ ] 原有事件输出不变

**Verification:**
- [ ] `node --test test/adapters.test.ts`

**Dependencies:** Task 1

**Files likely touched:**
- `src/adapters/claude.ts`
- `src/adapters/agy.ts`
- `src/adapters/kimi.ts`
- `test/adapters.test.ts`

**Estimated scope:** M

### Task 4: supervisor 写入 activity/usage，展示到终止视图和 tail

**Description:** supervisor 在流式处理时收集当前 turn 的 `tool_call`/`usage` 事件，turn 结束时调用 `summarizeEvents`，和 `git_changes` 在同一处写进 turn。`finished()` 附带当前 turn 的 `activity`/`usage`。`tail` 把 usage 事件显示成一行。

**Acceptance criteria:**
- [ ] 用 `FAKE_FIXTURE` 回放 codex fixture，跑一次 start，`turns/1.json` 里有 `activity`/`usage`，且 `activity.tool_calls` 等于 `events.jsonl` 里的 `tool_call` 数
- [ ] `baton status`、`baton wait` 的终止视图带上这两个字段；MCP `task_status` 测试也覆盖到
- [ ] 孤儿收尾的 turn 不写这两个字段，`status` 不报错

**Verification:**
- [ ] `node --test test/observe.test.ts test/lifecycle.test.ts test/mcp.test.ts`

**Dependencies:** Task 2

**Files likely touched:**
- `src/supervisor.ts`
- `src/tasks.ts`
- `src/tail.ts`
- `test/observe.test.ts`

**Estimated scope:** M

### Task 5: `baton stats` 命令

**Description:** 按 spec D6 实现：
- 参数 `--target`、`--since`（ISO 日期或 `Nd`）、`--all`，cwd 过滤和 `ls` 一致
- 输出 JSON，顶层字段为 `schema_version: 1`、`generated_at`、`note`、`targets`
- turn 里没有 `activity` 时，用 adapter 的 `parseLine` 回放 `raw/N.stdout.log`；raw 也不存在时，计入 `tasks`，不计入 `measured`

**Acceptance criteria:**
- [ ] 在临时 `BATON_HOME` 下构造三类任务（有 activity、只有 raw、两者都没有），断言分组、中位数、p75、`explore_share`、`cached_share`、`rework_rate`、`check_failed_rate`、`measured`
- [ ] `--since`、`--target`、`--all`、cwd 过滤各有用例
- [ ] `baton stats -h` 由 `src/usage.ts` 的选项表生成，`help.test.ts` 通过

**Verification:**
- [ ] `node --test test/stats.test.ts test/help.test.ts`
- [ ] `node src/cli.ts stats --all` 在真实 `~/.baton` 上只读运行成功

**Dependencies:** Task 4

**Files likely touched:**
- `src/metrics.ts`
- `src/usage.ts`
- `src/cli.ts`
- `test/stats.test.ts`（新）

**Estimated scope:** M

### Task 6: metrics 文档、冒烟、基线

**Description:** 文档写明以下内容：
- `activity`、`usage` 字段
- `baton stats` 的用法、JSON 结构和口径说明
- `tail` 里的 usage 行

然后用 codex、cursor、agy、claude、kimi 各跑一次真实任务做冒烟。最后记录基线。

**Acceptance criteria:**
- [ ] `docs/reference.md`、`docs/reference.zh-CN.md` 更新
- [ ] 五家冒烟：`turns/1.json` 的 usage 和 raw 原值换算一致，`activity.tool_calls` 和 `tool_call` 事件数一致
- [ ] `baton stats --all` 的基线（每个 target 的 `measured`、`before_first_edit` 中位/p75、`explore_share`、`first_turn.input` 中位）写进 `tasks/plan.md`，并满足 `measured ≥ 75`、中位数和统计脚本的 42 同一量级

**Verification:**
- [ ] `npm test`
- [ ] `npm run build && node dist/cli.js stats --all`

**Dependencies:** Task 5

**Files likely touched:**
- `docs/reference.md`
- `docs/reference.zh-CN.md`
- `tasks/plan.md`

**Estimated scope:** S

### Checkpoint: PR 1
- [ ] `npm test` 在 ubuntu、macOS、Windows CI 全绿
- [ ] 基线已记录
- [ ] 人工评审后合并

## Phase 2: file-snippets（PR 2）

### Task 7: `src/snippets.ts`

**Description:** 按 spec D7–D9 实现以下内容：
- `parseFileArg`：先整体当作路径；不存在时用行尾正则拆行号；`:N` 等同 `:N-N`
- `loadExcerpts(cwd, args)`：负责全部校验（cwd 内、普通文件、二进制检测、行号范围、400 行和 64 KB 限额、敏感名单）
- `renderExcerpts`：渲染标题和围栏，计算围栏长度

**Acceptance criteria:**
- [ ] 解析：普通路径、`:N`、`:N-M`、Windows 盘符、文件名带冒号
- [ ] 校验失败直接抛错，错误信息具体：越界时带出实际行数，敏感文件提示"在 prompt 里写明位置"。覆盖 `start > end`、401 行、超过 64 KB、NUL 字节、`..` 逃逸、符号链接逃逸（仅 POSIX）
- [ ] 敏感名单：每个命中项和每个放行项（`.env.example`、`.env.sample`、`.env.template`、`.env.dist`）都有用例；内容里含反引号时围栏会加长

**Verification:**
- [ ] `node --test test/snippets.test.ts`

**Dependencies:** Checkpoint PR 1

**Files likely touched:**
- `src/snippets.ts`（新）
- `test/snippets.test.ts`（新）

**Estimated scope:** M

### Task 8: 接入 start 和 MCP delegate_task

**Description:** `start()` 对带行号的 `--file` 调用 `loadExcerpts`，用 task cwd 解析路径（`--isolate` 时是 worktree），把渲染结果接在宿主 prompt 之后，写进 `turn.prompt`。`turn.files` 保留原始参数，不带行号的路径照旧进 Focus 列表。同时更新 CLI 和 MCP 里 `--file`/`files` 的描述。

**Acceptance criteria:**
- [ ] 用 `FAKE_INPUT_FILE` 断言子进程收到的 prompt 布局和 spec D9 一致，片段原文完整出现
- [ ] `--isolate` 时片段从 worktree 读取（构造源目录有未提交改动的场景，片段里不应出现这些改动）
- [ ] `.env:1-3` 让 `start` 同步失败，任务目录里不存在这个文件的内容；不带行号的 `--file` 行为逐字节不变

**Verification:**
- [ ] `node --test test/snippets-start.test.ts test/prompt-stdin.test.ts test/mcp.test.ts`

**Dependencies:** Task 7

**Files likely touched:**
- `src/tasks.ts`
- `src/mcp.ts`
- `src/usage.ts`
- `test/snippets-start.test.ts`（新）

**Estimated scope:** M

### Task 9: reply --file 和 MCP task_reply.files

**Description:** `reply()` 增加 `files` 参数：带行号的渲染进该轮 prompt，不带行号的写进该轮 `turn.files`。CLI 的 `reply` 增加 `--file`（可重复），MCP 的 `task_reply` 增加 `files`。

**Acceptance criteria:**
- [ ] reply 轮带片段时，子进程收到的 prompt 里有片段；不带 `--file` 的 reply 行为不变
- [ ] 校验失败时 reply 同步失败，任务状态不变（不进入 running）
- [ ] `baton reply -h` 和 MCP schema 更新

**Verification:**
- [ ] `node --test test/snippets-start.test.ts test/help.test.ts test/mcp.test.ts`

**Dependencies:** Task 8

**Files likely touched:**
- `src/tasks.ts`
- `src/cli.ts`
- `src/usage.ts`
- `src/mcp.ts`
- `test/snippets-start.test.ts`

**Estimated scope:** M

### Task 10: snippets 文档和冒烟

**Description:** 文档写明以下内容：
- 行号语法
- 限额
- 敏感名单
- `--isolate` 时从 worktree 读取的说明

然后用真实 CLI 冒烟一次。

**Acceptance criteria:**
- [ ] `docs/reference.md`、`docs/reference.zh-CN.md` 更新
- [ ] 真实 CLI（任选两家）收到片段，并在回复里引用了片段内容；`turns/1.json` 记录的 prompt 和发出的一致

**Verification:**
- [ ] `npm test`

**Dependencies:** Task 9

**Files likely touched:**
- `docs/reference.md`
- `docs/reference.zh-CN.md`

**Estimated scope:** S

### Checkpoint: PR 2
- [ ] `npm test` 三平台全绿
- [ ] 人工评审后合并

## Phase 3: handoff-brief（PR 3）

### Task 11: 标签检测和输入合约

**Description:** 在 `src/contract.ts` 加标签检测正则和输入合约文本（spec D11）。`buildPrompt` 在本轮 prompt（含 reply）检测到标签时，在输出合约之前注入输入合约。

**Acceptance criteria:**
- [ ] 六种标签都能被检测；`[readme]`、`[x]`、跨行的方括号不算标签
- [ ] 带标签的 prompt 注入输入合约，位置在输出合约之前；不带标签的 prompt 输出和改动前逐字节一致
- [ ] reply 轮同样生效

**Verification:**
- [ ] `node --test test/contract.test.ts test/prompt-stdin.test.ts`

**Dependencies:** Checkpoint PR 2

**Files likely touched:**
- `src/contract.ts`
- `test/contract.test.ts`

**Estimated scope:** S

### Task 12: 两份 skill 的简报模板和规则

**Description:** `baton-rescue`、`baton-orchestrate` 两份 skill 按 spec D12 写入以下内容（英文）：
- 简报模板和标签表
- 只交已经知道的
- 代码用 `--file path:start-end` 给坐标
- 敏感值只写位置
- 工具提示只能写成条件句
- 续会话优先
- 评审例外

现有 `SKILL.md:48` 那条"写清完成标准和看哪些文件"的说法改为引用模板。

**Acceptance criteria:**
- [ ] `skills.test.ts` 新增断言：模板章节名、六个标签名、reply-first、评审例外，且不含汉字
- [ ] 两份 skill 的规则一致，不互相矛盾；orchestrate 里的派发示例使用简报模板

**Verification:**
- [ ] `node --test test/skills.test.ts test/manifests.test.ts`

**Dependencies:** Task 11

**Files likely touched:**
- `skills/baton-rescue/SKILL.md`
- `skills/baton-orchestrate/SKILL.md`
- `test/skills.test.ts`

**Estimated scope:** S

### Task 13: brief 文档和端到端冒烟

**Description:** 文档写明以下内容：
- 标签表
- 输入合约
- 简报模板入口

然后用一份带标签和片段的真实简报交给 codex 和 cursor 各一次，用 `stats` 查看这两个任务的 `activity`。

**Acceptance criteria:**
- [ ] `docs/reference.md`、`docs/reference.zh-CN.md`、`docs/hosts.md`（如涉及宿主用法）更新
- [ ] 两次冒烟的 `turns/1.json` 里有输入合约，`activity` 已记录，结果写进 `tasks/plan.md` 作为首批数据

**Verification:**
- [ ] `npm test`

**Dependencies:** Task 12

**Files likely touched:**
- `docs/reference.md`
- `docs/reference.zh-CN.md`
- `docs/hosts.md`
- `tasks/plan.md`

**Estimated scope:** S

### Checkpoint: PR 3
- [ ] `npm test` 三平台全绿
- [ ] 人工评审后合并

## Phase 4: 复盘

### Task 14: 对照效果目标

**Description:** 启用简报的任务累计 ≥ 20 个后，运行 `baton stats --all --since <PR 3 合并日>`，按 CLI 和基线对比 spec 的效果目标，结论和调整建议回写 spec。

**Acceptance criteria:**
- [ ] 四项效果指标逐项给出"达标 / 未达标 + 原因"
- [ ] 对未达标项提出具体调整：合约措辞、skill 规则或限额

**Verification:**
- [ ] 人工评审结论

**Dependencies:** Checkpoint PR 3

**Files likely touched:**
- `SPEC-handoff-context.md`

**Estimated scope:** XS
