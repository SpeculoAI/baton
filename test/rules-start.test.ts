import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, exec, cli } from "./helpers.ts";
import type { TaskMeta } from "../src/types.ts";

function gitInit(dir: string) {
  spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "t@test"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
}

test("start --rules check (default): unseen for codex when only CLAUDE.md; prompt unchanged", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  fs.writeFileSync(path.join(s.cwd, "CLAUDE.md"), "# rules\n");
  spawnSync("git", ["add", "CLAUDE.md"], { cwd: s.cwd });
  spawnSync("git", ["commit", "-qm", "seed"], { cwd: s.cwd });

  const started = await s.run<TaskMeta>("start", "--target", "codex", "--prompt", "fix it");
  await s.until(started.task_id);
  const meta = s.meta(started.task_id);
  assert.equal(meta.rules?.mode, "check");
  assert.deepEqual(meta.rules?.found, ["CLAUDE.md"]);
  assert.deepEqual(meta.rules?.unseen, ["CLAUDE.md"]);
  assert.equal(meta.rules?.pointer_injected, false);
  assert.equal(s.turn(started.task_id).prompt, "fix it");
});

test("start --rules check: cursor sees CLAUDE.md natively → unseen empty", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  fs.writeFileSync(path.join(s.cwd, "CLAUDE.md"), "# rules\n");
  const started = await s.run<TaskMeta>("start", "--target", "cursor", "--prompt", "hi");
  await s.until(started.task_id);
  assert.deepEqual(s.meta(started.task_id).rules?.unseen, []);
  assert.equal(s.turn(started.task_id).prompt, "hi");
});

test("start --rules off: no rules field", async (t) => {
  const s = sandbox(t);
  fs.writeFileSync(path.join(s.cwd, "CLAUDE.md"), "# rules\n");
  const started = await s.run<TaskMeta>("start", "--target", "codex", "--prompt", "hi", "--rules", "off");
  await s.until(started.task_id);
  assert.equal(s.meta(started.task_id).rules, undefined);
});

test("start --rules invalid: fails and creates no task", async (t) => {
  const s = sandbox(t);
  await assert.rejects(
    exec(process.execPath, [cli, "start", "--target", "codex", "--prompt", "hi", "--rules", "nope"], { cwd: s.cwd, env: s.env }),
    (error: unknown) => {
      const e = error as { stdout: string; code: number };
      assert.ok(e.code !== 0);
      assert.match(JSON.parse(e.stdout).summary, /rules must be check, pointer, or off/);
      return true;
    },
  );
  assert.ok(!fs.existsSync(path.join(s.home, "tasks")) || fs.readdirSync(path.join(s.home, "tasks")).length === 0);
});

test("start --rules pointer: first turn injects; reply does not", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  fs.writeFileSync(path.join(s.cwd, "CLAUDE.md"), "# rules\n");
  const started = await s.run<TaskMeta>("start", "--target", "codex", "--prompt", "fix it", "--rules", "pointer");
  await s.until(started.task_id);
  const turn1 = s.turn(started.task_id).prompt;
  assert.match(turn1, /does not load automatically/);
  assert.match(turn1, /CLAUDE\.md/);
  assert.match(turn1, /fix it$/);
  assert.equal(s.meta(started.task_id).rules?.pointer_injected, true);

  const cont = await s.run<TaskMeta>("reply", started.task_id, "--prompt", "continue");
  await s.until(cont.task_id, (m) => m.status !== "running" && m.turn >= 2);
  assert.equal(s.turn(started.task_id, 2).prompt, "continue");
  assert.ok(s.meta(started.task_id).rules);
});

test("start with .rulesync: target_configured / gates; supervisor check → in_sync", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  fs.mkdirSync(path.join(s.cwd, ".rulesync"));
  fs.writeFileSync(path.join(s.cwd, "rulesync.jsonc"), `{
    "targets": { "cursor": ["rules", "mcp"] },
    "features": ["rules"]
  }`);
  const argsFile = path.join(s.home, "rulesync-args.txt");
  s.env.FAKE_RULESYNC_ARGS = argsFile;

  const forCodex = await s.run<TaskMeta>("start", "--target", "codex", "--prompt", "hi");
  assert.equal(forCodex.rules?.rulesync?.status, "pending");
  assert.equal(forCodex.rules?.rulesync?.target_configured, false);
  await s.until(forCodex.task_id);
  assert.equal(s.meta(forCodex.task_id).rules?.rulesync?.status, "in_sync");
  assert.equal(s.meta(forCodex.task_id).status, "success");
  assert.equal(fs.readFileSync(argsFile, "utf8").trim(), "generate\n--check");

  const forCursor = await s.run<TaskMeta>("start", "--target", "cursor", "--prompt", "hi");
  assert.equal(forCursor.rules?.rulesync?.target_configured, true);
  assert.ok(forCursor.rules?.rulesync?.gates.some((g) => /--approve-mcps/.test(g)));
  await s.until(forCursor.task_id);
  assert.equal(s.meta(forCursor.task_id).rules?.rulesync?.status, "in_sync");
});

test("rulesync check: exit 1 → stale; exit 2 → error; hang → error; task still succeeds", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  fs.mkdirSync(path.join(s.cwd, ".rulesync"));
  fs.writeFileSync(path.join(s.cwd, "rulesync.jsonc"), `{ "targets": ["codexcli"], "features": ["rules"] }`);

  s.env.FAKE_RULESYNC_EXIT = "1";
  const stale = await s.run<TaskMeta>("start", "--target", "codex", "--prompt", "hi");
  await s.until(stale.task_id);
  assert.equal(s.meta(stale.task_id).rules?.rulesync?.status, "stale");
  assert.equal(s.meta(stale.task_id).status, "success");

  s.env.FAKE_RULESYNC_EXIT = "2";
  s.env.FAKE_RULESYNC_STDERR = "boom";
  const err = await s.run<TaskMeta>("start", "--target", "codex", "--prompt", "hi");
  await s.until(err.task_id);
  assert.equal(s.meta(err.task_id).rules?.rulesync?.status, "error");
  assert.match(s.meta(err.task_id).rules?.rulesync?.detail ?? "", /boom|exited 2/);
  assert.equal(s.meta(err.task_id).status, "success");

  delete s.env.FAKE_RULESYNC_EXIT;
  delete s.env.FAKE_RULESYNC_STDERR;
  s.env.FAKE_RULESYNC_SLEEP = "5";
  s.env.BATON_RULESYNC_CHECK_MS = "300";
  const hung = await s.run<TaskMeta>("start", "--target", "codex", "--prompt", "hi");
  // While rulesync is hanging, heartbeat must keep the task from looking orphaned.
  await new Promise((r) => setTimeout(r, 150));
  const mid = await s.run<TaskMeta & { liveness?: string }>("status", hung.task_id);
  assert.ok(mid.status === "running" || mid.status === "success");
  assert.notEqual(mid.liveness, "orphaned");
  await s.until(hung.task_id, undefined, 8000);
  assert.equal(s.meta(hung.task_id).rules?.rulesync?.status, "error");
  assert.match(s.meta(hung.task_id).rules?.rulesync?.detail ?? "", /timed out/);
  assert.equal(s.meta(hung.task_id).status, "success");
});

test("start --rules pointer with --scope: order is scope, rules, user prompt", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  fs.writeFileSync(path.join(s.cwd, "CLAUDE.md"), "# rules\n");
  fs.writeFileSync(path.join(s.cwd, "keep.txt"), "a\n");
  spawnSync("git", ["add", "-A"], { cwd: s.cwd });
  spawnSync("git", ["commit", "-qm", "seed"], { cwd: s.cwd });
  const started = await s.run<TaskMeta>(
    "start", "--target", "codex", "--prompt", "user-body",
    "--rules", "pointer", "--scope", "keep.txt",
  );
  await s.until(started.task_id);
  const prompt = s.turn(started.task_id).prompt;
  const scopeAt = prompt.indexOf("[Baton scope]");
  const rulesAt = prompt.indexOf("does not load automatically");
  const userAt = prompt.lastIndexOf("user-body");
  assert.ok(scopeAt >= 0 && rulesAt > scopeAt && userAt > rulesAt);
});
