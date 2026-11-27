# Todo: install 时同步宿主插件

Spec: `SPEC-host-plugin-sync.md` · Plan: `tasks/plan-host-sync.md`

- [ ] T0：实测各宿主「已装旧版时重跑 install」的行为
  - Acceptance：codex、cursor、agy 各记录 exit code、输出里是否含 already installed、插件是否刷新到新版；gemini 依据现有测试样例和文档记录；结论写进 spec「实测依据」，并据此确认 plan 第 1 节的定法（是否有宿主需要无条件补跑）
  - Verify：每个宿主一段实测输出（隔离目录 + 本地市场 checkout `v0.6.0` → `v0.8.0`）；没有隔离手段的宿主先问用户
  - Files：`SPEC-host-plugin-sync.md`，必要时 `tasks/plan-host-sync.md`

- [ ] T1：install 命中 already installed 时补跑 update，并分开「已装上」与「ok」的记录
  - Acceptance：spec New Behavior 第 1、2、3、6 条成立；全新安装结果不变；agy 这种 update 与 install 相同的宿主不重复执行
  - Verify：`npm test`；新增单测：已安装→update 成功（note `already installed, updated`）、已安装→update 失败（`ok: false`、`exitCode: 1`、仍记录）、dry-run 列出 update 步骤；更新原 `already installed, skipped` 用例
  - Files：`src/install.ts`、`test/install.test.ts`

- [ ] T2：结果顶层 `note`（重开会话）与 `warnings`（update 无记录），TTY 打印
  - Acceptance：spec New Behavior 第 4、5 条成立；dry-run 或全部失败时不带 `note`；`--only` 时不报无记录警告
  - Verify：`npm test`；新增单测覆盖 note 有/无、warnings 有/无；TTY 下手工跑一次 `baton update --dry-run`
  - Files：`src/install.ts`、`src/cli.ts`、`src/install-ui.ts`、`test/install.test.ts`

- [ ] T3：文档
  - Acceptance：README（中英）与 reference（中英）写明只用 `npm i -g` 不会更新宿主插件、请用 `baton update`、升级后重开会话；dry-run 列出的 update 步骤是「可能执行」
  - Verify：人工通读四处改动；`npm test`（如有文档相关测试）
  - Files：`README.md`、`README.zh-CN.md`、`docs/reference.md`、`docs/reference.zh-CN.md`

- [ ] T4：端到端复现、全量验证、提 PR
  - Acceptance：spec Success Criteria 1–4 全部满足；spec `Status` 改为 implemented
  - Verify：隔离 `CLAUDE_CONFIG_DIR` 下 0.6.0 → 0.8.0，用 worktree 里的 CLI 跑 `install --only claude --skip-global`，`claude plugin list --json` 显示 `0.8.0`；`npm test`、`npm run typecheck`
  - Files：`SPEC-host-plugin-sync.md`
