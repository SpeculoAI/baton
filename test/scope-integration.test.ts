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
  assert.match(done.summary || "", /scope_violation: see scope_violations/);
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
      assert.match(body.summary || "", /git|HEAD|repo/i);
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

test("reply replaces scope and baseline, then keeps them across turns", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  s.env.FAKE_WRITE = "keep.txt";
  const { task_id } = await s.run("start", "--target", "codex", "--prompt", "hi", "--scope", "keep.txt");
  const first = await s.until(task_id);
  assert.equal(first.status, "success");

  s.env.FAKE_WRITE = "next.txt";
  s.env.FAKE_INPUT_FILE = path.join(s.home, "prompt.txt");
  await s.run("reply", task_id, "--prompt", "next", "--scope", " next.txt ", "--scope", "extra/**", "--scope-on-violation", "fail");
  const second = await s.until(task_id);
  assert.equal(second.status, "success");
  assert.deepEqual(second.scope_violations ?? [], []);
  assert.deepEqual(second.scope, ["next.txt", "extra/**"]);
  assert.equal(second.scope_on_violation, "fail");
  assert.notDeepEqual(second.scope_baseline, first.scope_baseline);
  assert.match(fs.readFileSync(s.env.FAKE_INPUT_FILE, "utf8"), /^\[Baton scope\] Only modify these paths \(post-check enforced\): next\.txt, extra\/\*\*\n\nnext/);

  s.env.FAKE_WRITE = "keep.txt";
  s.env.FAKE_WRITE_CONTENT = "changed again";
  await s.run("reply", task_id, "--prompt", "continue");
  const third = await s.until(task_id);
  assert.equal(third.status, "scope_violation");
  assert.deepEqual(third.scope_violations, ["keep.txt"]);
  assert.deepEqual(third.scope, second.scope);
  assert.equal(third.scope_on_violation, "fail");
  assert.deepEqual(third.scope_baseline, second.scope_baseline);

  await s.run("reply", task_id, "--prompt", "continue", "--scope-on-violation", "warn");
  const fourth = await s.until(task_id);
  assert.equal(fourth.status, "success");
  assert.deepEqual(fourth.scope_violations, ["keep.txt"]);
  assert.equal(fourth.scope_on_violation, "warn");
  assert.deepEqual(fourth.scope_baseline, second.scope_baseline);
});

test("reply rejects invalid scope updates without starting a turn", async (t) => {
  const s = sandbox(t);
  const { task_id } = await s.run("start", "--target", "codex", "--prompt", "hi");
  await s.until(task_id);
  for (const [flags, message] of [
    [["--scope", "keep.txt"], "With --scope, cwd must be a git repository (HEAD baseline required)."],
    [["--scope-on-violation", "fail"], "--scope-on-violation cannot be used without --scope."],
    [["--scope-on-violation", ""], "scope-on-violation must be warn or fail."],
    [["--scope", ""], "scope must not be empty."],
    [["--scope", "keep.txt", "--scope", " "], "scope must not be empty."],
    [["--scope", "!foo"], "scope does not support ! negation patterns."],
  ] as const) {
    await assert.rejects(s.run("reply", task_id, "--prompt", "next", ...flags), (err: { stdout: string }) => {
      assert.equal(JSON.parse(err.stdout).summary, message);
      return true;
    });
  }
  assert.equal(s.meta(task_id).turn, 1);
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
