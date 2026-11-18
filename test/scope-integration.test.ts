import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sandbox } from "./helpers.ts";

function gitInit(cwd: string) {
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init"]);
  fs.writeFileSync(path.join(cwd, "keep.txt"), "keep\n");
  git(["add", "keep.txt"]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init"]);
}

test("scope warn: success + scope_violations", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  s.env.FAKE_WRITE = "leak.txt";
  const started = await s.run(
    "start", "--target", "codex", "--prompt", "hi",
    "--scope", "keep.txt", "--scope-on-violation", "warn",
  );
  assert.equal(started.status, "running");
  assert.ok(started.scope_baseline?.head);
  const done = await s.until(started.task_id);
  assert.equal(done.status, "success");
  assert.ok(done.scope_violations?.includes("leak.txt"));
  assert.match(done.warning || "", /scope_violation/);
});

test("scope fail: success → scope_violation", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  s.env.FAKE_WRITE = "leak.txt";
  const started = await s.run(
    "start", "--target", "codex", "--prompt", "hi",
    "--scope", "src/**", "--scope-on-violation", "fail",
  );
  const done = await s.until(started.task_id);
  assert.equal(done.status, "scope_violation");
  assert.ok(done.scope_violations?.includes("leak.txt"));
  assert.match(done.summary || "", /scope_violation: 见 scope_violations/);
});

test("scope: in-scope write → no violations", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  s.env.FAKE_WRITE = "keep.txt";
  s.env.FAKE_WRITE_CONTENT = "keep\nedited\n";
  const started = await s.run(
    "start", "--target", "codex", "--prompt", "hi",
    "--scope", "keep.txt", "--scope-on-violation", "fail",
  );
  const done = await s.until(started.task_id);
  assert.equal(done.status, "success");
  assert.deepEqual(done.scope_violations ?? [], []);
});

test("scope without git repo rejected", async (t) => {
  const s = sandbox(t);
  await assert.rejects(
    () => s.run("start", "--target", "codex", "--prompt", "hi", "--scope", "a/**"),
    (err: NodeJS.ErrnoException & { stdout?: string }) => {
      const body = JSON.parse(err.stdout || "{}") as { summary?: string };
      assert.match(body.summary || "", /git|HEAD|仓库/i);
      return true;
    },
  );
});

test("scope: gitignored write not in violations", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  fs.writeFileSync(path.join(s.cwd, ".gitignore"), "secret.bin\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: s.cwd });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "ignore"], { cwd: s.cwd });
  s.env.FAKE_WRITE = "secret.bin";
  const started = await s.run(
    "start", "--target", "codex", "--prompt", "hi",
    "--scope", "keep.txt", "--scope-on-violation", "fail",
  );
  const done = await s.until(started.task_id);
  assert.equal(done.status, "success");
  assert.equal((done.scope_violations ?? []).includes("secret.bin"), false);
});

test("scope: rework restore clears violations", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  s.env.FAKE_WRITE = "leak.txt";
  const started = await s.run(
    "start", "--target", "codex", "--prompt", "hi",
    "--scope", "keep.txt", "--scope-on-violation", "fail",
  );
  const first = await s.until(started.task_id);
  assert.equal(first.status, "scope_violation");
  fs.rmSync(path.join(s.cwd, "leak.txt"), { force: true });
  delete s.env.FAKE_WRITE;
  const again = await s.run("reply", started.task_id, "--prompt", "restore");
  assert.equal(again.status, "running");
  const second = await s.until(started.task_id);
  assert.equal(second.status, "success");
  assert.deepEqual(second.scope_violations ?? [], []);
});

test("scope: cwd subdirectory maps paths; outside is violation", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  const sub = path.join(s.cwd, "pkg");
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, "in.ts"), "in\n");
  execFileSync("git", ["add", "pkg/in.ts"], { cwd: s.cwd });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "pkg"], { cwd: s.cwd });
  s.env.FAKE_WRITE = path.join("..", "leak-root.txt");
  // Fake writes relative to task cwd=sub → creates s.cwd/leak-root.txt
  const started = await s.run(
    "start", "--target", "codex", "--prompt", "hi", "--cwd", sub,
    "--scope", "in.ts", "--scope-on-violation", "fail",
  );
  const done = await s.until(started.task_id);
  assert.equal(done.status, "scope_violation");
  assert.ok((done.scope_violations ?? []).some((p) => p.includes("..") || p.includes("leak-root")));
});
