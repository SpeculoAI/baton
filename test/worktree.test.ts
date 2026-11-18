import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, lstatSync, realpathSync as fsRealpath } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadWorktreeConfig,
  resolveWorktreeRoot,
  ensureIgnored,
  assertNotNestedWorktree,
  addWorktree,
  listWorktrees,
  removeWorktree,
  matchBasename,
} from "../src/worktree.ts";

function tempRepo(): { cwd: string; git: (args: string[]) => string; cleanup: () => void } {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "baton-wt-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  writeFileSync(path.join(cwd, "README.md"), "init\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "init"]);
  return { cwd, git, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("loadWorktreeConfig 读 .baton.json，缺省给安全默认值", () => {
  const { cwd, cleanup } = tempRepo();
  try {
    const empty = loadWorktreeConfig(cwd);
    assert.equal(empty.dir, undefined);
    assert.deepEqual(empty.copy, []);
    assert.deepEqual(empty.symlink, []);
    assert.deepEqual(empty.post_create, []);
    assert.equal(empty.base, undefined);

    writeFileSync(path.join(cwd, ".baton.json"), JSON.stringify({
      worktree: {
        dir: ".worktrees",
        base: "main",
        copy: [".env"],
        symlink: ["node_modules"],
        post_create: ["echo hi"],
      },
    }));
    const cfg = loadWorktreeConfig(cwd);
    assert.equal(cfg.dir, ".worktrees");
    assert.equal(cfg.base, "main");
    assert.deepEqual(cfg.copy, [".env"]);
    assert.deepEqual(cfg.symlink, ["node_modules"]);
    assert.deepEqual(cfg.post_create, ["echo hi"]);
  } finally {
    cleanup();
  }
});

test("resolveWorktreeRoot：配置 dir > .worktrees > worktrees > 默认 .worktrees", () => {
  const { cwd, cleanup } = tempRepo();
  try {
    assert.equal(resolveWorktreeRoot(cwd, {}), path.join(cwd, ".worktrees"));

    mkdirSync(path.join(cwd, "worktrees"));
    assert.equal(resolveWorktreeRoot(cwd, {}), path.join(cwd, "worktrees"));

    mkdirSync(path.join(cwd, ".worktrees"));
    assert.equal(resolveWorktreeRoot(cwd, {}), path.join(cwd, ".worktrees"));

    assert.equal(
      resolveWorktreeRoot(cwd, { dir: "custom-trees" }),
      path.join(cwd, "custom-trees"),
    );
  } finally {
    cleanup();
  }
});

test("ensureIgnored：未忽略则追加 .gitignore，已忽略则不动", () => {
  const { cwd, git, cleanup } = tempRepo();
  try {
    const root = path.join(cwd, ".worktrees");
    mkdirSync(root);
    const first = ensureIgnored(cwd, root);
    assert.equal(first, true);
    assert.match(readFileSync(path.join(cwd, ".gitignore"), "utf8"), /\.worktrees\/?/);
    assert.equal(execFileSync("git", ["check-ignore", "-q", ".worktrees"], { cwd, encoding: "utf8" }), "");

    const second = ensureIgnored(cwd, root);
    assert.equal(second, false);
  } finally {
    cleanup();
  }
});

test("assertNotNestedWorktree：主仓通过，linked worktree 拒绝", () => {
  const { cwd, git, cleanup } = tempRepo();
  try {
    assert.doesNotThrow(() => assertNotNestedWorktree(cwd));

    writeFileSync(path.join(cwd, ".gitignore"), ".worktrees/\n");
    git(["add", ".gitignore"]);
    git(["commit", "-m", "ignore"]);
    mkdirSync(path.join(cwd, ".worktrees"));
    const linked = path.join(cwd, ".worktrees", "feat");
    git(["worktree", "add", "-b", "feat-branch", linked]);

    assert.throws(() => assertNotNestedWorktree(linked), /linked worktree|嵌套|main repo/i);
  } finally {
    cleanup();
  }
});

test("addWorktree 默认命名并写登记文件；ls 可见", () => {
  const { cwd, cleanup } = tempRepo();
  try {
    const added = addWorktree(cwd);
    assert.equal(added.status, "ok");
    assert.match(added.name, /^[0-9a-f]{8}$/);
    assert.equal(added.branch, `baton/${added.name}`);
    assert.equal(added.gitignore_updated, true);
    assert.ok(existsSync(added.path));
    const meta = JSON.parse(readFileSync(path.join(added.path, ".baton-worktree.json"), "utf8"));
    assert.equal(meta.name, added.name);
    assert.equal(meta.branch, added.branch);

    const listed = listWorktrees(cwd);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.name, added.name);
    assert.equal(listed[0]?.path, added.path);
  } finally {
    cleanup();
  }
});

test("addWorktree 接受自定义 name/branch/base", () => {
  const { cwd, git, cleanup } = tempRepo();
  try {
    git(["branch", "develop"]);
    const added = addWorktree(cwd, { name: "job1", branch: "feature/job1", base: "develop" });
    assert.equal(added.name, "job1");
    assert.equal(added.branch, "feature/job1");
    assert.equal(added.base, "develop");
    assert.ok(added.path.endsWith(`${path.sep}.worktrees${path.sep}job1`));
  } finally {
    cleanup();
  }
});

test("matchBasename 覆盖 .env 与 .env.*", () => {
  assert.equal(matchBasename(".env", ".env"), true);
  assert.equal(matchBasename(".env.local", ".env.*"), true);
  assert.equal(matchBasename(".env", ".env.*"), false);
  assert.equal(matchBasename("node_modules", "node_modules"), true);
});

test("addWorktree 按配置 copy / symlink，post_create 注入环境变量", () => {
  const { cwd, cleanup } = tempRepo();
  try {
    writeFileSync(path.join(cwd, ".env"), "SECRET=1\n");
    writeFileSync(path.join(cwd, ".env.local"), "LOCAL=1\n");
    mkdirSync(path.join(cwd, "node_modules"));
    writeFileSync(path.join(cwd, "node_modules", "x"), "1\n");
    writeFileSync(path.join(cwd, ".baton.json"), JSON.stringify({
      worktree: {
        copy: [".env", ".env.*"],
        symlink: ["node_modules"],
        post_create: ["node -e \"require('fs').writeFileSync('ok.txt', process.env.BATON_MAIN_REPO+'\\n'+process.env.BATON_WORKTREE)\""],
      },
    }));

    const added = addWorktree(cwd, { name: "prep" });
    assert.equal(readFileSync(path.join(added.path, ".env"), "utf8"), "SECRET=1\n");
    assert.equal(readFileSync(path.join(added.path, ".env.local"), "utf8"), "LOCAL=1\n");
    assert.ok(lstatSync(path.join(added.path, "node_modules")).isSymbolicLink());
    const ok = readFileSync(path.join(added.path, "ok.txt"), "utf8").trim().split("\n");
    assert.equal(fsRealpath(ok[0]!), fsRealpath(cwd));
    assert.equal(fsRealpath(ok[1]!), fsRealpath(added.path));
  } finally {
    cleanup();
  }
});

test("post_create 失败会清理半成品 worktree", () => {
  const { cwd, cleanup } = tempRepo();
  try {
    writeFileSync(path.join(cwd, ".baton.json"), JSON.stringify({
      worktree: { post_create: ["node -e \"process.exit(2)\""] },
    }));
    assert.throws(() => addWorktree(cwd, { name: "boom" }), /post_create/);
    assert.equal(existsSync(path.join(cwd, ".worktrees", "boom")), false);
    assert.equal(listWorktrees(cwd).length, 0);
  } finally {
    cleanup();
  }
});

test("CLI worktree add/ls/rm 与 start --cwd 冒烟", async () => {
  const { cwd, cleanup } = tempRepo();
  const { exec, cli, sleep } = await import("./helpers.ts");
  const home = mkdtempSync(path.join(os.tmpdir(), "baton-home-"));
  try {
    const env = { ...process.env, PATH: `${path.join(import.meta.dirname, "fake-cli")}${path.delimiter}${process.env.PATH || ""}` };
    const addOut = await exec(process.execPath, [cli, "worktree", "add", "--name", "cli1"], { cwd, env, timeout: 8000 });
    const added = JSON.parse(addOut.stdout) as { status: string; path: string; name: string };
    assert.equal(added.status, "ok");
    assert.equal(added.name, "cli1");

    const lsOut = await exec(process.execPath, [cli, "worktree", "ls"], { cwd, env, timeout: 8000 });
    const listed = JSON.parse(lsOut.stdout) as { worktrees: { name: string }[] };
    assert.equal(listed.worktrees.length, 1);

    const fixture = path.join(home, "fixture.jsonl");
    writeFileSync(fixture, `${JSON.stringify({ type: "thread.started", thread_id: "t1" })}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "BATON_RESULT\nsummary: ok\nBATON_END" } })}\n`);
    const startEnv = {
      ...env,
      BATON_HOME: home,
      BATON_DELEGATION: "0",
      FAKE_FIXTURE: fixture,
      FAKE_SLEEP: "0",
      FAKE_EXIT: "0",
      FAKE_HANG: "0",
    };
    const started = JSON.parse((await exec(process.execPath, [cli, "start", "--target", "codex", "--prompt", "hi", "--cwd", added.path], { cwd, env: startEnv, timeout: 8000 })).stdout) as { cwd: string; status: string; task_id: string };
    assert.equal(started.status, "running");
    assert.equal(fsRealpath(started.cwd), fsRealpath(added.path));

    await exec(process.execPath, [cli, "cancel", started.task_id], { cwd: added.path, env: startEnv, timeout: 8000 });
    for (let i = 0; i < 50; i++) {
      const view = JSON.parse((await exec(process.execPath, [cli, "status", started.task_id], { cwd: added.path, env: startEnv, timeout: 8000 })).stdout) as { status: string };
      if (view.status !== "running") break;
      await sleep(50);
    }

    const rmOut = await exec(process.execPath, [cli, "worktree", "rm", "cli1"], { cwd, env, timeout: 8000 });
    assert.equal(JSON.parse(rmOut.stdout).status, "ok");
  } finally {
    rmSync(home, { recursive: true, force: true });
    cleanup();
  }
});
test("removeWorktree：净树可删；脏树与未合并提交拒绝；provenance 拒绝主仓", () => {
  const { cwd, git, cleanup } = tempRepo();
  try {
    const clean = addWorktree(cwd, { name: "clean" });
    const removed = removeWorktree(cwd, "clean");
    assert.equal(removed.status, "ok");
    assert.equal(existsSync(clean.path), false);
    assert.equal(listWorktrees(cwd).length, 0);

    const dirty = addWorktree(cwd, { name: "dirty" });
    writeFileSync(path.join(dirty.path, "README.md"), "dirty\n");
    assert.throws(() => removeWorktree(cwd, "dirty"), /未提交/);

    const ahead = addWorktree(cwd, { name: "ahead" });
    writeFileSync(path.join(ahead.path, "extra.txt"), "x\n");
    git(["-C", ahead.path, "add", "extra.txt"]);
    git(["-C", ahead.path, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "ahead"]);
    assert.throws(() => removeWorktree(cwd, "ahead"), /未合并/);

    assert.throws(() => removeWorktree(cwd, cwd), /只能删除|管理/);
  } finally {
    cleanup();
  }
});
