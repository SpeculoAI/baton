import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { exe, fakeBin } from "./helpers.ts";
import { codex } from "../src/adapters/codex.ts";
import { which, authHit, assertArgvSafe } from "../src/adapters/common.ts";
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

test("codex 0.167.0 real output: keeps errors and messages and reports terminal usage", () => {
  const lines = fs.readFileSync(new URL("fixtures/codex-0.167.0.stream.jsonl", import.meta.url), "utf8").trim().split("\n");
  for (const line of lines) assert.notEqual(codex.parseLine(line), null, line);
  const events = lines.flatMap((line) => codex.parseLine(line) ?? []);
  assert.deepEqual(events.map((e) => e.type), ["error", "error", "message", "usage"]);
});

test("Codex parses a top-level error event", () => {
  const event = codex.parseLine('{"type":"error","message":"Usage limit reached."}')?.[0];
  assert.equal(event?.type === "error" && event.text, "Usage limit reached.");
});

function fixture(name: string): string[] {
  return fs.readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8").trim().split("\n");
}

test("Codex usage fixture reports classified calls and cumulative terminal usage", () => {
  const events = fixture("usage/codex.jsonl").flatMap((line) => codex.parseLine(line) ?? []);
  assert.deepEqual(events.map(({ ts, turn, ...data }) => data), [
    { type: "tool_call", name: "command_execution", kind: "shell", intent: "explore",
      detail: "/bin/zsh -lc 'git status --short && ls src; git diff -- docs/reference.md'" },
    { type: "message", text: "[模型回复]" },
    { type: "usage", input: 5506514, cached_input: 5339520, output: 35027, reasoning: 8812,
      raw: { input_tokens: 5506514, cached_input_tokens: 5339520, cache_write_input_tokens: 0,
        output_tokens: 35027, reasoning_output_tokens: 8812 } },
  ]);
  assert.equal(codex.usageCumulative, true);
  const edit = codex.parseLine('{"type":"item.started","item":{"type":"file_change","changes":[]}}')?.[0];
  assert.equal(edit?.type === "tool_call" && edit.kind, "edit");
  const other = codex.parseLine('{"type":"item.started","item":{"type":"mcp_tool_call","server":"tools","tool":"lookup"}}')?.[0];
  assert.equal(other?.type === "tool_call" && other.kind, "other");
});

test("Cursor usage fixture reports classified calls and per-turn terminal usage", () => {
  const cursor = getAdapter("cursor")!;
  const events = fixture("usage/cursor.jsonl").flatMap((line) => cursor.parseLine(line) ?? []);
  assert.deepEqual(events.map(({ ts, turn, ...data }) => data), [
    { type: "tool_call", name: "grep", kind: "search", detail: "/Users/u/myself/baton" },
    { type: "tool_call", name: "read", kind: "read", detail: "/Users/u/myself/baton/src/contract.ts" },
    { type: "tool_call", name: "shell", kind: "shell", intent: "explore", detail: "rg -n buildPrompt src" },
    { type: "usage", input: 5904382, cached_input: 5859840, output: 33635, reasoning: 16133,
      raw: { inputTokens: 44542, outputTokens: 33635, cacheReadTokens: 5859840, cacheWriteTokens: 0, reasoningTokens: 16133 } },
  ]);
  assert.ok(!cursor.usageCumulative);
  for (const [name, kind] of Object.entries({
    glob: "search", edit: "edit", delete: "edit",
    mcp: "other", getMcpTools: "other", webFetch: "other", await: "other", constructor: "other",
  })) {
    const line = JSON.stringify({ type: "tool_call", subtype: "started", tool_call: { [name + "ToolCall"]: { args: {} } } });
    const call = cursor.parseLine(line)?.[0];
    assert.equal(call?.type === "tool_call" && call.kind, kind, name);
    assert.ok(call && !("intent" in call), name);
  }
});

test("Shell intent uses the complete command before display truncation", () => {
  const command = "rg " + "x".repeat(220) + " && npm test";
  const cursor = getAdapter("cursor")!;
  const calls = [
    codex.parseLine(JSON.stringify({ type: "item.started", item: { type: "command_execution", command } }))?.[0],
    cursor.parseLine(JSON.stringify({ type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: { command } } } }))?.[0],
  ];
  for (const call of calls) {
    assert.ok(call?.type === "tool_call");
    assert.equal(call.detail, command.slice(0, 200));
    assert.equal(call.intent, "verify");
  }
});

test("Terminal usage excludes nonnumeric metadata and preserves Cursor errors", () => {
  const cursor = getAdapter("cursor")!;
  const result = { type: "result", is_error: true, result: "failure" };
  const usage = { inputTokens: 4, cacheReadTokens: 8, cacheWriteTokens: 2, outputTokens: 3 };
  const failed = cursor.parseLine(JSON.stringify({ ...result, usage: { ...usage, metadata: "ignored" } }))!;
  assert.deepEqual(failed.map(({ ts, turn, ...data }) => data), [
    { type: "error", text: "failure" },
    { type: "usage", input: 14, cached_input: 8, output: 3, raw: usage },
  ]);
  assert.deepEqual(cursor.parseLine(JSON.stringify(result))?.map((e) => e.type), ["error"]);
  assert.deepEqual(cursor.parseLine('{"type":"result","usage":{"inputTokens":"4"}}'), []);
  assert.deepEqual(codex.parseLine('{"type":"turn.completed","usage":{"input_tokens":4}}'), []);
  assert.deepEqual(codex.parseLine('{"type":"turn.completed"}'), []);
});

test("cursor real stream-json: session, tools, messages; thinking deltas emit no events; no raw kept", () => {
  const cursor = getAdapter("cursor")!;
  const lines = fixture("cursor-2026.11.11.stream.jsonl");
  assert.equal(cursor.sessionIdFrom(lines[0]), "ac43faa4-c292-43be-83ce-3dca1fa125cf");
  for (const line of lines) assert.notEqual(cursor.parseLine(line), null, line);
  const events = lines.flatMap((line) => cursor.parseLine(line) ?? []);
  assert.deepEqual(events.map((e) => e.type), ["message", "tool_call", "tool_result", "message", "usage"]);
  assert.deepEqual(events[2], { ...events[2], name: "shell", ok: true, detail: "cat a.txt" });
  const last = events.at(-2);
  assert.equal(last?.type === "message" && last.text, "hi");
  assert.deepEqual(cursor.build({ bin: "c", cwd: "/w", prompt: "p", sessionId: "s1", reasoningEffort: null, model: null }).args,
    ["--print", "--force", "--trust", "--output-format", "stream-json", "--workspace", "/w", "--resume", "s1"]);
  assert.deepEqual(cursor.build({ bin: "c", cwd: "/w", prompt: "p", sessionId: null, reasoningEffort: null, model: "grok-4.7-xhigh" }).args,
    ["--print", "--force", "--trust", "--output-format", "stream-json", "--workspace", "/w", "--model", "grok-4.7-xhigh"]);
});

test("agy real stream-json: tool steps are paired; the full reply comes from result only once; no raw kept", () => {
  const agy = getAdapter("agy")!;
  const lines = fixture("agy-1.5.6.stream.jsonl");
  assert.equal(agy.sessionIdFrom(lines[0]), "9c0bfa4e-4c5c-4b0c-bd90-ff90c173e27c");
  for (const line of lines) assert.notEqual(agy.parseLine(line), null, line);
  const events = lines.flatMap((line) => agy.parseLine(line) ?? []);
  assert.deepEqual(events.map((e) => e.type), ["tool_call", "tool_result", "message", "usage"]);
  assert.equal(events[2].type === "message" && events[2].text, "hi\n");
  const failed = agy.parseLine(JSON.stringify({ event: "result", result: { status: "ERROR", response: "boom" } }));
  assert.deepEqual(failed?.map((e) => e.type), ["error"]);
  assert.deepEqual(agy.build({ bin: "a", cwd: "/w", prompt: "p", sessionId: "c1", reasoningEffort: "ultra" }).args,
    ["--print=", "--mode", "accept-edits", "--input-format", "stream-json", "--output-format", "stream-json", "--effort", "max", "--conversation", "c1"]);
  assert.deepEqual(JSON.parse(agy.build({ bin: "a", cwd: "/w", prompt: "a\nb", sessionId: null, reasoningEffort: null }).stdin!), { event: "user", message: { content: "a\nb" } });
});

test("Agy uses result.error when a failed result has no response", () => {
  const agy = getAdapter("agy")!;
  const event = agy.parseLine('{"event":"result","result":{"status":"ERROR","error":{"message":"Please log in."}}}')?.[0];
  assert.equal(event?.type === "error" && event.text, "Please log in.");
});

test("claude real stream-json: hook/init/thinking/rate-limit emit no events; tools are paired; no raw kept", () => {
  const claude = getAdapter("claude")!;
  const lines = fixture("claude-2.1.323.stream.jsonl");
  assert.equal(claude.sessionIdFrom(lines[0]), null);
  assert.equal(claude.sessionIdFrom(lines[1]), "46c0d693-4fe0-4bcf-be41-33ebe2cc57fc");
  for (const line of lines) assert.notEqual(claude.parseLine(line), null, line);
  const events = lines.flatMap((line) => claude.parseLine(line) ?? []);
  assert.deepEqual(events.map((e) => e.type), ["tool_call", "tool_result", "message", "usage"]);
  assert.deepEqual(events[0], { ...events[0], name: "Bash", detail: "cat a.txt" });
  assert.deepEqual(events[1], { ...events[1], ok: true, detail: "hi" });
  const failed = claude.parseLine(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }));
  assert.deepEqual(failed?.map((e) => e.type), ["error"]);
  assert.deepEqual(claude.build({ bin: "c", cwd: "/w", prompt: "p", sessionId: "s1", reasoningEffort: "ultra" }).args,
    ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--effort", "max", "--resume", "s1"]);
  assert.equal(claude.build({ bin: "c", cwd: "/w", prompt: "p", sessionId: null, reasoningEffort: null }).stdin, "p");
});

test("Claude usage fixture ignores duplicate assistant usage and keeps terminal reasoning", () => {
  const claude = getAdapter("claude")!;
  const lines = fixture("usage/claude.jsonl");
  assert.equal(lines.map((line) => JSON.parse(line)).filter((row) => row.message?.usage).length, 2);
  const events = lines.flatMap((line) => claude.parseLine(line) ?? []);
  assert.deepEqual(events.map(({ ts, turn, ...data }) => data), [
    { type: "tool_call", name: "Bash", kind: "shell", intent: "explore",
      detail: 'grep -rl "buildPrompt" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist .' },
    { type: "tool_call", name: "Read", kind: "read", detail: "/Users/u/myself/baton/src/contract.ts" },
    { type: "usage", input: 179827, cached_input: 88436, output: 1213, reasoning: 261,
      raw: { input_tokens: 4, cache_creation_input_tokens: 91387, cache_read_input_tokens: 88436, output_tokens: 1213 } },
  ]);
  assert.ok(!claude.usageCumulative);
  const result = JSON.parse(lines.at(-1)!);
  result.usage.output_tokens_details.thinking_tokens = 0;
  const failed = claude.parseLine(JSON.stringify({ ...result, is_error: true, result: "boom" }))!;
  assert.deepEqual(failed.map((event) => event.type), ["error", "usage"]);
  assert.equal(failed[0].type === "error" && failed[0].text, "boom");
  assert.equal(failed[1].type === "usage" && failed[1].reasoning, 0);
});

test("AGY usage fixture ignores step usage and preserves the result message", () => {
  const agy = getAdapter("agy")!;
  const lines = fixture("usage/agy.jsonl");
  const events = lines.flatMap((line) => agy.parseLine(line) ?? []);
  assert.deepEqual(events.map(({ ts, turn, ...data }) => data), [
    { type: "tool_call", name: "run_command", kind: "shell",
      detail: JSON.stringify({ CommandLine: 'rg -l "buildPrompt" && echo "---GLOB---" && ls -1 src/adapters/*.ts && echo "---LS---" && ls -1 src' }) },
    { type: "tool_call", name: "read_file", kind: "read",
      detail: JSON.stringify({ EndLine: 5, Path: "/Users/u/myself/baton/src/contract.ts", StartLine: 1 }) },
    { type: "message", text: "[模型回复]" },
    { type: "usage", input: 53282, cached_input: 23905, output: 2041, reasoning: 1599,
      raw: { input_tokens: 29377, output_tokens: 2041, thinking_tokens: 1599, cache_read_tokens: 23905, total_tokens: 31418 } },
  ]);
  assert.equal(agy.usageCumulative, true);
  const { result } = JSON.parse(lines.at(-1)!);
  const failed = agy.parseLine(JSON.stringify({ event: "result", result: { ...result, status: "ERROR", response: "boom" } }))!;
  assert.deepEqual(failed.map((event) => event.type), ["error", "usage"]);
  assert.equal(failed[0].type === "error" && failed[0].text, "boom");
});

test("Kimi usage fixture classifies tools and preserves messages and results", () => {
  const kimi = getAdapter("kimi")!;
  const events = fixture("usage/kimi.jsonl").flatMap((line) => kimi.parseLine(line) ?? []);
  assert.deepEqual(events.map(({ ts, turn, ...data }) => data), [
    { type: "tool_call", name: "Grep", kind: "search", detail: '{"pattern":"buildPrompt","output_mode":"files_with_matches"}' },
    { type: "tool_call", name: "Glob", kind: "search", detail: '{"pattern":"src/adapters/*.ts"}' },
    { type: "tool_call", name: "Bash", kind: "shell", intent: "explore", detail: "ls src" },
    { type: "tool_call", name: "Read", kind: "read", detail: "src/contract.ts" },
    { type: "message", text: "[模型回复]" },
    ...Array.from({ length: 4 }, () => ({ type: "tool_result", name: "tool", ok: true, detail: "[工具输出]" })),
    { type: "message", text: "[模型回复]" },
  ]);
  assert.equal(kimi.usage, undefined);
  const invalid = kimi.parseLine('{"role":"assistant","tool_calls":[{"function":{"name":"Bash","arguments":"bad JSON"}}]}')!;
  assert.deepEqual(invalid.map(({ ts, turn, ...data }) => data), [
    { type: "tool_call", name: "Bash", kind: "shell", detail: "bad JSON" },
  ]);
});

test("Claude, AGY and Kimi classify the untruncated shell command", () => {
  const command = "rg " + "x".repeat(220) + " && npm test";
  const claude = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } };
  const agy = { event: "step_update", step_update: { step_type: "tool", state: "ACTIVE",
    tool_info: { name: "run_command", parameters: { CommandLine: command } } } };
  const kimi = { role: "assistant", tool_calls: [{ function: { name: "Bash", arguments: JSON.stringify({ command }) } }] };
  for (const [target, line] of Object.entries({ claude, agy, kimi })) {
    const call = getAdapter(target)!.parseLine(JSON.stringify(line))?.[0];
    assert.ok(call?.type === "tool_call", target);
    assert.equal(call.detail.length, 200, target);
    assert.equal(call.intent, "verify", target);
  }
});

test("cursor resolves cursor-agent first, then falls back to agent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-bin-"));
  const agent = fakeBin(dir, "agent");
  const cursorAgent = fakeBin(dir, "cursor-agent");
  assert.equal(getAdapter("cursor")!.resolve({ PATH: dir }), cursorAgent);
  fs.rmSync(cursorAgent);
  assert.equal(getAdapter("cursor")!.resolve({ PATH: dir }), agent);
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

test("codex build: --model becomes -m on fresh and resume; absent model adds nothing", () => {
  for (const sessionId of [null, "thread-9"]) {
    const spec = codex.build({ bin: "/b", cwd: "/w", prompt: "p", sessionId, reasoningEffort: "high", model: "gpt-6.2-sol" });
    const i = spec.args.indexOf("-m");
    assert.ok(i > 0 && spec.args[i + 1] === "gpt-6.2-sol");
    assert.equal(spec.args.filter((a) => a === "-m").length, 1);
    assert.equal(spec.modelArg, "gpt-6.2-sol");
    assert.ok(spec.args.includes(`model_reasoning_effort="high"`));
    if (sessionId) assert.equal(spec.args.at(-2), sessionId);
  }
  const none = codex.build({ bin: "/b", cwd: "/w", prompt: "p", sessionId: null, reasoningEffort: null, model: null });
  assert.equal(none.args.includes("-m"), false);
  assert.equal(none.modelArg, undefined);
});

test("codex build uses exact sandbox and approval arguments for fresh turns", () => {
  const input = { bin: "/b", cwd: "/w", prompt: "p", sessionId: null, reasoningEffort: null };
  const write = codex.build({ ...input, mode: "write" });
  assert.deepEqual(write.args, [
    "exec", "--json", "--color", "never", "--approve-for-me", "--skip-git-repo-check",
    "--cd", "/w", "--output-last-message", write.lastMessagePath, "-",
  ]);
  const readonly = codex.build({ ...input, mode: "readonly" });
  assert.deepEqual(readonly.args, [
    "exec", "--json", "--color", "never", "--sandbox", "read-only", "--skip-git-repo-check",
    "--cd", "/w", "--output-last-message", readonly.lastMessagePath, "-",
  ]);
});

test("codex build preserves workspace-write sandbox on resume", () => {
  const spec = codex.build({
    bin: "/b", cwd: "/w", prompt: "p", sessionId: "thread-9", reasoningEffort: null, mode: "write",
  });
  assert.deepEqual(spec.args, [
    "exec", "resume", "--json", "--skip-git-repo-check", "--output-last-message", spec.lastMessagePath,
    "-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"', "thread-9", "-",
  ]);
});

test("codex build preserves read-only sandbox on resume", () => {
  const spec = codex.build({
    bin: "/b", cwd: "/w", prompt: "p", sessionId: "thread-9", reasoningEffort: null, mode: "readonly",
  });
  assert.deepEqual(spec.args, [
    "exec", "resume", "--json", "--skip-git-repo-check", "--output-last-message", spec.lastMessagePath,
    "-c", 'sandbox_mode="read-only"', "thread-9", "-",
  ]);
});

test("readonly mode: argv mapping for Claude, Cursor and AGY", () => {
  const input = { bin: "/b", cwd: "/w", prompt: "p", sessionId: null as string | null, reasoningEffort: null as null, mode: "readonly" as const };
  assert.deepEqual(getAdapter("claude")!.build(input).args.slice(0, 8),
    ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan", "--permission-prompts", "none"]);
  assert.deepEqual(getAdapter("cursor")!.build(input).args.slice(0, 7),
    ["--print", "--mode", "ask", "--trust", "--output-format", "stream-json", "--workspace"]);
  assert.ok(!getAdapter("cursor")!.build(input).args.includes("--force"));
  assert.deepEqual(getAdapter("agy")!.build(input).args.slice(0, 5),
    ["--print=", "--mode", "plan", "--input-format", "stream-json"]);
});

test("fake CLI resolves via PATH, outputs per fixture and supports exit codes", () => {
  const dir = path.join(import.meta.dirname, "fake-cli");
  const env = { ...process.env, PATH: dir, BATON_TEST_NODE: process.execPath, FAKE_FIXTURE: path.join(import.meta.dirname, "fixtures/codex.stream.jsonl"), FAKE_SLEEP: "0", FAKE_EXIT: "0", FAKE_HANG: "0" };
  const bin = which(["codex"], env);
  assert.equal(bin, path.join(dir, exe("codex")));
  assert.match(crossSpawn.sync(bin!, [], { env, encoding: "utf8", input: "prompt" }).stdout, /thread.started/);
  assert.equal(crossSpawn.sync(bin!, [], { env: { ...env, FAKE_EXIT: "3" }, input: "prompt" }).status, 3);
  assert.equal(which(["missing"], env), null);
  assert.ok(authHit("NOT LOGGED IN", ["not logged in"]));
});

test("which on Windows finds .exe and .cmd by PATHEXT, never the extensionless npm shim", { skip: process.platform !== "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-bin-"));
  fs.writeFileSync(path.join(dir, "tool"), "#!/bin/sh\n"); // what npm puts next to tool.cmd
  fs.writeFileSync(path.join(dir, "tool.cmd"), "@exit /b 0\r\n");
  fs.writeFileSync(path.join(dir, "other.exe"), "");
  assert.equal(which(["tool"], { PATH: dir }), path.join(dir, "tool.cmd"));
  assert.equal(which(["other"], { Path: dir, PATHEXT: ".EXE;.CMD" }), path.join(dir, "other.exe"));
  assert.equal(which(["tool"], { PATH: dir, PATHEXT: ".EXE" }), null);
  fs.rmSync(dir, { recursive: true, force: true });
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

test("assertArgvSafe: argv prompts pass on POSIX and to a Windows .exe; a .cmd shim refuses newlines and cmd.exe metacharacters", () => {
  const multi = ["-p", "line one & two\nline two"];
  assert.doesNotThrow(() => assertArgvSafe("/usr/bin/kimi", multi, "linux"));
  assert.doesNotThrow(() => assertArgvSafe("C:\\bin\\kimi.exe", multi, "win32"));
  assert.doesNotThrow(() => assertArgvSafe("C:\\bin\\kimi.cmd", ["-p", "plain one line"], "win32"));
  for (const bad of ["a\nb", "a\rb", "a & b", "a | b", "a < b", "a > b", "a ^ b", "100%", "hi!", 'say "x"', "(x)"]) {
    assert.throws(() => assertArgvSafe("C:\\bin\\KIMI.CMD", ["-p", bad], "win32", "use install.ps1"), (err: Error) => {
      assert.match(err.message, /kimi\.cmd/i);
      assert.match(err.message, /cmd\.exe/);
      assert.match(err.message, /use install\.ps1/);
      return true;
    }, JSON.stringify(bad));
  }
  assert.throws(() => assertArgvSafe("C:\\bin\\kimi.bat", ["-p", "a\nb"], "win32"), /\.bat/);
  const long = ["-p", "x".repeat(32767)];
  assert.doesNotThrow(() => assertArgvSafe("/usr/bin/kimi", long, "darwin"));
  assert.throws(() => assertArgvSafe("C:\\bin\\kimi.exe", long, "win32"), /32767/);
});

test("kimi 2.8.0 real stream-json: tool calls and results pair up, failed Bash is ok:false, the session id comes from the trailing resume hint", () => {
  const kimi = getAdapter("kimi")!;
  const lines = fixture("kimi-2.8.0.stream.jsonl");
  for (const line of lines) assert.notEqual(kimi.parseLine(line), null, line);
  assert.deepEqual(lines.map((line) => kimi.sessionIdFrom(line)).filter(Boolean), ["session_00000000-0000-4000-8000-000000000001"]);
  const events = lines.flatMap((line) => kimi.parseLine(line) ?? []);
  assert.deepEqual(events.map((e) => e.type), ["tool_call", "tool_result", "tool_call", "message", "tool_result", "message"]);
  assert.deepEqual(events.filter((e) => e.type === "tool_call").map((e) => e.type === "tool_call" && [e.name, e.detail]), [["Bash", "echo hi"], ["Bash", "ls /nonexistent_dir_xyz"]]);
  assert.deepEqual(events.filter((e) => e.type === "tool_result").map((e) => e.type === "tool_result" && e.ok), [true, false]);
  const last = events.at(-1);
  assert.equal(last?.type === "message" && last.text, "DONE");
  const long = kimi.parseLine(JSON.stringify({ role: "assistant", tool_calls: [{ function: { name: "Write", arguments: JSON.stringify({ content: "x".repeat(300) }) } }] }));
  assert.equal(long?.[0].type === "tool_call" && long[0].detail.length, 200);
  for (const line of ["bad json", "null", "{}", '{"role":"user","content":"x"}']) assert.equal(kimi.parseLine(line), null, line);

  assert.deepEqual(kimi.build({ bin: "k", cwd: "/w", prompt: "a\nb", sessionId: null, reasoningEffort: null }),
    { command: "k", args: ["-p", "a\nb", "--output-format", "stream-json"], stdin: null });
  const resume = kimi.build({ bin: "k", cwd: "/w", prompt: "p", sessionId: "session_1", reasoningEffort: null, model: " kimi-code/k3 " });
  assert.deepEqual(resume.args, ["-p", "p", "--output-format", "stream-json", "-m", "kimi-code/k3", "-S", "session_1"]);
  assert.equal(resume.modelArg, "kimi-code/k3");
  const effort = kimi.build({ bin: "k", cwd: "/w", prompt: "p", sessionId: null, reasoningEffort: "high" });
  assert.ok(!effort.args.some((arg) => /effort/.test(arg)));
  assert.match(effort.warning ?? "", /effort/);

  assert.equal(kimi.readonlyEnforcement, undefined);
  assert.ok(kimi.isAuthFailure("error: failed to run prompt: No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml."));
  assert.ok(!kimi.isAuthFailure("error: failed to run prompt: Prompt turn ended with reason: failed"));
});
