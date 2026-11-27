import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sandbox } from "./helpers.ts";
import type { CheckResult, Target, TaskMeta, Turn } from "../src/types.ts";

function seedTask(s: ReturnType<typeof sandbox>, target: Target, overrides: Partial<TaskMeta> = {}, ...turns: Turn[]): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const meta: TaskMeta = {
    task_id: id, target, cwd: s.cwd, created_at: now, updated_at: now, status: "success",
    turn: turns.length || 1, session_id: null, idle_timeout_s: 600, max_duration_s: null,
    supervisor_pid: null, child_pid: null, heartbeat_at: null, last_event_at: null,
    ...overrides,
  };
  const dir = s.dir(id);
  fs.mkdirSync(path.join(dir, "turns"), { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
  for (const turn of turns) fs.writeFileSync(path.join(dir, "turns", `${turn.turn}.json`), JSON.stringify(turn));
  return id;
}

function turn(turn: number, checkStatus: CheckResult["status"], data: Partial<Turn> = {}): Turn {
  const status = checkStatus === "failed" || checkStatus === "timed_out" ? "check_failed" : "success";
  return {
    turn, author: "host", prompt: "private prompt", status,
    ...(checkStatus && { check: { command: "check", status: checkStatus, exit_code: null, duration_ms: 0, output_tail: "" } }),
    ...data,
  };
}

test("stats aggregates stored and replayed first turns and counts missing records", async (t) => {
  const s = sandbox(t);
  seedTask(s, "codex", { check_command: "check" }, turn(1, "failed", {
    activity: { tool_calls: 5, before_first_edit: 2, explore: 2, verify: 0, by_kind: { read: 2, search: 0, edit: 3, shell: 0, other: 0 } },
    usage: { input: 100, cached_input: 50, output: 10, raw: {} },
  }), turn(2, "passed"));
  seedTask(s, "codex", { check_command: "check", status: "check_failed" }, turn(1, "passed", {
    activity: { tool_calls: 8, before_first_edit: 6, explore: 6, verify: 0, by_kind: { read: 6, search: 0, edit: 2, shell: 0, other: 0 } },
    usage: { input: 300, cached_input: 120, output: 30, raw: {} },
  }), turn(2, "timed_out"));
  const replay = seedTask(s, "codex");
  fs.mkdirSync(path.join(s.dir(replay), "raw"));
  fs.copyFileSync(path.join(import.meta.dirname, "fixtures", "usage", "codex.jsonl"), path.join(s.dir(replay), "raw", "1.stdout.log"));
  const missing = seedTask(s, "codex", { check_command: "check" });
  seedTask(s, "kimi", { mode: "readonly" }, turn(1, undefined, {
    activity: { tool_calls: 0, before_first_edit: null, explore: 0, verify: 0, by_kind: { read: 0, search: 0, edit: 0, shell: 0, other: 0 } },
  }));

  const stats = await s.run<{ generated_at: string }>("stats");
  assert.equal(new Date(stats.generated_at).toISOString(), stats.generated_at);
  assert.deepEqual(stats, {
    schema_version: 1,
    generated_at: stats.generated_at,
    note: "Usage accounting differs across CLIs. Only compare changes over time within the same CLI.",
    targets: {
      codex: {
        tasks: 4, measured: 3,
        first_turn: {
          before_first_edit: { median: 4, p75: 5, n: 2 },
          explore_share: 9 / 14,
          input: { median: 300, n: 3 }, output: { median: 30, n: 3 },
          cached_share: (50 + 120 + 5339520) / (100 + 300 + 5506514),
        },
        rework_rate: 2 / 4, check_failed_rate: 2 / 3,
      },
      kimi: {
        tasks: 1, measured: 1,
        first_turn: {
          before_first_edit: { median: null, p75: null, n: 0 },
          explore_share: null, input: { median: null, n: 0 }, output: { median: null, n: 0 }, cached_share: null,
        },
        rework_rate: 0, check_failed_rate: null,
      },
    },
  });
  assert.equal(fs.existsSync(path.join(s.dir(replay), "turns", "1.json")), false);
  assert.equal(fs.existsSync(path.join(s.dir(missing), "raw")), false);
});

test("stats filters by cwd, worktree source, target, and creation date without recovering orphans", async (t) => {
  const s = sandbox(t);
  const since = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const old = "2000-01-01T00:00:00.000Z";
  seedTask(s, "codex", { created_at: `${since}T00:00:00.000Z` });
  seedTask(s, "codex", { created_at: old });
  const worktree = path.join(s.home, "isolated");
  fs.mkdirSync(worktree);
  seedTask(s, "claude", { cwd: worktree, worktree: { path: worktree, branch: "test", source_cwd: s.cwd, gitignore_updated: false } });
  seedTask(s, "cursor", { cwd: s.home });
  const orphan = seedTask(s, "agy", { status: "running", updated_at: old });
  const before = fs.readFileSync(path.join(s.dir(orphan), "meta.json"));

  async function counts(...args: string[]) {
    const { targets } = await s.run<{ targets: Record<string, { tasks: number }> }>("stats", ...args);
    return Object.fromEntries(Object.entries(targets).map(([target, group]) => [target, group.tasks]));
  }
  assert.deepEqual(await counts(), { codex: 2, claude: 1 });
  assert.deepEqual(await counts("--all"), { codex: 2, claude: 1, cursor: 1 });
  assert.deepEqual(await counts("--target", "codex"), { codex: 2 });
  assert.deepEqual(await counts("--target", "cursor"), {});
  assert.deepEqual(await counts("--all", "--target", "cursor"), { cursor: 1 });
  assert.deepEqual(await counts("--since", since), { codex: 1, claude: 1 });
  assert.deepEqual(await counts("--since", "3d"), { codex: 1, claude: 1 });
  assert.deepEqual(fs.readFileSync(path.join(s.dir(orphan), "meta.json")), before);
  assert.deepEqual(s.events(orphan), []);
});

test("stats rejects invalid date and target filters", async (t) => {
  const s = sandbox(t);
  for (const value of ["yesterday", "3", "-2d", "2026-02-30"]) {
    await assert.rejects(s.run("stats", `--since=${value}`), (error: { stdout: string }) =>
      /--since/.test(JSON.parse(error.stdout).summary));
  }
  await assert.rejects(s.run("stats", "--target", "unknown"), (error: { stdout: string }) =>
    /Unknown target: unknown/.test(JSON.parse(error.stdout).summary));
});
