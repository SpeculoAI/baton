# Spec: npx 安装器（@speculoai/baton）

## 前提假设

1. 发布到 npm 的包名是 `@speculoai/baton`，命令名仍是 `baton`。`speculoai` 组织的 owner 是 `dineal.wei`。
2. 仓库地址换成 `https://github.com/SpeculoAI/baton`，marketplace 名改成 `speculoai`，插件安装 ID 变成 `baton@speculoai`。
3. 运行时代码由全局 npm 包提供。插件（skill + MCP 配置）只调 `baton`，不再从插件目录跑 `node src/cli.ts`。
4. 不打 bundle：用 `tsc` 编译出 `dist/`，依赖交给 npm 安装。`dist/` 不提交进 git。
5. 开发和测试照旧在 Node 24 上直接跑 `src/*.ts`。发布出去的 `dist/` 只要求 Node `>=20.17`，这个下限来自 `scope.ts` 用的 `path.matchesGlob`。
6. 版本升到 `0.4.0`：marketplace 改名属于破坏性变更。

## Objective

让用户装 Baton 只需要一条命令，后续更新也只需要一条命令。

用户故事，对应需求 1–5：

1. **npx 一键安装**：`npx @speculoai/baton install` 装好全局 `baton` 命令，并把插件装进用户选择的 agent。
2. **用 CLI 装或重装到指定 agent**：`baton install --only claude`，加 `--force` 先卸载再装，`baton uninstall --only claude` 卸载。
3. **保留 marketplace + `/baton:setup`**：照旧可以 `claude plugin marketplace add ...` 安装。`/baton:setup` 只负责确保 `baton` 命令存在，不存在就 `npm install -g @speculoai/baton`。skill 里一律写 `baton start ...`，不再出现 `node <plugin-root>/...`。
4. **一条命令更新**：`npx @speculoai/baton@latest update` 先升级全局包，再对之前装过的 agent 逐个执行它自家的更新命令。
5. **自选 agent**：自动检测本机已有的 agent CLI。交互终端下列出编号让用户多选，回车等于全选。非交互时默认装所有检测到的；也可以用 `--only` 指定，可重复。

## Tech Stack

- TypeScript 7（`tsc`），Node 内置模块：`child_process`、`readline/promises`、`util.parseArgs`。
- 运行时依赖不变：`@modelcontextprotocol/sdk`。不新增依赖。

## Commands

```bash
# 开发
npm test                      # tsc --noEmit + node --test（Node 24，直接跑 .ts）
npm run build                 # tsc -p tsconfig.build.json → dist/
npm pack --dry-run            # 检查发布内容只有 dist/ 和 package.json/README

# 用户侧
npx @speculoai/baton install [--only <agent>]... [--force] [--dry-run] [--skip-global]
npx @speculoai/baton@latest update [--only <agent>]... [--dry-run] [--skip-global]
baton uninstall [--only <agent>]... [--dry-run]
baton version
```

`<agent>` 取值：`claude`、`codex`、`cursor`、`agy`、`gemini`。

## 各 agent 的执行命令

`REPO=https://github.com/SpeculoAI/baton`，`ID=baton@speculoai`。

| agent | 检测 | install | update | uninstall |
|---|---|---|---|---|
| claude | `claude` | `claude plugin marketplace add REPO`（已存在不算失败）→ `claude plugin install ID` | `claude plugin marketplace update speculoai` → `claude plugin update ID` | `claude plugin uninstall ID` |
| codex | `codex` | `codex plugin marketplace add REPO`（同上）→ `codex plugin add ID` | `codex plugin marketplace upgrade speculoai`，再 `codex plugin add ID`（upgrade 只刷新 marketplace 快照，add 才会更新已装插件缓存；重复 add 成功且刷新缓存） | `codex plugin remove ID` |
| cursor | `cursor-agent` 或 `agent` | `agent plugin marketplace add REPO`，然后提示用户在对话里执行 `/add-plugin baton` | `agent plugin marketplace update speculoai` | `agent plugin marketplace remove speculoai` |
| agy | `agy` | `agy plugin install REPO` | 同 install | `agy plugin uninstall baton` |
| gemini | `gemini` | `gemini extensions install REPO --consent` | `gemini extensions update baton` | `gemini extensions uninstall baton` |

全局包：install 执行 `npm install -g @speculoai/baton@<当前版本>`，update 执行 `npm install -g @speculoai/baton@latest`。`--skip-global` 跳过这一步。uninstall 不动全局包。

装过哪些 agent 记录在 `~/.baton/installed.json`（遵循 `BATON_HOME`）。update 和 uninstall 默认只处理记录里的 agent。

## 输出约定

沿用现有 CLI 约定：子进程输出和进度提示走 stderr，结束时 stdout 只打一个 JSON 对象，例如：

```json
{"action":"install","global":{"ok":true},"hosts":[{"id":"claude","ok":true},{"id":"cursor","ok":true,"note":"在 Cursor 对话里执行 /add-plugin baton"}]}
```

任何一步失败，退出码为 1。`--dry-run` 只列出将要执行的命令，不实际执行。

## Project Structure

```
src/install.ts          → 新增：agent 列表、选择、执行、记录
src/cli.ts              → 新增 install / update / uninstall / version 子命令
src/tasks.ts            → supervisor 启动路径改为与当前文件同扩展名（.ts 或 .js）
tsconfig.build.json     → 新增：输出到 dist/，改写 .ts 导入后缀
package.json            → 包名、bin → dist/cli.js、files、engines、publishConfig
.mcp.json / .codex-mcp.json / .cursor-mcp.json / mcp_config.json / gemini-extension.json
                        → command 改为 "baton"，args 改为 ["mcp"]
.claude-plugin/marketplace.json → name 改为 speculoai
skills/*/SKILL.md       → 一律调 baton；setup 改为检查/安装全局包
scripts/setup.mjs + test/setup.test.mjs → 删除
test/install.test.ts    → 新增
README.md / README.zh-CN.md → 新仓库地址、npx 安装为首选
```

## Code Style

与现有 `src/` 一致：中文报错信息、紧凑函数、不加多余抽象。agent 定义写成纯数据：

```ts
{ id: "gemini", label: "Gemini CLI", bins: ["gemini"],
  install: [{ args: ["extensions", "install", REPO] }],
  update: [{ args: ["extensions", "update", "baton"] }],
  uninstall: [{ args: ["extensions", "uninstall", "baton"] }] }
```

## Testing Strategy

- 框架：`node:test`，测试放在 `test/`，测试名用中文，与现有测试一致。
- `test/install.test.ts`：
  - 选择解析：`1,3`、回车、`q`、越界编号。
  - 每个 agent 在 install/update/uninstall 下生成的命令序列，用 `--dry-run` 校验，不碰真实配置。
  - `--force` 先卸载再安装。
  - `installed.json` 的写入与读取，用临时 `BATON_HOME`。
  - `--only` 指定了未知或未安装的 agent 时报错。
- `test/skills.test.ts`、`test/smoke.test.ts`：断言改为 `baton`、`>=20.17`。
- 构建验证：`npm run build` 之后用 `node dist/cli.js agents` 和 `node dist/cli.js version` 实跑；supervisor 从 `dist/` 能正常拉起。
- 在本机用 `--dry-run` 走一遍。真实安装会改动你的 agent 配置，须你同意后再做。

## Boundaries

- **Always**：只调用各 agent 官方的插件命令；改动前先跑 `npm test`；保持 stdout 只输出一个 JSON 对象。
- **Ask first**：在本机做真实 install/uninstall（会改 `~/.claude`、`~/.codex` 等配置）；`npm publish`；推送分支或合并 PR。
- **Never**：直接手改各 agent 的配置目录；uninstall 时删除全局 npm 包或 `~/.baton` 里的任务数据；把 npm token 写进仓库。

## Success Criteria

1. `npm run build` 成功；`npm pack --dry-run` 只包含 `dist/`、`package.json` 和 README。
2. 在 Node 20.17 上 `node dist/cli.js agents` 能运行；一次 `start` 能拉起 supervisor，即 `dist/cli.js _supervise`。
3. `baton install --dry-run` 在交互终端列出检测到的 agent 供选择，并打印上表对应的命令；非交互时选中全部检测到的 agent。
4. `--only`、`--force`、`update`、`uninstall` 的命令序列与上表一致，并有测试覆盖。
5. 仓库内的 skill 和 MCP 配置不再出现 `src/cli.ts` 或 `setup.mjs`（历史 spec/plan 文档除外）。
6. `/baton:setup` 在 `baton` 缺失时提示并安装全局包，存在时报告版本。
7. README 中英文都以 `npx @speculoai/baton install` 为首选，并使用新的仓库地址。
8. `npm test` 全部通过。

## 已定决策

1. **旧插件迁移**：install 时自动卸载旧 ID `baton@agent-plugin-agent`（claude、codex）和旧 marketplace `agent-plugin-agent`（claude、codex、cursor）。旧的不存在不算失败。
2. **全局安装失败**：跳过全局安装，继续装插件；结果 JSON 里 `global.ok` 为 false 并附上提示，退出码不因此变为 1。
3. **真实安装验证**：允许在本机对 gemini 和 codex 做真实的 install → update → uninstall。
4. **GUI 宿主的 PATH**：本次不另做处理，在 README 和 `/baton:setup` 里说明排查方式。
5. **Codex 更新**：已在本机实测。`marketplace upgrade` 只更新 marketplace 快照；紧接着的 `plugin add` 会刷新已安装插件（重复执行退出码为 0，缓存目录 mtime 变化）。update 因此包含这两步。
6. **Gemini 安装**：`extensions install` 会停在确认提示，非交互时加上 `--consent`。输出里出现 `already installed` 视为已安装，跳过，不算失败。
