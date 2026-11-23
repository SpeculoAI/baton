# Spec Delta: 空闲超时的终态 — V1

Status: proposed

对应 issue：[SpeculoAI/baton#60](https://github.com/SpeculoAI/baton/issues/60)。已发布行为见 `docs/architecture.md`（Statuses and liveness）和 `docs/reference.md`（Statuses and liveness）。本文件只描述这次修正。

## Objective

`baton wait` / `baton status` 在空闲超时之后必须给出 `timed_out`，摘要为 `Timed out: idle.`。supervisor 在记下这个决定之后、写完最终事件之前退出时，下一次读取仍给出同一终态，并杀掉残留子进程。

使用者是调用 `baton wait --until-done` 的 host agent。成功是：静默超过 `--idle-timeout` 的任务以 `timed_out` 结束，技能文档里「`timed_out` 则加大 `--idle-timeout` 再开一单」的分支能够走通。

同一条 `stop()` 路径上的 `max_duration` 与 `cancelled` 一并保住决定。真正的 supervisor 崩溃（还没进入 `stop()`）仍是 `failed` / `supervisor exited unexpectedly`。

## Current Behavior

`src/supervisor.ts` 的空闲计时器在 `lastByteAt` 超过 `idle_timeout_s` 时调用 `stop("idle")`。`stop()` 只在内存里记下原因并 `killGroup(childPid)`。`timed_out` 与 `turn_ended` 要等子进程退出、git 收尾之后才写入。

supervisor 若在这次写入之前退出，磁盘上的 `status` 仍是 `running`。`src/tasks.ts` 的 `status()` 把这视为孤儿：杀掉残留进程，写入 `failed`、`supervisor exited unexpectedly`，并追加 `turn_ended`（`exit_code: null`）。`wait` 返回的第一次视图还带 `liveness: "orphaned"`。

#60 的观测：`--idle-timeout 600`，`quiet_for_s` 约 606，`status: failed`，`summary: supervisor exited unexpectedly`，`liveness: orphaned`。`quiet_for_s` 按最后一条事件计算，空闲计时按最后一次 stdout/stderr 字节计算，两者可以相差数秒。

`docs/architecture.md` 与 `skills/baton-rescue/SKILL.md`、`skills/baton-orchestrate/SKILL.md` 已要求空闲超时为 `timed_out`。代码在这条崩溃窗口里做不到。

## New Behavior

`stop()` 第一次生效时，先把决定写入 `meta.json`，再杀进程组：

- 字段：`stop_reason`，取值 `idle` | `max_duration` | `cancelled`。
- 此时 `status` 仍为 `running`。已有 `stop_reason` 不重复写。
- 然后调用 `killGroup`。`killGroup` 抛错只吞掉，不能阻止决定已经落盘，也不能让计时器回调把进程打崩。
- `stop_reason` 是内部字段。终态写入时删掉它。稳定对外结果仍是 `status` + `summary`。

supervisor 活到收尾时，行为与现在的成功路径相同：`idle` / `max_duration` → `timed_out`，摘要 `Timed out: idle.` 或 `Timed out: max_duration.`；`cancelled` → `cancelled`，摘要 `Cancelled.`。只追加一条 `turn_ended`。`git_changes`、scope、readonly 收尾仍在这条路径上做，且不得把已经决定的 `timed_out` / `cancelled` 改成 `failed`。

supervisor 在落盘 `stop_reason` 之后、完成上述收尾之前退出时，下一次 `status()` / `wait` 走现有孤儿锁，并按 `stop_reason` 收尾：

| `stop_reason` | `status` | `summary` |
|---|---|---|
| `idle` | `timed_out` | `Timed out: idle.` |
| `max_duration` | `timed_out` | `Timed out: max_duration.` |
| `cancelled` | `cancelled` | `Cancelled.` |

这次收尾仍杀掉残留子进程，并追加恰好一条对应状态的 `turn_ended`（`exit_code: null`）。返回视图与正常终态读取一致：有 `status` 与 `summary`，没有 `liveness`。没有 `stop_reason` 的孤儿路径不变：`failed`、`supervisor exited unexpectedly`、第一次读取带 `liveness: "orphaned"`。

`status !== "running"` 的任务不改写。

## Tech Stack

Node.js `>=20.17`，TypeScript ESM。测试用 `node:test`。无新依赖。

## Commands

```bash
npm test
npm run typecheck
npm run build
```

`npm test` 已包含 `tsc --noEmit` 与 `node --test "test/**/*.test.ts"`。本改动的回归在 `npm test`。

## Project Structure

```
src/supervisor.ts   stop() 先落盘 stop_reason，再 killGroup
src/tasks.ts        孤儿收尾读取 stop_reason
src/types.ts        TaskMeta.stop_reason
test/lifecycle.test.ts
docs/architecture.md
docs/reference.md
docs/reference.zh-CN.md
```

技能文案已与目标行为一致，不改。

## Code Style

与现有 `src/supervisor.ts` 一致：直接写 meta，不新加一层 stop 服务。示意：

```ts
const stop = (reason: "idle" | "max_duration" | "cancelled") => {
  if (!stopped) {
    stopped = reason;
    meta.stop_reason = reason;
    meta.updated_at = new Date().toISOString();
    writeMeta(meta);
  }
  try { killGroup(childPid); } catch { /* 决定已落盘；杀进程失败留待孤儿收尾 */ }
};
```

## Testing Strategy

框架：`node:test` + `node:assert/strict`。测试放在 `test/lifecycle.test.ts`，沿用现有 `sandbox` / fake CLI。

1. 现有用例保持：idle、max_duration 得到 `timed_out` 且摘要匹配原因；cancel 得到 `cancelled`；孙进程被杀掉；事件流以一条 `turn_ended` 结束。
2. 新增崩溃窗口：fake CLI 挂起，`--idle-timeout 0.4`。supervisor 在 `stop_reason` 落盘且 `killGroup` 尝试之后、最终 `turn_ended` 之前 `process.exit(1)`。注入只认环境变量 `BATON_CRASH_AFTER_STOP_PERSIST=1`，不是 CLI 旗标，不写进用户文档。`wait` / `status` 得到 `timed_out`、摘要 `Timed out: idle.`、无 `liveness`。事件里没有 `status: failed` 的 `turn_ended`。再读一次 `status`，状态与事件条数不变。孙进程已退出。
3. 同一注入覆盖 `max_duration` 与 `cancel` 各一次。
4. 现有「SIGKILL supervisor」用例保持：无 `stop_reason` 时仍是 `failed`、`supervisor exited unexpectedly`、`liveness: orphaned`，且只写一次。

## Boundaries

- Always: 跑 `npm test`。happy path 恰好一条 `turn_ended`。终态摘要字符串与现在的 supervisor 文案逐字相同。
- Ask first: 新依赖、把 `stop_reason` 做成用户可见的稳定字段、改动「无 `stop_reason` 的崩溃仍是 `failed`」这条。
- Never: 用 `quiet_for_s >= idle_timeout_s` 猜测超时。提交密钥。删掉现有孤儿测试来换绿灯。把 `BATON_CRASH_AFTER_STOP_PERSIST` 写进 CLI 帮助或 reference。

## Success Criteria

- 空闲超时且 supervisor 正常收尾：`status === "timed_out"`，`summary === "Timed out: idle."`，恰好一条 `turn_ended`，无 `liveness`。
- `BATON_CRASH_AFTER_STOP_PERSIST=1` 的空闲超时：同上，残留孙进程不在，第二次 `status` 不追加事件。
- `max_duration` 在正常收尾与崩溃注入下均为 `timed_out`，摘要 `Timed out: max_duration.`。
- `cancel` 在正常收尾与崩溃注入下均为 `cancelled`，摘要 `Cancelled.`。
- supervisor 在 `stop()` 之前被 `SIGKILL`：`failed`，摘要 `supervisor exited unexpectedly`，第一次读取 `liveness === "orphaned"`。
- `npm test` 通过。

## Out of Scope (Deferred)

- 用静默时长把无 `stop_reason` 的孤儿改判成 `timed_out`。会把超时窗口之外的崩溃标错。
- 让空闲计时改看 `last_event_at`，或让 Cursor 适配器把 `thinking` 行记成事件。这解释 #60 里多出来的约 6 秒，不决定终态分类。
- `stop_reason` 落盘之后、`killGroup` 根本没发出去就退出时，靠别的机制补杀。本版仍靠下一次 `status()` / `wait` 的孤儿路径杀残留进程。
- 追查 cursor-agent 为何在这扇窗口里让 supervisor 退出。终态以落盘的 `stop_reason` 为准。

## Open Questions

无阻塞项。V1 按下列假设写死，评审时直接改本文件：

1. `idle`、`max_duration`、`cancelled` 都走「先落盘再杀」。#60 只点名 idle，另外两个是同一个 `stop()`。
2. 崩溃窗口由下一次读取补上一条 `turn_ended`（`exit_code` 为 `null`），tail 上能看到终态。
3. `stop_reason` 不进入稳定 API，终态 meta 里删除。
