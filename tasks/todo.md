# Tasks: Claude target 支持 `--model`

Source spec: `SPEC-claude-model.md`
Plan: `tasks/plan.md`

## Task 1: 放行 claude 的 `--model`，并在每一轮传给 CLI

**Description:** `src/tasks.ts` 的闸门放行 claude，`model_argv` 取 `model`；agy 的报错文案改为 `agy does not support --model yet (cursor, codex and claude only).`。`claude.build()` 在有 `model` 时把 `--model <id>` 追加在 `--resume` 与 prompt 之前，并返回 `modelArg`。`src/mcp.ts` 中 `model` 字段的 describe 加上 claude。新增 `test/fake-cli/claude -> fake.sh`。

**Acceptance criteria:**
- [x] `start --target claude --model sonnet`：返回的 `model`、`model_argv` 都是 `sonnet`；argv 中 `--model` 恰好出现一次，值为 `sonnet`，且在 `--resume` 之前（spec 第 1 条）。「prompt 是最后一个参数」没写断言：prompt 被 baton 包装成多行，按行切分的 argv 文件无法判断；由 `build()` 最后执行 `args.push(prompt)` 保证
- [x] `reply` 第 2 轮的 argv 同时含 `--resume <sid>` 和 `--model sonnet`，meta 里的 `model` 不变（spec 第 2 条）
- [x] `--model opus --effort high`：argv 同时含 `--model opus` 和 `--effort high`（spec 第 3 条）
- [x] 不带 `--model`：argv 中没有 `--model`，meta 中没有 `model` / `model_argv`（spec 第 4 条）
- [x] 原来「claude 拒绝 `--model`」的用例改为 agy，`summary` 匹配 `/not support --model/i`（spec 第 5 条）
- [x] codex / cursor 的现有 `--model` 用例不改且通过（spec 第 6 条）
- [x] Open Question 1：把实测得到的非法模型输出（`result` 事件，`is_error: true`）交给 `failureSummary` 跑一次，记录 `summary` 是否含 "issue with the selected model"；取不到只记录，不修

**Verification:**
- [x] Tests pass: `node --test test/model-start.test.ts test/adapters.test.ts`
- [x] Build succeeds: `npm run build`
- [x] Manual check: 不需要真实调用 claude；CLI 行为已在 spec 的 Verified CLI Behavior 表中实测

**Dependencies:** None

**Files likely touched:**
- `src/tasks.ts`
- `src/adapters/claude.ts`
- `src/mcp.ts`
- `test/model-start.test.ts`
- `test/fake-cli/claude`（新 symlink）

**Estimated scope:** Small: 4 个文件 + 1 个 symlink

**Open Question 1 结果（2026-11-24）：** 把实测的非法模型输出交给 fake claude（`FAKE_EXIT=1`）端到端跑了一次：终态 `failed`，`summary` 含 "issue with the selected model"，但它是原始 stream-json 尾部的 8192 字符，开头是 init 事件里的 skills 列表，主 Agent 很难读出来。按 spec 只做记录，不在本次修复：`failureSummary` 只识别 Codex 的 `turn.failed`，不读 Claude `result` 事件里的错误文本。

## Checkpoint: After Task 1

- [x] `node --test test/model-start.test.ts test/adapters.test.ts` 通过
- [x] `npm run build` 通过

## Task 2: 文档与技能同步

**Description:** 把「Claude/Agy error on `--model`」改为「Claude、Codex、Cursor 支持；Agy 报错」，并写明 Claude 每一轮都重新传 `--model`（resume 不会记住模型）、可与 `--effort` 同用、原样传给 CLI、支持 `sonnet` / `opus` 等别名。

**Acceptance criteria:**
- [x] `docs/reference.md` 与 `docs/reference.zh-CN.md` 的 `--model` 条目已更新，两种语言内容一致
- [x] `skills/baton-rescue/SKILL.md` 第 50 行、`skills/baton-orchestrate/SKILL.md` 第 48 行和第 132 行、`skills/setup/SKILL.md` 第 45 行已更新
- [x] `grep -rn "Claude/Agy error\|Claude and Agy error\|cursor and codex only\|For Cursor or Codex" docs skills src` 没有残留

**Verification:**
- [x] Tests pass: `npm test`（`test/manifests.test.ts`、`test/dist.test.ts` 覆盖了技能和清单文件）
- [x] Build succeeds: `npm run build`

**Dependencies:** Task 1

**Files likely touched:**
- `docs/reference.md`
- `docs/reference.zh-CN.md`
- `test/skills.test.ts`（原断言钉住了 "Cursor and Codex" 这句旧文案）
- `skills/baton-rescue/SKILL.md`
- `skills/baton-orchestrate/SKILL.md`
- `skills/setup/SKILL.md`

**Estimated scope:** Small: 5 个文档文件

## Checkpoint: Complete

- [x] `npm test` 全量通过
- [x] `npm run build` 通过
- [x] spec 第 1 至第 8 条全部满足
- [x] 不包含版本号与发布改动（spec Boundaries：要先问）
