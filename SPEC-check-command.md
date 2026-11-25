# Spec Delta: `start --check <cmd>` 由 Baton 运行验收命令 — V1

Status: proposed

已发布行为见 `docs/reference.md`（Command line、Statuses and liveness 两节）。本文件只描述这次新增。

## Objective

现在同一批测试会跑两遍：worker 在改代码的循环里跑一遍，host 审查时再跑一遍。host 重跑是 `skills/baton-orchestrate/SKILL.md` 要求的（"Never upgrade a worker self-report or transport `success` into `verified pass` without an independent check"）。worker 说「测试通过」只是它最终消息里的一句话，host 不能采信。

本次让 Baton 在 worker 的一轮结束后，在任务的 cwd 里亲自运行 host 指定的验收命令，并把退出码记录到 meta 和 turn。这份结果不是 worker 的自述，host 可以直接采信，不必重跑同一条命令。

使用者是派单的 host agent。成功是：

- 带 `--check` 的任务，host 读 `status` / `wait` 就知道验收命令是否通过，不再自己跑同一条命令。
- 验收失败时，任务以 `check_failed` 结束，带上输出尾部，host 可以直接 `reply` 让 worker 返工。
- 依赖这一单的下游任务，不会因为 worker 退出码为 0 就被解锁。

## Current Behavior

- worker 的一轮结束后，`src/supervisor.ts` 依次判断：transport 终态、readonly 检查、scope 检查，然后写 turn 和 `turn_ended` 事件。没有运行项目命令的步骤。
- skill 让 host 在审查时自己跑测试。用了 `--isolate` 时，host 还得记得先 cd 到 worktree，否则测的是主目录，不是 worker 改过的代码。

## New Behavior

### 参数

- `baton start ... --check "<cmd>"`：一条 shell 命令字符串。需要多条命令时，用户自己用 `&&` 连接，例如 `--check "npm run typecheck && npm test"`。
- MCP `delegate_task` 新增 `check` 参数（string），语义相同。
- 命令写入 meta 的 `check_command`，`reply` 沿用，每一轮结束后都会再跑一次。
- 去掉首尾空白后为空串，视同未传。

### 何时运行

- 只在本轮终态为 `success` 时运行，并且排在 readonly / scope 检查之后。`scope` 的 warn 策略不改变 `success`，所以 warn 时仍然运行。
- 本轮终态是 `needs_input`、`failed`、`timed_out`、`cancelled`、`quota_exceeded`、`not_authenticated`、`scope_violation`、`readonly_violation` 时都不运行，也不写 `check` 字段。
- `--mode readonly` 的任务同样运行（例如只审查、跑测试的任务）。readonly 检查在它之前，测试产生的文件不会被记成 `readonly_violation`。

### 如何运行

- `/bin/sh -c "<cmd>"`，cwd 为 `meta.cwd`（`--isolate` 时就是 worktree）。环境与 worker 相同，含 `BATON_DELEGATION=1`。
- 独立进程组。运行期间 `meta.child_pid` 指向它，所以 `cancel` 和孤儿回收都能杀掉它。
- 超时：沿用任务的 `idle_timeout_s`，连续这么多秒没有任何输出就杀掉进程组，结果记为 `timed_out`。`max_duration_s` 只管 worker，不管 check。
- 完整输出写入 `raw/<n>.check.log`（`0600`），与 worker 的 raw 日志相同对待。

### 结果

`turns/<n>.json` 与 meta 都写入 `check`（meta 中的是最近一轮的结果）：

```json
{
  "command": "npm test",
  "status": "passed",
  "exit_code": 0,
  "duration_ms": 8123,
  "output_tail": "…最后 4000 字符，已脱敏…"
}
```

- `status`：`passed`（退出码 0）、`failed`（退出码非 0，或进程无法启动）、`timed_out`（空闲超时）。
- `passed`：任务终态仍为 `success`，`summary` 不变。
- `failed` / `timed_out`：任务终态改为新的 `check_failed`，`summary` 为 `check_failed: exit <code>`（超时则为 `check_failed: timed out`），换行后接 `output_tail`，整体仍截断到 8192 字符。
- 运行期间被 `cancel`：任务终态为 `cancelled`，`check` 字段记为未完成（不写 `status`），沿用现有的取消收尾。
- 事件流追加两条：`{ "type": "check_started", "command": "…" }` 和 `{ "type": "check_ended", "status": "…", "exit_code": … }`。`tail` 能看到。

### 对外契约

- 新增终态 `check_failed`，与 `scope_violation`、`readonly_violation` 同类：它是一个已结束的 turn，可以 `reply`，`reply` 后的新一轮结束时再跑一次 check。
- **Breaking note**（与 `scope_violation` 当时的写法一致）：客户端会遇到新的终态值 `check_failed` 和可选字段 `check`。

### Skill 规则

- `baton-orchestrate` 与 `baton-rescue`：项目有现成的验收命令（typecheck、单测）时，派写任务带上 `--check`。
- `check.status === "passed"`：视为该命令已经由 Baton 独立验证。Review 时**不再重跑同一条命令**，只审 diff 和命令覆盖不到的部分。
- `check_failed`：把 `output_tail` 要点用 `baton reply` 发回同一会话返工，计入返工次数；不得换别家 CLI（与 `scope_violation` 同样处理）。
- 没带 `--check` 的任务，Review 规则不变。

## Success Criteria

1. `--check "exit 0"`：终态 `success`；meta 与 turn 中 `check.status` 为 `passed`、`exit_code` 为 0；事件流有 `check_started` 和 `check_ended`。
2. `--check "echo boom; exit 3"`：终态 `check_failed`；`check.exit_code` 为 3；`summary` 以 `check_failed: exit 3` 开头并含 `boom`；`raw/1.check.log` 含 `boom`。
3. check 的 cwd 是任务 cwd：`--check "test -f marker"` 在 cwd 有 `marker` 时为 `passed`；与 `--isolate` 同用时，在 worktree 里运行。
4. worker 本轮不是 `success`（例如 `FAKE_EXIT=1`）：不运行 check，没有 `check` 字段，也没有 check 事件。
5. 对 `check_failed` 的任务 `reply`：第 2 轮结束后重新运行 check，结果覆盖 meta 中的 `check`，turn 2 有自己的 `check`。
6. 空闲超时：`--idle-timeout 1 --check "sleep 5"` 得到 `check_failed`，`check.status` 为 `timed_out`，check 进程组已被杀掉。
7. check 运行期间 `cancel`：终态 `cancelled`，check 进程组已被杀掉，只有一条 `turn_ended`。
8. 不带 `--check`：行为、meta、事件与现在完全相同。
9. `npm test` 和 `npm run build` 通过。
10. 文档同步：`docs/reference.md`（Command line、Statuses and liveness、MCP tools、Task directory 中的 `raw/<n>.check.log`）、`docs/reference.zh-CN.md`、`docs/architecture.md` 的状态列表、两个 skill 的 Review 规则、`src/mcp.ts`。

## Boundaries

- 改动范围：`src/types.ts`（`TaskStatus`、`TaskMeta`、turn 和事件类型）、`src/tasks.ts`（参数校验、写入 meta）、`src/cli.ts`、`src/mcp.ts`、`src/supervisor.ts`（收尾处运行 check），以及测试和第 10 条列出的文档。
- check 的运行逻辑留在 `supervisor.ts` 的收尾流程里，不新建模块，除非函数长到影响阅读。
- 命令来自 host，按受信输入处理（与 prompt 相同），但输出写入 events、summary 之前要脱敏。
- 测试使用 fake CLI 和真实的 `/bin/sh`，不调用真实 agent。
- 运行时文案、测试、英文文档用英文；中文只写进 `docs/reference.zh-CN.md`。
- 先问再做：版本号与发布。

## Out of Scope (Deferred)

- `baton check <id>`：不派 worker，只对已结束的任务重跑 check。等真有需要再做。
- check 失败后自动 `reply` 返工：是否返工、返工几次由编排者决定，这属于 #23 的调度范围。
- 多条 check、每条单独记结果：用 `&&` 已能满足；分条结果等有需求再做。
- warn / fail 策略开关（像 `--scope-on-violation`）：check 的意义就是卡点，V1 固定为失败即 `check_failed`。
- 依赖图调度（`baton plan run`）：仍按 #23 暂缓。

## Open Questions

1. 输出尾部定为 4000 字符：够看清测试框架的失败摘要，又不会占满 host 上下文。可以吗？
2. check 的超时沿用 `idle_timeout_s`（默认 600 秒无输出），不新增 `--check-timeout`。测试长时间静默的项目需要调大 `--idle-timeout`，它也会同时作用于 worker。可以接受吗？
