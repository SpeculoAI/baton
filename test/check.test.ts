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

// Checks run through the platform shell (sh, or cmd.exe on Windows), so build them from `node -e` instead of shell syntax.
const NODE = process.platform === "win32" ? '"%BATON_TEST_NODE%"' : '"$BATON_TEST_NODE"';
const js = (code: string) => `${NODE} -e "${code}"`;
const fileExists = (name: string) => js(`process.exitCode = require('fs').existsSync('${name}') ? 0 : 1`);
// Starts a 30s grandchild, records its pid in $CHECK_PID_FILE, then waits.
const holdChild = js("const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'});require('fs').writeFileSync(process.env.CHECK_PID_FILE,String(c.pid));setInterval(()=>{},1000)");

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
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", js("console.log('boom');process.stdout.write('x'.repeat(9000));process.exitCode=3"));
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
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", js("console.error('boom');process.exitCode=1"));
  const done = await s.until(started.task_id);
  assert.equal(done.status, "check_failed");
  assert.match(done.summary || "", /boom/);
  assert.match(done.check!.output_tail, /boom/);
});

test("--check runs in the task cwd", async (t) => {
  const s = sandbox(t);
  fs.writeFileSync(path.join(s.cwd, "marker"), "");
  const passed = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", fileExists("marker"));
  assert.equal((await s.until(passed.task_id)).check?.status, "passed");
  fs.rmSync(path.join(s.cwd, "marker"));
  const failed = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", fileExists("marker"));
  assert.equal((await s.until(failed.task_id)).status, "check_failed");
});

test("--check with --isolate runs in the worktree", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  fs.writeFileSync(path.join(s.cwd, "main-only.txt"), "untracked in the main tree\n");
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--isolate", "--check", js("const f=require('fs');process.exitCode=f.existsSync('keep.txt')&&!f.existsSync('main-only.txt')?0:1"));
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
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", fileExists("fixed"));
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

test("reply replaces, keeps, and clears the check command", async (t) => {
  const s = sandbox(t);
  const { task_id } = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", "exit 0");
  assert.equal((await s.until(task_id)).status, "success");

  await s.run("reply", task_id, "--prompt", "next", "--check", "  exit 7  ");
  const second = await s.until(task_id);
  assert.equal(second.check_command, "exit 7");
  assert.equal(second.status, "check_failed");
  assert.equal(second.check?.exit_code, 7);

  await s.run("reply", task_id, "--prompt", "continue");
  const third = await s.until(task_id);
  assert.equal(third.check_command, "exit 7");
  assert.equal(third.check?.exit_code, 7);

  await s.run("reply", task_id, "--prompt", "continue", "--check", "");
  const fourth = await s.until(task_id);
  assert.equal(fourth.status, "success");
  assert.equal("check_command" in fourth, false);
  assert.equal("check" in fourth, false);
});

test("while the check runs, the task is still running", async (t) => {
  const s = sandbox(t);
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", js("setTimeout(()=>{},1500)"));
  await s.until(started.task_id, () => s.events(started.task_id).some((e) => e.type === "check_started"));
  assert.equal((await s.run("status", started.task_id)).status, "running");
  assert.equal((await s.until(started.task_id)).status, "success");
});

test("--check idle timeout: check_failed / timed_out and the check process group is killed", async (t) => {
  const s = sandbox(t);
  const pidFile = path.join(s.home, "check.pid");
  s.env.CHECK_PID_FILE = pidFile;
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--idle-timeout", "1", "--check", holdChild);
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
  s.env.CHECK_PID_FILE = pidFile;
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--check", holdChild);
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
