# Implementation Plan: 空闲超时的终态

Source spec: `SPEC-idle-timeout-terminal-state.md`

## Overview

`stop()` 在杀子进程之前把 `stop_reason` 写入仍为 `running` 的 meta。supervisor 正常收尾时删掉该字段，终态与现在的成功路径相同。它中途退出时，现有 `status()` 孤儿路径按 `stop_reason` 收成 `timed_out` 或 `cancelled`，并杀掉残留子进程。没有该字段的崩溃仍是 `failed` / `supervisor exited unexpectedly`。

任务全文在 `tasks/todo.md`。下面是顺序索引。

## Architecture Decisions

- 决定记在 `TaskMeta.stop_reason`（`"idle" | "max_duration" | "cancelled"`），不新开文件。终态 `writeMeta` 时删除。运行中的短暂窗口可以带上这个字段，不把它做成稳定 API，也不在 `status()` 的 running 视图里单独剔除。
- 不改 `orphaned()` 的判定。有字段才改收尾文案和 `status`；没字段的分支保持 `failed` 与 `liveness: "orphaned"`。
- `killGroup` 的异常在 `stop()` 里吞掉。计时器回调不能在决定落盘前把进程打崩。
- 崩溃注入 `BATON_CRASH_AFTER_STOP_PERSIST=1` 只在 `stop()` 里、`killGroup` 尝试之后 `process.exit(1)`。测试通过 sandbox 的 `env` 在 `start` 前设上。不进 CLI、不进 reference。
- 同一 turn 只追加一条 `turn_ended`。`store.ts` 提供「本 turn 是否已有 `turn_ended`」的读取，supervisor 收尾和孤儿收尾都先查再写。避免心跳过期把活着的 supervisor `SIGKILL` 掉时两边各写一条。
- 有 `stop_reason` 的收尾返回 `finished(meta)`，不带 `liveness`。无字段的孤儿返回保持现在的 `{ ...meta, liveness: "orphaned", quiet_for_s }`。
- 摘要字符串逐字沿用 supervisor 现有文案：`Timed out: idle.`、`Timed out: max_duration.`、`Cancelled.`、`supervisor exited unexpectedly`。
- 不新加模块。逻辑留在 `stop()` 和 `status()`。

## Dependency Graph

```
TaskMeta.stop_reason
    │
    └── stop() 先落盘，再 killGroup，正常收尾时删除
            │
            └── status() 孤儿路径按字段收尾
                    │
                    └── 崩溃注入测试（idle / max_duration / cancel）
                            │
                            └── 三份文档补一句契约
```

顺序执行。文档依赖收尾文案已经在代码里定死，不与 Task 2 并行。

## Task List

### Phase 1: 决定落盘

- [x] Task 1: `stop()` 写入并在正常收尾时删除 `stop_reason`

### Checkpoint: 决定落盘

- [x] 现有 idle / max_duration / cancel 用例仍是对应终态
- [x] 终态 meta 没有 `stop_reason`
- [x] `node --test test/lifecycle.test.ts` 通过

### Phase 2: 崩溃窗口

- [x] Task 2: 孤儿路径认 `stop_reason`，并补崩溃注入测试

### Checkpoint: 崩溃窗口

- [x] `npm test` 通过
- [x] 无 `stop_reason` 的 SIGKILL 用例仍是 `failed` + `liveness: orphaned`

### Phase 3: 文档

- [x] Task 3: architecture 与两份 reference 补上这句契约

### Checkpoint: Complete

- [x] `npm test` 通过
- [x] 三份文档都写明：已有 `stop_reason` 时下次读取收成 `timed_out` 或 `cancelled`
- [x] 人审之后再改代码以外的范围

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| supervisor 最终 `writeMeta` 与孤儿收尾同时写，出现两条 `turn_ended` | Med | 两边追加前都看本 turn 是否已有 `turn_ended`。孤儿路径在锁内重读 meta，`status !== "running"` 则直接返回 |
| `wait` 在 `stop_reason` 已写入、终态尚未写入时仍看到 `running` | Low | 这是 spec 要求的窗口。终态仍由正常收尾或下一次孤儿读取给出 |
| 崩溃注入环境变量漏进用户环境 | Low | 只认精确值 `"1"`，且只在 `stop()` 内生效。文档不记载 |
| 正常收尾的 git / scope 检查把 `timed_out` 改成别的状态 | Low | 现有升级条件只作用于 `success`。收尾赋值以内存里的 `stopped` 为准，并删掉 `stop_reason` |

## Open Questions

无。范围以 spec 的三条假设为准：三种 `stop()` 原因都修；崩溃窗口补一条 `exit_code: null` 的 `turn_ended`；`stop_reason` 不进入稳定 API。

## Parallelization

必须顺序做。三处写入共享同一 meta 字段和同一句摘要。没有可以拆开并行的切片。
