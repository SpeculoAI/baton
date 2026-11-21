import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (name: string) => fs.readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8");

test("skills have correct frontmatter and English body", () => {
  const rescue = read("baton-rescue");
  const orchestrate = read("baton-orchestrate");
  assert.match(rescue, /^name:\s*baton-rescue\s*$/m);
  assert.match(orchestrate, /^name:\s*baton-orchestrate\s*$/m);
  assert.match(rescue, /baton-orchestrate/);
  assert.doesNotMatch(rescue, /\p{Script=Han}/u);
  assert.doesNotMatch(orchestrate, /\p{Script=Han}/u);
});

test("skills are shell-command first and cover the 0.3.0 status and reply flow", () => {
  for (const text of [read("baton-rescue"), read("baton-orchestrate")]) {
    for (const needle of ["baton ", " start ", "wait", "--for 50", "reply", "--as human", "tail -f", "needs_input", "quota_exceeded", "orphaned", "busy"]) {
      assert.ok(text.includes(needle), `missing ${needle}`);
    }
    assert.doesNotMatch(text, /src\/cli\.ts|plugin-root|setup\.mjs/);
    // MCP is only a fallback entry point; it must not require the host to spawn background sub-agents.
    assert.match(text, /MCP/);
    assert.doesNotMatch(text, /must open a (host )?background sub-agent/i);
  }
});

test("skills no longer contain the legacy 0.2.x usage", () => {
  for (const text of [read("baton-rescue"), read("baton-orchestrate")]) {
    for (const old of ["task_wait_any", "timeout_seconds", "effective_timeout_seconds", "1800", "needs_decision", "session_id", "gemini"]) {
      assert.ok(!text.includes(old), `still contains legacy usage ${old}`);
    }
  }
});

test("orchestrate: transport success is not acceptance (#35)", () => {
  const orchestrate = read("baton-orchestrate");
  assert.doesNotMatch(orchestrate, /skip review/i);
  assert.doesNotMatch(
    orchestrate,
    /clean `success` is a pass|success[`'"]?\s+as\s+pass|success[`'"]?\s+status\s+is\s+enough/i,
  );
  assert.match(orchestrate, /minimal task-matched verification/i);
  assert.match(orchestrate, /execution complete/i);
  assert.match(orchestrate, /verified pass/i);
  assert.match(orchestrate, /acceptance failed/i);
  assert.match(orchestrate, /never treat transport/i);
  assert.match(orchestrate, /do not unblock dependents that need a verified pass/i);
  assert.match(orchestrate, /dependents that need acceptance wait/i);
  assert.match(orchestrate, /## Review \(project-owned gate \+ minimal default\)/);
});

test("orchestrate: scope_violation can be replied to; non-empty violations under warn do not count as pass (#37)", () => {
  const orchestrate = read("baton-orchestrate");
  assert.match(orchestrate, /--scope/);
  assert.match(orchestrate, /scope_violation/);
  assert.match(orchestrate, /scope_violations/);
  assert.match(orchestrate, /mistake fence/i);
  assert.doesNotMatch(orchestrate, /scope_violation[\s\S]{0,80}next vendor/i);
});

test("rescue: --model + scope_violation terminal state; orchestrate brief covers worktree/model", () => {
  const rescue = read("baton-rescue");
  const orchestrate = read("baton-orchestrate");
  assert.match(rescue, /--model <id>/);
  assert.match(rescue, /Cursor only/i);
  assert.match(rescue, /scope_violation/);
  assert.match(rescue, /scope_violations/);
  assert.match(rescue, /success`, `needs_input`, `scope_violation`, or `readonly_violation/);
  assert.match(orchestrate, /--model <id>/);
  assert.match(orchestrate, /worktree/);
  assert.match(orchestrate, /agents, start, wait, status, tail, reply, cancel, ls, worktree/);
});

test("skills: --until-done and --mode readonly; --for 50 is still kept", () => {
  for (const text of [read("baton-rescue"), read("baton-orchestrate")]) {
    assert.match(text, /--until-done/);
    assert.match(text, /--mode readonly/);
    assert.ok(text.includes("--for 50"));
  }
});

test("setup: Node >= 20.17; installs the global package when the command is missing", () => {
  const setup = read("setup");
  assert.match(setup, /Node\.js >= 20\.17/);
  assert.match(setup, /@speculoai\/baton/);
  assert.doesNotMatch(setup, /setup\.mjs/);
  assert.match(setup, /baton-rescue/);
  assert.match(setup, /baton-orchestrate/);
  assert.match(setup, /--model/);
  assert.match(setup, /--scope/);
});
