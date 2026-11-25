# Spec Delta: Claude target 支持 `--model` — V1

Status: proposed

已发布行为见 `docs/reference.md`（Command line 一节的 `--model` 条目）。本文件只描述这次修正。

## Objective

`baton start --target claude --model <id>` 按任务指定 Claude Code 使用的模型，`reply` 延续同一模型。

使用者是派单的 host agent 或用户。典型场景：轻任务派给 `sonnet` / `haiku` 省额度，难任务派给 `opus`。成功是：Claude 与 Codex 在 `--model` 上行为一致（写入 meta、每轮都传给 CLI、可与 `--effort` 同用）。

## Current Behavior

- `src/tasks.ts:123`：target 不是 cursor / codex 时，`--model` 直接报错 `claude does not support --model yet (cursor and codex only).`。
- `src/adapters/claude.ts` 的 `build()` 不接收 `model`，从不传 `--model`。
- 文档与技能都写明「Claude/Agy error on `--model`」。

## Verified CLI Behavior（2026-11-24，Claude Code 2.1.332）

| 调用 | 结果 |
|---|---|
| `claude -p --model haiku ...` | `system/init` 事件 `model` 为 `claude-haiku-5-5`；别名被 CLI 解析 |
| `claude -p --model haiku --resume <sid> ...` | 同一 `session_id`，`model` 仍为 `claude-haiku-5-5` |
| `claude -p --resume <sid> ...`（不带 `--model`） | `model` 回落为默认的 `claude-sonnet-5-5` |
| `claude -p --model no-such-model-xyz ...` | 退出码 1，`result` 事件 `is_error: true`，文本含 "issue with the selected model" |

结论：resume 不会记住上一轮的模型，**每一轮都必须重新传 `--model`**。

## New Behavior

- `start --target claude --model <id>`：`<id>` 去掉首尾空白后原样传给 CLI，作为 `--model <id>`，放在 `--resume` 与 prompt 之前。Baton 不校验别名或模型名，交给 CLI 判断。
- meta 写入 `model`（请求值）与 `model_argv`（传给 CLI 的值），两者相同。语义与 Codex 一致：`model_argv` 是请求值，不是 provider 确认的实际模型。
- `reply` 的每一轮都从 meta 读出 `model`，并再次传 `--model`。
- 可与 `--effort` 同用：两个参数各自独立传入。
- 不带 `--model` 时，argv 与现在完全相同。
- Agy 不变，仍然报错。报错文案改为 `agy does not support --model yet (cursor, codex and claude only).`。
- 模型名非法时，CLI 退出码非 0，任务终态为 `failed`。现有失败路径不做改动。

## Success Criteria

1. `start --target claude --model sonnet`：返回的 `model`、`model_argv` 都是 `sonnet`；fake CLI 收到的 argv 中有且只有一对 `--model sonnet`。
2. 对该任务 `reply`：第 2 轮的 argv 同时含 `--resume <sid>` 和 `--model sonnet`，meta 里的 `model` 不变。
3. `--model opus --effort high`：argv 同时含 `--model opus` 和 `--effort high`。
4. 不带 `--model` 的 claude 任务：argv 中没有 `--model`，meta 中没有 `model` / `model_argv`。
5. `start --target agy --model x` 仍然报错，`summary` 匹配 `/not support --model/i`。
6. Codex 与 Cursor 的 `--model` 行为及其现有测试不变。
7. `npm test` 和 `npm run build` 通过。
8. 文档同步更新：`docs/reference.md`、`docs/reference.zh-CN.md`、`skills/baton-rescue/SKILL.md`、`skills/baton-orchestrate/SKILL.md`（2 处）、`skills/setup/SKILL.md`、`src/mcp.ts` 中 `model` 字段的 describe。

## Boundaries

- 改动范围：`src/tasks.ts`、`src/adapters/claude.ts`、`src/mcp.ts`、`test/model-start.test.ts`，以及第 8 条列出的文档。
- 测试使用现有的 fake CLI 和 `FAKE_ARGS_FILE`，不调用真实的 `claude`。
- 运行时文案、测试、`docs/reference.md` 用英文；中文只写进 `docs/reference.zh-CN.md`（沿用仓库惯例）。
- 不改 `TaskMeta` 字段，也不新增状态。
- 先问再做：版本号与发布（manifests、tag）。

## Out of Scope (Deferred)

- 记录 provider 确认的实际模型：Claude 的 `system/init` 事件带 `model`（如 `claude-haiku-5-5`），可以另开一个字段记录。这个需求四家通用，留给「用量与成本落盘」一起做。
- Agy 支持 `--model`：`agy --help` 里没有找到模型参数，需要先实测。
- 在 `start` 阶段预先校验模型名：交给 CLI 判断，避免维护模型清单。
- 改进 Claude 失败时的 `summary` 提取（例如直接取 `result` 事件的错误文本）：属于通用的失败摘要问题，本次不扩大范围。

## Open Questions

1. 非法模型的 `summary` 现在由 `failureSummary(stdout, stderr)` 生成，还没确认能否取到 "issue with the selected model" 这句。实现时会检查一次：取得到就不处理；取不到就只记录，按 Deferred 另开 issue。可以吗？
