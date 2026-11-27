import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sandbox } from "./helpers.ts";

// Same prompt as prompt-stdin.test.ts: newlines plus everything cmd.exe or a shell treats specially.
const PROMPT = "first line\nsecond & | > < ^ \" % ! ( ) line\n  indented 'single' `tick` $HOME\nlast line";
const REPLY = "BATON_RESULT\nsummary: kimi ok\nBATON_END";
// The Windows fake is kimi.cmd, which assertArgvSafe refuses for every prompt (the output contract is multi-line).
// The refusal has its own win32 test below; the rest runs where the fake can actually start.
const RUNS_FAKE = { skip: process.platform === "win32" ? "kimi.cmd is refused on Windows by design" : false };

function kimiOutput(file: string, reply = REPLY) {
  fs.writeFileSync(file,
    `${JSON.stringify({ role: "meta", type: "system.version", version: "2.8.0" })}\n` +
    `${JSON.stringify({ role: "assistant", tool_calls: [{ type: "function", id: "t1", function: { name: "Bash", arguments: JSON.stringify({ command: "ls" }) } }] })}\n` +
    `${JSON.stringify({ role: "tool", tool_call_id: "t1", content: "a.txt\n" })}\n` +
    `${JSON.stringify({ role: "assistant", content: reply })}\n` +
    `${JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "session_fake-1" })}\n`);
}

function gitInit(cwd: string) {
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init"]);
  fs.writeFileSync(path.join(cwd, "keep.txt"), "keep\n");
  git(["add", "keep.txt"]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init"]);
}

test("kimi: start → wait → success; the last reply, tool events and session id are recorded", RUNS_FAKE, async (t) => {
  const s = sandbox(t);
  kimiOutput(s.fixture);
  const started = await s.run("start", "--target", "kimi", "--prompt", "hi");
  const done = await s.until(started.task_id);
  assert.equal(done.status, "success");
  assert.equal(done.session_id, "session_fake-1");
  assert.match(done.summary || "", /kimi ok/);
  assert.equal(s.turn(started.task_id).final_message, REPLY);
  assert.deepEqual(s.events(started.task_id).filter((e) => e.type === "tool_call" || e.type === "tool_result").map((e) => e.type), ["tool_call", "tool_result"]);
});

if (process.platform !== "win32") {
  test("kimi: the prompt reaches the worker in argv byte for byte, right after -p", async (t) => {
    const s = sandbox(t);
    kimiOutput(s.fixture);
    s.env.FAKE_ARGS_FILE = path.join(s.home, "args.txt");
    const started = await s.run("start", "--target", "kimi", "--prompt", PROMPT);
    assert.equal((await s.until(started.task_id)).status, "success");
    // fake.mjs writes one argument per line; baton appends its result contract after the user's text.
    assert.ok(fs.readFileSync(s.env.FAKE_ARGS_FILE, "utf8").startsWith(`-p\n${PROMPT}\n\n`), "prompt changed on the way");
  });
} else {
  test("kimi on Windows: a .cmd shim refuses the multi-line prompt before spawn and says why", async (t) => {
    const s = sandbox(t);
    kimiOutput(s.fixture);
    s.env.FAKE_ARGS_FILE = path.join(s.home, "args.txt");
    const started = await s.run("start", "--target", "kimi", "--prompt", PROMPT);
    const done = await s.until(started.task_id);
    assert.equal(done.status, "failed");
    assert.match(done.summary || "", /kimi\.cmd is a \.cmd\/\.bat shim/i);
    assert.match(done.summary || "", /install\.ps1/);
    assert.ok(!fs.existsSync(s.env.FAKE_ARGS_FILE), "the worker must not start");
  });
}

test("kimi readonly: needs --allow-weak; a write is then caught as readonly_violation", RUNS_FAKE, async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  kimiOutput(s.fixture);
  await assert.rejects(
    () => s.run("start", "--target", "kimi", "--prompt", "hi", "--mode", "readonly"),
    (err: { stdout?: string }) => {
      assert.match(JSON.parse(err.stdout || "{}").summary || "", /kimi cannot enforce read-only; add --allow-weak to allow it\./);
      return true;
    },
  );
  s.env.FAKE_WRITE = "leak.txt";
  const started = await s.run("start", "--target", "kimi", "--prompt", "hi", "--mode", "readonly", "--allow-weak");
  assert.equal(started.enforcement, "none");
  assert.equal((await s.until(started.task_id)).status, "readonly_violation");
});

test("kimi: the no-model / not-logged-in error is not_authenticated; --effort leaves a warning", RUNS_FAKE, async (t) => {
  const s = sandbox(t);
  fs.writeFileSync(s.fixture, "error: failed to run prompt: No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml.\n");
  s.env.FAKE_EXIT = "1";
  const denied = await s.run("start", "--target", "kimi", "--prompt", "hi");
  assert.equal((await s.until(denied.task_id)).status, "not_authenticated");

  kimiOutput(s.fixture);
  s.env.FAKE_EXIT = "0";
  const effort = await s.run("start", "--target", "kimi", "--prompt", "hi", "--effort", "high");
  const done = await s.until(effort.task_id);
  assert.equal(done.status, "success");
  assert.match(done.warning || "", /--effort high was ignored/);
});
