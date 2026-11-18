# Implementation Plan: Worktree 管理与任务 cwd 解耦 (#36)

规格：`SPEC-task-worktree.md`  
状态：待审  
分支建议：从最新 `main` 开 `feat/issue-36-worktree`（当前另有未 push 的 `fix/issue-35-orchestrate-acceptance`）

## Overview

新增独立的 `baton worktree add|ls|rm`，读取 `.baton.json`，在 `.worktrees`（或兼容 `worktrees`）下创建/列出/安全删除 git worktree。`baton start` 不改语义，只用已有 `--cwd`。对齐 Superpowers 的 ignore / 嵌套 / provenance / 删除顺序。

## Architecture Decisions

- **解耦：** 树生命周期 ≠ 任务生命周期；不改 `TaskMeta`。
- **登记：** 每个树内写 `.baton-worktree.json`（`name` / `branch` / `base` / `created_at`），`ls`/`rm` 靠它 + `git worktree list`，不另建全局 DB。
- **Git 调用：** `spawnSync("git", …)`，与现有风格一致。
- **copy 匹配：** 自写极简 gitignore 风格匹配（`*` / `?` / 前缀 `**/`），不加 minimatch 依赖；覆盖 `.env`、`.env.*` 足够。
- **CLI：** `cli.ts` 增加 `worktree` 子命令，再 parse `add|ls|rm`。
- **失败形态：** 与其它命令一致——stdout 一行 JSON，`status: "failed"`，`process.exitCode = 1`。

## Dependency Graph

```
T1 配置 + Safety 基元（ignore / 嵌套 / 根目录解析）
 └─ T2 worktree add（git + 登记文件）+ ls
      └─ T3 copy / symlink / post_create
           └─ T4 worktree rm（脏检 / provenance / 顺序）
                └─ T5 CLI 接线 + start --cwd 冒烟
                     └─ T6 skills + README
```

## Task List

见 `tasks/todo-worktree.md`。

- Phase 1：T1–T2（能 add/ls）
- Phase 2：T3–T4（准备与安全删除）
- Phase 3：T5–T6（入口与文档）

## Parallelization

全部串行。共享 `src/worktree.ts` / `cli.ts`，并行易冲突。

## Risks and Mitigations

| 风险 | 影响 | 缓解 |
|---|---|---|
| `git worktree add` 在沙箱/权限下失败 | 中 | 测试用临时仓；错误原文进 `summary` |
| copy glob 过简，漏匹配 | 低 | 测试钉死 `.env` / `.env.local` / `node_modules` symlink |
| `post_create` 命令注入/挂起 | 中 | 只跑配置数组里的字符串；设超时（如 600s）；非 0 退出则 add 失败并尝试清理半成品树 |
| 半成品树残留 | 中 | add 失败路径：若已 `worktree add` 则尽力 `remove --force`（仅未登记成功时） |
| 与 issue #35 分支交错 | 低 | worktree 从最新 main 拉新分支；#35 另 PR |

## Open Questions

无（规格已收口）。批准本 plan 后按 `todo-worktree.md` 实施。
