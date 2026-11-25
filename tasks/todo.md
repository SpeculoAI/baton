# Tasks: `start --check <cmd>`

Source spec: `SPEC-check-command.md`
Plan: `tasks/plan.md`

## Task 1: 主路径——worker 成功后运行 check，记录结果

**Description:** 类型：`TaskStatus` 加 `check_failed`，`TaskMeta` 加 `check_command` 和 `check`，`Turn` 加 `check`，`EventData` 加 `check_started` / `check_ended`。参数：`cli.ts` 加 `--check`，`mcp.ts` 的 `delegate_task` 加 `check`，`tasks.start` 去掉首尾空白后写入 `meta.check_command`（空串视同未传）。supervisor：本轮终态为 `success` 时，在 readonly / scope 检查之后用 `/bin/sh -c` 在 `meta.cwd` 运行 check，写入 `raw/<n>.check.log`，结果写进 turn 与 meta，失败时终态改为 `check_failed`。`tail.ts` 格式化两种新事件。

**Acceptance criteria:**
- [x] `--check "exit 0"`：终态 `success`；meta 与 turn 中 `check.status` 为 `passed`、`exit_code` 为 0，且有 `duration_ms`；事件流有 `check_started` 和 `check_ended`（spec 第 1 条）
- [x] `--check "echo boom; exit 3"`：终态 `check_failed`；`check.exit_code` 为 3；`summary` 以 `check_failed: exit 3` 开头并含 `boom`；`raw/1.check.log` 含 `boom`；`output_tail` 不超过 4000 字符（spec 第 2 条）
- [x] `--check "test -f marker"`：cwd 有 `marker` 时为 `passed`，没有时为 `check_failed`；与 `--isolate` 同用时在 worktree 里运行（spec 第 3 条）
- [x] worker 本轮 `FAKE_EXIT=1`：不运行 check，没有 `check` 字段，没有 check 事件（spec 第 4 条）
- [x] 不带 `--check`：meta 中没有 `check_command` / `check`，没有 check 事件；现有测试全部不改（spec 第 8 条）
- [x] MCP `delegate_task` 的 `check` 参数与 CLI 效果相同

**Verification:**
- [x] Tests pass: `node --test test/check.test.ts test/mcp.test.ts`
- [x] Build succeeds: `npm run build`

**Dependencies:** None

**Files likely touched:**
- `src/types.ts`
- `src/tasks.ts`
- `src/cli.ts`
- `src/mcp.ts`
- `src/supervisor.ts`
- `src/tail.ts`
- `test/check.test.ts`（新）

**Estimated scope:** Medium：6 个源文件 + 1 个新测试文件。超出约 5 个文件的建议，但这些都是同一条参数通路上的小改动，拆开后中间状态无法验证。

## Checkpoint: After Task 1

- [x] `node --test test/check.test.ts test/mcp.test.ts` 通过
- [x] `npm run build` 通过

## Task 2: `reply` 与每轮重跑

**Description:** `src/tasks.ts` 的 `reply` 允许从 `check_failed` 继续；新一轮开始时删除 meta 中上一轮的 `check`。`check_command` 跨轮保留，每轮结束时重新运行。`src/mcp.ts` 中 `task_reply` 的说明加上 `check_failed`。

**Acceptance criteria:**
- [x] 对 `check_failed` 的任务 `reply`：第 2 轮结束后重新运行 check；meta 中的 `check` 为第 2 轮的结果；`turns/1.json` 与 `turns/2.json` 各有自己的 `check`（spec 第 5 条）
- [x] 第 2 轮运行期间，meta 中没有第 1 轮遗留的 `check`

**Verification:**
- [x] Tests pass: `node --test test/check.test.ts`

**Dependencies:** Task 1

**Files likely touched:**
- `src/tasks.ts`
- `src/mcp.ts`
- `test/check.test.ts`

**Estimated scope:** Small：3 个文件

## Task 3: 超时、cancel、heartbeat，以及 check 期间状态仍为 running

**Description:** check 运行期间，落盘的 meta 保持 `running`，check 结束后再写终态；heartbeat 保持到 check 结束；check 用自己的空闲计时器（`idle_timeout_s`），超时只杀 check 进程组，结果记为 `timed_out` / `check_failed`；check 期间 `childPid` 与 `meta.child_pid` 指向 check 进程组，`cancel` 收成 `cancelled`。

**Acceptance criteria:**
- [x] `--check "sleep 2"`：check 运行期间 `status` 返回 `running`，不是 `success`
- [x] `--idle-timeout 1 --check "sleep 5"`：终态 `check_failed`，`check.status` 为 `timed_out`，summary 以 `check_failed: timed out` 开头，check 进程组已退出（spec 第 6 条）
- [x] check 运行期间 `cancel`：终态 `cancelled`，check 进程组已退出，该 turn 只有一条 `turn_ended`（spec 第 7 条）
- [x] 代码中 heartbeat 在 check 结束前不会被清除，并有一行注释说明原因（等 30 秒的用例太慢，不写）

**Verification:**
- [x] Tests pass: `npm test`
- [x] Build succeeds: `npm run build`

**Dependencies:** Task 1

**Files likely touched:**
- `src/supervisor.ts`
- `test/check.test.ts`

**Estimated scope:** Small：2 个文件

## Checkpoint: After Task 3

- [x] `npm test` 全量通过
- [x] spec 第 1 至第 8 条满足

## Task 4: 文档与 skill

**Description:** 英文文档写清参数、结果字段、新终态和 Breaking note，提示 `--isolate` 时用 `.baton.json` 的 `post_create` 装依赖；中文 reference 同步。skill 的 Review 规则改为：有现成验收命令时带上 `--check`；`check.status` 为 `passed` 时不再重跑同一条命令；`check_failed` 回原会话返工，计入返工次数，不换别家 CLI。

**Acceptance criteria:**
- [x] `docs/reference.md`：Command line（`--check`）、Statuses and liveness（`check_failed`）、MCP tools（`check`）、Task directory（`raw/<n>.check.log`）
- [x] `docs/reference.zh-CN.md` 与英文内容一致
- [x] `docs/architecture.md` 的状态表加入 `check_failed`，与 `scope_violation` / `readonly_violation` 同一行
- [x] `skills/baton-rescue/SKILL.md` 与 `skills/baton-orchestrate/SKILL.md` 的用法和 Review 规则已更新
- [x] 如果 `test/skills.test.ts` 或其他测试锁定了旧文案，同步更新

**Verification:**
- [x] Tests pass: `npm test`
- [x] Build succeeds: `npm run build`

**Dependencies:** Task 3

**Files likely touched:**
- `docs/reference.md`
- `docs/reference.zh-CN.md`
- `docs/architecture.md`
- `skills/baton-rescue/SKILL.md`
- `skills/baton-orchestrate/SKILL.md`

**Estimated scope:** Small：5 个文档文件

## 执行记录（2026-11-24）

- Task 3 的四个防护（check 期间保持 `running`、check 自己的 heartbeat、check 自己的空闲计时器、`childPid` 指向 check）和 Task 1 一起写进了 `runCheck`：它们是同一段代码，分开写会先产出一个有缺陷的中间版本。测试仍按任务分开写，都在 `test/check.test.ts`。
- 变异检查：删掉「check 期间保持 `running`」那一行后，`while the check runs, the task is still running` 用例失败，说明它能抓到提前写入 `success` 的问题。
- 计划外的改动：`test/mcp.test.ts` 加了一条 MCP `check` 用例（Task 1 验收要求）；`test/skills.test.ts` 锁定了「reply works after …」的原文，已按新文案更新，并补上 `--check` 规则的断言。

## Checkpoint: Complete

- [x] `npm test` 全量通过
- [x] `npm run build` 通过
- [x] spec 第 1 至第 10 条全部满足
- [x] 不包含版本号与发布改动
