import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, lstatSync, realpathSync } from "node:fs";
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

// Windows temp dirs come as 8.3 short names (RUNNER~1); only the native variant expands them.
const fsRealpath = realpathSync.native;

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

test("loadWorktreeConfig reads .baton.json and falls back to safe defaults", () => {
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

test("resolveWorktreeRoot: configured dir > .worktrees > worktrees > default .worktrees", () => {
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

test("ensureIgnored: appends to .gitignore if not ignored, leaves it alone if already ignored", () => {
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

test("assertNotNestedWorktree: main repo passes, linked worktree is rejected", () => {
  const { cwd, git, cleanup } = tempRepo();
  try {
    assert.doesNotThrow(() => assertNotNestedWorktree(cwd));

    writeFileSync(path.join(cwd, ".gitignore"), ".worktrees/\n");
    git(["add", ".gitignore"]);
    git(["commit", "-m", "ignore"]);
    mkdirSync(path.join(cwd, ".worktrees"));
    const linked = path.join(cwd, ".worktrees", "feat");
    git(["worktree", "add", "-b", "feat-branch", linked]);

    assert.throws(() => assertNotNestedWorktree(linked), /linked worktree|nested|main repo/i);
  } finally {
    cleanup();
  }
});

test("addWorktree uses default naming and writes the registry file; visible in ls", () => {
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

test("addWorktree accepts custom name/branch/base", () => {
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

test("matchBasename covers .env and .env.*", () => {
  assert.equal(matchBasename(".env", ".env"), true);
  assert.equal(matchBasename(".env.local", ".env.*"), true);
  assert.equal(matchBasename(".env", ".env.*"), false);
  assert.equal(matchBasename("node_modules", "node_modules"), true);
});

test("addWorktree copies / symlinks per config; post_create receives injected env vars", () => {
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

test("a failing post_create cleans up the half-built worktree", () => {
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

test("worktree rulesync: generate / skip / error / missing / dirtied", () => {
  const fakeCli = path.join(import.meta.dirname, "fake-cli");
  const prevPath = process.env.PATH;
  process.env.PATH = `${fakeCli}${path.delimiter}${prevPath || ""}`;
  const { cwd, git, cleanup } = tempRepo();
  try {
    mkdirSync(path.join(cwd, ".rulesync"));
    writeFileSync(path.join(cwd, ".rulesync", ".keep"), "");
    writeFileSync(path.join(cwd, "rulesync.jsonc"), `{ "targets": ["codexcli"], "features": ["rules"] }`);
    writeFileSync(path.join(cwd, "CLAUDE.local.md"), "local\n");
    writeFileSync(path.join(cwd, ".gitignore"), "CLAUDE.local.md\n");
    git(["add", "-A"]);
    git(["commit", "-m", "rulesync seed"]);

    process.env.FAKE_RULESYNC_EXIT = "0";
    const generated = addWorktree(cwd, { name: "rs-ok" });
    assert.equal(generated.rules?.rulesync, "generated");
    assert.ok(generated.rules?.missing.includes("CLAUDE.local.md"));

    writeFileSync(path.join(cwd, ".baton.json"), JSON.stringify({ worktree: { rulesync: false } }));
    const skipped = addWorktree(cwd, { name: "rs-off" });
    assert.equal(skipped.rules?.rulesync, "skipped");

    writeFileSync(path.join(cwd, ".baton.json"), JSON.stringify({ worktree: { copy: ["CLAUDE.local.md"] } }));
    process.env.FAKE_RULESYNC_EXIT = "0";
    const copied = addWorktree(cwd, { name: "rs-copy" });
    assert.equal(copied.rules?.rulesync, "generated");
    assert.ok(!copied.rules?.missing.includes("CLAUDE.local.md"));

    process.env.FAKE_RULESYNC_EXIT = "3";
    process.env.FAKE_RULESYNC_STDERR = "nope";
    const failed = addWorktree(cwd, { name: "rs-err" });
    assert.equal(failed.rules?.rulesync, "error");
    assert.match(failed.rules?.detail ?? "", /nope|exited/);
    assert.ok(existsSync(failed.path));

    delete process.env.FAKE_RULESYNC_EXIT;
    delete process.env.FAKE_RULESYNC_STDERR;
    process.env.FAKE_RULESYNC_TOUCH = path.join(cwd, "README.md"); // wrong — touch must be inside worktree
    // Recreate with touch relative: fake script appends to absolute path we set after add starts — use a hook via env that points at worktree file after creation is hard.
    // Instead: make fake rewrite README by writing into cwd of generate (worktree): use FAKE_RULESYNC_TOUCH=README.md relative.
    process.env.FAKE_RULESYNC_TOUCH = "README.md";
    const dirty = addWorktree(cwd, { name: "rs-dirty" });
    assert.equal(dirty.rules?.rulesync, "generated");
    assert.ok(dirty.rules?.dirtied.some((p) => p.includes("README.md")));
  } finally {
    delete process.env.FAKE_RULESYNC_EXIT;
    delete process.env.FAKE_RULESYNC_STDERR;
    delete process.env.FAKE_RULESYNC_TOUCH;
    process.env.PATH = prevPath;
    cleanup();
  }
});

test("smoke test: CLI worktree add/ls/rm and start --cwd", async () => {
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
test("removeWorktree: clean tree can be removed; dirty tree and unmerged commits are rejected; provenance rejects the main repo", () => {
  const { cwd, git, cleanup } = tempRepo();
  try {
    const clean = addWorktree(cwd, { name: "clean" });
    const removed = removeWorktree(cwd, "clean");
    assert.equal(removed.status, "ok");
    assert.equal(existsSync(clean.path), false);
    assert.equal(listWorktrees(cwd).length, 0);

    const dirty = addWorktree(cwd, { name: "dirty" });
    writeFileSync(path.join(dirty.path, "README.md"), "dirty\n");
    assert.throws(() => removeWorktree(cwd, "dirty"), /uncommitted/i);

    const ahead = addWorktree(cwd, { name: "ahead" });
    writeFileSync(path.join(ahead.path, "extra.txt"), "x\n");
    git(["-C", ahead.path, "add", "extra.txt"]);
    git(["-C", ahead.path, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "ahead"]);
    assert.throws(() => removeWorktree(cwd, "ahead"), /not merged|unmerged/i);

    assert.throws(() => removeWorktree(cwd, cwd), /only (remove|delete)|managed/i);
  } finally {
    cleanup();
  }
});

test("removeWorktree with force removes dirty and unmerged trees, still rejects main repo", () => {
  const { cwd, git, cleanup } = tempRepo();
  try {
    const dirty = addWorktree(cwd, { name: "dirty-f" });
    writeFileSync(path.join(dirty.path, "README.md"), "dirty\n");
    assert.throws(() => removeWorktree(cwd, "dirty-f"), /--force/);
    const rmDirty = removeWorktree(cwd, "dirty-f", { force: true });
    assert.equal(rmDirty.status, "ok");
    assert.equal(existsSync(dirty.path), false);
    assert.throws(() => git(["rev-parse", "--verify", dirty.branch]));

    const ahead = addWorktree(cwd, { name: "ahead-f" });
    writeFileSync(path.join(ahead.path, "extra.txt"), "x\n");
    git(["-C", ahead.path, "add", "extra.txt"]);
    git(["-C", ahead.path, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "ahead"]);
    assert.throws(() => removeWorktree(cwd, "ahead-f"), /--force/);
    const rmAhead = removeWorktree(cwd, "ahead-f", { force: true });
    assert.equal(rmAhead.status, "ok");
    assert.equal(existsSync(ahead.path), false);
    assert.throws(() => git(["rev-parse", "--verify", ahead.branch]));

    assert.throws(() => removeWorktree(cwd, cwd, { force: true }), /only (remove|delete)|managed/i);
  } finally {
    cleanup();
  }
});

test("removeWorktree rejects untracked files unless exempt or forced, and force succeeds when branch is already gone", () => {
  const { cwd, git, cleanup } = tempRepo();
  try {
    writeFileSync(path.join(cwd, ".env.local"), "SECRET=1\n");
    writeFileSync(path.join(cwd, ".baton.json"), JSON.stringify({ worktree: { copy: [".env.*"] } }));

    const exemptOnly = addWorktree(cwd, { name: "exempt-only" });
    assert.equal(removeWorktree(cwd, "exempt-only").status, "ok");
    assert.equal(existsSync(exemptOnly.path), false);

    const untracked = addWorktree(cwd, { name: "untracked" });
    writeFileSync(path.join(untracked.path, "new-file.txt"), "draft\n");
    assert.throws(() => removeWorktree(cwd, "untracked"), /uncommitted.*--force/i);
    assert.equal(removeWorktree(cwd, "untracked", { force: true }).status, "ok");
    assert.equal(existsSync(untracked.path), false);

    const detached = addWorktree(cwd, { name: "missing-branch" });
    git(["-C", detached.path, "checkout", "--detach"]);
    git(["branch", "-D", detached.branch]);
    assert.equal(removeWorktree(cwd, "missing-branch", { force: true }).status, "ok");
    assert.equal(existsSync(detached.path), false);
    assert.ok(!git(["worktree", "list", "--porcelain"]).includes("missing-branch"));
  } finally {
    cleanup();
  }
});

test("CLI worktree rm supports --force / -f and rejects unknown flags across add/ls/rm", async () => {
  const { cwd, git, cleanup } = tempRepo();
  const { exec, cli } = await import("./helpers.ts");
  const run = (...args: string[]) => exec(process.execPath, [cli, ...args], { cwd, timeout: 8000 });
  try {
    const dirty = addWorktree(cwd, { name: "cli-dirty" });
    writeFileSync(path.join(dirty.path, "README.md"), "modified\n");

    await assert.rejects(
      run("worktree", "rm", "cli-dirty", "--bogus"),
      (error: { stdout: string }) => /unknown option.*--bogus/i.test(JSON.parse(error.stdout).summary),
    );
    await assert.rejects(
      run("worktree", "rm", "cli-dirty", "--base", "main"),
      (error: { stdout: string }) => /unknown option.*--base/i.test(JSON.parse(error.stdout).summary),
    );
    await assert.rejects(
      run("worktree", "rm", "--force"),
      (error: { stdout: string }) => /requires one name or path/i.test(JSON.parse(error.stdout).summary),
    );
    await assert.rejects(
      run("worktree", "add", "--force"),
      (error: { stdout: string }) => /unknown option.*--force/i.test(JSON.parse(error.stdout).summary),
    );
    await assert.rejects(
      run("worktree", "ls", "--bogus"),
      (error: { stdout: string }) => /unknown option.*--bogus/i.test(JSON.parse(error.stdout).summary),
    );

    const rmLong = JSON.parse((await run("worktree", "rm", "cli-dirty", "--force")).stdout) as { status: string; name: string };
    assert.equal(rmLong.status, "ok");
    assert.equal(rmLong.name, "cli-dirty");
    assert.equal(existsSync(dirty.path), false);

    const ahead = addWorktree(cwd, { name: "cli-ahead" });
    writeFileSync(path.join(ahead.path, "a.txt"), "1\n");
    git(["-C", ahead.path, "add", "a.txt"]);
    git(["-C", ahead.path, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "ahead"]);

    const rmShort = JSON.parse((await run("worktree", "rm", "-f", "cli-ahead")).stdout) as { status: string; name: string };
    assert.equal(rmShort.status, "ok");
    assert.equal(rmShort.name, "cli-ahead");
    assert.equal(existsSync(ahead.path), false);
    assert.throws(() => git(["rev-parse", "--verify", ahead.branch]));

    const byPath = addWorktree(cwd, { name: "cli-path" });
    writeFileSync(path.join(byPath.path, "untracked.txt"), "u\n");
    const rmByPath = JSON.parse((await run("worktree", "rm", byPath.path, "--force")).stdout) as { status: string; name: string };
    assert.equal(rmByPath.status, "ok");
    assert.equal(rmByPath.name, "cli-path");
    assert.equal(existsSync(byPath.path), false);
  } finally {
    cleanup();
  }
});
