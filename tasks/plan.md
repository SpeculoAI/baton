# 实施计划：项目规则与环境透传

规格：[`SPEC-rules-propagation.md`](../SPEC-rules-propagation.md)（v2）
任务清单：[`tasks/todo.md`](todo.md)

## 概述

分五个阶段交付：先用本机 CLI 实测两项未核实的加载关卡（T0）；然后做与 CLI 无关的纯函数基础（规则发现、覆盖计算、adapter 声明）；接着打通 `baton start --rules` 的派工路径；再接入 rulesync（读配置、整体同步检查、worktree 生成）；最后补文档和技能说明。每个阶段结束都有检查点，保证 `npm test` 全绿、默认行为不变。

## 架构决定

- **所有新逻辑集中在 `src/rules.ts`**：发现、覆盖计算、pointer 文本、rulesync 查找、JSONC 配置读取、子进程调用都在这里；`tasks.ts`、`supervisor.ts`、`worktree.ts` 只做调用。
- **adapter 只声明、不执行**：`Adapter.rules` 是纯数据（原生读取的文件、条件规则、rulesync 目标 ID、加载关卡说明）。
- **独立字段 `meta.rules`**：不复用 `meta.warning`，因为 supervisor 每轮会覆盖它，`reply` 也会删除它。
- **rulesync 分两段**：`start()` 同步读配置（只读文件、耗时可忽略），写入 `pending`；supervisor 第一轮异步执行 `generate --check`。这样 `baton start` 仍然立即返回，主控在 `pending` 阶段就能看到“目标是否在配置内”和“加载关卡”。
- **`--check` 检查整个项目**：不传 `--targets` / `--features`，因为它们会覆盖用户配置，且共用文件本来就按完整配置比对。
- **rulesync 检查使用异步子进程**：supervisor 启动时立即写一次心跳，之后每 10 秒一次，30 秒没有心跳就会被判定为已退出。同步调用会阻塞事件循环，所以必须异步，放在心跳计时器之后、空闲计时器之前。
- **worktree 中 rulesync 失败不回滚**：与 `post_create` 失败会回滚不同，这是有意为之。
- **不改执行者启动参数**：加载关卡只提示。

## 依赖关系

```
T0 实测加载关卡（只产出结论，补进 spec 2.3）
 └─ T2 adapter 声明（gates 依赖 T0 结论）

T1 rules.ts 发现/覆盖（纯函数）
 └─ T2 adapter 声明
     └─ T3 start --rules check|off（meta.rules，CLI + MCP）
         ├─ T4 --rules pointer 注入
         └─ T5 start 阶段读 rulesync 配置（pending / skipped / target_configured / features / gates）
             └─ T6 supervisor 执行 --check
T5 的 rulesync 查找函数 ── T7 worktree 生成 + missing + dirtied
T3–T7 ── T8 reference 文档
T3–T7 ── T9 README + 技能说明
```

## 任务列表（索引）

### 阶段 0：实测
- [ ] T0：实测 Claude `-p` 下项目 MCP 是否加载、Codex 在 Baton worktree 中是否信任项目配置

### 阶段 1：基础
- [ ] T1：规则发现与覆盖计算（`src/rules.ts` 纯函数）
- [ ] T2：四个 adapter 声明规则支持与加载关卡

### 检查点 A
- [ ] `npm test` 全部通过，默认派工行为没有变化

### 阶段 2：派工路径
- [ ] T3：`baton start --rules check|off`，输出 `meta.rules`
- [ ] T4：`--rules pointer` 在第一轮 prompt 中注入规则提示

### 检查点 B
- [ ] 默认 prompt 与当前版本逐字一致（回归测试覆盖）
- [ ] 手动验证：在只有 `CLAUDE.md` 的临时仓库里对 codex 和 cursor 各运行一次，`unseen` 分别非空和为空
- [ ] 与用户一起评审后再进入阶段 3

### 阶段 3：rulesync 集成
- [ ] T5：`start` 阶段读取 rulesync 配置
- [ ] T6：supervisor 第一轮执行 `rulesync generate --check`
- [ ] T7：`baton worktree add` 生成环境，报告 `missing` 与 `dirtied`

### 检查点 C
- [ ] `npm test` 全部通过
- [ ] 手动验证：装有真实 rulesync 的临时仓库中，只改 `.rulesync/mcp.jsonc` 不重新生成，`status` 为 `stale`；生成后为 `in_sync`
- [ ] 手动验证：`rulesync.jsonc` 只配置 `claudecode` 时，派给 codex 的任务 `target_configured` 为 `false`
- [ ] 手动验证：`baton worktree add` 后新 worktree 中有 rulesync 生成的文件

### 阶段 4：文档
- [ ] T8：reference 文档（中英文）
- [ ] T9：README FAQ（中英文）与两份技能说明

### 检查点 D：完成
- [ ] spec 第 9 节全部成功标准满足
- [ ] `npm test`、`npm run build` 通过
- [ ] 准备评审

## 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| T0 实测推翻 spec 2.3 的假设（例如 Claude `-p` 根本不加载项目 MCP） | 中 | T0 先做；结论只影响 adapter 的 `gates` 文案和文档，不影响代码结构 |
| rulesync 检查阻塞 supervisor，心跳停止，任务被误判为已退出 | 高 | 异步 `spawn` 加超时；用会卡住的假 rulesync 做集成测试 |
| 检查耗时计入执行者的超时 | 中 | 检查放在空闲计时器启动之前 |
| 自写的 JSONC 解析遇到少见写法（如字符串里有 `//`） | 中 | 只在字符串外去注释；解析失败返回 `target_configured: null`，不报错；单测覆盖字符串内的 `//` |
| rulesync 配置格式随版本变化（大版本迭代极快） | 中 | 只读 `targets`、`features` 两个键，其他忽略；读不懂就返回“未知”，不影响任务 |
| worktree 里 `rulesync generate` 改动已提交文件，导致 `worktree rm` 拒绝删除 | 中 | 报告 `dirtied`；文档建议先在主仓库生成并提交 |
| 各家 CLI 行为变化导致 adapter 声明过期 | 中 | 声明注明核实日期；文档给出自查方法；只影响提示准确性 |
| `test/skills.test.ts` / `test/manifests.test.ts` 校验技能文件多处副本一致 | 低 | T9 开始前先读这两个测试 |
| 假 `rulesync` 出现在所有集成测试的 `PATH` 中 | 低 | 只在存在 `.rulesync/` 时调用；现有测试不创建该目录 |

## 可并行的部分

- T0 和 T1 互相独立，可以并行。
- T7 只依赖 T5 的查找函数，可以与 T6 并行。
- T8 和 T9 互相独立，可以并行。

## 待决问题

无。T0 结论如果推翻 spec 2.3，先更新 spec 再继续。
