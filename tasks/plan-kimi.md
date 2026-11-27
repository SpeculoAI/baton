# Implementation Plan: Kimi Code CLI adapter

Source spec: `SPEC-kimi-adapter.md`
Task list: `tasks/todo-kimi.md`

## Overview

新增 `kimi` target：一个 adapter 文件，加上注册表和 target 枚举处的改动，再加测试与文档。运行时通用逻辑不变，只把 `src/tasks.ts:126` 的 `--model` 白名单扩到 kimi。全部改动在分支 `feat/kimi-adapter`（worktree `.worktree/kimi-adapter`）上，最后合成一个 PR。

## Architecture Decisions

- adapter 结构照 `src/adapters/agy.ts`，实测行为一律写注释并标日期和版本（spec「Code Style」）。
- Windows 下 argv 提示词的安全检查放进 `src/adapters/common.ts`，做成与具体 CLI 无关的函数，由 kimi 的 `build()` 调用；出错时直接抛异常，由 supervisor 现有的 try 捕获，任务记为失败（spec K1）。
- 单测的样例行来自 T0 的真实输出，整理成 `test/fixtures/kimi-2.8.0.stream.jsonl`，去掉真实会话 id 和本机路径。
- 集成测试复用现有 fake CLI：新增入口脚本 `test/fake-cli/kimi` 和 `kimi.cmd`，测试里把 `FAKE_FIXTURE` 换成 kimi 格式的输出。`fake.mjs` 本身不改。
- `rulesync-setup` 不改：target 映射直接取 adapter 的 `rules.rulesyncTarget`。

## 依赖关系

```
T1 common.ts argv 检查 ─┐
                        ├─> T2 kimi adapter + 注册 + 单测 ─┬─> T3 CLI/MCP 入口 + --model 白名单
                        │                                  ├─> T4 fake CLI 集成测试（依赖 T3）
                        │                                  └─> T5 规则 / rulesync 测试
                        └──────────────────────────────────────> T6 文档（依赖 T2–T5 定稿）
                                                                  T7 真机冒烟 + 回写 spec（依赖全部）
```

T1 风险最高（Windows 行为只能在 CI 上看到），放在最前面。T3 和 T5 互不依赖。T4 要等 T3，因为集成测试会用到 `--model`。

## Task List

### Phase 1: Foundation
- [x] T1：`common.ts` 新增 Windows argv 提示词安全检查，附单测
- [x] T2：`kimi.ts` adapter，注册进 `index.ts` / `types.ts`，附 fixture 和单测

### Checkpoint A
- [x] `npm test` 本机全绿；`getAdapter("kimi")` 能用

### Phase 2: Wiring
- [x] T3：CLI / MCP 入口：`mcp.ts`、`usage.ts`、`tasks.ts:126`，附 model-start 测试
- [x] T4：fake CLI 集成测试：start/wait/reply、argv 逐字节、win32 `.cmd` 报错、readonly
- [x] T5：规则、gate、rulesync 映射测试

### Checkpoint B
- [x] `npm test` 本机全绿（237 个测试：235 通过、2 跳过）
- [ ] 征得你同意后 push 分支并开 draft PR，看三平台 CI（Windows 上 T1 / T4 的行为只能在这里验证）

### Phase 3: Docs & verification
- [ ] T6：README、docs、skills 全部补上 kimi
- [ ] T7：macOS 真机冒烟，结果写回 spec，Status 改为 implemented

### Checkpoint C
- [ ] spec 的 Success Criteria 1–10 全部满足
- [ ] 三平台 CI 全绿，交给你评审

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Windows 上只能靠 CI 看到 `.cmd` / `.exe` 的分支行为 | Med | T1 先用纯函数单测覆盖分支（平台和后缀作为参数传入），T4 在 windows-latest 上跑真实的 `.cmd` fake |
| `OUTPUT_CONTRACT` 是多行的，npm 装的 `kimi.cmd` 在 Windows 上每次都会报错 | Med | 按 spec K1 预期行为处理：报错信息写清改用 `install.ps1`，docs 写明 Windows 只支持官方安装 |
| kimi 输出格式随版本变化（目前 2.8.0） | Med | fixture 文件名带版本号；`parseLine` 遇到不认识的行返回 `null`，不让整轮崩掉 |
| 往 `test/fake-cli` 加 `kimi` 后，PATH 里多出一个 target，可能影响枚举 agents 的测试 | Low | T4 开始前 grep 所有依赖 agent 数量或顺序的断言（已初查：没有测试断言 `agents` 列表） |
| 服务端错误时 summary 只有笼统的 `reason: failed` | Low | spec 已决定 V1 接受；summary 里保留 kimi 打印的 `See log: <path>` |
| POSIX 上 argv 长度有 `ARG_MAX` 上限 | Low | `buildPrompt` 只拼文件路径、不拼文件内容，提示词不会太长；真超限时 spawn 会报 `E2BIG`，任务记为失败 |

## Open Questions

无。spec 的两个问题已按建议定稿；`tasks.ts:126` 的改动已获同意。
