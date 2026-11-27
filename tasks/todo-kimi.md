# Todo: Kimi Code CLI adapter

Spec: `SPEC-kimi-adapter.md` · Plan: `tasks/plan-kimi.md`

每个任务完成都要满足 Definition of Done：
- `npm test` 全绿，原有断言不放宽；
- 一个任务一个 commit（Conventional Commits）；
- 行为与 spec 不一致时，先改 spec 再改代码。

---

## T1：Windows argv 提示词安全检查

**Description:** 在 `src/adapters/common.ts` 新增一个与具体 CLI 无关的检查函数（spec K1）。输入：解析出的 `bin`、提示词、平台（默认 `process.platform`，测试时可以传入）。规则如下：

- 非 win32：直接放行。
- win32，且 `bin` 是 `.cmd` 或 `.bat`（大小写不敏感），且提示词含换行或 `& | < > ^ % ! " ( )`：抛错。错误信息说明 `.cmd` shim 会经过 `cmd.exe` 截断提示词，并建议改用 `install.ps1` 装的原生 `kimi.exe`。CLI 名从 `bin` 的文件名取，不写死 kimi。
- win32 的其他情况：整个命令行超过 32767 字符就抛错。

**Acceptance criteria:**
- [x] 三条分支都有单测，平台作为参数传入，所以 macOS 上也能跑完全部分支。
- [x] 错误信息里有原因和改法。

**Verification:**
- [x] `node --test test/adapters.test.ts`
- [x] `npm run typecheck`

**Dependencies:** None

**Files likely touched:** `src/adapters/common.ts`、`test/adapters.test.ts`

**Estimated scope:** S

---

## T2：kimi adapter、注册与单测

**Description:** 新增 `src/adapters/kimi.ts`，实现 spec 的 K1–K8：

- `build`：`-p <prompt> --output-format stream-json`；有会话 id 时加 `-S <id>`；指定了 model 时加 `-m <model>` 并返回 `modelArg`；指定了 effort 时返回 `warning`；调用 T1 的检查；`stdin: null`。
- `parseLine`：按 K6 映射。
- `sessionIdFrom`：只认 `session.resume_hint` 那一行。
- `isAuthFailure`：认 `no model configured`、`use /login`。
- `rules`：files、`rulesyncTarget: "kimi-code"`、`gates.mcp` 和 `gates.hooks`。
- `readonlyEnforcement`：不设。

注册进 `src/adapters/index.ts`，`src/types.ts` 的 `Target` 加 `"kimi"`。从 T0 的真实输出整理 `test/fixtures/kimi-2.8.0.stream.jsonl`，覆盖成功和失败的 tool 行、带 `tool_calls` 的 assistant 行、meta 行；会话 id 换成假值，去掉本机路径。

**Acceptance criteria:**
- [x] fixture 每一行 `parseLine` 都不返回 `null`；事件序列符合 K6，`Command failed with exit code: 1.` 结尾的那行 `ok: false`。
- [x] `build` 的 args 覆盖这些组合：首轮、续接、带 model、带 effort（有 warning、无 effort 参数）。
- [x] `isAuthFailure` 能识别 T0 里未登录的原文。

**Verification:**
- [x] `node --test test/adapters.test.ts`
- [x] `npm test`

**Dependencies:** T1

**Files likely touched:** `src/adapters/kimi.ts`、`src/adapters/index.ts`、`src/types.ts`、`test/adapters.test.ts`、`test/fixtures/kimi-2.8.0.stream.jsonl`

**Estimated scope:** M

---

## Checkpoint A
- [x] `npm test` 本机全绿
- [x] `node src/cli.ts agents` 的输出里有 kimi，显示 `bin` 和版本 `2.8.0`

---

## T3：CLI / MCP 入口与 --model 白名单

**Description:** 改动只有这几处：

- `src/mcp.ts`：`target_agent` 枚举加 `"kimi"`，model 参数的说明加 kimi。
- `src/usage.ts`：`--target` 说明加 kimi；如果有 `--model` 说明，也加上。
- `src/tasks.ts:126`：白名单加 kimi，报错文字同步更新。其他逻辑不动（用户已同意）。

**Acceptance criteria:**
- [x] `baton start --target kimi --model kimi-code/kimi-for-coding` 不再被拒，meta 里记下 model。
- [x] `baton start --target kimi -h` 的说明里有 kimi。
- [x] MCP `delegate_task` 接受 `target_agent: "kimi"`。

**Verification:**
- [x] `node --test test/model-start.test.ts test/mcp.test.ts test/help.test.ts`
- [x] `npm test`

**Dependencies:** T2

**Files likely touched:** `src/mcp.ts`、`src/usage.ts`、`src/tasks.ts`、`test/model-start.test.ts`

**Estimated scope:** S

---

## T4：fake CLI 集成测试

**Description:** 新增 `test/fake-cli/kimi`（sh）和 `kimi.cmd`，写法照 `agy` / `agy.cmd`。测试里把 `FAKE_FIXTURE` 换成 kimi 格式的输出，覆盖：

- `start → wait → success`，并能用 `result` 取到最后一条回复；
- `reply`：argv 里有 `-S <fixture 中的 id>`，start 时指定了 model 的话还有 `-m <model>`；
- 提示词：非 win32 上，`prompt-stdin.test.ts` 的 `PROMPT` 经 argv 逐字节到达（FAKE_ARGS_FILE 里 `-p` 的下一个参数）；win32 上，经 `kimi.cmd` 启动时任务失败，summary 里有 T1 的原因；
- `--mode readonly`：不带 `--allow-weak` 时报 `kimi cannot enforce read-only; add --allow-weak to allow it.`；带上后，fake 写了文件就判 `readonly_violation`；
- 未登录：fake 退出码 1，stderr 输出 T0 原文，判为 `not_authenticated`。

开始前先 grep 有没有测试依赖 fake-cli 的数量或 agents 的顺序。

**Acceptance criteria:**
- [x] 以上各项都有测试，在 macOS 上通过。
- [x] win32 分支由平台条件区分，不是跳过不测。

**Verification:**
- [x] `node --test test/prompt-stdin.test.ts test/readonly.test.ts test/lifecycle.test.ts`
- [x] `npm test`

**Dependencies:** T2、T3

**Files touched:** fake-cli 入口脚本已在 T3 提前建好（model-start 测试要用）；场景集中在新文件 `test/kimi.test.ts`。原计划：`test/fake-cli/kimi`、`test/fake-cli/kimi.cmd`、`test/prompt-stdin.test.ts`、`test/readonly.test.ts`、`test/lifecycle.test.ts`（如果 kimi 的场景太散，单独建一个 `test/kimi.test.ts`）

**Estimated scope:** M

---

## T5：规则、gate 与 rulesync 映射

**Description:** 给 kimi 的规则支持补上测试，必要时修正 T2 里的字段：

- `unseenRules`：`CLAUDE.md` 判为 unseen，`AGENTS.md` 和 `.kimi-code/AGENTS.md` 判为 found；
- `--rules check` 的报告带上 MCP 和 hooks 两条 gate；
- `rulesyncTargets([... "kimi"])` 里有 `kimi-code`。

**Acceptance criteria:**
- [x] spec Success Criteria 7 的每一项都有断言。

**Verification:**
- [x] `node --test test/rules.test.ts test/rulesync-setup.test.ts test/rules-start.test.ts`
- [x] `npm test`

**Dependencies:** T2

**Files touched:** `src/rules.ts`（RULE_ENTRIES 加 `.kimi-code/AGENTS.md`；另有 basenameMatch 修复，单独 commit `616a294`）、`test/rules.test.ts`、`test/rulesync-setup.test.ts`、`test/rules-start.test.ts`

**Estimated scope:** S

---

## Checkpoint B
- [x] `npm test` 本机全绿
- [ ] 征得你同意后 push 分支、开 draft PR；macOS、Linux、Windows 三平台 CI 全绿

---

## T6：文档

**Description:** 在所有列出 target 的地方加上 kimi，内容与实现一致：

- `README.md` 和 `README.zh-CN.md` 的 Workers 那一行；
- `docs/reference.md` 和 `reference.zh-CN.md`：
  - 新增 kimi 的安装与调用说明（Windows 只支持官方 `install.ps1`）；
  - 规则表、rulesync 映射、调用表各加一行（readonly 需要 `--allow-weak`，effort 会被忽略）；
  - target 枚举；
  - 已知限制：turn 中途取消后，reply 会开新会话；项目 MCP 需要工作区已被信任；
- `skills/baton-rescue/SKILL.md`、`skills/baton-orchestrate/SKILL.md` 里的 target 列表。

**Acceptance criteria:**
- [x] `grep -rn "agy" README* docs skills` 命中的 target 列表处都有 kimi。
- [x] 中英文 docs 内容对应。

**Verification:**
- [x] `npm test`（`test/skills.test.ts`、`test/manifests.test.ts` 会检查 skill 和 manifest）
- [x] 人工通读一遍改动

**Dependencies:** T2–T5

**Files likely touched:** `README.md`、`README.zh-CN.md`、`docs/reference.md`、`docs/reference.zh-CN.md`、`skills/baton-rescue/SKILL.md`、`skills/baton-orchestrate/SKILL.md`（实际没改：它只有一条路由建议，没有 target 列表）

**Estimated scope:** M（只有文档，6 个文件）

---

## T7：macOS 真机冒烟并回写 spec

**Description:** 在 scratchpad 的一个 git 仓库里，用真实 kimi 跑一次 `node src/cli.ts start --target kimi`（多行提示词，含 `& | > ^ " %`），然后 `wait`，再 `reply` 问上一轮的内容。把结果写进 spec 的 T0 小节，Status 改为 `implemented`。

**Acceptance criteria:**
- [x] 两轮都是 `success`；reply 能回忆首轮内容；提示词逐字节一致。
- [x] spec 已回写。

**Verification:**
- [x] `node src/cli.ts result <task_id>` 的输出符合预期

**Dependencies:** T1–T6

**Files likely touched:** `SPEC-kimi-adapter.md`

**Estimated scope:** XS

---

## Checkpoint C
- [ ] spec Success Criteria 1–10 全部满足
- [ ] 三平台 CI 全绿，交给你评审
