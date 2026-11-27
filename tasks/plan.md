# Implementation Plan: 交接上下文

Source spec: `SPEC-handoff-context.md`
Task list: `tasks/todo.md`

## Overview

分五个阶段交付，每个模块一个 PR：

- **阶段 0**：只做验证，不写代码。用真实 CLI 确认 claude 的 usage 字段、agy 的搜索工具名、kimi 的工具名和 usage，以及续轮（resume）时各家 usage 是"本轮"还是"会话累计"。结果回写 spec 的 D1、D3，并沉淀成测试 fixture。
- **阶段 1（PR 1 `handoff-metrics`）**：工具调用分类、usage 解析、turn 汇总、`baton stats`。合并后立刻记录基线。
- **阶段 2（PR 2 `file-snippets`）**：`--file path:start-end`，覆盖 start、reply、MCP 三处入口。
- **阶段 3（PR 3 `handoff-brief`）**：来源标签、输入合约、两份 skill。
- **阶段 4**：复盘。启用简报的任务跑满 20 个以上后，用 `stats` 对照效果目标。

## Architecture Decisions

- **一个纯函数服务两个入口。** `summarizeEvents(events)` 放在 `src/metrics.ts`。supervisor 在 turn 结束时调用它；`stats` 回放旧任务的 raw 日志时也调用它。两边口径不会分叉。
- **分类在 adapter 里、截断之前完成。** `kind` 来自各 adapter 自己的映射表，`intent` 在 `detail` 被截到 200 字符之前用完整命令计算。下游只读字段，不再猜测。
- **usage 以每轮最后一个事件为准。** 如果阶段 0 发现某家续轮报的是会话累计值，在 `summarizeEvents` 之外做"减去上一轮"的修正，修正规则写回 spec D3。`summarizeEvents` 本身保持纯函数。
- **片段在 `start()`/`reply()` 里同步读取并渲染，写进 `turn.prompt`。** 这和现有 scope、rules pointer 前缀的做法一致，`turns/N.json` 就是子任务实际看到的内容。读文件和校验集中在新文件 `src/snippets.ts`。
- **输入合约在 `buildPrompt` 里按需注入。** 只有检测到来源标签才加，所以不带标签的 prompt 逐字节不变。
- **构建顺序**：metrics → snippets → brief。brief 的 skill 要引用 `--file` 的行号语法，所以排在 snippets 之后。metrics 放最前，是为了先有基线。

## Task List

### Phase 0: 验证
- [x] Task 0: T0 真实 CLI 验证，回写 spec，沉淀 fixture

### Phase 1: handoff-metrics（PR 1）
- [x] Task 1: 类型、`shellIntent`、`summarizeEvents`（纯函数）
- [x] Task 2: codex、cursor adapter 输出 `kind`/`intent`/`usage`
- [x] Task 3: claude、agy、kimi adapter 输出 `kind`/`intent`/`usage`
- [x] Task 4: supervisor 写入 turn 的 `activity`/`usage`；终止视图和 `tail` 展示
- [x] Task 5: `baton stats` 命令（含 raw 回放）
- [x] Task 6: metrics 文档、真实 CLI 冒烟、记录基线

### Checkpoint: PR 1
- [ ] `npm test` 三平台 CI 全绿
- [x] `baton stats --all` 在现有 `~/.baton` 上 `measured ≥ 75`，基线写进本文件（见下方「基线」）
- [ ] 人工评审后合并

### 基线（PR 1，2026-11-27）

`npm run build && node dist/cli.js stats --all`，在本机 `~/.baton` 上运行，共 100 个任务，全部 measured。其中包含 5 个只读冒烟任务（2026-11-27）；它们没有编辑，因此不计入 `before_first_edit`。

| target | tasks | measured | before_first_edit 中位 / p75（n） | explore_share | first_turn.input 中位 |
|---|---|---|---|---|---|
| codex | 38 | 38 | 19 / 22（23） | 0.303 | 1,974,279 |
| cursor | 48 | 48 | 61 / 81（45） | 0.616 | 3,491,964 |
| agy | 10 | 10 | 37 / 41（5） | 0.623 | 2,180,952 |
| claude | 2 | 2 | —（0） | 1.0 | 210,376.5 |
| kimi | 2 | 2 | —（0） | 1.0 | — |

- 和统计脚本的 42 属于同一量级：42 是各家合计的结果，按 target 拆开后分别是 19、61、37。
- 各 target 之间差距大，效果目标应按同一 target 前后对比来衡量。cursor 和 agy 是主要优化对象；codex 已低于合计目标 20（见 Open Questions）。
- codex 的 `explore_share` 偏低：它的探索主要通过 shell 完成，而 `rg`/`sed -n` 之外的组合（如含 `awk`）判为无 intent。这符合 D2，属于有意保守。

### Phase 2: file-snippets（PR 2）
- [x] Task 7: `src/snippets.ts` 解析、校验、敏感名单、渲染
- [x] Task 8: 接入 `start` 和 MCP `delegate_task`
- [x] Task 9: `reply --file` 和 MCP `task_reply.files`
- [x] Task 10: snippets 文档和冒烟

### Checkpoint: PR 2
- [ ] `npm test` 三平台全绿
- [ ] 真实 CLI 收到的 prompt 里有片段原文；`.env:1-3` 被拒绝，`turns/` 下没有它的内容
- [ ] 人工评审后合并

### Phase 3: handoff-brief（PR 3）
- [ ] Task 11: 标签检测和输入合约
- [ ] Task 12: 两份 skill 的简报模板和规则
- [ ] Task 13: brief 文档和端到端冒烟

### Checkpoint: PR 3
- [ ] `npm test` 三平台全绿
- [ ] 带标签的真实交接会注入输入合约，不带标签的 prompt 逐字节不变
- [ ] 人工评审后合并

### Phase 4: 复盘
- [ ] Task 14: 启用简报的任务 ≥ 20 个后，用 `stats` 对照效果目标，结论回写 spec

## Risks and Mitigations

| 风险 | 影响 | 缓解 |
|---|---|---|
| 某家续轮的 usage 是会话累计值，会让多轮任务的 token 重复计算 | 高 | 阶段 0 用现有多轮任务的 `raw/2.stdout.log` 和 claude/agy 的 reply 实测确认，再决定是否做差分修正 |
| `shellIntent` 误分类，codex 的探索数会偏低或偏高 | 中 | 规则用表格测试固定；用 Task 5 的回放结果和统计脚本对比量级；误差在文档里写明 |
| claude/agy/kimi 的工具名或 usage 字段和预期不符，或 kimi 不输出 usage | 中 | 阶段 0 先确认；映射表里没有的名字记为 `other`，不报错 |
| 符号链接逃逸测试在 Windows 上需要特权 | 低 | 沿用现有做法，只在 POSIX 跑，并写明 |
| 旧任务目录缺字段，导致 `status`/`stats` 报错 | 中 | 新字段全部可选；`stats` 用临时 `BATON_HOME` 构造三类旧数据做测试 |
| 片段让 prompt 变长，每一步重复发送反而更贵 | 中 | 400 行和 64 KB 的限额；skill 规定只给改动位置和必须看的接口；阶段 4 用 `stats` 检查 |
| 子 CLI 不理会输入合约，照样重新探索 | 高 | 这是效果层面的风险，不影响合并；阶段 4 按 CLI 看数据，再调整合约措辞或 skill |

## Open Questions
- 效果目标「before_first_edit 中位 42→≤20」是各家合计口径；基线显示 codex 已是 19、cursor 是 61。是否改为按 target 设目标（例如 cursor、agy 各降 50%，codex 不退化）？待用户确认。

- 三个 T0 探测任务（claude `db2266e0`、agy `f965f2fd`、kimi `26cdef6b`）各跑了两轮，Task 0 直接读取它们的 raw 日志。
