# Implementation Plan: 原生 Windows 支持

Source spec: `SPEC-native-windows.md`
Task list: `tasks/todo.md`

## Overview

分四个阶段交付：

- **阶段 0**：只做验证，用真实 CLI 确认能否从 stdin 读提示词。
- **阶段 1（PR A）**：把测试脚手架改成跨平台，运行时代码一行不动。
- **阶段 2（PR B）**：先打开 Windows CI 作为反馈环，再按决策逐片改运行时代码，直到三个平台的 CI 全绿。
- **阶段 3（PR C）**：处理 install、补文档、真机冒烟测试。

## Architecture Decisions

实现必须遵守 spec 里的 D1–D9，这里不重复。下面三条是实施层面的约定：

- **先开 Windows CI 再修。** PR B 的第一个提交就把 `windows-latest` 加进 matrix。之后每推送一次，都能看到 Windows 上还剩哪些失败。只有三个平台全绿，PR B 才能合并。
- **假 CLI 启动器是提交进仓库的静态文件，不在运行时生成。**
  - 现在的 `agent`、`claude`、`codex`、`cursor-agent` 是指向 `fake.sh` 的 git 符号链接。Windows 检出时，符号链接默认会变成普通文本文件，所以必须换掉。
  - POSIX 启动器是可执行的 sh 文件，Windows 启动器是对应的 `.cmd` 文件。POSIX 上的 `which` 不看 `PATHEXT`，所以 `.cmd` 文件在 POSIX 上不会被误用。
- **平台差异就地写分支。** 直接用 `process.platform === "win32"` 判断，不新建平台抽象层。

## Dependency Graph

```
T0 验证 stdin ──────────────────────────────┐
                                             ▼
T1 fake.mjs+启动器 ─► T2 helpers ─► T3 内联桩 ─► T4 check 命令/计时/.gitattributes
                                             │
                                  [Checkpoint A：PR A]
                                             │
                     T5 Windows CI（预期红）
                                             │
     T6 cross-spawn+which ─► T7 其余 spawn 点
                    │
                    ├─► T8 提示词走 stdin（依赖 T0）
                    ├─► T9 killGroup+windowsHide ─► T10 cancel 取消文件
                    └─► T11 --check shell + junction
                                             │
                                  [Checkpoint B：PR B]
                                             │
                     T12 install+文档 ─► T13 真机冒烟（设备待定）
                                             │
                                  [Checkpoint C：PR C]
```

T8、T9/T10、T11 都只依赖 T6，相互之间独立，可以按任意顺序做。不过它们都会改 `src/supervisor.ts`，所以按顺序做，避免冲突。

## Task List

详见 `tasks/todo.md`。

### Phase 0: 验证
- [x] T0：在 Mac 上验证 claude、cursor-agent、agy 能否从 stdin 读提示词

### Phase 1: 测试脚手架跨平台（PR A）
- [x] T1：`fake.mjs` 加启动器，替换 sh 假 CLI
- [x] T2：`helpers.ts` 跨平台
- [x] T3：测试里内联的 sh 桩改用 helper
- [x] T4：`--check` 测试命令改用 node；放大计时余量；加 `.gitattributes`

### Checkpoint A
- [ ] macOS、Linux CI 全绿；`git diff main -- src/` 为空

### Phase 2: 运行时（PR B）
- [ ] T5：CI matrix 加 `windows-latest`（预期红）
- [ ] T6：引入 cross-spawn；`which` 支持 `PATHEXT`；改造 worker 启动和 `agents()`
- [ ] T7：rules、rulesync-setup、install 改用 cross-spawn
- [ ] T8：提示词走 stdin（D1/D2），加逐字节一致测试
- [ ] T9：`killGroup` 的 taskkill 分支；加 `windowsHide`
- [ ] T10：cancel 改为写取消文件，配套兜底和孤儿收尾
- [ ] T11：`--check` 改用 `shell: true`；目录链接改用 junction

### Checkpoint B
- [ ] 三个平台 CI 全绿；满足 Success Criteria 1、2、3、5

### Phase 3: install、文档、真机（PR C）
- [ ] T12：install 去掉 `npm.cmd` 特判；文档写明平台支持和已知限制
- [ ] T13：真机冒烟（设备待定）

### Checkpoint C
- [ ] 满足 Success Criteria 4、6

## Risks and Mitigations

| 风险 | 影响 | 应对 |
|---|---|---|
| 某个 CLI 不支持从 stdin 读提示词 | 中 | T0 先验证。不支持的 adapter 走 D2：`.exe` 继续用 argv，`.cmd` 遇到不安全的提示词就报错 |
| Windows CI 每轮 5–10 分钟，调试慢 | 中 | T5 最先打开 CI。每个任务完成就推送一次，不攒到最后。本地先在 Mac 上跑通 POSIX 一侧 |
| Windows runner 慢，计时类用例偶发失败 | 中 | T4 统一放大余量。在 Windows 上新暴露的计时问题，同样只放大余量，不放宽断言语义 |
| `taskkill /T` 漏杀孙进程 | 低 | 测试覆盖中间层进程仍存活的常见情况；漏杀的情况写进文档（spec 已声明） |
| 原子写 `renameSync` 被杀毒软件占用，报 `EPERM` | 低 | 不预先处理。CI 或真机出现了，再按 spec 的 Ask first 加有上限的重试 |
| D1 改变了 POSIX 上提示词的传递方式 | 中 | T0 用真实 CLI 验证；macOS、Linux 现有测试必须保持全绿，断言不放宽 |
| `.gitattributes` 会让已有文件的换行被重新归一化 | 低 | T4 跑 `git add --renormalize .`，确认 diff 为空或只涉及预期的文件 |

## Open Questions

- T13 的 Windows 真机待定（spec Open Questions 1）。
