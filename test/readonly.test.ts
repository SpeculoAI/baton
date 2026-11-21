import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveReadonlyEnforcement } from "../src/tasks.ts";
import { sandbox } from "./helpers.ts";

function gitInit(cwd: string) {
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init"]);
  fs.writeFileSync(path.join(cwd, "keep.txt"), "keep\n");
  git(["add", "keep.txt"]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init"]);
}

test("resolveReadonlyEnforcement: defaults to write; none is rejected; allow-weak closes the gap", () => {
  assert.deepEqual(resolveReadonlyEnforcement({ id: "codex", readonlyEnforcement: "os-sandbox" }, undefined, undefined), {});
  assert.deepEqual(resolveReadonlyEnforcement({ id: "codex", readonlyEnforcement: "os-sandbox" }, "write", undefined), {});
  assert.deepEqual(
    resolveReadonlyEnforcement({ id: "codex", readonlyEnforcement: "os-sandbox" }, "readonly", undefined),
    { mode: "readonly", enforcement: "os-sandbox" },
  );
  assert.throws(
    () => resolveReadonlyEnforcement({ id: "future" }, "readonly", undefined),
    /cannot enforce read-?only|--allow-weak/i,
  );
  assert.deepEqual(
    resolveReadonlyEnforcement({ id: "future" }, "readonly", true),
    { mode: "readonly", enforcement: "none" },
  );
  assert.throws(
    () => resolveReadonlyEnforcement({ id: "codex", readonlyEnforcement: "os-sandbox" }, "readonly", true),
    /no need for --allow-weak|--allow-weak is not needed/i,
  );
  assert.throws(
    () => resolveReadonlyEnforcement({ id: "codex", readonlyEnforcement: "os-sandbox" }, "write", true),
    /only (for|with|valid with) --mode readonly/i,
  );
});

test("readonly dirty → readonly_violation; clean still succeeds; reply allowed", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  s.env.FAKE_WRITE = "leak.txt";
  const dirty = await s.run("start", "--target", "codex", "--prompt", "hi", "--mode", "readonly");
  assert.equal(dirty.status, "running");
  assert.equal(dirty.mode, "readonly");
  assert.equal(dirty.enforcement, "os-sandbox");
  const violated = await s.until(dirty.task_id);
  assert.equal(violated.status, "readonly_violation");
  assert.match(violated.summary || "", /readonly_violation/);

  fs.rmSync(path.join(s.cwd, "leak.txt"), { force: true });
  delete s.env.FAKE_WRITE;
  const again = await s.run("reply", dirty.task_id, "--prompt", "restore");
  assert.equal(again.status, "running");
  assert.equal(s.meta(dirty.task_id).mode, "readonly");
  const restored = await s.until(dirty.task_id);
  assert.equal(restored.status, "success");

  const clean = await s.run("start", "--target", "codex", "--prompt", "clean", "--mode", "readonly");
  const ok = await s.until(clean.task_id);
  assert.equal(ok.status, "success");
});

test("readonly + scope: readonly violation takes precedence", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  s.env.FAKE_WRITE = "leak.txt";
  const started = await s.run(
    "start", "--target", "codex", "--prompt", "hi",
    "--mode", "readonly", "--scope", "keep.txt", "--scope-on-violation", "fail",
  );
  const done = await s.until(started.task_id);
  assert.equal(done.status, "readonly_violation");
});

test("readonly: after reply, uncleaned changes are still compared against the task-start baseline", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  s.env.FAKE_WRITE = "leak.txt";
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--mode", "readonly");
  assert.ok(started.readonly_baseline?.head);
  const first = await s.until(started.task_id);
  assert.equal(first.status, "readonly_violation");
  // Leave leak.txt in place; same content rewrite must still violate vs task-start baseline.
  const again = await s.run("reply", started.task_id, "--prompt", "again");
  assert.equal(again.status, "running");
  const second = await s.until(started.task_id);
  assert.equal(second.status, "readonly_violation");
});
