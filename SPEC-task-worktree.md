# Spec: Worktree 管理与任务 cwd 解耦 (#36 v1)

日期：2026-11-17  
状态：已审定（进 Plan）  
关联：[#36](https://github.com/wei292224644/agent-plugin-agent/issues/36)

## Objective

并行开发需要独立 git worktree，但 **开树 ≠ 跑任务**。Baton 提供可选的 worktree 生命周期命令（创建时应用项目约定的 copy/symlink/post_create；清理时安全检查），任务执行仍只用已有的 `baton start --cwd <path>`，二者不绑定。

### 用户故事

- 作为宿主，我先 `baton worktree add`，得到路径与分支；再 `baton start --cwd <该路径> ...` 在树里跑任务。同一棵树可跑多轮 / 多任务。
- 作为宿主，我在 `.baton.json` 配 `copy` / `symlink` / `post_create`，`worktree add` 时自动准备 `.env` 与依赖约定。
- 作为宿主，`baton worktree rm` 在有未提交改动或未合并提交时只警告不删；干净则 remove worktree **并删除本地分支**。

### 非目标（v1 不做）

- `baton start --worktree` / 任务 meta 绑定 worktree / `prune` 顺带删树
- `auto` 在引擎里自动给每次 `start` 开树（编排 skill 可文档建议「先 add 再 start」）
- 端口段分配、基础分支同步、合并命令
- 写入锁 / scope（#37）、只读权限（#38）、确定性调度（#23）
- 自造根路径（如 `../.baton-worktrees`、`~/.baton/worktrees/...`）
- 创建后强制跑基线测试 / 猜语言装依赖（setup 只用可配的 `post_create`）
- 自动 `git commit` 对 `.gitignore` 的修改

## Tech Stack

- TypeScript（erasable），Node ≥24，`node --test`，无构建步骤
- Git：本机 `git worktree` / `status` / `branch`（`spawnSync`），不加 git 库
- 配置：仓库根 `.baton.json`（`JSON.parse`，不加 TOML 依赖）

## Commands

```
Test: npm test
Typecheck: 含在 npm test（tsc --noEmit）

baton worktree add [--name <id>] [--branch <name>] [--base <ref>]
baton worktree ls
baton worktree rm <name-or-path>

baton start --cwd <.worktrees/...> ...      # 已有，不变
```

每条命令仍打印一行 JSON。v1 **无** `--force` 强删脏树。

## Project Structure

```
src/worktree.ts          → 配置、add / ls / rm、安全检查、copy/symlink/post_create
src/cli.ts               → worktree 子命令
test/worktree.test.ts
skills/baton-orchestrate/SKILL.md  → 建议：先 worktree add，再 start --cwd
skills/baton-rescue/SKILL.md       → 可选一句：隔离时传 --cwd
README*.md               → 用法 + symlink 风险
SPEC-task-worktree.md
```

不改 `TaskMeta` 增加 worktree 字段（任务不拥有树）。可选：在 `.worktrees/.baton-meta.json` 或每树旁记录 `created_by_baton` / branch，供 `rm` 知道是否删分支——见下方实现约定。

## Code Style

与 `src/tasks.ts` 一致：小函数、显式错误、一行 JSON。

```ts
// add 成功示意
{ "status": "ok", "path": "/repo/.worktrees/a1b2c3d4", "branch": "baton/a1b2c3d4", "base": "main", "gitignore_updated": false }

// rm 因脏拒绝示意
{ "status": "failed", "summary": "worktree has uncommitted changes", "path": "..." }
```

## Safety（对齐 Superpowers 的引擎级约束）

1. **Ignore 校验：** `add` 前对 worktree 根目录跑 `git check-ignore`。未忽略 → **追加一行到 `.gitignore`（不 commit）**，JSON 里 `gitignore_updated: true`。
2. **禁止嵌套：** 若当前 cwd 已是 linked worktree（`GIT_DIR != GIT_COMMON`，且非 submodule）→ `add` 失败，提示先回到主仓。
3. **目录解析：** 显式配置 `dir` > 已存在的 `.worktrees` > 已存在的 `worktrees` > 默认新建 `.worktrees`。
4. **Provenance：** `rm` 只接受位于 worktree 根下的路径/名字；主仓工作区及其它路径拒绝。
5. **删除顺序：** 解析主仓根 → 在主仓执行 `git worktree remove` → 删本地分支 → `git worktree prune`。禁止在待删树内部执行 remove。

## Testing Strategy

- 临时 git 仓：`add`（默认名/分支/base）、ignore 自动追加、嵌套拒绝、`copy`/`symlink`、`post_create` 环境变量、`ls`、脏树拒删、净树删 worktree+分支+prune、provenance 拒删
- `start --cwd` 已有测试；加一条：在 worktree 路径下 start 的 cwd 正确即可（可复用 fake CLI）
- 回归：无 worktree 子命令时，现有 start/prune 行为不变

## Boundaries

- **Always:** ignore 校验；嵌套拒绝；provenance；主仓执行 remove；脏则不删；失败信息含路径
- **Ask first:** 新增依赖；给脏树加 `--force` 强删；改「未忽略则 fail 而非改 gitignore」
- **Never:** `start` 隐式建树；`prune` 级联删 worktree；静默 push/合并；删主工作区；自动 commit `.gitignore`；创建后强制全量测试

## Success Criteria

1. `baton worktree add` 在 worktree 根下 `<name>` 创建树；默认 `name` = 随机 8 hex；默认分支 `baton/<name>`；`base` 来自配置或 `main`/`master` 探测
2. 读取 `.baton.json` 的 `worktree`：`dir` / `base` / `copy` / `symlink` / `post_create`（无 `auto`）
3. `copy` / `symlink` / `post_create` 行为与先前约定一致；注入 `BATON_MAIN_REPO` / `BATON_WORKTREE`
4. ignore / 嵌套 / 目录优先级 / provenance / 删除顺序 均符合 Safety
5. `baton worktree ls` 列出该根下的树：path、branch
6. `baton worktree rm`：脏 → 失败；净 → remove + 删分支 + prune
7. `baton start --cwd <worktree>` 与今日一致；skill/README 写清两步用法 + symlink 风险
8. `npm test` 全绿

## Decisions（已拍板）

| # | 决定 |
|---|---|
| 模型 | **开树与跑任务解耦**；任务只通过 `--cwd` 指定目录 |
| 配置 | `.baton.json`，零 TOML 依赖 |
| 目录 | 默认 `.worktrees`（可配置 `dir`；未见配置时兼容已有 `worktrees/`） |
| 命名 | 默认目录名 8 hex；默认分支 `baton/<name>` |
| 清理 | `worktree rm` 干净时删本地分支 + prune；不挂在 `prune` 上 |
| ignore | 未忽略则 **追加 `.gitignore`、不 commit** |
| 不做 | `start --worktree`、引擎级 `auto`、任务 meta 绑树、基线测试、猜包管理器 |

### 配置示意

```json
{
  "worktree": {
    "dir": ".worktrees",
    "base": "main",
    "copy": [".env", ".env.*"],
    "symlink": ["node_modules"],
    "post_create": ["pnpm install --frozen-lockfile"]
  }
}
```

### 推荐宿主流程

```
baton worktree add                  # → { path, branch }
baton start --cwd <path> --target codex --prompt "..."
baton worktree rm <name>            # 任务结束后，确认干净再删
```

## Open Questions

无。计划见 `tasks/plan-worktree.md` / `tasks/todo-worktree.md`。
