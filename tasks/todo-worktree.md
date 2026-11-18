# Tasks: Worktree (#36)

规格：`SPEC-task-worktree.md`；计划：`tasks/plan-worktree.md`

## Phase 1: 基元 + add/ls

- [x] Task 1: 配置加载与 Safety 基元（S）
  - Acceptance:
    - 读仓库根 `.baton.json` → `worktree` 段；缺省安全默认值
    - `resolveWorktreeRoot(repo)`：配置 `dir` > `.worktrees` > `worktrees` > 默认 `.worktrees`
    - `ensureIgnored(root)`：`git check-ignore`；否则追加 gitignore 行，返回是否更新
    - `assertNotNestedWorktree(cwd)`：linked worktree（非 submodule）则抛错
    - 导出供 T2+ 使用，尚不接 CLI
  - Verify: `node --test test/worktree.test.ts`（临时 git 仓覆盖上述路径）
  - Files: `src/worktree.ts`, `test/worktree.test.ts`
  - Deps: 无

- [ ] Task 2: `worktree add` + `ls`（M）
  - Acceptance:
    - `add`：跑 Safety → `git worktree add -b baton/<name> <root>/<name> <base>`（name 默认 8 hex；branch/base 可覆写）
    - 树内写 `.baton-worktree.json`
    - 返回 `{ status:"ok", path, branch, base, gitignore_updated }`
    - `ls`：列出根下带登记文件的树（path、branch、name）
  - Verify: `node --test test/worktree.test.ts` 覆盖默认命名、自定义 name/branch、ls
  - Files: `src/worktree.ts`, `test/worktree.test.ts`
  - Deps: T1

## Checkpoint: Phase 1

- [ ] `npm test` 全绿
- [ ] 临时仓可 `add` 出目录且 `git worktree list` 可见

## Phase 2: 准备与删除

- [ ] Task 3: copy / symlink / post_create（M）
  - Acceptance:
    - `add` 成功后按配置从主仓 copy（gitignore 风格）与 symlink
    - `post_create` 在树内执行；环境含 `BATON_MAIN_REPO`、`BATON_WORKTREE`；非 0 → 失败并清理半成品
    - symlink 风险不在此任务写文档（T6）
  - Verify: 测试 copy `.env` / `.env.local`、symlink 目录、post_create 看到环境变量、失败清理
  - Files: `src/worktree.ts`, `test/worktree.test.ts`
  - Deps: T2

- [ ] Task 4: `worktree rm`（M）
  - Acceptance:
    - 解析 name 或 path；必须在 worktree 根下（provenance）
    - 脏（未提交改动）或有未合并且策略要求保留时 → `failed`，不删
    - 干净：主仓执行 `git worktree remove` → 删本地分支 → `git worktree prune`
    - 禁止在待删树 cwd 内执行 remove
  - Verify: 脏拒删、净删除、拒删主仓路径、删后 `ls` 为空
  - Files: `src/worktree.ts`, `test/worktree.test.ts`
  - Deps: T2

## Checkpoint: Phase 2

- [ ] `npm test` 全绿
- [ ] add → 改文件 → rm 失败；提交/还原后 rm 成功

## Phase 3: 入口与文档

- [ ] Task 5: CLI 接线 + start --cwd 冒烟（S）
  - Acceptance:
    - `baton worktree add|ls|rm` 经 `cli.ts` 可用，一行 JSON
    - 用法错误信息更新；不破坏现有命令
    - 测试或冒烟：`worktree add` 后 `start --cwd <path>` 的 meta.cwd 正确（fake CLI）
  - Verify: `npm test`；手工 `node src/cli.ts worktree …`
  - Files: `src/cli.ts`, `test/worktree.test.ts` 或 `test/lifecycle.test.ts` 追加
  - Deps: T3, T4

- [ ] Task 6: skills + README（S）
  - Acceptance:
    - `baton-orchestrate` / `baton-rescue`：先 `worktree add`，再 `start --cwd`；删树用 `worktree rm`
    - README 中英：命令、`.baton.json` 示意、symlink `node_modules` 风险、与 Superpowers 目录约定一致
    - `SPEC-task-worktree.md` 状态改为已审定/实现中
  - Verify: skills 测试不引入 0.2.x 旧词；文档命令与 CLI 一致
  - Files: `skills/*`, `README.md`, `README.zh-CN.md`, `SPEC-task-worktree.md`, 或有 `test/skills.test.ts`
  - Deps: T5

## Checkpoint: Complete

- [ ] `npm test` 全绿
- [ ] SPEC Success Criteria 1–8 逐条核对
- [ ] 开 PR，关联 #36
