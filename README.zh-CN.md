<h1 align="center">Baton</h1>

<p align="center">
  <strong>把活儿递给隔壁的 Agent。</strong>
</p>

<p align="center">
  <a href="https://github.com/SpeculoAI/baton/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/SpeculoAI/baton/ci.yml?branch=main&style=flat-square&label=CI" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@speculoai/baton"><img src="https://img.shields.io/npm/v/@speculoai/baton?style=flat-square&color=111111&label=npm" alt="npm"></a>
  <img src="https://img.shields.io/node/v/@speculoai/baton?style=flat-square&color=111111" alt="Node 版本">
  <img src="https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20Cursor%20%C2%B7%20Antigravity%20%C2%B7%20Gemini-111111?style=flat-square" alt="支持的宿主">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT 许可证"></a>
</p>

<p align="center">
  <a href="#前后对比">前后对比</a> •
  <a href="#安装">安装</a> •
  <a href="#怎么用">怎么用</a> •
  <a href="#工作原理">工作原理</a> •
  <a href="docs/reference.zh-CN.md">完整手册</a> •
  <a href="README.md">English</a>
</p>

---

你正在 Claude Code 里干活。同一台电脑上还装着 Codex，已经登录、已经付了费，却闲着。Baton 让你正在对话的这个 Agent 把一块有边界的代码任务交给那个 Agent：盯着它跑、替你转达它的问题，最后把结果带回来。

**任何 Agent 都能当主控，任何 Agent 都能当执行者。** 不需要 API Key，不需要服务器，不上云。每个 Agent 都用它自己的登录和订阅额度。

可派工的执行者：`codex`（Codex CLI）· `claude`（Claude Code）· `cursor`（Cursor Agent CLI）· `agy`（Antigravity）。

## 前后对比

<table>
<tr>
<td width="50%">

### 没有 Baton

1. 另开一个终端，启动 `codex`。
2. 把任务和它需要的上下文复制进去。
3. 来回切窗口看它跑到哪了。
4. 它问一句“选 A 还是 B？”，然后就一直等着你，可能一等几个小时。
5. 再把结果复制回第一个会话，解释它改了什么。

</td>
<td width="50%">

### 有了 Baton

> **你：** 把这次重构交给 Codex。

主控 Agent 启动任务，分小段检查进度，把 Codex 的“A 还是 B？”转给你，最后告诉你 Codex 做了什么、改了哪些文件。你全程不用离开当前会话。

</td>
</tr>
</table>

## 安装

```bash
npx @speculoai/baton install
```

它会找出本机装了哪些 Agent CLI，问你要给哪些装插件，并安装全局 `baton` 命令。之后会推荐为当前项目配置 [rulesync](https://github.com/dyoshikawa/rulesync)（可选，以后可随时用 `baton rules init` 重跑）。需要 Node ≥ 20.17，以及至少一个已登录的受支持 Agent CLI。

看看 Baton 能找到哪些执行者：

```bash
baton agents
```

以后用 `npx @speculoai/baton@latest update` 一键更新。安装参数（`--only`、`--force`、`--dry-run`）、各宿主的手动安装方式，以及 Claude Desktop、Windsurf、Zed 的 MCP 配置，见[完整手册](docs/reference.zh-CN.md#安装指南-installation)。

## 怎么用

直接用大白话说：

```text
把这个失败的测试交给 codex 修
让 claude 只读地审一下这次 diff
把迁移拆成三个任务，分给 codex 和 cursor 跑
```

主控 Agent 在背后执行的只是普通 shell 命令：

```bash
baton start --target codex --prompt "修复 src/parser.ts 里失败的测试"   # 立刻返回 task_id
baton wait <task_id> --for 50                                          # 反复调用，直到任务停下
```

想看执行者在干什么，在任意终端里运行：

```bash
baton tail -f <task_id>
```

没指定目标时默认交给 `codex`；如果你本来就在 Codex 里，就交给 `claude`。Baton 永远不会把任务派给你当前正在用的那个 Agent。

## 你会得到什么

| 技能 | 作用 |
|---|---|
| `baton-rescue` | 派出一个任务，分小段等待，把执行者的问题转给你，最后汇报结果。 |
| `baton-orchestrate` | 调度多个有依赖关系的任务：逐个审查、返工，某个执行者失败时换一家，最后写汇总。 |
| `/baton:setup` | 如果通过插件市场安装时没装上 `baton` 命令，用它补上。 |

| 命令 | 作用 |
|---|---|
| `baton start` | 启动任务。可选参数包括 `--effort`、`--mode readonly`、`--scope <glob>`、`--rules check\|pointer\|off`、`--cwd <worktree>`。 |
| `baton wait` / `status` | 等任务停下，或者看一眼当前状态。 |
| `baton result` | 只打印 worker 的完整最终回答，不含过程记录。 |
| `baton diff` / `apply` | 查看 `--isolate` 任务改了什么，再把改动作为一个本地 commit 收回到当前分支（不 push）。 |
| `baton tail [-f]` | 以可读文本显示实时事件流。 |
| `baton reply` | 执行者提问、或者你想追加要求时，在同一个会话里接着说。 |
| `baton cancel` / `ls` / `prune` | 停止任务、列出任务、清理旧任务。 |
| `baton worktree add/ls/rm` | 给任务单独开一个 git worktree，不碰你的工作目录。 |
| `baton rules init` | 为当前项目安装并初始化 rulesync，写入前先预览改动。 |
| `baton mcp` | 以 MCP 服务器的形式提供同样的操作，给不能跑 shell 的宿主用。 |

每个命令都只输出一个 JSON 对象，主控 Agent 读起来不会出错。全部参数和状态见[完整手册](docs/reference.zh-CN.md#命令行)。

## 工作原理

```
主控 Agent ──shell──> baton start ──拉起独立的守护进程──> 执行者 CLI（codex / claude / ...）
    │                     │ 立刻返回 task_id                │ 流式输出 → 统一事件
    │                     ▼                                 │
    │             ~/.baton/tasks/<id>/  <────── 唯一写者 ───┘
    │                     ▲
    └──shell/MCP──> baton wait / status / tail / reply / cancel
```

- **任务不依附主控。** 每个任务都由自己的守护进程看管。关掉会话、关掉终端或重启 MCP，任务都照常跑，之后仍能读到结果。
- **没有总时长上限。** 只有连续 10 分钟没有任何输出才会停，慢模型想几个小时也没问题。
- **统一的事件格式。** 各家 CLI 的消息、工具调用和错误都转换成同一种事件；`status` 会告诉你执行者是在干活、在安静思考，还是已经死了。
- **提问不会把任务卡死。** 执行者需要你拍板时，任务停在 `needs_input`；`baton reply` 会在原会话里继续，并记下是谁回答的。
- **是护栏，不是沙箱。** `--mode readonly` 使用各家 CLI 自带的只读模式，如果文件还是被改了就标记出来；`--scope` 在每轮结束后用路径规则检查 git 改动。执行者不能再调用 Baton，事件日志里的凭据会被脱敏。

## 常见问题

**需要 API Key 吗？**
不需要。Baton 调用的是你已经装好的 CLI，用它们现有的登录。

**任务跑到一半我把主控会话关了怎么办？**
任务会继续跑。开个新会话，运行 `baton ls` 或 `baton status <id>`。

**`--scope` 算安全边界吗？**
不算。它只能拦住 git 看得见的文件里的误改。要真正隔离，请把任务放进 `baton worktree`。

**执行者会遵守我的项目规则 / 环境吗？**
`baton status` 会报告 `rules.unseen`（目标原生不会加载的规则文件）；若你用了 [rulesync](https://github.com/dyoshikawa/rulesync)，还会报告生成配置是否同步。需要时加 `--rules pointer`，让执行者先去读那些文件。更稳妥的做法是维护共享的 `AGENTS.md`，并用 rulesync 把 MCP/skills/hooks 同步到各家 CLI。

**Gemini CLI 能当执行者吗？**
暂时不能，但可以当主控。

**状态存在哪？**
在 `~/.baton/tasks/<id>/` 下（可用 `BATON_HOME` 修改）：`meta.json`、`events.jsonl`、每轮一个文件，以及原始日志。不会被自动删除。

## 开发

```bash
npm install
npm test        # 类型检查 + node --test，用假 CLI 跑，不消耗模型额度
```

所有改动都必须通过 PR 合并，分支、PR、CI 和发布流程见 [CONTRIBUTING](.github/CONTRIBUTING.md)。设计文档见 [docs/architecture.md](docs/architecture.md) 和 [docs/hosts.md](docs/hosts.md)。从 0.3.x 或更早版本升级，请看[升级说明](docs/reference.zh-CN.md#从-03x-升级)。

## 许可证

[MIT](LICENSE)

---

<sub>曾用名 **Agent-Plugin-Agent (APA)**。旧的安装字符串已失效，请使用 `baton@speculoai`。</sub>
