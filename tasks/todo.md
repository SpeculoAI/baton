# Tasks: 空闲超时的终态

Source spec: `SPEC-idle-timeout-terminal-state.md`
Plan: `tasks/plan.md`

## Task 1: `stop()` 写入并在正常收尾时删除 `stop_reason`

**Description:** 给 `TaskMeta` 加上可选字段 `stop_reason`。`stop()` 第一次生效时先把 `idle` / `max_duration` / `cancelled` 写入 meta（`status` 仍为 `running`），再 `killGroup`；`killGroup` 抛错只吞掉。supervisor 正常走到终态写入时删除 `stop_reason`，`timed_out` / `cancelled` 的摘要保持现有字符串。

**Acceptance criteria:**
- [x] 正常 idle、max_duration 仍得到 `timed_out`，摘要分别为 `Timed out: idle.`、`Timed out: max_duration.`；cancel 仍得到 `cancelled` / `Cancelled.`
- [x] 上述三条正常路径结束后，`meta.json` 没有 `stop_reason`
- [x] 每条正常路径仍然恰好一条 `turn_ended`，孙进程被杀掉

**Verification:**
- [x] Tests pass: `node --test test/lifecycle.test.ts`
- [x] Build succeeds: `npm run build`
- [x] Manual check: 不需要。终态用现有 lifecycle 用例断言

**Dependencies:** None

**Files likely touched:**
- `src/types.ts`
- `src/supervisor.ts`
- `test/lifecycle.test.ts`

**Estimated scope:** Small: 3 files

## Checkpoint: After Task 1

- [x] `node --test test/lifecycle.test.ts` 通过
- [x] 正常超时 / 取消的终态 meta 没有 `stop_reason`

## Task 2: 孤儿路径认 `stop_reason`，并补崩溃注入测试

**Description:** `status()` 在锁内重读后，若任务仍是 `running` 且已是孤儿：有 `stop_reason` 就按 spec 表写成 `timed_out` 或 `cancelled`，杀掉残留子进程，追加一条 `exit_code: null` 的 `turn_ended`，删掉 `stop_reason`，返回 `finished(meta)`（无 `liveness`）。没有 `stop_reason` 时保持现在的 `failed` / `supervisor exited unexpectedly` / `liveness: orphaned`。同一 turn 已有 `turn_ended` 则不再追加；supervisor 自己的收尾也遵守这条。`BATON_CRASH_AFTER_STOP_PERSIST=1` 时，`stop()` 在 `killGroup` 尝试之后 `process.exit(1)`。

**Acceptance criteria:**
- [x] 崩溃注入下，idle → `timed_out` / `Timed out: idle.`；max_duration → `timed_out` / `Timed out: max_duration.`；cancel → `cancelled` / `Cancelled.`。返回视图没有 `liveness`
- [x] 这三条的事件里没有 `status: failed` 的 `turn_ended`，且该 turn 的 `turn_ended` 恰好一条。第二次 `status` 不改变状态、不追加事件。孙进程已退出
- [x] supervisor 在 `stop()` 之前被 `SIGKILL`：仍是 `failed`、`supervisor exited unexpectedly`、第一次读取 `liveness === "orphaned"`，事件只多一条

**Verification:**
- [x] Tests pass: `npm test`
- [x] Build succeeds: `npm run build`
- [x] Manual check: 不需要。崩溃窗口由 lifecycle 注入覆盖

**Dependencies:** Task 1

**Files likely touched:**
- `src/supervisor.ts`
- `src/tasks.ts`
- `src/store.ts`
- `test/lifecycle.test.ts`

**Estimated scope:** Medium: 4 files

## Checkpoint: After Task 2

- [x] `npm test` 通过
- [x] 无 `stop_reason` 的 SIGKILL 用例仍失败为孤儿
- [x] 人审崩溃窗口的三条断言与 spec 成功标准一致后再写文档

## Task 3: 文档补上已决定的超时契约

**Description:** 在架构说明和两份 reference 的 liveness 段落后各加一句：meta 里已有 `stop_reason` 时，下次读取收成 `timed_out`（`idle` / `max_duration`）或 `cancelled`，摘要与 supervisor 正常收尾相同；没有该字段时仍收成 `failed`。不改技能文案，不记载 `BATON_CRASH_AFTER_STOP_PERSIST`。

**Acceptance criteria:**
- [x] `docs/architecture.md`、`docs/reference.md`、`docs/reference.zh-CN.md` 都有上述句子，中英文字段名一致
- [x] 技能目录与 CLI 帮助里没有崩溃注入变量

**Verification:**
- [x] Tests pass: `npm test`
- [x] Build succeeds: `npm run build`
- [x] Manual check: 读这三处段落，确认无 `stop_reason` 的孤儿句子还在

**Dependencies:** Task 2

**Files likely touched:**
- `docs/architecture.md`
- `docs/reference.md`
- `docs/reference.zh-CN.md`

**Estimated scope:** Small: 3 files

## Checkpoint: Complete

- [x] `npm test` 通过
- [x] spec 的 Success Criteria 都有对应测试或文档句子
- [x] 准备给人审，通过前不扩大范围
