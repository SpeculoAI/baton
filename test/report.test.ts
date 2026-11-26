import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildReport, sanitize, submitReport } from "../src/report.ts";
import { appendEvent, writeMeta, writeTurn } from "../src/store.ts";
import { cli, exec, sandbox } from "./helpers.ts";
import type { TaskMeta } from "../src/types.ts";

test("sanitize redacts env secrets and replaces cwd and home paths", () => {
  const prev = process.env.BATON_TEST_SECRET_TOKEN;
  process.env.BATON_TEST_SECRET_TOKEN = "super-secret-value-99";
  try {
    const fakeCwd = path.join(os.homedir(), "secret-project");
    const out = sanitize(`fail in ${fakeCwd}/a.ts with super-secret-value-99 and ${os.homedir()}/other`, fakeCwd);
    assert.ok(!out.includes("super-secret-value-99"));
    assert.ok(!out.includes("secret-project"));
    assert.ok(out.includes("<cwd>/a.ts"));
    assert.ok(out.includes("[REDACTED]"));
    assert.ok(out.includes("~/other"));
  } finally {
    if (prev === undefined) delete process.env.BATON_TEST_SECRET_TOKEN;
    else process.env.BATON_TEST_SECRET_TOKEN = prev;
  }
});

test("buildReport with task_id keeps strict whitelist and omits prompts, business summaries, raw logs, and paths", (t) => {
  const s = sandbox(t);
  const prevHome = process.env.BATON_HOME;
  process.env.BATON_HOME = s.home;
  t.after(() => {
    if (prevHome === undefined) delete process.env.BATON_HOME;
    else process.env.BATON_HOME = prevHome;
  });

  const failedId = randomUUID();
  const now = new Date().toISOString();
  const failedMeta: TaskMeta = {
    task_id: failedId,
    target: "codex",
    cwd: s.cwd,
    created_at: now,
    updated_at: now,
    status: "failed",
    turn: 1,
    session_id: "sess-1",
    mode: "write",
    enforcement: "agent-enforced",
    idle_timeout_s: 600,
    max_duration_s: null,
    supervisor_pid: null,
    child_pid: null,
    heartbeat_at: now,
    last_event_at: now,
    summary: `supervisor failed in ${s.cwd} with Bearer abc.def.ghi\nsecond line detail`,
  };
  writeMeta(failedMeta);
  writeTurn(failedId, { turn: 1, author: "host", prompt: "TOP_SECRET_PROMPT_TEXT", status: "failed", summary: failedMeta.summary });
  fs.writeFileSync(path.join(s.dir(failedId), "raw", "1.stdout.log"), "RAW_LOG_SHOULD_NEVER_APPEAR\n");
  appendEvent(failedId, { ts: now, turn: 1, type: "message", text: "ASSISTANT_MESSAGE_SHOULD_NEVER_APPEAR" });
  appendEvent(failedId, { ts: now, turn: 1, type: "tool_call", name: "bash", detail: "SECRET_TOOL_ARG" });
  appendEvent(failedId, { ts: now, turn: 1, type: "error", text: `boom at ${s.cwd}/secret.ts` });
  appendEvent(failedId, { ts: now, turn: 1, type: "turn_ended", status: "failed", exit_code: 1 });

  const rep = buildReport(failedId);
  assert.equal(rep.title, "bug(codex): failed");
  assert.match(rep.markdown, /Review before posting/);
  assert.match(rep.markdown, /- target: codex/);
  assert.match(rep.markdown, /- status: failed/);
  assert.match(rep.markdown, /supervisor failed in <cwd> with Bearer \[REDACTED\]/);
  assert.match(rep.markdown, /t1 error boom at <cwd>\/secret\.ts/);
  assert.match(rep.markdown, /t1 turn_ended status=failed exit=1/);
  assert.ok(!rep.markdown.includes("TOP_SECRET_PROMPT_TEXT"));
  assert.ok(!rep.markdown.includes("RAW_LOG_SHOULD_NEVER_APPEAR"));
  assert.ok(!rep.markdown.includes("ASSISTANT_MESSAGE_SHOULD_NEVER_APPEAR"));
  assert.ok(!rep.markdown.includes("SECRET_TOOL_ARG"));
  assert.ok(!rep.markdown.includes(s.cwd));
  assert.ok(!rep.markdown.includes("second line detail"));
  assert.ok(rep.issueUrl.startsWith("https://github.com/SpeculoAI/baton/issues/new?"));

  // Business summary on a success task must be omitted.
  const okId = randomUUID();
  writeMeta({ ...failedMeta, task_id: okId, status: "success", summary: "Refactored Acme Corp billing checkout" });
  const okRep = buildReport(okId);
  assert.ok(!okRep.markdown.includes("Acme Corp"));
  assert.ok(!okRep.markdown.includes("- summary:"));
});

test("submitReport uses gh when authenticated, and falls back to browser or url otherwise", () => {
  const sample = { title: "bug: sample", markdown: "body text", issueUrl: "https://github.com/SpeculoAI/baton/issues/new?title=bug" };

  // Authenticated gh path
  const calls: [string, readonly string[] | undefined][] = [];
  const ghRes = submitReport(sample, {
    spawnSync: ((cmd: string, args?: readonly string[]) => {
      calls.push([cmd, args]);
      if (args?.[0] === "auth") return { status: 0, stdout: "", stderr: "" } as ReturnType<typeof import("cross-spawn").sync>;
      return { status: 0, stdout: "https://github.com/SpeculoAI/baton/issues/999\n", stderr: "" } as ReturnType<typeof import("cross-spawn").sync>;
    }) as typeof import("cross-spawn").sync,
    openBrowser: () => { throw new Error("should not open browser when gh succeeds"); },
  });
  assert.deepEqual(ghRes, { method: "gh", url: "https://github.com/SpeculoAI/baton/issues/999", submitted: true });
  assert.equal(calls.length, 2);

  // Unauthenticated gh -> browser fallback
  let openedUrl = "";
  const browserRes = submitReport(sample, {
    spawnSync: (() => ({ status: 1, stdout: "", stderr: "" }) as ReturnType<typeof import("cross-spawn").sync>) as typeof import("cross-spawn").sync,
    openBrowser: (url) => { openedUrl = url; return true; },
  });
  assert.deepEqual(browserRes, { method: "browser", url: sample.issueUrl, submitted: false });
  assert.equal(openedUrl, sample.issueUrl);

  // Browser unavailable -> url fallback
  const urlRes = submitReport(sample, {
    spawnSync: (() => ({ status: 1, stdout: "", stderr: "" }) as ReturnType<typeof import("cross-spawn").sync>) as typeof import("cross-spawn").sync,
    openBrowser: () => false,
  });
  assert.deepEqual(urlRes, { method: "url", url: sample.issueUrl, submitted: false });
});

test("CLI baton report prints markdown and issue url without task_id, and rejects unknown task_id", async (t) => {
  const s = sandbox(t);
  const { stdout } = await exec(process.execPath, [cli, "report", "--title", "bug: custom"], { cwd: s.cwd, env: s.env, timeout: 15_000 });
  assert.match(stdout, /### Environment/);
  assert.match(stdout, /Open issue: https:\/\/github\.com\/SpeculoAI\/baton\/issues\/new\?/);
  assert.match(stdout, /title=bug%3A\+custom/);

  await assert.rejects(
    exec(process.execPath, [cli, "report", randomUUID()], { cwd: s.cwd, env: s.env, timeout: 15_000 }),
    (error: { stdout: string }) => /No such task/.test(JSON.parse(error.stdout).summary),
  );
});
