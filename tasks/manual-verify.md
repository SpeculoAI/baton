# 真机验证流程：规则 / 环境透传（检查点 B + C）

规格：[`SPEC-rules-propagation.md`](../SPEC-rules-propagation.md) §9 · 清单：[`todo.md`](todo.md)

## 前置

| 项 | 要求 |
|---|---|
| Baton | 用**本仓库刚 build 的** CLI：`node dist/cli.js`（不要用全局 `baton`，可能尚未含 `--rules`） |
| 执行者 | `codex`、`cursor`（`cursor-agent`）已登录 |
| rulesync | 检查点 C：在临时仓 `npm i rulesync`（Baton 不 `npx` 安装） |
| 隔离 | `BATON_HOME` 指到临时目录，避免污染 `~/.baton` |
| 额度 | B1/B2 会打真实模型；prompt 极短 + `--mode readonly` |

一键脚本（推荐）：

```bash
npm run build
bash tasks/manual-verify.sh
```

产物与日志：`.manual-verify/`（已在 `.gitignore` 时可忽略；脚本结束打印 PASS/FAIL）。

---

## 检查点 B — 规则发现与覆盖

### 准备

```text
临时 git 仓 ROOT_B
├── CLAUDE.md          # 唯一项目规则文件（内容随意，一行即可）
└── （无 AGENTS.md）
```

### B1 — codex 应看见 `CLAUDE.md` 为 unseen

```bash
export BATON_HOME=...  # 临时
cd "$ROOT_B"
node "$BATON_REPO/dist/cli.js" start --target codex --mode readonly \
  --idle-timeout 90 --prompt "Reply with exactly: OK. Do nothing else."
node "$BATON_REPO/dist/cli.js" wait <task_id> --until-done
node "$BATON_REPO/dist/cli.js" status <task_id>
```

**通过条件：** `rules.found` 含 `CLAUDE.md`；`rules.unseen` **含** `CLAUDE.md`。  
（任务终态可为 success / needs_input / failed；本项只验 `rules`。）

### B2 — cursor 应原生加载 `CLAUDE.md`

同上，`--target cursor`。

**通过条件：** `rules.found` 含 `CLAUDE.md`；`rules.unseen` **为空数组**。

---

## 检查点 C — 真实 rulesync

### 准备

```bash
cd "$ROOT_C"
git init && npm init -y && npm i rulesync
./node_modules/.bin/rulesync init -s
# 只保留 claudecode（C2 需要）
# 编辑 rulesync.jsonc → "targets": ["claudecode"]
./node_modules/.bin/rulesync generate -s
git add -A && git commit -m init
# 可选：写一份 CLAUDE.local.md 并加入 .gitignore（测 missing）
```

### C1 — stale → in_sync

1. 改 `.rulesync/mcp.jsonc`（实质性变更，例如增删一个 server 条目），**不**跑 `generate`。
2. `start --target claude`（或任意已装目标）→ `wait` → 看 `rules.rulesync.status`。
3. **通过：** `status === "stale"`（或与本机 `rulesync generate --check` 非 0 一致）。
4. 在仓内执行 `./node_modules/.bin/rulesync generate -s`。
5. 再 `start` 一轮 → **通过：** `status === "in_sync"`。

### C2 — target_configured=false

`rulesync.jsonc` 仅 `"targets": ["claudecode"]` 时：

```bash
start --target codex ...
```

**通过：** `rules.rulesync.target_configured === false`。

### C3 — worktree 生成

```bash
node dist/cli.js worktree add --name mv-c3
# JSON 结果含 rules.generated / missing / dirtied
ls <worktree>/CLAUDE.md   # 或该 targets 下应有的生成物
```

**通过：** worktree 创建成功；有 `.rulesync/` 且找到 rulesync 时结果为 `generated`（失败不回滚）；新 worktree 内存在 rulesync 生成文件。若主仓有被 ignore 的 `CLAUDE.local.md` 且未配置 `copy`，`rules.missing` 应列出它。

---

## 结果记录（2026-11-22 真机）

命令：`npm run build && bash tasks/manual-verify.sh`  
环境：本仓库 `dist/cli.js`；codex 0.166 / cursor-agent 2026.11.05；rulesync 43.11.0  
产物：`.manual-verify/`

| 项 | 期望 | 实测 | 备注 |
|---|---|---|---|
| B1 codex unseen | 含 CLAUDE.md | PASS | `found`/`unseen` 均为 `["CLAUDE.md"]` |
| B2 cursor unseen | `[]` | PASS | |
| C1 stale | `stale` | PASS | 改 `.rulesync/mcp.jsonc` 后 `generate --check` exit=1 |
| C1 再生后 | `in_sync` | PASS | regenerate 后 check exit=0 |
| C2 codex | `target_configured: false` | PASS | targets 仅 `claudecode` |
| C3 worktree | generated + 文件存在 + missing | PASS | `rulesync=generated`；补跑后 `missing` 含 `CLAUDE.local.md`（脚本已在 `worktree add` 前重建该文件） |

失败时保留 `.manual-verify/logs/` 与对应 `status` JSON，不要立刻删 `BATON_HOME`。
