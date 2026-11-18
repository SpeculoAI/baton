import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sandbox } from "./helpers.ts";

function cursorFixture(homeFixture: string) {
  fs.writeFileSync(
    homeFixture,
    `${JSON.stringify({ type: "system", subtype: "init", session_id: "cursor-sess-1", model: "Grok" })}\n` +
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } })}\n` +
      `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" })}\n`,
  );
}

test("cursor --model 写入 meta；reply 延续；argv 单 --model", async (t) => {
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

test("非 cursor 传 --model 拒绝", async (t) => {
  const s = sandbox(t);
  await assert.rejects(
    () => s.run("start", "--target", "codex", "--prompt", "hi", "--model", "grok-4.7-xhigh"),
    (err: NodeJS.ErrnoException & { stdout?: string }) => {
      const body = JSON.parse(err.stdout || "{}") as { summary?: string };
      assert.match(body.summary || "", /不支持 --model|cursor/i);
      return true;
    },
  );
});

test("cursor：已含档位的 model 再带 --effort 拒绝", async (t) => {
  const s = sandbox(t);
  cursorFixture(s.fixture);
  await assert.rejects(
    () => s.run("start", "--target", "cursor", "--prompt", "hi", "--model", "grok-4.7-xhigh", "--effort", "high"),
    (err: NodeJS.ErrnoException & { stdout?: string }) => {
      const body = JSON.parse(err.stdout || "{}") as { summary?: string };
      assert.match(body.summary || "", /档位|effort/i);
      return true;
    },
  );
});
