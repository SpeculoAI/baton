# Plan: Claude target 支持 `--model`

Source spec: `SPEC-claude-model.md`

## 现状与数据流

`--model` 已经有完整的通路，Claude 只缺两处：

1. `src/tasks.ts:122-128` 是入口闸门：只放行 cursor / codex，并在这里算出写入 meta 的 `model_argv`（codex 直接等于 `model`）。
2. `src/supervisor.ts:138-154` 每一轮都调用 `adapter.build({ ..., model: meta.model })`，再用返回的 `spec.modelArg` 回写 `meta.model_argv`。`reply` 走同一段代码，所以只要 `build()` 每次都传 `--model`，「每轮重传」就自动成立。
3. `src/adapters/claude.ts` 的 `build()` 目前不解构 `model`，也不返回 `modelArg`。

所以改动只有：闸门放行 claude，`claude.build()` 追加 `--model` 并返回 `modelArg`。`supervisor.ts` 与 `types.ts` 都不用动。

## 测试缺口

`test/fake-cli/` 里没有 `claude`，现有 claude 的 `--model` 用例在 spawn 之前就被拒了，所以从没走到 fake CLI。需要新增 symlink `test/fake-cli/claude -> fake.sh`，与 `codex`、`cursor-agent` 做法相同。已确认：`not_installed` 用例改 PATH 后用的是 codex，`mcp.test.ts` 只断言 codex 已安装，新增 fake claude 不影响现有用例。

fake claude 要能 `reply`，fixture 需要输出 `system/init`（带 `session_id`）和 `result` 事件，写法照 `cursorFixture`。

## 顺序与依赖

```
Task 1 代码 + 测试  ──→  Task 2 文档 + 技能
```

Task 2 描述的是 Task 1 交付的行为，所以要先做 Task 1。两个任务都很小，不并行。

## 风险

| 风险 | 应对 |
|---|---|
| `--model` 在 argv 中的位置不对，被 CLI 当成 prompt | 放在 `--resume` 与 prompt 之前；单测断言 prompt 仍是最后一个参数 |
| resume 时漏传，导致回落到默认模型 | 第 2 轮 argv 断言同时有 `--resume` 和 `--model`（实测已知会回落） |
| 非法模型时 `failureSummary` 取不到 CLI 的报错句 | 按 spec 的 Open Question 1：实现时用真实失败输出检查一次，取不到就只记录、另开 issue |

## 检查点

- Task 1 之后：`node --test test/model-start.test.ts test/adapters.test.ts` 通过，`npm run build` 通过。
- Task 2 之后：`npm test` 全量通过；`grep -rn "Claude/Agy error\|Claude and Agy error\|cursor and codex only" docs skills src` 没有残留。
