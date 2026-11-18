import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (name: string) => fs.readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8");

test("skills 带正确 frontmatter，正文保持英文", () => {
  const rescue = read("baton-rescue");
  const orchestrate = read("baton-orchestrate");
  assert.match(rescue, /^name:\s*baton-rescue\s*$/m);
  assert.match(orchestrate, /^name:\s*baton-orchestrate\s*$/m);
  assert.match(rescue, /baton-orchestrate/);
  assert.doesNotMatch(rescue, /[一-鿿]/);
  assert.doesNotMatch(orchestrate, /[一-鿿]/);
});

test("skills 以 shell 命令为主，覆盖 0.3.0 的状态与续轮方式", () => {
  for (const text of [read("baton-rescue"), read("baton-orchestrate")]) {
    for (const needle of ["src/cli.ts", " start ", "wait", "--for 50", "reply", "--as human", "tail -f", "needs_input", "quota_exceeded", "orphaned", "busy"]) {
      assert.ok(text.includes(needle), `缺少 ${needle}`);
    }
    // MCP 只是备选入口，不能要求宿主开后台子 Agent。
    assert.match(text, /MCP/);
    assert.doesNotMatch(text, /must open a (host )?background sub-agent/i);
  }
});

test("skills 不再出现 0.2.x 的旧用法", () => {
  for (const text of [read("baton-rescue"), read("baton-orchestrate")]) {
    for (const old of ["task_wait_any", "timeout_seconds", "effective_timeout_seconds", "1800", "needs_decision", "session_id", "gemini"]) {
      assert.ok(!text.includes(old), `仍含旧用法 ${old}`);
    }
  }
});

test("orchestrate: transport success 不等于验收通过 (#35)", () => {
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

test("orchestrate: scope_violation 可 reply，warn 下非空 violations 不算通过 (#37)", () => {
  const orchestrate = read("baton-orchestrate");
  assert.match(orchestrate, /--scope/);
  assert.match(orchestrate, /scope_violation/);
  assert.match(orchestrate, /scope_violations/);
  assert.match(orchestrate, /mistake fence/i);
  assert.doesNotMatch(orchestrate, /scope_violation[\s\S]{0,80}next vendor/i);
});
