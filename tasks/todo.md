# Todo: npx 安装器（@speculoai/baton）

计划：`tasks/plan.md`；规格：`SPEC-npx-installer.md`

## Task 1: dist 构建可运行，加 `version` 子命令 ✓

**Description:** 新增 `tsconfig.build.json`，`npm run build` 输出 `dist/`；`package.json` 改为可发布的 `@speculoai/baton`；supervisor 启动路径跟随文件扩展名；新增 `baton version`。

**Acceptance criteria:**
- [ ] `package.json`：name `@speculoai/baton`，去掉 `private`，`bin.baton` 指向 `dist/cli.js`，`files: ["dist"]`，`build` 和 `prepack` 脚本，`engines.node` 为 `>=20.17`，`publishConfig.access` 为 `public`，加 `repository`
- [ ] `node dist/cli.js version` 输出 `{"version":"..."}`；从 `dist/` 启动的 `start` 能拉起 `dist/cli.js _supervise`
- [ ] `dist/` 写进 `.gitignore`

**Verification:**
- [ ] `npm test`
- [ ] `npm run build && node dist/cli.js version && node dist/cli.js agents`
- [ ] 用 fake CLI 从 `dist/` 跑一次 `start` + `wait`，状态到达终态

**Dependencies:** None

**Files likely touched:** `package.json`, `tsconfig.build.json`, `.gitignore`, `src/tasks.ts`, `src/cli.ts`, `test/smoke.test.ts`

**Estimated scope:** M

## Task 2: 在 Node 20.17 上验证 dist ✓

**Description:** 用 Node 20.17 实跑构建产物，确认版本下限成立；有不兼容就在源码里修。

**Acceptance criteria:**
- [ ] `npx -p node@20.17 node dist/cli.js agents` 和 `version` 正常
- [ ] Node 20.17 下 `start` + `wait`（fake CLI）到达终态
- [ ] Node 20.17 下 `mcp` 能启动并响应 `tools/list`

**Verification:**
- [ ] 上面三条命令的实际输出

**Dependencies:** Task 1

**Files likely touched:** 视发现的问题而定，预计 0–2 个 `src/` 文件

**Estimated scope:** XS–S

## Checkpoint 1
- [ ] `npm test` 通过；构建成功；Node 20.17 与 24 都能跑 `dist/`

## Task 3: 安装器核心 ✓

**Description:** 新增 `src/install.ts`：agent 定义表（claude、codex、cursor、agy、gemini）、`which` 检测、选择解析（`1,3` / 回车 / `q`）、按 install/update/uninstall 生成命令序列、读写 `~/.baton/installed.json`。`cli.ts` 接入 `install` / `update` / `uninstall`，先支持 `--dry-run` 和 `--only`。

**Acceptance criteria:**
- [ ] 每个 agent 三种动作生成的命令与规格中的表一致
- [ ] `--only` 指定未知或未检测到的 agent 时报错；update/uninstall 默认只处理记录里的 agent
- [ ] `--dry-run` 输出 JSON，列出检测结果和将执行的命令，不执行任何子进程

**Verification:**
- [ ] `node --test test/install.test.ts`
- [ ] `node src/cli.ts install --dry-run --only gemini`

**Dependencies:** Task 1（`version` 用于全局包版本号）

**Files likely touched:** `src/install.ts`, `src/cli.ts`, `test/install.test.ts`

**Estimated scope:** M

## Task 4: 安装器执行 ✓

**Description:** 实际执行命令（子进程输出走 stderr）；软失败步骤；`--force` 先卸载再装；install 时卸载旧 ID `baton@agent-plugin-agent` 和旧 marketplace；全局 `npm install -g`，失败时跳过并继续；交互终端下的多选提示；`--skip-global`。

**Acceptance criteria:**
- [ ] 用 PATH 里的假 agent 脚本记录收到的参数，验证执行顺序、软失败、`--force`、旧插件迁移
- [ ] 全局安装失败时 `global.ok` 为 false，插件照常安装，退出码由插件结果决定
- [ ] 任一插件步骤失败时退出码为 1，JSON 里有对应 `error`

**Verification:**
- [ ] `node --test test/install.test.ts`
- [ ] 本机：`node src/cli.ts install --only gemini --skip-global`，然后 `update`、`uninstall`，每步用 `gemini extensions list` 确认
- [ ] 本机：对 codex 做同样流程，用 `codex plugin list` 确认；实测 `marketplace upgrade` 是否刷新已装插件，据此定 update 命令

**Dependencies:** Task 3

**Files likely touched:** `src/install.ts`, `test/install.test.ts`, 可能新增 `test/fake-cli/` 下的假脚本

**Estimated scope:** M

## Checkpoint 2
- [ ] `npm test` 通过
- [ ] 本机 `install --dry-run` 正确；gemini 真实安装流程跑通
- [ ] 与你一起看一遍再继续

## Task 5: MCP 配置与 marketplace ✓

**Description:** 五个 MCP 配置的 command 改为 `baton`、args 改为 `["mcp"]`、去掉 `cwd`；`.claude-plugin/marketplace.json` 的 name 改为 `speculoai`；所有清单的 version 升到 `0.4.0`。

**Acceptance criteria:**
- [ ] 仓库中的清单不再出现 `src/cli.ts`
- [ ] 所有清单版本一致为 `0.4.0`

**Verification:**
- [ ] `rg -n "src/cli.ts|agent-plugin-agent" -g '*.json'` 无结果（`package-lock.json` 除外）
- [ ] `claude plugin validate .` 通过

**Dependencies:** Task 1

**Files likely touched:** `.mcp.json`, `.codex-mcp.json`, `.cursor-mcp.json`, `mcp_config.json`, `gemini-extension.json`, `.claude-plugin/*.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `plugin.json`

**Estimated scope:** S（文件多但每处一两行）

## Task 6: skill 与 setup ✓

**Description:** `baton-rescue`、`baton-orchestrate` 中的 `node <plugin-root>/src/cli.ts` 改为 `baton`；`setup` 改为检查 `baton version`，缺失时询问后 `npm install -g @speculoai/baton`，并说明 GUI 宿主的 PATH 排查；删除 `scripts/setup.mjs` 和 `test/setup.test.mjs`；更新 `test/skills.test.ts`。

**Acceptance criteria:**
- [ ] skill 中不再出现 `src/cli.ts`、`plugin-root`、`setup.mjs`
- [ ] setup 写明 Node `>=20.17`，并指向 `baton-rescue` / `baton-orchestrate`

**Verification:**
- [ ] `node --test test/skills.test.ts`
- [ ] `npm test`

**Dependencies:** Task 5

**Files likely touched:** `skills/baton-rescue/SKILL.md`, `skills/baton-orchestrate/SKILL.md`, `skills/setup/SKILL.md`, `test/skills.test.ts`, `package.json`（test 脚本去掉 setup.test.mjs）

**Estimated scope:** M

## Task 7: README 中英文 ✓

**Description:** 首选安装方式改为 `npx @speculoai/baton install`；保留各 agent 的手动安装方式，地址换成 `https://github.com/SpeculoAI/baton`、ID 换成 `baton@speculoai`；Node 要求改为 `>=20.17`；`baton` 指全局命令；补 0.4.0 迁移说明和 GUI 宿主 PATH 说明。

**Acceptance criteria:**
- [ ] 两份 README 不再出现 `wei292224644/agent-plugin-agent` 和 `src/cli.ts`
- [ ] 中英文内容对应

**Verification:**
- [ ] `rg -n "agent-plugin-agent|src/cli.ts|>= 24" README.md README.zh-CN.md` 无结果

**Dependencies:** Task 3–6

**Files likely touched:** `README.md`, `README.zh-CN.md`

**Estimated scope:** S

## Checkpoint 3: 完成
- [ ] 规格中 8 条 Success Criteria 全部满足
- [ ] `npm test` 通过；`npm pack --dry-run` 只含 `dist/`、`package.json`、README
- [ ] 准备提交，push、开 PR、发布都等你决定
