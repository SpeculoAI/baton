# Tasks: task-scope (#37)

规格：`SPEC-task-scope.md`；计划：`tasks/plan-scope.md`

## Phase 1: 纯函数与 git

- [x] **T1** Types + `scope.ts` matcher（S）
  - Acceptance: matchesGlob/前缀/`!` 拒绝/`../` 越界；`TaskStatus`/`TaskMeta` 字段就位
  - Verify: `node --test test/scope.test.ts` && `npm run typecheck`
  - Files: `src/scope.ts`, `src/types.ts`, `test/scope.test.ts`
  - Deps: 无

- [x] **T2** `pathsSinceBaseline`（S）
  - Acceptance: snapshot 含 head；commit∪digest 并集；rename/delete；既有 `gitChanges` 回归
  - Verify: `node --test test/git.test.ts test/scope*.test.ts`
  - Files: `src/git.ts`, `test/git.test.ts`（或 `test/scope-git.test.ts`）
  - Deps: T1

## Checkpoint A
- [x] T1–T2 测试绿；无 CLI 行为变化

## Phase 2: 接线

- [x] **T3** Policy + start/CLI/MCP（M）
  - Acceptance: applyPolicy 单测；非 git+scope 拒绝；flags/MCP 字段
  - Verify: 相关 unit 测试
  - Files: `src/scope.ts`, `src/tasks.ts`, `src/cli.ts`, `src/mcp.ts`, tests
  - Deps: T2

- [x] **T4** Supervisor 钩子（M）
  - Acceptance: 任务级检查；warn/fail 集成；净空则 `scope_violations=[]`
  - Verify: fake-cli 集成
  - Files: `src/supervisor.ts`, tests
  - Deps: T3

## Checkpoint B
- [x] warn/fail 端到端可演示

## Phase 3: 契约与收尾

- [x] **T5** reply + skills/README/SPEC.md（S）
  - Acceptance: reply 接受 `scope_violation`；orchestrate 三条规则；盲区与新状态说明
  - Verify: `test/skills.test.ts` + reply 测试
  - Files: `src/tasks.ts`, skills, README*, `SPEC.md`
  - Deps: T4

- [x] **T6** 边角集成 + 全量（M）
  - Acceptance: 返工还原、子 cwd、gitignore 盲区、无 scope 回归
  - Verify: `npm test`（78 全绿）
  - Deps: T5

## Done when
- [x] `SPEC-task-scope.md` Success Criteria 落地（待 PR 勾文档）
- [ ] PR 指向 Issue #37
