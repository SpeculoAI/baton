import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { codex } from "../src/adapters/codex.ts";
import { which, authHit } from "../src/adapters/common.ts";
import { getAdapter } from "../src/adapters/index.ts";
import { unseenRules } from "../src/rules.ts";

test("codex fixture parses messages, commands, file changes and failures; unknown lines are not dropped", () => {
  const lines = fs.readFileSync(new URL("fixtures/codex.stream.jsonl", import.meta.url), "utf8").trim().split("\n");
  assert.equal(codex.sessionIdFrom(lines[0]), "thread-fake-1");
  const events = lines.flatMap((line) => codex.parseLine(line) ?? []);
  assert.deepEqual(events.map((event) => event.type), ["tool_call", "tool_result", "tool_call", "tool_result", "message", "error"]);
  assert.ok(events.some((event) => event.type === "message" && event.text.includes("BATON_RESULT")));
  assert.ok(events.some((event) => event.type === "tool_result" && event.ok));
  for (const line of ["bad json", "null", "{}", '{"type":"item.completed","item":{}}']) assert.equal(codex.parseLine(line), null);
  const long = codex.parseLine(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "x".repeat(300) } }));
  assert.ok(long?.[0].type === "tool_call");
  assert.equal(long[0].detail.length, 200);
  assert.equal(codex.sessionIdFrom("no JSON"), null);
  assert.equal(codex.isAuthFailure("Please log in"), true);
});

test("codex 0.167.0 real output: lifecycle events are silent, error items become error, no raw kept", () => {
  const lines = fs.readFileSync(new URL("fixtures/codex-0.167.0.stream.jsonl", import.meta.url), "utf8").trim().split("\n");
  for (const line of lines) assert.notEqual(codex.parseLine(line), null, line);
  const events = lines.flatMap((line) => codex.parseLine(line) ?? []);
  assert.deepEqual(events.map((e) => e.type), ["error", "error", "message"]);
});

function fixture(name: string): string[] {
  return fs.readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8").trim().split("\n");
}

test("cursor real stream-json: session, tools, messages; thinking deltas emit no events; no raw kept", () => {
  const cursor = getAdapter("cursor")!;
  const lines = fixture("cursor-2026.11.11.stream.jsonl");
  assert.equal(cursor.sessionIdFrom(lines[0]), "ac43faa4-c292-43be-83ce-3dca1fa125cf");
  for (const line of lines) assert.notEqual(cursor.parseLine(line), null, line);
  const events = lines.flatMap((line) => cursor.parseLine(line) ?? []);
  assert.deepEqual(events.map((e) => e.type), ["message", "tool_call", "tool_result", "message"]);
  assert.deepEqual(events[2], { ...events[2], name: "shell", ok: true, detail: "cat a.txt" });
  const last = events.at(-1);
  assert.equal(last?.type === "message" && last.text, "hi");
  assert.deepEqual(cursor.build({ bin: "c", cwd: "/w", prompt: "p", sessionId: "s1", reasoningEffort: null, model: null }).args,
    ["--print", "--force", "--trust", "--output-format", "stream-json", "--workspace", "/w", "--resume", "s1", "p"]);
  assert.deepEqual(cursor.build({ bin: "c", cwd: "/w", prompt: "p", sessionId: null, reasoningEffort: null, model: "grok-4.7-xhigh" }).args,
    ["--print", "--force", "--trust", "--output-format", "stream-json", "--workspace", "/w", "--model", "grok-4.7-xhigh", "p"]);
});

test("agy real stream-json: tool steps are paired; the full reply comes from result only once; no raw kept", () => {
  const agy = getAdapter("agy")!;
  const lines = fixture("agy-1.5.6.stream.jsonl");
  assert.equal(agy.sessionIdFrom(lines[0]), "9c0bfa4e-4c5c-4b0c-bd90-ff90c173e27c");
  for (const line of lines) assert.notEqual(agy.parseLine(line), null, line);
  const events = lines.flatMap((line) => agy.parseLine(line) ?? []);
  assert.deepEqual(events.map((e) => e.type), ["tool_call", "tool_result", "message"]);
  assert.equal(events[2].type === "message" && events[2].text, "hi\n");
  const failed = agy.parseLine(JSON.stringify({ event: "result", result: { status: "ERROR", response: "boom" } }));
  assert.deepEqual(failed?.map((e) => e.type), ["error"]);
  assert.deepEqual(agy.build({ bin: "a", cwd: "/w", prompt: "p", sessionId: "c1", reasoningEffort: "ultra" }).args,
    ["--print", "p", "--mode", "accept-edits", "--output-format", "stream-json", "--effort", "max", "--conversation", "c1"]);
});

test("claude real stream-json: hook/init/thinking/rate-limit emit no events; tools are paired; no raw kept", () => {
  const claude = getAdapter("claude")!;
  const lines = fixture("claude-2.1.323.stream.jsonl");
  assert.equal(claude.sessionIdFrom(lines[0]), null);
  assert.equal(claude.sessionIdFrom(lines[1]), "46c0d693-4fe0-4bcf-be41-33ebe2cc57fc");
  for (const line of lines) assert.notEqual(claude.parseLine(line), null, line);
  const events = lines.flatMap((line) => claude.parseLine(line) ?? []);
  assert.deepEqual(events.map((e) => e.type), ["tool_call", "tool_result", "message"]);
  assert.deepEqual(events[0], { ...events[0], name: "Bash", detail: "cat a.txt" });
  assert.deepEqual(events[1], { ...events[1], ok: true, detail: "hi" });
  const failed = claude.parseLine(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }));
  assert.deepEqual(failed?.map((e) => e.type), ["error"]);
  assert.deepEqual(claude.build({ bin: "c", cwd: "/w", prompt: "p", sessionId: "s1", reasoningEffort: "ultra" }).args,
    ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--effort", "max", "--resume", "s1", "p"]);
});

test("cursor resolves cursor-agent first, then falls back to agent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-bin-"));
  for (const name of ["agent", "cursor-agent"]) { fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n"); fs.chmodSync(path.join(dir, name), 0o755); }
  assert.equal(getAdapter("cursor")!.resolve({ PATH: dir }), path.join(dir, "cursor-agent"));
  fs.rmSync(path.join(dir, "cursor-agent"));
  assert.equal(getAdapter("cursor")!.resolve({ PATH: dir }), path.join(dir, "agent"));
});

test("codex build keeps fresh/resume and the four effort-level arguments", () => {
  for (const reasoningEffort of ["low", "medium", "high", "ultra"] as const) {
    for (const sessionId of [null, "thread-9"]) {
      const spec = codex.build({ bin: "/fake/codex", cwd: "/work", prompt: "hello", sessionId, reasoningEffort });
      assert.equal(spec.stdin, "hello");
      assert.ok(spec.args.includes(`model_reasoning_effort="${reasoningEffort}"`));
      assert.ok(!spec.args.includes("--sandbox"));
      assert.ok(!spec.args.includes("--ephemeral"));
      if (sessionId) {
        assert.deepEqual(spec.args.slice(0, 3), ["exec", "resume", "--json"]);
        assert.equal(spec.args.at(-2), sessionId);
        assert.ok(!spec.args.includes("--cd"));
        assert.ok(!spec.args.includes("--color"));
      } else assert.ok(spec.args.includes("--approve-for-me"));
    }
  }
  assert.equal(getAdapter("codex"), codex);
  assert.equal(getAdapter("missing"), null);
  assert.equal(getAdapter("__proto__"), null);
  assert.equal(getAdapter("constructor"), null);
});

test("readonly mode: argv mapping for all four; codex resume still has no sandbox/approve", () => {
  const input = { bin: "/b", cwd: "/w", prompt: "p", sessionId: null as string | null, reasoningEffort: null as null, mode: "readonly" as const };
  assert.deepEqual(codex.build(input).args.slice(0, 8), ["exec", "--json", "--color", "never", "--sandbox", "read-only", "--skip-git-repo-check", "--cd"]);
  assert.ok(!codex.build(input).args.includes("--approve-for-me"));
  const resume = codex.build({ ...input, sessionId: "thread-9" });
  assert.ok(!resume.args.includes("--sandbox"));
  assert.ok(!resume.args.includes("--approve-for-me"));
  assert.deepEqual(getAdapter("claude")!.build(input).args.slice(0, 8),
    ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan", "--permission-prompts", "none"]);
  assert.deepEqual(getAdapter("cursor")!.build(input).args.slice(0, 7),
    ["--print", "--mode", "ask", "--trust", "--output-format", "stream-json", "--workspace"]);
  assert.ok(!getAdapter("cursor")!.build(input).args.includes("--force"));
  assert.deepEqual(getAdapter("agy")!.build(input).args.slice(0, 5),
    ["--print", "p", "--mode", "plan", "--output-format"]);
});

test("fake CLI resolves via PATH, outputs per fixture and supports exit codes", () => {
  const dir = path.join(import.meta.dirname, "fake-cli");
  const env = { ...process.env, PATH: dir, FAKE_FIXTURE: path.join(import.meta.dirname, "fixtures/codex.stream.jsonl"), FAKE_SLEEP: "0", FAKE_EXIT: "0", FAKE_HANG: "0" };
  const bin = which(["codex"], env);
  assert.equal(bin, path.join(dir, "codex"));
  assert.match(execFileSync(bin!, [], { env, encoding: "utf8", input: "prompt" }), /thread.started/);
  assert.throws(() => execFileSync(bin!, [], { env: { ...env, FAKE_EXIT: "3" }, input: "prompt" }), (error: unknown) => (error as { status: number }).status === 3);
  assert.equal(which(["missing"], env), null);
  assert.ok(authHit("NOT LOGGED IN", ["not logged in"]));
});

test("adapter rules: coverage matrix and rulesyncTarget / gates", () => {
  const claude = getAdapter("claude")!;
  const codexA = getAdapter("codex")!;
  const cursor = getAdapter("cursor")!;
  const agy = getAdapter("agy")!;
  assert.equal(claude.rules?.rulesyncTarget, "claudecode");
  assert.equal(codexA.rules?.rulesyncTarget, "codexcli");
  assert.equal(cursor.rules?.rulesyncTarget, "cursor");
  assert.equal(agy.rules?.rulesyncTarget, "antigravity-cli");
  assert.match(cursor.rules?.gates?.mcp ?? "", /--approve-mcps/);
  assert.match(codexA.rules?.gates?.mcp ?? "", /trust/i);
  assert.match(codexA.rules?.gates?.hooks ?? "", /hook/i);
  assert.equal(claude.rules?.gates?.mcp, undefined);

  assert.deepEqual(unseenRules(["CLAUDE.md"], codexA.rules), ["CLAUDE.md"]);
  assert.deepEqual(unseenRules(["CLAUDE.md"], agy.rules), ["CLAUDE.md"]);
  assert.deepEqual(unseenRules(["CLAUDE.md"], claude.rules), []);
  assert.deepEqual(unseenRules(["CLAUDE.md"], cursor.rules), []);
  assert.deepEqual(unseenRules(["AGENTS.md"], claude.rules), []);
  assert.deepEqual(unseenRules(["AGENTS.md", "CLAUDE.md"], claude.rules), ["AGENTS.md"]);
});
