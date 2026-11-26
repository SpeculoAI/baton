# Todo: 原生 Windows 支持

Spec: `SPEC-native-windows.md` · Plan: `tasks/plan.md`

每个任务完成都要满足 Definition of Done：

- `npm test` 通过，且没有回归；
- 运行时行为经过验证，不能只靠单元测试；
- 行为有变化的地方，文档已同步。

---

## Phase 0: 验证

### T0：验证 claude、cursor-agent、agy 能否从 stdin 读提示词

**Description**：在 Mac 上，用真实 CLI 和 adapter 实际使用的参数（去掉 argv 里的提示词）各跑一次：

- 提示词：两行，带 `& | > ^ " %`，要求回复 `ok` 并原样复述第二行。
- agy：先试纯文本 stdin，不行再试 `--input-format stream-json`。

**Acceptance criteria**：
- [x] 每个 CLI 都得出结论：claude、cursor-agent 纯文本 stdin 可用；agy 只能用 stream-json。
- [x] 把结论写回 spec 的 D1/D2，并标明每个 adapter 采用哪种方式。

**Verification**：
- [x] 输出里能看到复述的第二行，与原文逐字节一致。

**Result（2026-11-25）**：已完成，详见 spec 的 "T0 验证结果"。agy 带 `--conversation` 续接时是否正常，留给 T8 验证。

**Dependencies**：无
**Files likely touched**：`SPEC-native-windows.md`
**Estimated scope**：XS

---

## Phase 1: 测试脚手架跨平台（PR A，`src/` 不改动）

### T1：用 `fake.mjs` 加启动器替换 sh 假 CLI

**Description**：
- 新增 `test/fake-cli/fake.mjs`，实现 `fake.sh` 的全部 `FAKE_*` 行为：ARGS_FILE、INPUT_FILE、CHILD_PID_FILE（留下一个忽略 TERM 的孙进程）、TICKS/TICK_SLEEP、SLEEP、WRITE、FIXTURE、HANG、REMOVE_LAST、EXIT。
- 新增 `fake-git.mjs` 和 `fake-rulesync.mjs`。fake-git 在 PATH 中排除自己所在的目录后，再找真实的 git 执行。
- `agent`、`claude`、`codex`、`cursor-agent`、`git`、`rulesync` 都改成：
  - POSIX 上是可执行 sh 启动器，`exec node "$(dirname "$0")/<x>.mjs" "$@"`；
  - Windows 上加同名 `.cmd`，内容为 `@node "%~dp0<x>.mjs" %*`。
- 删除 `fake.sh` 和原来的符号链接。

**Acceptance criteria**：
- [x] `test/fake-cli/` 下没有符号链接；除启动器的 shebang 和 POSIX 专用的 `git` 垫片外，没有 `/bin/` 路径。Windows 上不使用 `git` 垫片，所以 `FAKE_GIT_SLEEP` 用例在 Windows 上怎么处理，等 T5 的 CI 结果再定。
- [x] 每个假 CLI 都有 sh 和 `.cmd` 两个启动器。
- [x] `fake.mjs` 覆盖 `fake.sh` 的全部行为。

**Verification**：
- [x] `npm test` 全绿（Mac）。
- [x] `find test/fake-cli -type l` 没有输出。

**Dependencies**：无
**Files likely touched**：`test/fake-cli/fake.mjs`、`test/fake-cli/fake-git.mjs`、`test/fake-cli/fake-rulesync.mjs`，以及启动器 ×12（这些是机械性的小文件）
**Estimated scope**：M

### T2：`test/helpers.ts` 跨平台

**Description**：
- sandbox 的 PATH 改用 `path.delimiter` 拼接：
  - POSIX 上保持现在的 `fake-cli:/usr/bin:/bin`；
  - win32 上是 fake-cli、`dirname(process.execPath)`、git 所在目录、`%SystemRoot%\System32`。
- 测试结束时的清理改用 `src/process.ts` 的 `killGroup`，替换 `process.kill(-pid)`。

**Acceptance criteria**：
- [x] `helpers.ts` 里没有硬编码的 `:` 分隔符，没有 `/usr/bin`（POSIX 分支除外），也没有负数 PID。

**Verification**：
- [x] `npm test` 全绿（Mac）。

**Dependencies**：T1
**Files likely touched**：`test/helpers.ts`
**Estimated scope**：S

### T3：测试里内联的 sh 桩改用 helper

**Description**：
- 在 `helpers.ts` 里新增 `fakeBin(dir, name, js)`。它写出 `<name>.mjs` 和对应的 sh/`.cmd` 启动器。
- 把下面这些地方内联的 `#!/bin/sh` 桩迁移过去：
  - `adapters.test.ts:86`
  - `install.test.ts:15,183`
  - `rules.test.ts:155`
  - `rulesync-setup.test.ts:31`

**Acceptance criteria**：
- [x] `test/*.ts` 里没有 `#!/bin/sh`，也没有 `chmodSync(…, 0o755)`。
- [x] 断言语义不变。

**Verification**：
- [x] `npm test` 全绿（Mac）。
- [x] `grep -n '#!/bin/sh' test/*.ts` 没有输出。

**Dependencies**：T2
**Files likely touched**：`test/helpers.ts`、`test/adapters.test.ts`、`test/install.test.ts`、`test/rules.test.ts`、`test/rulesync-setup.test.ts`
**Estimated scope**：M

### T4：`--check` 测试命令改用 node；放大计时余量；加 `.gitattributes`

**Description**：
- `test/check.test.ts` 里的 `test -f`、`head | tr`、`sleep`、`echo >&2; exit` 改写成 `node -e "…"`。
- 放大 `lifecycle.test.ts:154` 的余量：`--idle-timeout 1`，`FAKE_TICKS=30`。
- 新增 `.gitattributes`，内容为 `* text=auto eol=lf`，然后跑 `git add --renormalize .`。

**Acceptance criteria**：
- [x] check 用例不依赖 sh 语法。
- [x] renormalize 之后没有意外的 diff。
- [x] 计时用例仍然验证"输出持续、超过空闲阈值时不会被杀"。

**Verification**：
- [x] `npm test` 全绿（Mac）。
- [x] `git status` 只出现预期的文件。

**Dependencies**：T2
**Files likely touched**：`test/check.test.ts`、`test/lifecycle.test.ts`、`.gitattributes`
**Estimated scope**：S

## Checkpoint A：PR A

- [ ] `git diff main --stat -- src/` 为空。
- [ ] PR A 的 CI 在 macOS 和 Linux 上全绿。
- [ ] 交给你评审，合并后再开始 Phase 2。

---

## Phase 2: 运行时（PR B）

### T5：CI matrix 加 `windows-latest`

**Description**：在 `ci.yml` 的 test matrix 里加上 `windows-latest`。之后每次推送都能拿到 Windows 上的失败清单。

**Acceptance criteria**：
- [ ] Windows job 能跑起来，失败原因都出在测试上，不是 CI 配置错误。
- [ ] 不修改 `ci-ok` 的判断规则。

**Verification**：
- [ ] 推送后看 job 日志，确认失败都落在预期的模块上。

**Dependencies**：Checkpoint A
**Files likely touched**：`.github/workflows/ci.yml`
**Estimated scope**：XS

### T6：引入 cross-spawn；`which` 支持 `PATHEXT`；改造 worker 启动和 `agents()`

**Description**：
- 新增依赖 `cross-spawn` 和 `@types/cross-spawn`。
- `which` 在 win32 上按 `PATHEXT` 依次尝试后缀，跳过 `X_OK` 检查。
- supervisor 启动 worker 改用 cross-spawn。
- `agents()` 调用 `--version` 改用 cross-spawn 的同步版本。

**Acceptance criteria**：
- [ ] Windows 上 `baton agents` 能识别 `.cmd` 和 `.exe`。
- [ ] Windows 上能启动 `.cmd` 形式的 worker。
- [ ] POSIX 上行为不变。

**Verification**：
- [ ] `npm test` 在三个平台上通过 which 和 start 相关用例。
- [ ] 新增用例：`which` 能找到 `x.cmd` 和 `x.exe`，只在 win32 上运行。

**Dependencies**：T5
**Files likely touched**：`package.json`、`package-lock.json`、`src/adapters/common.ts`、`src/supervisor.ts`、`src/tasks.ts`、`test/adapters.test.ts`
**Estimated scope**：M

### T7：rules、rulesync-setup、install 改用 cross-spawn

**Description**：把这三处启动外部程序的 `spawn` 和 `spawnSync` 替换成 cross-spawn。`git` 调用保持不变。

**Acceptance criteria**：
- [ ] Windows 上 rulesync 和 npm 的 `.cmd` 能正常启动。
- [ ] 现有测试全绿。

**Verification**：
- [ ] 三个平台上 `npm test` 的 rules、rulesync-setup、install 用例通过。

**Dependencies**：T6
**Files likely touched**：`src/rules.ts`、`src/rulesync-setup.ts`、`src/install.ts`
**Estimated scope**：S

### T8：提示词走 stdin（D1/D2），加逐字节一致测试

**Description**：
- 按 T0 的结论，把 claude、cursor、agy 的 `build()` 改成从 stdin 传提示词。
- 需要走 D2 的 adapter，在启动前检查：程序是 `.cmd`/`.bat`，且提示词含换行或元字符时，直接报错。
- 新增测试：提示词包含换行和 `& | > ^ " %`，经过每个 adapter 后，由假 CLI 的 `FAKE_INPUT_FILE` 收到的内容与原文逐字节一致。

**Acceptance criteria**：
- [ ] 三个平台上，提示词都逐字节到达 worker。
- [ ] argv 里不再出现提示词（D2 的 `.exe` 回退除外）。

**Verification**：
- [ ] 三个平台上 `npm test` 通过新增用例。
- [ ] 现有 adapter 参数断言已按新行为同步更新。

**Dependencies**：T0、T6
**Files likely touched**：`src/adapters/claude.ts`、`src/adapters/cursor.ts`、`src/adapters/agy.ts`、`test/adapters.test.ts`、`test/lifecycle.test.ts`
**Estimated scope**：M

### T9：`killGroup` 的 taskkill 分支；加 `windowsHide`

**Description**：
- win32 上，`killGroup` 执行 `taskkill /PID <pid> /T /F`，进程不存在时视为成功。
- supervisor launch、worker、check 三处 `detached` 启动都加上 `windowsHide: true`。

**Acceptance criteria**：
- [ ] Windows 上 idle timeout 和 max duration 能杀掉整棵 worker 进程树，包括孙进程。
- [ ] POSIX 分支不变。

**Verification**：
- [ ] 三个平台上，lifecycle 的超时和孙进程用例通过。
- [ ] `process.test.ts` 新增 win32 用例：对已退出的 PID 调用不报错。

**Dependencies**：T6
**Files likely touched**：`src/process.ts`、`src/supervisor.ts`、`src/tasks.ts`、`test/process.test.ts`
**Estimated scope**：S

### T10：cancel 改为写取消文件，配套兜底和孤儿收尾

**Description**：
- `cancel` 在任务目录创建 `cancel_requested.<turn>`，用 `wx` 方式，文件已存在也不报错。POSIX 上继续发 SIGTERM。
- supervisor 启动时检查一次，之后每 250ms 检查一次，发现文件就调用 `stop("cancelled")`。
- 兜底：5 秒内没有收尾、且 supervisor 仍存活，就强杀 supervisor。
- 孤儿收尾时，如果当前 turn 存在取消文件，就记为 `cancelled`。

**Acceptance criteria**：
- [ ] Windows 上 cancel 后状态记为 `cancelled`，并且杀掉孙进程。
- [ ] supervisor 卡死时，兜底仍能记为 `cancelled`。
- [ ] `reply` 之后，上一轮的取消文件不影响新的一轮。

**Verification**：
- [ ] 三个平台上 cancel 相关用例通过，另新增 3 条：兜底、孤儿收尾识别取消文件、reply 不受影响。

**Dependencies**：T9
**Files likely touched**：`src/tasks.ts`、`src/supervisor.ts`、`test/lifecycle.test.ts`
**Estimated scope**：M

### T11：`--check` 改用 `shell: true`；目录链接改用 junction

**Description**：
- `runCheck` 改成 `spawn(command, { shell: true, detached: true, windowsHide: true })`。
- worktree 的目录链接用 `"junction"` 类型。文件链接遇到 `EPERM` 时报错，并提示改用 `copy`。

**Acceptance criteria**：
- [ ] 三个平台上 check 用例通过。
- [ ] Windows 上 worktree add/rm 和 `--isolate` + `diff` + `apply` 通过。

**Verification**：
- [ ] 三个平台上 `npm test` 的 check、worktree、isolation、diff-apply 用例通过。

**Dependencies**：T6
**Files likely touched**：`src/supervisor.ts`、`src/worktree.ts`、`test/worktree.test.ts`
**Estimated scope**：S

## Checkpoint B：PR B

- [ ] 三个平台的 CI 全绿。
- [ ] Success Criteria 1、2、3、5 逐条核对。
- [ ] 如果 Windows 上暴露了 rename `EPERM` 或路径大小写问题，先停下来问你（spec Ask first）。
- [ ] 交给你评审。

---

## Phase 3: install、文档、真机（PR C）

### T12：install 去掉 `npm.cmd` 特判；文档写明平台支持和已知限制

**Description**：
- 去掉 `install.ts:147` 和 `rulesync-setup.ts:250` 的 `npm.cmd` 判断，统一写 `npm`，由 cross-spawn 解析。
- 在 README、README.zh-CN、`docs/reference.md`、`docs/reference.zh-CN.md` 里写明：
  - 支持的平台；
  - Windows 上文件权限 `0600`/`0700` 不生效，由用户目录的 ACL 保护；
  - `taskkill` 可能漏杀孙进程；
  - `--check` 和 `post_create` 在 Windows 上通过 `cmd.exe` 执行。

**Acceptance criteria**：
- [ ] Success Criteria 6 满足。
- [ ] install 测试通过。

**Verification**：
- [ ] 三个平台上 `npm test` 通过。
- [ ] 中英文文档内容一致。

**Dependencies**：Checkpoint B
**Files likely touched**：`src/install.ts`、`src/rulesync-setup.ts`、`README.md`、`README.zh-CN.md`、`docs/reference.md`、`docs/reference.zh-CN.md`（文档文件为机械同步）
**Estimated scope**：M

### T13：Windows 真机冒烟（设备待定）

**Description**：在 Windows 真机上依次验证：

- `npx @speculoai/baton install` 能装上 Claude Code 和 Codex；
- `baton agents` 能识别它们；
- codex 和 claude 各完成一次真实的 start → wait → reply，提示词为多行并带特殊字符。

**Acceptance criteria**：
- [ ] Success Criteria 4 满足。

**Verification**：
- [ ] 留存命令和输出记录。

**Dependencies**：T12，以及确定可用的设备
**Files likely touched**：无，或按发现的问题修复
**Estimated scope**：S

## Checkpoint C：PR C

- [ ] Success Criteria 4、6 满足。
- [ ] 把 spec 的 Status 改为 implemented。
