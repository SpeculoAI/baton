import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sandbox } from "./helpers.ts";
import { isAlive } from "../src/process.ts";

function gitInit(cwd: string) {
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(cwd, "keep.txt"), "keep\n");
  git(["add", "keep.txt"]);
  git(["commit", "-m", "init"]);
}

const checkEvents = (events: { type: string }[]) => events.filter((e) => e.type === "check_started" || e.type === "check_ended");

test("--check passing: success, check recorded on meta and turn, check events emitted", async (t) => {
  const s = sandbox(t);
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", "  exit 0  ");
  assert.equal(started.check_command, "exit 0");
  const done = await s.until(started.task_id);
  assert.equal(done.status, "success");
  assert.equal(done.check?.status, "passed");
  assert.equal(done.check?.exit_code, 0);
  assert.equal(typeof done.check?.duration_ms, "number");
  assert.deepEqual(s.turn(started.task_id).check, done.check);
  const events = checkEvents(s.events(started.task_id));
  assert.deepEqual(events.map((e) => e.type), ["check_started", "check_ended"]);
  assert.equal((events[1] as { status?: string }).status, "passed");
});

test("--check failing: check_failed with exit code, output tail in summary and raw log", async (t) => {
  const s = sandbox(t);
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", "echo boom; head -c 9000 /dev/zero | tr '\\0' x; exit 3");
  const done = await s.until(started.task_id);
  assert.equal(done.status, "check_failed");
  assert.equal(done.check?.status, "failed");
  assert.equal(done.check?.exit_code, 3);
  assert.ok(done.check!.output_tail.length <= 4000);
  assert.match(done.summary || "", /^check_failed: exit 3\n/);
  assert.equal(s.turn(started.task_id).status, "check_failed");
  assert.match(fs.readFileSync(path.join(s.dir(started.task_id), "raw", "1.check.log"), "utf8"), /^boom\n/);
  const ended = s.events(started.task_id).filter((e) => e.type === "turn_ended");
  assert.equal(ended.length, 1);
  assert.equal((ended[0] as { status?: string }).status, "check_failed");
});

test("--check output tail keeps the failure text", async (t) => {
  const s = sandbox(t);
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", "echo boom >&2; exit 1");
  const done = await s.until(started.task_id);
  assert.equal(done.status, "check_failed");
  assert.match(done.summary || "", /boom/);
  assert.match(done.check!.output_tail, /boom/);
});

test("--check runs in the task cwd", async (t) => {
  const s = sandbox(t);
  fs.writeFileSync(path.join(s.cwd, "marker"), "");
  const passed = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", "test -f marker");
  assert.equal((await s.until(passed.task_id)).check?.status, "passed");
  fs.rmSync(path.join(s.cwd, "marker"));
  const failed = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", "test -f marker");
  assert.equal((await s.until(failed.task_id)).status, "check_failed");
});

test("--check with --isolate runs in the worktree", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  fs.writeFileSync(path.join(s.cwd, "main-only.txt"), "untracked in the main tree\n");
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--isolate", "--check", "test -f keep.txt && test ! -f main-only.txt");
  const done = await s.until(started.task_id);
  assert.equal(done.check?.status, "passed");
  assert.equal(done.status, "success");
});

test("--check does not run when the worker turn did not succeed", async (t) => {
  const s = sandbox(t);
  s.env.FAKE_EXIT = "1";
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", "exit 0");
  const done = await s.until(started.task_id);
  assert.equal(done.status, "failed");
  assert.equal("check" in done, false);
  assert.equal("check" in s.turn(started.task_id), false);
  assert.deepEqual(checkEvents(s.events(started.task_id)), []);
});

test("without --check nothing changes", async (t) => {
  const s = sandbox(t);
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", "   ");
  const done = await s.until(started.task_id);
  assert.equal(done.status, "success");
  assert.equal("check_command" in done, false);
  assert.equal("check" in done, false);
  assert.deepEqual(checkEvents(s.events(started.task_id)), []);
  assert.equal(fs.existsSync(path.join(s.dir(started.task_id), "raw", "1.check.log")), false);
});

test("reply after check_failed reruns the check; each turn keeps its own result", async (t) => {
  const s = sandbox(t);
  const flag = path.join(s.cwd, "fixed");
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", "test -f fixed");
  assert.equal((await s.until(started.task_id)).status, "check_failed");
  fs.writeFileSync(flag, "");
  s.env.FAKE_SLEEP = "0.5";
  const again = await s.run("reply", started.task_id, "--prompt", "fix it");
  assert.equal(again.status, "running");
  assert.equal("check" in s.meta(started.task_id), false);
  const done = await s.until(started.task_id, (m) => m.turn === 2 && m.status !== "running");
  assert.equal(done.status, "success");
  assert.equal(done.check?.status, "passed");
  assert.equal(s.turn(started.task_id, 1).check?.status, "failed");
  assert.equal(s.turn(started.task_id, 2).check?.status, "passed");
});

test("while the check runs, the task is still running", async (t) => {
  const s = sandbox(t);
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", "sleep 1.5");
  await s.until(started.task_id, () => s.events(started.task_id).some((e) => e.type === "check_started"));
  assert.equal((await s.run("status", started.task_id)).status, "running");
  assert.equal((await s.until(started.task_id)).status, "success");
});

test("--check idle timeout: check_failed / timed_out and the check process group is killed", async (t) => {
  const s = sandbox(t);
  const pidFile = path.join(s.home, "check.pid");
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--idle-timeout", "1", "--check", `sleep 30 & echo $! > ${pidFile}; wait`);
  const done = await s.until(started.task_id, undefined, 8000);
  assert.equal(done.status, "check_failed");
  assert.equal(done.check?.status, "timed_out");
  assert.match(done.summary || "", /^check_failed: timed out/);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  await s.until(started.task_id, () => !isAlive(pid), 3000);
});

test("cancel during the check: cancelled, check killed, one turn_ended", async (t) => {
  const s = sandbox(t);
  const pidFile = path.join(s.home, "check.pid");
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", `sleep 30 & echo $! > ${pidFile}; wait`);
  await s.until(started.task_id, () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "");
  await s.run("cancel", started.task_id);
  const done = await s.until(started.task_id);
  assert.equal(done.status, "cancelled");
  assert.equal(done.summary, "Cancelled.");
  assert.equal(done.check?.status, undefined);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  await s.until(started.task_id, () => !isAlive(pid), 3000);
  assert.equal(s.events(started.task_id).filter((e) => e.type === "turn_ended").length, 1);
});
