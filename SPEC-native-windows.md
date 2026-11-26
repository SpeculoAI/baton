# Spec: 原生 Windows 支持 — V1

Status: approved
Issue: [#48](https://github.com/SpeculoAI/baton/issues/48)

## Objective

让 baton 在原生 Windows 10/11（PowerShell 或 cmd）上完整可用，并且不改变 macOS/Linux 的行为。WSL 已按 Linux 处理，不在本 spec 范围内。

**用户**：在原生 Windows 上使用 Claude Code、Codex 等 agent CLI，想用 baton 委派任务的开发者。Codex 和 Claude Code 都已经主打原生 Windows，这些用户不会为了 baton 去装 WSL。

**现状**：`npx @speculoai/baton install` 在 Windows 上可以装上，但核心功能用不了。下面是每处代码会怎么坏：

| 位置 | Windows 上的问题 |
|---|---|
| `src/process.ts` `killGroup` | `process.kill(-pid)` 依赖进程组，Windows 上会抛错，cancel 和超时都失效 |
| `src/tasks.ts` `cancel` | 向 supervisor 发 SIGTERM 会被当成强杀，收尾代码不执行，任务记不成 `cancelled` |
| `src/adapters/common.ts` `which` | 只按裸名查找，找不到 `codex.cmd`、`claude.exe` 这类带后缀的程序 |
| 所有 `spawn(bin)` | Node 拒绝直接启动 `.cmd` 文件（`EINVAL`） |
| claude/cursor/agy adapter | 提示词放在 argv 里，经过 `cmd.exe` 时在换行处被截断，还会被注入 |
| `src/supervisor.ts` `--check` | 写死了 `/bin/sh` |
| `src/worktree.ts` symlink | 普通用户默认没有创建符号链接的权限 |
| `test/fake-cli/*` | 全是 sh 脚本，测试在 Windows 上一个都跑不起来 |

**做法**：遵循 Node 生态的标准方案（execa 用的就是 cross-spawn 加 `taskkill /T /F`），再加上业界对多行参数的共识：不让不可信数据经过 `cmd.exe`。

## 关键决策

- **D1 提示词走 stdin。** 所有 adapter 在所有平台上都把提示词写进 stdin，不再放进 argv。codex 现在已经这样做。
  - 理由：`cmd.exe` 处理 `.cmd` 的参数时，在换行处截断，而且没有正确的转义方法。
  - 好处：POSIX 上 `ps` 不再显示提示词，也不受 `ARG_MAX` 限制。
- **T0 验证结果（2026-11-25，macOS，真实 CLI，提示词为两行并含 `& | > ^ " %`，复述内容逐字节一致）**：
  - `claude -p`：不带位置参数，提示词从 stdin 读取。可用。
  - `cursor-agent --print`：不带位置参数，提示词从 stdin 读取。可用。
  - `agy`：纯文本 stdin 不可用，`--print` 必须带值，`--print=-` 会把 `-` 当成提示词。可用的写法是 `--print= --input-format stream-json --output-format stream-json`（`--print=` 值为空），再从 stdin 写一行 `{"event":"user","message":{"content":"<提示词>"}}`，写完关闭 stdin。字段名只有 `content` 有效，`text` 和 `prompt` 会报错。输出事件格式与现在相同，adapter 的解析逻辑不用改。
  - 所以三个 adapter 都按 D1 处理，D2 的回退暂时用不到。agy 带 `--conversation` 续接时是否仍然正常：2026-11-25 尝试验证时 agy 账号额度已用完（429，约 166 小时后重置），**尚未验证**。首轮已确认提示词经 stdin 被 agy 读取并处理（baton 拿到了 session id，报错来自模型调用）。
- **D2 某个 CLI 不支持 stdin 时的回退。**
  - 解析出的程序是 `.exe`（或 POSIX 上的任意程序）：提示词继续走 argv。这不经过 `cmd.exe`，只需检查 Windows 命令行 32767 字符的上限。
  - 解析出的程序是 `.cmd`/`.bat`，且提示词含换行或 `cmd.exe` 元字符：启动前直接报错，写清楚原因。绝不静默截断。
- **D3 启动外部程序改用 `cross-spawn`**（新增运行时依赖），并且 `which` 在 `win32` 上按 `PATHEXT` 逐个尝试后缀，跳过 `X_OK` 检查。
  - 涉及：supervisor 启动 worker、`agents()` 调用 `--version`、`rules.ts` 和 `rulesync-setup.ts` 启动 rulesync、`install.ts`。
  - `git` 在 Windows 上是 `.exe`，保持用 `child_process`。
- **D4 杀进程树。**
  - `win32`：执行 `taskkill /PID <pid> /T /F`，"进程不存在"视为成功。
  - POSIX：保持 `kill(-pid, "SIGKILL")`。
- **D5 cancel 不依赖信号，所有平台同一条路径。**
  1. `cancel` 在任务目录写入 `cancel_requested.<turn>`，用 `wx` 方式创建，重复写入无害。
  2. supervisor 启动时检查一次，之后每 250ms 检查一次。发现文件后，走现有的 `stop("cancelled")` 收尾。
  3. POSIX 上 `cancel` 照常发 SIGTERM，只是为了让 supervisor 立即响应。
  4. 兜底：5 秒内没收尾，且 supervisor 仍然存活，就强杀 supervisor。之后孤儿收尾看到当前 turn 的 `cancel_requested.<turn>`，记为 `cancelled`。
  5. 文件名带 turn 号，所以 `reply` 进入下一轮时，不会被上一轮的取消请求误伤。
- **D6 `--check` 改用 `spawn(command, { shell: true, detached: true })`。** 在 POSIX 上，这和现在的 `/bin/sh -c` 等价；在 Windows 上走 `cmd.exe`。`post_create` 本来就是 `shell: true`。
- **D7 worktree 链接。** 目录用 `fs.symlinkSync(src, dest, "junction")`。文件链接遇到 `EPERM` 时报错，并提示把该条目改到 `copy`。
- **D8** 所有 `detached: true` 的启动加 `windowsHide: true`。
- **D9 新增 `.gitattributes`，内容 `* text=auto eol=lf`。** Windows runner 默认开启 `autocrlf`，会把 fixture 和 patch 转成 CRLF。

## Tech Stack

- Node `>=20.17`，ESM，TypeScript。测试时 Node 直接运行 `.ts`（type stripping）。
- 新增运行时依赖 `cross-spawn`，开发依赖 `@types/cross-spawn`。cross-spawn 有 3 个传递依赖：path-key、shebang-command、which。
- 不引入任何原生扩展。

## Commands

```
Test:  npm test                 # tsc --noEmit && node --test "test/**/*.test.ts"
Build: npm run build
Dist:  node dist/cli.js version && node dist/cli.js agents
CI:    .github/workflows/ci.yml 的 test matrix：ubuntu-latest, macos-latest, windows-latest
```

## Project Structure

```
src/process.ts            killGroup 加 win32 分支（D4）
src/adapters/common.ts    which 支持 PATHEXT（D3）
src/adapters/*.ts         提示词改走 stdin（D1/D2）
src/supervisor.ts         cross-spawn 启动 worker、检查取消文件、--check 用 shell:true（D3/D5/D6/D8）
src/tasks.ts              cancel 写取消文件并兜底；孤儿收尾识别取消文件；agents() 用 cross-spawn（D3/D5）
src/worktree.ts           junction 链接（D7）
src/rules.ts, src/rulesync-setup.ts, src/install.ts   改用 cross-spawn（D3）
test/fake-cli/fake.mjs    统一的 Node 版假 agent CLI
test/fake-cli/<name>      POSIX 启动器：exec node "$(dirname "$0")/fake.mjs" "$@"
test/fake-cli/<name>.cmd  Windows 启动器：@node "%~dp0fake.mjs" %*
.gitattributes            D9
docs/, README*            平台支持说明与已知限制
```

## Code Style

延续现有风格：

- 平台差异就地用 `process.platform === "win32"` 分支处理，不新建平台抽象层。
- 注释只写代码本身看不出来的原因，一行英文。
- 走捷径的地方写 `shortcut: <限制>, <何时升级>`。

```ts
export function killGroup(pid: number | null): void {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return;
  if (process.platform === "win32") {
    // shortcut: taskkill walks parent pids, so grandchildren whose parent already exited escape; a Job Object would need a native addon.
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch (error) { /* 现有 ESRCH/EPERM 处理不变 */ }
}
```

## Testing Strategy

- 框架不变，用 `node:test` 和 `node:assert/strict`，测试放在 `test/*.test.ts`。
- **假 CLI**：一个 `fake.mjs` 实现现有 sh 脚本的全部 `FAKE_*` 行为。"留下一个忽略 TERM 的孙进程"也用 Node 实现。Windows 上通过 `.cmd` 启动器调用，这样测的正是用户真实会走的 `.cmd` 路径。
- **测试里内联的 `#!/bin/sh` 桩**（install、rules、rulesync-setup、adapters）改成一个 helper，同时写出 sh 启动器和 `.cmd` 启动器。
- **`--check` 用例**：改用 `node -e ...` 这类跨平台命令，不再写 `test -f`、`head`、`sleep`。
- **新增用例**：
  - 提示词逐字节一致：内容含换行和 `& | > ^ " %`，在三个平台上都原样到达 worker。
  - `which` 能找到 `.cmd` 和 `.exe`，在 Windows 上运行。
  - cancel 能杀掉孙进程，并记为 `cancelled`。
  - 存在 `cancel_requested.<turn>` 时，孤儿收尾记为 `cancelled`。
  - `reply` 之后，上一轮的取消文件不影响新的一轮。
  - D2：`.cmd` 程序遇到含换行的提示词时报错，前提是有 adapter 需要走 D2。
- **计时类用例**：放大余量，避免 Windows runner 慢导致偶发失败。`lifecycle.test.ts:154` 已经出现过这种情况。
- **验收依据**：`windows-latest` 是必须通过的检查。真实 CLI 冒烟测试在 Windows 真机上手动完成。

## Boundaries

- **Always**
  - 每个 PR 在三个平台上都跑 `npm test`。
  - macOS/Linux 的对外行为保持不变。
  - 不可信数据（提示词）不经过 `cmd.exe`。
  - 新增的平台分支要有测试覆盖。
- **Ask first**
  - 新增依赖（本 spec 只批准 `cross-spawn`）。
  - 修改 CI 的必过检查。
  - 把 D1/D2 中任何一个 adapter 改成别的传参方式。
  - 预防性地加 rename 重试或路径大小写归一化（等 CI 或真机暴露问题后再加）。
- **Never**
  - 自己实现 `cmd.exe` 的转义。
  - 静默截断或改写提示词。
  - 引入原生扩展或 PowerShell 辅助脚本。
  - 为了让测试变绿而删除或跳过 Windows 用例。

## Success Criteria

1. `windows-latest` 上 `npm test` 全部通过，覆盖以下流程：
   - start → wait → success
   - `needs_input` → `reply`
   - idle timeout、max duration
   - cancel 杀掉整个 worker 树（含孙进程）并记为 `cancelled`
   - 孤儿检测
   - `--check`
   - worktree add/rm、`--isolate` + `diff` + `apply`
2. 在 Windows 上，`baton agents` 能识别以 `.cmd` 和 `.exe` 形式安装的 CLI。
3. 含换行和 `& | > ^ " %` 的提示词，在三个平台上都逐字节到达 worker；做不到时（D2）明确报错。
4. Windows 真机上，`npx @speculoai/baton install` 能为 Claude Code 和 Codex 安装成功；codex 和 claude 各完成一次真实的 start → wait → reply。
5. macOS/Linux 的 CI 保持全绿，且原有测试的断言没有被放宽。计时余量的调整除外，需要单独说明。
6. README 和 docs 写明：
   - 支持的平台；
   - Windows 上文件权限 `0600`/`0700` 不生效，由用户目录的 ACL 保护；
   - `taskkill` 可能漏杀孙进程；
   - `--check` 和 `post_create` 在 Windows 上通过 `cmd.exe` 执行。

## 交付拆分

0. **验证（不写代码）**：在 Mac 上用真实 CLI 确认 `claude -p`、`cursor-agent -p`、`agy --print` 能否从 stdin 读提示词。结果决定 D1/D2 对每个 adapter 怎么落地，并回写本 spec。
1. **PR A**：测试脚手架改成跨平台，加 `.gitattributes`。`src/` 零改动，macOS/Linux CI 全绿。
2. **PR B**：D1–D8 的运行时改动，加上 `windows-latest` CI。验收为 Success Criteria 1、2、3、5。
3. **PR C**：Windows 上的 install、文档，以及真机冒烟。验收为 Success Criteria 4、6。真机待定，见 Open Questions。

## Out of Scope (Deferred)

- 用 Job Object 精确管理进程树：Node 没有这个 API，需要原生扩展。
- 专门适配 Git Bash、Cygwin、MSYS 等混合环境：当作普通 Windows 处理，出问题再说。
- Windows ARM64 专项验证：CI 和真机都是 x64。
- 原子写 rename 的 `EPERM`/`EBUSY` 重试、路径大小写归一化：CI 或真机暴露问题再加。
- 不支持时的兜底声明（`package.json` 加 `"os"` 字段）：本 spec 选择完整支持，不需要。

## Open Questions

1. PR C 用哪台 Windows 真机：待定。那台设备的网络比较复杂，后面再定。

已决定（2026-11-25）：
- 同意新增运行时依赖 `cross-spawn`。
- 同意第 0 步在 Mac 上对 claude、cursor-agent、agy 各做一次真实调用。
- D1 所有平台一起改为 stdin。
- 本 spec 放在仓库根目录，不同步到 #48。
