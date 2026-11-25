import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox } from "./helpers.ts";

function cursorFixture(homeFixture: string) {
  fs.writeFileSync(
    homeFixture,
    `${JSON.stringify({ type: "system", subtype: "init", session_id: "cursor-sess-1", model: "Grok" })}\n` +
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } })}\n` +
      `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" })}\n`,
  );
}

test("cursor --model is written to meta; reply continues it; argv has a single --model", async (t) => {
  const s = sandbox(t);
  cursorFixture(s.fixture);
  const started = await s.run(
    "start", "--target", "cursor", "--prompt", "hi",
    "--model", "grok-4.7-xhigh",
  );
  assert.equal(started.status, "running");
  assert.equal(started.model, "grok-4.7-xhigh");
  assert.equal(started.model_argv, "grok-4.7-xhigh");
  const done = await s.until(started.task_id);
  assert.equal(done.status, "success");
  assert.equal(done.model, "grok-4.7-xhigh");
  assert.equal(done.model_argv, "grok-4.7-xhigh");
  const again = await s.run("reply", started.task_id, "--prompt", "more");
  assert.equal(again.status, "running");
  assert.equal(s.meta(started.task_id).model, "grok-4.7-xhigh");
  await s.until(started.task_id);
});

test("codex --model is written to meta and kept across reply", async (t) => {
  const s = sandbox(t);
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--model", "gpt-6.2-sol", "--effort", "high");
  assert.equal(started.model, "gpt-6.2-sol");
  assert.equal(started.model_argv, "gpt-6.2-sol");
  const done = await s.until(started.task_id);
  assert.equal(done.status, "success");
  assert.equal(done.model_argv, "gpt-6.2-sol");
  const argsFile = path.join(s.home, "args.txt");
  s.env.FAKE_ARGS_FILE = argsFile;
  await s.run("reply", started.task_id, "--prompt", "more");
  const again = await s.until(started.task_id, (m) => m.turn === 2 && m.status !== "running");
  const argv = fs.readFileSync(argsFile, "utf8").split("\n");
  assert.deepEqual(argv.slice(0, 2), ["exec", "resume"]);
  assert.equal(argv[argv.indexOf("-m") + 1], "gpt-6.2-sol");
  assert.equal(again.model, "gpt-6.2-sol");
  assert.equal(again.model_argv, "gpt-6.2-sol");
});

function claudeFixture(homeFixture: string) {
  fs.writeFileSync(
    homeFixture,
    `${JSON.stringify({ type: "system", subtype: "init", session_id: "claude-sess-1", model: "claude-sonnet-5-5" })}\n` +
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } })}\n` +
      `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" })}\n`,
  );
}

test("claude --model is passed on every turn (resume does not remember it) and kept in meta", async (t) => {
  const s = sandbox(t);
  claudeFixture(s.fixture);
  const argsFile = path.join(s.home, "args.txt");
  s.env.FAKE_ARGS_FILE = argsFile;
  const started = await s.run("start", "--target", "claude", "--prompt", "hi", "--model", " sonnet ");
  assert.equal(started.model, "sonnet");
  assert.equal(started.model_argv, "sonnet");
  const done = await s.until(started.task_id);
  assert.equal(done.status, "success");
  assert.equal(done.model_argv, "sonnet");
  let argv = fs.readFileSync(argsFile, "utf8").trimEnd().split("\n");
  assert.equal(argv.filter((a) => a === "--model").length, 1);
  assert.equal(argv[argv.indexOf("--model") + 1], "sonnet");
  await s.run("reply", started.task_id, "--prompt", "more");
  const again = await s.until(started.task_id, (m) => m.turn === 2 && m.status !== "running");
  argv = fs.readFileSync(argsFile, "utf8").trimEnd().split("\n");
  assert.equal(argv[argv.indexOf("--resume") + 1], "claude-sess-1");
  assert.equal(argv[argv.indexOf("--model") + 1], "sonnet");
  assert.ok(argv.indexOf("--model") < argv.indexOf("--resume"));
  assert.equal(again.model, "sonnet");
  assert.equal(again.model_argv, "sonnet");
});

test("claude --model combines with --effort; without --model no model is passed or stored", async (t) => {
  const s = sandbox(t);
  claudeFixture(s.fixture);
  const argsFile = path.join(s.home, "args.txt");
  s.env.FAKE_ARGS_FILE = argsFile;
  const both = await s.run("start", "--target", "claude", "--prompt", "hi", "--model", "opus", "--effort", "high");
  await s.until(both.task_id);
  let argv = fs.readFileSync(argsFile, "utf8").trimEnd().split("\n");
  assert.equal(argv[argv.indexOf("--model") + 1], "opus");
  assert.equal(argv[argv.indexOf("--effort") + 1], "high");
  const plain = await s.run("start", "--target", "claude", "--prompt", "hi");
  const done = await s.until(plain.task_id);
  argv = fs.readFileSync(argsFile, "utf8").trimEnd().split("\n");
  assert.equal(argv.includes("--model"), false);
  assert.equal("model" in done, false);
  assert.equal("model_argv" in done, false);
});

test("--model on a target without model support is rejected", async (t) => {
  const s = sandbox(t);
  await assert.rejects(
    () => s.run("start", "--target", "agy", "--prompt", "hi", "--model", "grok-4.7-xhigh"),
    (err: NodeJS.ErrnoException & { stdout?: string }) => {
      const body = JSON.parse(err.stdout || "{}") as { summary?: string };
      assert.match(body.summary || "", /not support --model/i);
      return true;
    },
  );
});

test("cursor: --effort fails fast at start, with or without --model", async (t) => {
  const s = sandbox(t);
  cursorFixture(s.fixture);
  await assert.rejects(
    () => s.run("start", "--target", "cursor", "--prompt", "hi", "--effort", "high"),
    (err: NodeJS.ErrnoException & { stdout?: string }) => {
      const body = JSON.parse(err.stdout || "{}") as { summary?: string };
      assert.match(body.summary || "", /does not support --effort/);
      return true;
    },
  );
  await assert.rejects(
    () => s.run("start", "--target", "cursor", "--prompt", "hi", "--model", "grok-4.7-xhigh", "--effort", "high"),
    (err: NodeJS.ErrnoException & { stdout?: string }) => {
      const body = JSON.parse(err.stdout || "{}") as { summary?: string };
      assert.match(body.summary || "", /does not support --effort/);
      return true;
    },
  );
});
