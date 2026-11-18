# Spec: task-scope

日期：2026-11-18  
Module: `task-scope`（Issue #37）  
状态：已实现（待 PR，2026-11-18）  
关联：Issue #38（readonly）可复用变更路径原语，本 module **不实现** readonly。

## Objective

并行 worker 时，宿主可为任务声明允许修改的路径范围（`--scope`）。任务在**可判定终态**时，Baton 用相对**任务起点**的**净变更**对照 scope；越界则按策略警告或硬失败。

这是**防失误**，不是安全边界。真正隔离用 worktree / 容器 / 沙箱。Worktree（目录隔离）与 scope（路径围栏）正交，可叠用。

## 核实记录（审稿前几条）

对照当前 `src/git.ts` / `src/supervisor.ts`（2026-11-18）：

| # | 审稿点 | 核实结果 |
|---|---|---|
| 1 | worker 本轮 commit 后漏检 | **属实**。`gitSnapshot` 仅 `git status --porcelain`，**不记录 HEAD**。全部提交后 after 干净 → 差分空。须扩展。 |
| 2 | 已脏文件再改 | **现有 digest 可检出**（脏路径带 sha256）。scope 的工作区支路须继续用 digest，不能退化成「只比路径是否脏」。 |
| 3 | 单轮 vs 任务净变更 | 现逻辑按**单轮** before/after。返工还原会被单轮当成又一次变更。scope **改为任务起点 → 当前**净差分；单轮 `git_changes` 仍按轮报告，不动。 |

## ASSUMPTIONS

1. **Scope 权威变更集** = 任务起点 baseline 与当前状态的并集：
   - `git diff --name-only --diff-filter=ACDMRTUXB <baselineHead>..<currentHead>`（本任务期间提交的；重命名两侧都计入）
   - 工作区 + 未跟踪：baseline 与当前的 porcelain/digest 差分（同现有 `gitChanges` 路径逻辑）
   - **不是**单独的 `base...HEAD`，也**不是**仅单轮工作区差分
2. **策略语义**：
   - `warn`（默认）：保留原终态；写 `scope_violations` + 一行 `warning`；**不改** worker `summary` 原文
   - `fail`：若原终态为 `success`，改为 `scope_violation`，`summary` 开头加一行 `scope_violation: 见 scope_violations`，其余保留原文；其它终态不覆盖 status，只写 violations + warning
3. 硬失败态名 = `scope_violation`
4. MVP：事后检查 + `warn|fail`。不做 overlap / `revert` / CLI 事前权限
5. 配置仅 CLI / MCP；无 `--scope` → 零行为变化
6. `reply` 允许在 `scope_violation` 上继续（与 `success` / `needs_input` 同类「可返工」）
7. 可选：prompt 短前缀列出 scope；权威仍是事后检查
→ 纠正现在，或批了再进 Plan。

## CLI / MCP

```bash
baton start --target <cli> \
  --scope "src/auth/**" --scope "tests/auth/**" \
  --scope-on-violation warn|fail \
  [--cwd <path>] \
  --prompt "..."
```

| 参数 | 含义 |
|---|---|
| `--scope <glob>` | 可重复。相对任务 `cwd`。至少一个时启用检查。 |
| `--scope-on-violation` | `warn`（默认）\| `fail`。无 `--scope` 却传此参数 → 报错。 |

MCP `delegate_task`：`scope?: string[]`、`scope_on_violation?: "warn" \| "fail"`。

`baton reply`：允许状态增 `scope_violation`（现仅 `success` \| `needs_input`）。

非 `running` 时 CLI `exitCode = 1`（现有行为已覆盖 `scope_violation`）。

## Baseline 与数据流

```
start（turn 1）:
  baseline = {
    head: git rev-parse HEAD,          # 非 git 仓 → scope 检查跳过并 warning，或 start 拒绝带 scope（见下）
    snapshot: gitSnapshot(cwd)         # porcelain + digests；并扩展记录 head
  }
  写入 meta.scope_baseline（或等价持久化）
  meta.scope / scope_on_violation 写入

每轮 supervisor 结束（含 reply 轮）:
  turn.git_changes = 单轮 before/after（现有，不变）
  if meta.scope?.length:
    paths = union(
      committedNames(baseline.head, currentHead),  # 含重命名两侧；删除计入
      workingTreeChanged(baseline.snapshot, currentSnapshot)  # digest 感知
    )
    paths = relativizeToTaskCwd(paths)             # 见「路径归一化」
    outside = paths starting with "../" or absolute escape → 一律越界
    violations = findScopeViolations(inCwdPaths, scope) ∪ outside
    meta.scope_violations = violations             # 无越界则 [] 或删除字段
    if violations.length:
      meta.warning = 一行说明（可与既有 warning 拼接）
      if policy==fail && final==success:
        final = scope_violation
        summary = "scope_violation: 见 scope_violations\n" + originalSummary
      # warn：不改 status / 不改 summary 正文
```

非 git 仓库 + 传了 `--scope`：`start` **拒绝**（清晰报错）。无 scope 时非 git 仓行为与今日一致（`git_changes` 可为缺省）。

## Meta / 类型

```ts
scope?: string[];
scope_on_violation?: "warn" | "fail";
scope_violations?: string[];           // MVP 必加；相对 cwd 的 posix 路径
scope_baseline?: { head: string; /* snapshot 可存旁路文件以免 meta 过大 */ };
```

`TaskStatus` 增：`"scope_violation"`。

发布说明（README / changelog 段）须注明：新终态会影响穷举 `TaskStatus` 的 MCP 客户端与技能。

## 路径归一化

- Git 输出路径相对**仓库根**；scope glob 相对**任务 cwd**。
- 换算：`path.relative(cwd, path.resolve(repoRoot, gitPath))`，再 `\` → `/`。
- 换算后以 `../` 开头（cwd 之外）→ **直接越界**，不参与 glob 匹配。
- **删除**算变更；**重命名**把旧路径、新路径都列入变更集后再做 scope 判定。
- 匹配前统一 posix 相对路径，无前导 `./`。

## Glob 语义

- **实现**：优先 `node:path` 的 `path.matchesGlob`（Node 24 已提供；本机 v24.22.2 可用）。**零新依赖**。若运行时缺失再 fallback 最小自研（Ask first 才引入第三方）。
- 多条 scope **OR**。
- 空字符串拒绝；**显式拒绝**以 `!` 开头的否定模式（报错，避免以为支持）。
- 含通配符：交给 `matchesGlob`。
  - `src/auth/**` 匹配 `src/auth/x.ts`（已核实 `true`）；匹配 `src/auth/`（`true`）；**不**匹配无尾斜杠的目录名 `src/auth`（`false`，通常也不出现在变更列表）。
  - `**/*` **不**匹配 `.github/...`（已核实）；需要点目录时用户须写显式段，如 `**/.github/**`。文档写明。
- **不含通配符**：
  - 精确匹配该路径；或
  - 若 `pattern` 在 cwd 下是已存在目录，或路径以 `pattern + "/"` 为前缀 → 按目录前缀匹配（`src/auth` ≡ 其下所有文件）
- 不支持 brace expansion 等扩展语法；不承诺与 gitignore 完全一致。

## `scope_violation` 与 baton-orchestrate

技能与 `reply` 契约：

1. `scope_violation` **可 `reply`**（产出不合格，同会话返工），**不要**默认当成 `failed` 去换厂商重开（避免改动面更大）。
2. 处理：`reply` 要求还原/移出越界文件，**计入返工次数**（与 acceptance failed 同一 cap）。
3. **`success` 且 `scope_violations` 非空**（warn 策略）：视为**审查未通过**，不得当成 verified pass；应 `reply` 或按 cap 失败处理。
4. 并行：计划里路径互不相交时，把任务的 files/路径声明**原样作为 `--scope` 传入**，使「计划声明」与「检查范围」同一份数据。

## summary / warning / scope_violations（统一）

| 字段 | 规则 |
|---|---|
| `scope_violations` | 越界路径数组；权威结构化列表（MVP 必有） |
| `warning` | 一行人类可读说明（如 `scope_violation: N files`） |
| `summary` | 默认保持 worker 原文；仅当 status 变为 `scope_violation` 时，开头加 `scope_violation: 见 scope_violations` |

Open Question 1/2 已关闭：按上表。

## Project Structure

```
src/types.ts
src/git.ts            Snapshot 含 head；导出 committed+working 并集的 changedPathsSince(baseline, current)
src/scope.ts          归一化、matchesGlob 包装、目录前缀、findScopeViolations
src/tasks.ts          start 写 baseline/scope；reply 允许 scope_violation
src/cli.ts / mcp.ts
src/supervisor.ts     终态前跑任务级 scope 检查
skills/baton-orchestrate/SKILL.md
skills/baton-rescue/SKILL.md      可选
README.md / README.zh-CN.md       含已知盲区、新状态发布说明
SPEC.md                           TaskStatus 同步
SPEC-task-scope.md
test/scope.test.ts
```

## Code Style

- 纯函数：`findScopeViolations`、`pathsSinceBaseline`。
- 不吞 `git_changes`；中文报错风格一致；文档强调非安全边界。

## Testing Strategy

1. Matcher：`src/auth/**`、无通配目录前缀、`!` 拒绝、点路径需显式段、cwd 外 `../` 越界。
2. 策略：success+warn / success+fail / failed+fail 不覆盖。
3. **Commit 并集**：轮内 commit 后工作区干净，仍能检出已提交越界文件。
4. **已脏再改**：baseline 已脏，内容再变 → 计入；内容不变 → 不计入净变更。
5. **返工净变更**：轮 1 越界，轮 2 还原 → 任务级 violations 清空（warn/fail 相应恢复逻辑：以检查当下净集为准）。
6. **cwd = 子目录**：仓库根变更换算；cwd 外 → 越界。
7. 删除、重命名（两侧）。
8. `.gitignore` 内文件：确认**不出现**在变更集（与文档盲区一致）。
9. 无 `--scope` 回归全绿。

## 已知盲区（文档必写）

- 被 `.gitignore` 忽略的路径（`dist/`、`.env`、`node_modules` 等）不在检测范围。
- 非 git 仓库：带 `--scope` 时 start 拒绝；不检测任意文件系统写入。
- **共享 cwd、无 worktree** 时，用户或其他 worker 的并发修改会算到本任务净变更上 → 误报；故文档推荐 scope 与 worktree 叠用。
- supervisor 被杀（orphaned）时本轮检查**不会**跑；以 orphan 恢复逻辑为准（现有读侧标 failed）。
- 点文件/点目录须在 glob 中显式写出段名（`path.matchesGlob` 下 `**/*` 不配 `.github/...`）。

## Boundaries

- **Always**：无 scope 零变化；任务级净变更 + HEAD 并集；`scope_violations` 结构化；文档盲区与非安全边界；`npm test` 绿；发布说明提新 `TaskStatus`。
- **Ask first**：第三方 glob 库；`revert` / overlap / 事前 Edit 限制；改状态名；默认改 `fail`；把 baseline 存成巨大 inline blob 若需改存储形状。
- **Never**：scope 绑死 worktree；仅用 `base...HEAD` 或仅单轮工作区当权威；宣称沙箱级安全；否定 glob 静默忽略。

## Out of scope

- 并行 scope 重叠检测、`revert`、各 CLI 事前路径权限、`#38` readonly、`.baton.json` 默认 scope。

## Success Criteria

- [ ] `--scope` 写入 meta；可重复；`--scope-on-violation` 默认 `warn`。
- [ ] Snapshot/baseline 含 HEAD；轮内 commit 仍能检出。
- [ ] 脏文件 digest 再改能检出；未改动的预存脏文件不进净变更。
- [ ] 判定用任务起点 → 当前净差分；返工还原后越界可消失。
- [ ] 路径相对 cwd；cwd 外一律越界；删除与重命名两侧计入。
- [ ] `meta.scope_violations` 必有；warning 一行；summary 规则按统一表。
- [ ] `warn` / `fail` 策略行为符合 ASSUMPTIONS。
- [ ] `reply` 接受 `scope_violation`；orchestrate 技能：返工、`success`+非空 violations 视为未通过、files→`--scope`。
- [ ] README 含盲区、非安全边界、新状态说明。
- [ ] 上列测试项覆盖；`npm test` 全绿。

## Open Questions

无。审稿意见 1–10 已落入正文；若实现时 `path.matchesGlob` 行为与文档不符，以测试钉死并改文档，不改语义目标。
