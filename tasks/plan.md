# Implementation Plan: npx 安装器（@speculoai/baton）

规格：`SPEC-npx-installer.md`

## Overview

把 Baton 发布成 npm 包 `@speculoai/baton`。`npx @speculoai/baton install` 装全局 `baton` 命令，并把插件装进用户选中的 agent；`update` 一条命令更新全部。插件侧（skill + MCP 配置）改为只调 `baton`。

## Architecture Decisions

- **tsc 编译，不打 bundle**：`tsconfig.build.json` 继承现有配置，打开 `rewriteRelativeImportExtensions`，输出到 `dist/`。开发和测试照旧直接跑 `src/*.ts`。
- **supervisor 路径跟随当前文件扩展名**：`tasks.ts` 用 `"cli" + path.extname(import.meta.filename)` 拼出路径，`src/` 下得到 `cli.ts`，`dist/` 下得到 `cli.js`。不用 `process.argv[1]`，因为测试直接 import `tasks.ts`，那时 `argv[1]` 是测试文件。
- **agent 定义是纯数据**：命令序列与执行分开，`--dry-run` 和测试都只校验生成的命令，不碰真实配置。
- **复用现有代码**：bin 检测用 `adapters/common.ts` 的 `which`，记录位置用 `store.ts` 的 `batonHome()`。
- **输出约定不变**：子进程输出走 stderr（`stdio: ["inherit", 2, 2]`），stdout 只打一个 JSON。

## Task List

### Phase 1: 构建与发布基础（风险最高，先做）

- [x] Task 1: dist 构建可运行，加 `version` 子命令
- [x] Task 2: 在 Node 20.17 上验证 dist

### Checkpoint 1
- [x] `npm test` 通过；`npm run build` 成功；`node dist/cli.js version` 在 Node 20.17 和 24 上都能跑

### Phase 2: 安装器

- [x] Task 3: 安装器核心：agent 表、选择解析、命令生成、记录文件、`--dry-run`
- [x] Task 4: 安装器执行：实际运行、`--force`、旧插件迁移、全局 npm、交互选择

### Checkpoint 2
- [x] `npm test` 通过（lifecycle、tail 各有一次超时，单独重跑通过）
- [x] 本机 `node src/cli.ts install --dry-run` 列出五个 agent 和正确的命令
- [x] gemini：install / update / uninstall 跑通。codex：`baton@speculoai` 在远端 marketplace 改名之前会失败；已用当前名字把插件装回。update 命令已按实测改成 upgrade + add
- [x] 与你一起看一遍再继续

### Phase 3: 插件侧与文档

- [x] Task 5: MCP 配置改为 `baton mcp`，marketplace 改名，版本升到 0.4.0
- [x] Task 6: skill 改为调 `baton`，重写 setup，删除 `scripts/setup.mjs`
- [x] Task 7: README 中英文

### Checkpoint 3: 完成
- [x] 规格中的 8 条 Success Criteria 全部满足（`baton@speculoai` 要等这次改动推到 GitHub 后，远端安装才会用新 marketplace 名）
- [x] `npm pack --dry-run` 内容正确
- [x] 准备好提交。push、开 PR 按你的确认做；npm publish 仍等你登录后自己发

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| TypeScript 7 的 `tsc` 不支持 `rewriteRelativeImportExtensions`，或不改写动态 `import("./x.ts")` | 高 | Task 1 第一步就验证；不行就把动态 import 改成静态字符串常量，或在 build 后做一次后缀替换 |
| `dist/` 在 Node 20 上用到了更新版本才有的 API | 中 | Task 2 用 `npx -p node@20.17 node dist/cli.js ...` 实跑，包括一次 `start` |
| 各 agent 的插件命令输出或参数随版本变化 | 中 | 只用 `--help` 里确认过的命令；marketplace add 失败视为软失败，由后续 install 一步决定成败 |
| `claude plugin install` 在非交互模式下需要确认 | 低 | stdin 继承自终端，交互时用户可以直接确认；非交互时把错误原样返回 |
| `codex plugin marketplace upgrade` 不刷新已装插件 | 低 | update 时追加一次软失败的 `codex plugin add ID`（规格里的 Open Question） |

## Open Questions

- 无。Codex 的更新行为在 Checkpoint 2 实测后确定。
