# 任务清单：项目规则与环境透传

规格：[`SPEC-rules-propagation.md`](../SPEC-rules-propagation.md)（v2） · 计划：[`tasks/plan.md`](plan.md)

通用验证命令：

```bash
npm run typecheck
node --test test/<file>.test.ts     # 单个测试文件
npm test                            # 全量（worktree 相关测试需要在沙箱外运行）
npm run build
```

---

## 阶段 0：实测

### T0：实测两项未核实的加载关卡

**描述：** 用本机 CLI 实测 spec 2.3 中标为“未核实”的两项，结论写回 spec 2.3，作为 T2 填写 `gates` 的依据。实测只用最小的假 MCP 服务器（例如一个只暴露 `echo` 工具的 stdio 脚本）和最短的 prompt，尽量少消耗额度。
1. Claude：在临时仓库放一个 `.mcp.json`，用 Baton 实际使用的参数（`claude -p --permission-mode acceptEdits ...`）让它列出可用的 MCP 工具，看项目 MCP 是否被加载。
2. Codex：在一个已被信任的仓库里用 `baton worktree add` 建 worktree，放一个 `.codex/config.toml` 声明 MCP，用 Baton 实际的 `codex exec` 参数让它列出可用工具，看 worktree 是否继承主仓库的信任。

**验收标准：**
- [x] 两项各有明确结论（加载 / 不加载 / 条件加载），并附复现命令
- [x] spec 2.3 表格更新，“未核实”改为实测结果和日期
- [x] 实测过程不修改用户的 `~/.claude`、`~/.codex` 配置（如有必要，使用临时的 `CODEX_HOME`）

**验证：**
- [x] 人工检查 spec 2.3 的更新内容

**结论（2026-11-22）：** Claude `-p` 按文档加载项目 `.mcp.json`（交互为 Pending approval；模型调用因 OAuth 过期未做成）。Codex worktree **不**继承主仓库 trust；未列入 `projects` 时 `AGENTS.md` 仍加载；显式 `untrusted` 则不加载。项目 MCP 在 `codex exec` 下未能实证加载。详见 spec 2.3。

**依赖：** 无
**涉及文件：** `SPEC-rules-propagation.md`
**规模：** XS（需要少量真实模型调用）

---

## 阶段 1：基础

### T1：规则发现与覆盖计算

**描述：** 新建 `src/rules.ts`，实现与 CLI 无关的纯函数：从 `cwd` 向上扫描到 git 根目录（不是 git 仓库时只扫 `cwd`），找出 spec 3.2 清单中存在的规则文件和目录，以相对 `cwd` 的路径返回；根据给定的 `RuleSupport` 计算 `unseen`，包括 Claude 的条件规则。在 `src/types.ts` 中新增 `EnvFeature`、`RuleSupport`、`RulesyncReport`、`RulesReport`，给 `Adapter` 和 `TaskMeta` 加可选字段。

**验收标准：**
- [x] 多层目录下 `discoverRules(cwd)` 返回的路径集合和顺序正确；空规则目录不计入；不扫描 `cwd` 以下
- [x] `unseenRules(found, support)` 对“无声明”“普通文件”“目录”“条件规则满足/不满足”都正确
- [x] 不引入新依赖；现有测试全部通过

**验证：**
- [x] `node --test test/rules.test.ts`
- [x] `npm run typecheck`

**依赖：** 无
**涉及文件：** `src/rules.ts`（新）、`src/types.ts`、`test/rules.test.ts`（新）
**规模：** S

---

### T2：四个 adapter 声明规则支持与加载关卡

**描述：** 按 spec 2.1 和 2.3（含 T0 结论）为 `claude`、`codex`、`cursor`、`agy` 填写 `rules`：原生读取的文件、条件规则、rulesync 目标 ID、`gates`（只写已核实的关卡）。每个声明旁注明核实日期。

**验收标准：**
- [x] 只有 `CLAUDE.md` 时，codex 和 agy 的 `unseen` 包含它，claude 和 cursor 不包含；只有 `AGENTS.md` 时全部为空；两者都有时 claude 的 `unseen` 包含 `AGENTS.md`
- [x] `rulesyncTarget` 分别为 `claudecode`、`codexcli`、`cursor`、`antigravity-cli`
- [x] cursor 的 `gates.mcp` 提到 `--approve-mcps`；codex 的 `gates.mcp` 和 `gates.hooks` 分别说明项目信任和 hook 信任

**验证：**
- [x] `node --test test/adapters.test.ts test/rules.test.ts`

**依赖：** T0、T1
**涉及文件：** `src/adapters/claude.ts`、`src/adapters/codex.ts`、`src/adapters/cursor.ts`、`src/adapters/agy.ts`、`test/adapters.test.ts`
**规模：** M

---

## 检查点 A

- [x] `npm test` 全部通过
- [x] 默认派工行为没有变化

---

## 阶段 2：派工路径

### T3：`baton start --rules check|off`

**描述：** `StartInput` 新增 `rules?: "check" | "pointer" | "off"`，默认 `check`。`start()` 在非 `off` 模式下调用规则发现和覆盖计算，把结果写入 `meta.rules`（`pointer_injected` 暂为 `false`，暂不写 `rulesync`）。CLI 新增 `--rules`，MCP 的 `baton_start` 新增 `rules`（zod 枚举），都拒绝非法取值。`status` / `wait` 原样输出；`reply` 保留 `meta.rules`。

**验收标准：**
- [x] 只有 `CLAUDE.md` 的临时仓库中，`start --target codex` 的 `rules.unseen` 包含 `CLAUDE.md`
- [x] `--rules off` 时没有 `rules` 字段；非法取值报错且不创建任务
- [x] 不带 `--rules` 时 prompt 与改动前逐字一致（新增回归断言）

**验证：**
- [x] `node --test test/rules-start.test.ts test/mcp.test.ts test/lifecycle.test.ts`

**依赖：** T2
**涉及文件：** `src/tasks.ts`、`src/cli.ts`、`src/mcp.ts`、`test/rules-start.test.ts`（新）、`test/mcp.test.ts`
**规模：** M

---

### T4：`--rules pointer` 注入规则提示

**描述：** 在 `rules.ts` 实现 `rulesPointer(unseen)`，按 spec 3.5 生成英文提示，文件和目录写法不同，`unseen` 为空时返回空字符串。`start()` 在 `pointer` 模式且 `unseen` 非空时，把提示拼在 scope 提示之后、用户 prompt 之前，设置 `pointer_injected: true`。`reply` 不注入。

**验收标准：**
- [x] 第一轮 prompt 包含所有 `unseen` 路径；`reply` 后第二轮不包含
- [x] `unseen` 为空时 prompt 不变，`pointer_injected` 为 `false`
- [x] 同时使用 `--scope` 时顺序为：scope 提示、规则提示、用户 prompt、输出协议

**验证：**
- [x] `node --test test/rules.test.ts test/rules-start.test.ts`

**依赖：** T3
**涉及文件：** `src/rules.ts`、`src/tasks.ts`、`test/rules.test.ts`、`test/rules-start.test.ts`
**规模：** S

---

## 检查点 B

- [x] `npm test` 全部通过
- [x] 手动验证：在只有 `CLAUDE.md` 的临时 git 仓库里，用真实 `baton start --target codex` 和 `--target cursor` 各派一次只读小任务，前者 `unseen` 包含 `CLAUDE.md`，后者为空（2026-11-22：`tasks/manual-verify.sh` B1/B2 PASS）
- [x] 与用户一起评审后再进入阶段 3

---

## 阶段 3：rulesync 集成

### T5：`start` 阶段读取 rulesync 配置

**描述：** 在 `rules.ts` 实现三个函数：
- `resolveRulesync(repoRoot, mainRepoRoot?)`：按“项目 `node_modules/.bin` → 主仓库 `node_modules/.bin` → `PATH`”的顺序查找，找不到返回 `null`，不使用 `npx`；
- `readRulesyncConfig(repoRoot)`：容错解析 `rulesync.jsonc`，再用 `rulesync.local.jsonc` 浅覆盖，只取 `targets` 和 `features`，解析失败返回 `null`；
- `rulesyncReport(config, support, bin)`：算出 `target_configured`、`features`（处理数组形式、对象形式和 `"*"`）、`gates`，以及 `status`（找不到可执行文件为 `skipped`，否则为 `pending`）。

`start()` 在仓库根目录有 `.rulesync/` 时写入 `meta.rules.rulesync`。

**验收标准：**
- [x] 带注释、尾逗号、字符串内含 `//` 的 JSONC 能正确解析；`rulesync.local.jsonc` 能覆盖；解析失败时 `target_configured` 为 `null`
- [x] 数组形式、对象形式、`"*"` 三种 targets 写法下，`target_configured` 和 `features` 都正确；为 cursor 配置 `mcp` 时，派给 cursor 的 `gates` 非空
- [x] 没有 `.rulesync/` 时没有 `rulesync` 字段；找不到可执行文件时为 `skipped`，`detail` 写明原因

**验证：**
- [x] `node --test test/rules.test.ts test/rules-start.test.ts`

**依赖：** T3
**涉及文件：** `src/rules.ts`、`src/tasks.ts`、`test/rules.test.ts`、`test/rules-start.test.ts`
**规模：** M

---

### T6：supervisor 第一轮执行 `rulesync generate --check`

**描述：** 在 `rules.ts` 实现异步的 `rulesyncCheck(bin, repoRoot, timeoutMs)`：用 `spawn` 执行 `rulesync generate --check`（不传任何其他参数），超时 15 秒，环境变量带 `BATON_DELEGATION=1`，退出码映射为 `in_sync` / `stale` / `error`，错误详情经 `redact` 截断到 200 字符。supervisor 在 `meta.turn === 1` 且 `rules.rulesync.status === "pending"` 时调用它，位置在心跳计时器之后、空闲计时器和执行者启动之前。新增假 `rulesync` 脚本：记录收到的参数，退出码和是否卡住由环境变量控制，可选地修改指定文件（供 T7 测 `dirtied`）。

**验收标准：**
- [x] 假脚本返回 0、1、2、卡住超时时，分别得到 `in_sync`、`stale`、`error`、`error`；任务最终状态都是 `success`；假脚本收到的参数只有 `generate --check`
- [x] rulesync 卡住期间，`status` 不会把任务判定为 supervisor 已退出
- [x] 同时使用 `--scope` 时不产生越界报告

**验证：**
- [x] `node --test test/rules-start.test.ts test/scope-integration.test.ts test/observe.test.ts`

**依赖：** T5
**涉及文件：** `src/rules.ts`、`src/supervisor.ts`、`test/fake-cli/rulesync`（新）、`test/rules-start.test.ts`
**规模：** M

---

### T7：worktree 生成环境，报告 `missing` 与 `dirtied`

**描述：** `loadWorktreeConfig` 支持 `worktree.rulesync`（布尔值，默认开启）。`addWorktree` 在 `prepareWorktree` 之后、`post_create` 之前：新 worktree 有 `.rulesync/`、`resolveRulesync(worktree, mainRepo)` 找到可执行文件、配置没有关闭时，在新 worktree 里运行 `rulesync generate`（不带参数，超时 60 秒，失败不回滚）。之后用 `git status --porcelain` 找出被改动的已提交文件填入 `dirtied`；对比主仓库和新 worktree 的根目录，填入 `missing`。

**验收标准：**
- [x] 有 `.rulesync/` 时结果为 `generated`；`"rulesync": false` 时为 `skipped`；假脚本返回非 0 时为 `error`，worktree 仍创建成功
- [x] 被 gitignore 的 `CLAUDE.local.md`：`missing` 包含它，在 `copy` 里配置后不包含
- [x] 假脚本修改一个已提交文件时，`dirtied` 列出它；现有 worktree 测试全部通过（包括 `post_create` 失败回滚的用例）

**验证：**
- [x] `node --test test/worktree.test.ts`（需要在沙箱外运行）

**依赖：** T5（查找函数）、T6（假 rulesync 脚本；若并行开发，由先完成的一方创建）
**涉及文件：** `src/worktree.ts`、`src/rules.ts`、`test/worktree.test.ts`、`test/fake-cli/rulesync`
**规模：** M

---

## 检查点 C

- [x] `npm test` 全部通过
- [x] 手动验证：装有真实 rulesync 的临时仓库中，只改 `.rulesync/mcp.jsonc` 不重新生成，`rules.rulesync.status` 为 `stale`；生成后为 `in_sync`（2026-11-22：`tasks/manual-verify.sh` C1a/C1b PASS，rulesync 43.11.0）
- [x] 手动验证：`rulesync.jsonc` 只配置 `claudecode` 时，派给 codex 的任务 `target_configured` 为 `false`（C2 PASS）
- [x] 手动验证：`baton worktree add` 后新 worktree 中有 rulesync 生成的文件（C3 PASS，含 `missing: CLAUDE.local.md`）

---

## 阶段 4：文档

### T8：reference 文档（中英文）

**描述：** 在 `docs/reference.md` 和 `docs/reference.zh-CN.md` 中新增：`--rules` 及三种模式（说明它包含环境检查）；`meta.rules` 与 `rulesync` 子字段的含义；`.baton.json` 的 `worktree.rulesync`；各执行者原生读取的规则文件表和加载关卡表（注明核实日期）；已知限制（Codex 回退文件名误报、Codex 项目信任、用 `codex debug prompt-input` 自查）；建议在主仓库生成并提交 rulesync 输出。

**验收标准：**
- [x] 中英文内容一一对应
- [x] 每个参数和字段与实现一致（逐项对照 `src/cli.ts`、`src/mcp.ts`、`src/types.ts`）

**验证：**
- [x] 人工对照；`npm test` 通过

**依赖：** T3–T7
**涉及文件：** `docs/reference.md`、`docs/reference.zh-CN.md`
**规模：** S

---

### T9：README FAQ 与技能说明

**描述：** 在 `README.md` 和 `README.zh-CN.md` 的 FAQ 新增“执行者能用上我的项目环境吗？”，说明 `rules` 字段、`--rules pointer`，推荐 `AGENTS.md` 和 rulesync。在两份技能文件中各补一句：`rules.unseen` 非空、`rules.rulesync.status` 为 `stale`、`target_configured` 为 `false` 或 `gates` 非空时告知用户。开始前先读 `test/skills.test.ts` 和 `test/manifests.test.ts`。

**验收标准：**
- [x] README 中英文一致，FAQ 新条目不超过 6 行
- [x] 两份技能文件各只新增一句
- [x] `test/skills.test.ts`、`test/manifests.test.ts` 通过

**验证：**
- [x] `node --test test/skills.test.ts test/manifests.test.ts`

**依赖：** T3–T7
**涉及文件：** `README.md`、`README.zh-CN.md`、`skills/baton-rescue/SKILL.md`、`skills/baton-orchestrate/SKILL.md`
**规模：** S

---

## 检查点 D：完成

- [x] spec 第 9 节全部成功标准满足
- [x] `npm test` 通过（在沙箱外运行）
- [x] `npm run build` 通过
- [x] 准备评审
