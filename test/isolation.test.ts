import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sandbox, exec, cli } from "./helpers.ts";
import { dirtyPaths } from "../src/git.ts";
import { resolveWriteSafety } from "../src/tasks.ts";

function gitInit(cwd: string) {
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(cwd, "keep.txt"), "keep\n");
  git(["add", "keep.txt"]);
  git(["commit", "-m", "init"]);
}

function tempRepo(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-iso-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  gitInit(dir);
  return dir;
}

test("dirtyPaths: tracked + untracked; ignored excluded; sorted", (t) => {
  const dir = tempRepo(t);
  fs.writeFileSync(path.join(dir, "keep.txt"), "changed\n");
  fs.writeFileSync(path.join(dir, "z-new.txt"), "n\n");
  fs.writeFileSync(path.join(dir, "a-new.txt"), "n\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "secret.bin\n");
  fs.writeFileSync(path.join(dir, "secret.bin"), "x");
  const paths = dirtyPaths(dir);
  assert.deepEqual(paths, [".gitignore", "a-new.txt", "keep.txt", "z-new.txt"]);
});

test("dirtyPaths: non-git returns null", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-nongit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(dirtyPaths(dir), null);
});

test("resolveWriteSafety: readonly forbids isolate/allowDirty; both together forbidden", () => {
  assert.throws(() => resolveWriteSafety("readonly", true, false), /only for --mode write/);
  assert.throws(() => resolveWriteSafety("readonly", false, true), /only for --mode write/);
  assert.throws(() => resolveWriteSafety("write", true, true), /cannot be combined/);
  resolveWriteSafety("write", false, true);
  resolveWriteSafety(undefined, false, true);
});

test("start: dirty tracked file → dirty_worktree, no task dir", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  fs.writeFileSync(path.join(s.cwd, "keep.txt"), "dirty\n");
  const result = await exec(process.execPath, [cli, "start", "--target", "codex", "--prompt", "hi"], { cwd: s.cwd, env: s.env }).catch((e: NodeJS.ErrnoException & { stdout: string }) => e);
  assert.ok(result && "stdout" in result);
  const body = JSON.parse((result as { stdout: string }).stdout);
  assert.equal(body.status, "dirty_worktree");
  assert.ok(body.dirty_paths.includes("keep.txt"));
  assert.match(body.summary, /--isolate/);
  assert.match(body.summary, /--allow-dirty/);
  assert.match(body.summary, /HEAD/);
  assert.equal((result as { code?: number }).code ?? 1, 1);
  assert.equal(fs.existsSync(path.join(s.home, "tasks")), false);
});

test("start: untracked file → dirty_worktree", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  fs.writeFileSync(path.join(s.cwd, "extra.txt"), "x\n");
  await assert.rejects(
    () => exec(process.execPath, [cli, "start", "--target", "codex", "--prompt", "hi"], { cwd: s.cwd, env: s.env }),
    (error: unknown) => {
      const body = JSON.parse((error as { stdout: string }).stdout);
      assert.equal(body.status, "dirty_worktree");
      assert.ok(body.dirty_paths.includes("extra.txt"));
      return true;
    },
  );
});

test("start: ignored-only → runs", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  fs.writeFileSync(path.join(s.cwd, ".gitignore"), "secret.bin\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: s.cwd });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "ignore"], { cwd: s.cwd });
  fs.writeFileSync(path.join(s.cwd, "secret.bin"), "x");
  const started = await s.run("start", "--target", "codex", "--prompt", "hi");
  assert.equal(started.status, "running");
  await s.until(started.task_id);
});

test("start: clean tree → runs in place", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  const started = await s.run("start", "--target", "codex", "--prompt", "hi");
  assert.equal(started.status, "running");
  const done = await s.until(started.task_id);
  assert.equal(done.status, "success");
  assert.equal(done.allow_dirty, undefined);
});

test("start: --allow-dirty on dirty tree → runs; meta.allow_dirty", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  fs.writeFileSync(path.join(s.cwd, "keep.txt"), "dirty\n");
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--allow-dirty");
  assert.equal(started.status, "running");
  assert.equal(s.meta(started.task_id).allow_dirty, true);
  await s.until(started.task_id);
});

test("start: --allow-dirty on clean / non-git → no-op ok", async (t) => {
  const s = sandbox(t);
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--allow-dirty");
  assert.equal(started.status, "running");
  await s.until(started.task_id);

  const s2 = sandbox(t);
  gitInit(s2.cwd);
  const started2 = await s2.run("start", "--target", "codex", "--prompt", "hi", "--allow-dirty");
  assert.equal(started2.status, "running");
  await s2.until(started2.task_id);
});

test("start: --allow-dirty --mode readonly → failed", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  await assert.rejects(
    () => exec(process.execPath, [cli, "start", "--target", "codex", "--prompt", "hi", "--mode", "readonly", "--allow-dirty"], { cwd: s.cwd, env: s.env }),
    (error: unknown) => {
      const body = JSON.parse((error as { stdout: string }).stdout);
      assert.equal(body.status, "failed");
      assert.match(body.summary, /only for --mode write/);
      return true;
    },
  );
});

test("start: readonly on dirty tree → not blocked", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  fs.writeFileSync(path.join(s.cwd, "keep.txt"), "dirty\n");
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--mode", "readonly");
  assert.equal(started.status, "running");
  await s.until(started.task_id);
});

test("start: non-git write → warning each turn; reply keeps it", async (t) => {
  const s = sandbox(t);
  const started = await s.run("start", "--target", "codex", "--prompt", "hi");
  assert.equal(started.status, "running");
  const done = await s.until(started.task_id);
  assert.match(done.warning || "", /cannot be tracked/i);
  fs.writeFileSync(s.fixture, `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "BATON_RESULT\nsummary: again\nBATON_END" } })}\n`);
  const cont = await s.run("reply", started.task_id, "--prompt", "more");
  const done2 = await s.until(cont.task_id, (m) => m.status !== "running" && m.turn >= 2);
  assert.match(done2.warning || "", /cannot be tracked/i);
});

test("start: git write → no non-git warning", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  const started = await s.run("start", "--target", "codex", "--prompt", "hi");
  const done = await s.until(started.task_id);
  assert.doesNotMatch(done.warning || "", /cannot be tracked/i);
});

test("start: baton worktree add then start --cwd without flags → not blocked", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  const added = JSON.parse((await exec(process.execPath, [cli, "worktree", "add", "--name", "iso1"], { cwd: s.cwd, env: s.env, timeout: 8000 })).stdout) as { path: string };
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--cwd", added.path);
  assert.equal(started.status, "running");
  await s.until(started.task_id);
});

test("start: baton worktree with extra untracked → dirty_worktree", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  const added = JSON.parse((await exec(process.execPath, [cli, "worktree", "add", "--name", "iso2"], { cwd: s.cwd, env: s.env, timeout: 8000 })).stdout) as { path: string };
  fs.writeFileSync(path.join(added.path, "extra.txt"), "x\n");
  await assert.rejects(
    () => exec(process.execPath, [cli, "start", "--target", "codex", "--prompt", "hi", "--cwd", added.path], { cwd: s.cwd, env: s.env }),
    (error: unknown) => {
      const body = JSON.parse((error as { stdout: string }).stdout);
      assert.equal(body.status, "dirty_worktree");
      assert.ok(body.dirty_paths.includes("extra.txt"));
      assert.ok(!body.dirty_paths.includes(".baton-worktree.json"));
      return true;
    },
  );
});

test("start: .baton-worktree.json in main repo still counts as dirty", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  fs.writeFileSync(path.join(s.cwd, ".baton-worktree.json"), "{}\n");
  await assert.rejects(
    () => exec(process.execPath, [cli, "start", "--target", "codex", "--prompt", "hi"], { cwd: s.cwd, env: s.env }),
    (error: unknown) => {
      const body = JSON.parse((error as { stdout: string }).stdout);
      assert.equal(body.status, "dirty_worktree");
      assert.ok(body.dirty_paths.includes(".baton-worktree.json"));
      return true;
    },
  );
});

test("start: dirty_paths capped at 50", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(s.cwd, `f${String(i).padStart(2, "0")}.txt`), "x\n");
  await assert.rejects(
    () => exec(process.execPath, [cli, "start", "--target", "codex", "--prompt", "hi"], { cwd: s.cwd, env: s.env }),
    (error: unknown) => {
      const body = JSON.parse((error as { stdout: string }).stdout);
      assert.equal(body.status, "dirty_worktree");
      assert.equal(body.dirty_paths.length, 50);
      assert.equal(body.dirty_paths_truncated, true);
      return true;
    },
  );
});

test("start --isolate: worktree created; status reports worktree; main untouched", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  fs.writeFileSync(path.join(s.cwd, "keep.txt"), "dirty-main\n");
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--isolate");
  assert.equal(started.status, "running");
  assert.ok(started.worktree);
  assert.match(started.worktree!.path, /\.worktrees[\\/]task-[0-9a-f]{8}$/);
  assert.match(started.worktree!.branch, /^baton\/task-[0-9a-f]{8}$/);
  assert.equal(fs.realpathSync(started.worktree!.source_cwd), fs.realpathSync(s.cwd));
  assert.equal(fs.realpathSync(started.cwd), fs.realpathSync(started.worktree!.path));
  assert.equal(fs.readFileSync(path.join(s.cwd, "keep.txt"), "utf8"), "dirty-main\n");
  assert.equal(fs.readFileSync(path.join(started.cwd, "keep.txt"), "utf8"), "keep\n");
  await s.until(started.task_id);
});

test("start --isolate from subdirectory preserves relative cwd", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  const sub = path.join(s.cwd, "pkg");
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, "a.ts"), "a\n");
  execFileSync("git", ["add", "pkg"], { cwd: s.cwd });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "sub"], { cwd: s.cwd });
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--isolate", "--cwd", sub);
  assert.equal(started.status, "running");
  assert.equal(path.basename(started.cwd), "pkg");
  assert.ok(started.cwd.includes(`${path.sep}.worktrees${path.sep}`));
  assert.equal(fs.realpathSync(started.worktree!.source_cwd), fs.realpathSync(sub));
  await s.until(started.task_id);
});

test("start --isolate --mode readonly → failed", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  await assert.rejects(
    () => exec(process.execPath, [cli, "start", "--target", "codex", "--prompt", "hi", "--isolate", "--mode", "readonly"], { cwd: s.cwd, env: s.env }),
    (error: unknown) => {
      const body = JSON.parse((error as { stdout: string }).stdout);
      assert.equal(body.status, "failed");
      assert.match(body.summary, /only for --mode write/);
      return true;
    },
  );
});

test("start --isolate --allow-dirty → failed", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  await assert.rejects(
    () => exec(process.execPath, [cli, "start", "--target", "codex", "--prompt", "hi", "--isolate", "--allow-dirty"], { cwd: s.cwd, env: s.env }),
    (error: unknown) => {
      const body = JSON.parse((error as { stdout: string }).stdout);
      assert.equal(body.status, "failed");
      assert.match(body.summary, /cannot be combined/);
      return true;
    },
  );
});

test("start --isolate outside git → failed", async (t) => {
  const s = sandbox(t);
  await assert.rejects(
    () => exec(process.execPath, [cli, "start", "--target", "codex", "--prompt", "hi", "--isolate"], { cwd: s.cwd, env: s.env }),
    (error: unknown) => {
      const body = JSON.parse((error as { stdout: string }).stdout);
      assert.equal(body.status, "failed");
      assert.match(body.summary, /git/);
      return true;
    },
  );
});

test("start --isolate: ls from source lists task; reply stays in worktree", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--isolate");
  await s.until(started.task_id);
  const listed = await s.run<{ tasks: { task_id: string; cwd: string; worktree?: { path: string } }[] }>("ls");
  assert.ok(listed.tasks.some((row) => row.task_id === started.task_id));
  const wt = started.worktree!.path;
  fs.writeFileSync(s.fixture, `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "BATON_RESULT\nsummary: turn2\nBATON_END" } })}\n`);
  const cont = await s.run("reply", started.task_id, "--prompt", "more");
  const done = await s.until(cont.task_id, (m) => m.status !== "running" && m.turn >= 2);
  assert.equal(fs.realpathSync(done.cwd), fs.realpathSync(wt));
  assert.equal(done.worktree!.path, started.worktree!.path);
  assert.equal(done.worktree!.branch, started.worktree!.branch);
});

test("start --isolate inside linked worktree → failed", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  const added = JSON.parse((await exec(process.execPath, [cli, "worktree", "add", "--name", "nested"], { cwd: s.cwd, env: s.env, timeout: 8000 })).stdout) as { path: string };
  await assert.rejects(
    () => exec(process.execPath, [cli, "start", "--target", "codex", "--prompt", "hi", "--isolate", "--cwd", added.path], { cwd: s.cwd, env: s.env }),
    (error: unknown) => {
      const body = JSON.parse((error as { stdout: string }).stdout);
      assert.equal(body.status, "failed");
      assert.match(body.summary, /linked worktree|main repository/i);
      return true;
    },
  );
});
