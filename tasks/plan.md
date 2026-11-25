# Plan: `start --check <cmd>`

Source spec: `SPEC-check-command.md`

## 现状与插入点

`src/supervisor.ts` 中一轮的收尾顺序：

1. worker 退出后，`finally` 清掉 `heartbeat` 与 `timeout` 两个计时器。
2. 计算 transport 终态 `final` 与 `summary`，并**立刻赋值** `meta.status = final`。
3. git 快照、readonly 检查、scope 检查（可能把 `final` 升级为 `*_violation`）。
4. `writeTurn`，追加 `turn_ended`（`emit` 内部会 `save()` meta）。

check 插在第 3 步之后、第 4 步之前，并且只在 `final === "success"` 时运行。

## Architecture Decisions

- **check 运行期间，落盘的 meta 必须仍是 `running`。** 现在第 2 步就给 `meta.status` 赋了终态，而 `check_started` / `check_ended` 事件会经 `emit()` → `save()` 写盘。不改的话，`wait --until-done` 会在 check 跑完之前看到 `success` 并返回。做法：check 期间把 `meta.status` 保持为 `running`，check 结束后再统一写入终态（`success` 或 `check_failed`）。
- **check 运行期间 heartbeat 不能停。** `orphaned()`（`src/tasks.ts:261`）在 heartbeat 超过 30 秒没更新时，会把 supervisor 判为孤儿并杀掉。check 可能跑几分钟，所以 heartbeat 要一直保持到 check 结束（推迟 `clearInterval(heartbeat)`，或者在 check 期间重新开一个）。
- **check 的空闲超时不走 `stop()`。** `stop("idle")` 会落盘 `stop_reason`，使任务收成 `timed_out`。check 超时要收成 `check_failed` / `check.status: "timed_out"`，所以 check 用自己的局部计时器，只杀 check 进程组。
- **cancel 走现有路径。** check 运行期间令 `childPid` 与 `meta.child_pid` 指向 check 进程组，`stop("cancelled")` 就会杀掉它；之后由现有的 `stopped` 分支收成 `cancelled`。
- **复用现有工具函数。** 脱敏用 `redact()`，写日志用与 worker raw 日志相同的 `0600` 方式，进程组用 `spawn(..., { detached: true })` 加 `killGroup()`。check 逻辑写成 `supervisor.ts` 里的一个局部函数，不新建模块。
- **`reply` 清空上一轮的 `check`**，与 `scope_violations` 的处理一致；`check_failed` 加入允许 `reply` 的终态列表（`src/tasks.ts:359`）。
- supervisor 若在 check 期间崩溃：没有 `stop_reason`，沿用现有孤儿路径，收成 `failed` / `supervisor exited unexpectedly`。这符合 spec，不做特殊处理。

## Dependency Graph

```
types（TaskStatus、TaskMeta、Turn、EventData）
   │
   ├── 参数通路：cli --check、mcp check、tasks.start 写 meta.check_command
   │
   └── supervisor 收尾运行 check（通过 / 失败 / 不运行），tail 格式化新事件
            │
            ├── reply：允许 check_failed，每轮重跑
            │
            └── 超时、cancel、heartbeat、check 期间状态仍为 running
                     │
                     └── 文档与 skill
```

## 顺序

1. Task 1：端到端主路径（通过、失败、不运行、cwd、不带 `--check` 时行为不变）。
2. Task 2：`reply` 与每轮重跑。
3. Task 3：超时、cancel、check 期间 meta 仍为 `running`。
4. Task 4：文档与 skill。

全部顺序执行：后面的任务都改同一段收尾代码，不并行。

## 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| check 期间 meta 已写成 `success`，`wait` 提前返回 | 高：host 拿不到 check 结果就开始 review | Task 3 用例：check 用 `sleep` 时，`status` 仍为 `running` |
| heartbeat 停止，长 check 被误判为孤儿 | 高：真实项目中测试常常超过 30 秒 | 设计上保持 heartbeat；用例只能间接覆盖（等 30 秒太慢），在代码注释与 PR 中写明 |
| check 失败时 summary 过长，淹没 host 上下文 | 中 | `output_tail` 限 4000 字符，summary 整体仍截断到 8192 |
| 新终态 `check_failed` 让只认识旧状态的客户端出错 | 中 | 文档里写 Breaking note；Baton 自己的 skill 同步更新 |
| `--isolate` 的 worktree 里没装依赖，check 必然失败 | 中 | 文档提示用 `.baton.json` 的 `post_create` 安装依赖；不在 Baton 里自动安装 |

## 检查点

- Task 1 之后：`node --test test/check.test.ts` 通过，`npm run build` 通过。
- Task 3 之后：`npm test` 全量通过。
- Task 4 之后：`npm test` 通过；文档与 skill 中出现 `check_failed` 的地方说法一致。
