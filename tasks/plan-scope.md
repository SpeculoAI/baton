# task-scope (#37) Implementation Plan

> **For agentic workers:** Use TDD per task. Spec: `SPEC-task-scope.md`（已批准）. Do not expand into overlap / revert / 事前权限.

**Goal:** Optional `--scope` post-check against task-baseline net changes; `warn|fail` → `scope_violations` / `scope_violation`.

**Architecture:** Extend `gitSnapshot` with `head`; persist task `scope_baseline` at start; each turn end compute `pathsSinceBaseline` = committed names ∪ working-tree digest diff; `scope.ts` normalizes to cwd + matches globs; supervisor applies policy. `reply` accepts `scope_violation`. Orchestrate skill wires files→`--scope` and review rules.

**Tech Stack:** Node 24 TypeScript (existing), `path.matchesGlob`, `node:test`. No new deps.

## Global Constraints

- No `--scope` → zero behavior change
- Mistake prevention, not a security boundary
- Task-level net diff (not turn-only; not `base...HEAD` alone)
- Zero new dependencies; prefer `path.matchesGlob`
- Do not bind scope into `baton worktree`

## File map

| File | Role |
|---|---|
| `src/types.ts` | `scope_violation` status; meta fields |
| `src/git.ts` | Snapshot + `head`; `pathsSinceBaseline` |
| `src/scope.ts` | **new** normalize, match, violations, applyPolicy |
| `src/store.ts` | optional: baseline blob beside meta if large |
| `src/tasks.ts` | start validates/writes scope+baseline; reply allows status |
| `src/supervisor.ts` | run check before writing final status |
| `src/cli.ts` / `src/mcp.ts` | flags / schema |
| `skills/baton-orchestrate/SKILL.md` | reply / warn / files→scope |
| `README*.md` / `SPEC.md` | docs + status enum |
| `test/scope.test.ts` / extend `test/git.test.ts` | TDD |

## Dependency graph

```
T1 types + scope matcher (pure)
 └─ T2 git baseline / pathsSinceBaseline
      └─ T3 applyPolicy + start/cli/mcp wire-up
           └─ T4 supervisor hook
                └─ T5 reply + orchestrate/README/SPEC.md
                     └─ T6 integration cases (commit, rework, sub-cwd, …)
```

## Tasks

### T1 — Types + `scope.ts` matcher (TDD)

1. Add failing tests in `test/scope.test.ts` for:
   - `src/auth/**` matches `src/auth/x.ts`
   - bare `src/auth` as directory prefix
   - `!foo` rejected
   - `../outside` always violation
   - `**/*` does not match `.github/a` without explicit segment
2. Implement `src/scope.ts` with `path.matchesGlob` + prefix rule.
3. Extend `TaskStatus` / `TaskMeta` in `types.ts` (`scope`, `scope_on_violation`, `scope_violations`; baseline type).
4. Verify: `node --test test/scope.test.ts` + `tsc --noEmit`.

### T2 — Git baseline paths (TDD)

1. Failing tests in `test/git.test.ts` (or `test/scope-git.test.ts`):
   - commit during interval → path in `pathsSinceBaseline` even if worktree clean
   - pre-dirty unchanged → not in net set; content change → in set
   - rename → both paths; delete → path present
2. Extend snapshot with `head: string | null`.
3. Export `pathsSinceBaseline(cwd, baseline, current)` = HEAD range ∪ workingTreeChanged.
4. Keep existing `gitChanges` turn behavior unchanged (regression).
5. Verify focused git/scope tests.

### T3 — Policy + start/CLI/MCP

1. Unit-test `applyScopePolicy({ final, policy, violations, summary, warning })` outcomes (warn/fail/non-success).
2. `start`: reject `--scope` outside git repo; reject empty scope / `!` / policy without scope; write `scope*` + baseline (head+snapshot) on turn 1.
3. CLI: `--scope` multiple, `--scope-on-violation`.
4. MCP: `delegate_task` optional `scope`, `scope_on_violation`; update `task_reply` description.
5. Optional prompt prefix listing scopes (soft).
6. Verify unit + start validation tests (no full worker needed).

### T4 — Supervisor hook

1. After computing turn `git_changes`, if `meta.scope?.length`, load baseline, compute paths, relativize to cwd, set `scope_violations` / warning / maybe status+summary prefix.
2. Clear `scope_violations` to `[]` when net clean.
3. Verify with fake-cli integration: out-of-scope edit → warn keeps success; fail → `scope_violation`.

### T5 — Reply + docs/skills

1. `reply` allow `scope_violation` alongside `success`/`needs_input`.
2. Orchestrate skill:
   - `scope_violation` → reply to revert; counts as rework
   - `success` + non-empty `scope_violations` → not verified pass
   - path-disjoint jobs pass declared paths as `--scope`
   - mistake-prevention disclaimer
3. README zh/en: flags, blind spots, new status release note.
4. `SPEC.md`: add `scope_violation` to status diagram / enum if present.
5. Verify: `test/skills.test.ts` assertions for new wording; reply unit/integration.

### T6 — Spec edge integration battery

Cover remaining Success Criteria / Testing Strategy items not hit above:

- rework turn restores file → violations empty
- cwd = repo subdirectory + outside-cwd change → violation
- ignored file (`.gitignore`) absent from set
- no `--scope` lifecycle regression (`npm test` full)

## Checkpoints

- After T2: git helpers alone prove commit∪digest story
- After T4: end-to-end warn/fail works
- After T6: `npm test` green; ready for PR

## Out of plan

overlap warning, revert, CLI Edit allowlists, `#38` readonly, `.baton.json` defaults.
