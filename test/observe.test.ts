import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sandbox, exec, cli, sleep } from "./helpers.ts";
import type { TaskView } from "../src/tasks.ts";

test("wait --for 1 returns running at the deadline; supports any-of-many completion and already-finished tasks", async (t) => {
  const s = sandbox(t);
  s.env.FAKE_HANG = "1";
  const slow = await s.run("start", "--target", "codex", "--prompt", "slow");
  const begin = performance.now();
  const waiting = await s.run("wait", slow.task_id, "--for", "1");
  const elapsed = performance.now() - begin;
  assert.equal(waiting.status, "running");
  assert.ok(elapsed >= 1000 && elapsed < 3000, `took ${elapsed}ms`);
  s.env.FAKE_HANG = "0";
  s.env.FAKE_SLEEP = "0.4";
  const quick = await s.run("start", "--target", "codex", "--prompt", "quick");
  const done = await s.run("wait", slow.task_id, quick.task_id, "--for", "3");
  assert.equal(done.task_id, quick.task_id);
  assert.equal(done.status, "success");
  assert.equal((await s.run("wait", quick.task_id, "--for", "1")).status, "success");
  await s.run("cancel", slow.task_id);
  for (const args of [["wait"], ["wait", quick.task_id, "--for", "-1"], ["wait", quick.task_id, "../x"]]) await assert.rejects(s.run(...args));
});

test("wait --until-done blocks until finished; mutually exclusive with --for", async (t) => {
  const s = sandbox(t);
  s.env.FAKE_SLEEP = "0.3";
  const task = await s.run("start", "--target", "codex", "--prompt", "until");
  const done = await s.run("wait", task.task_id, "--until-done");
  assert.equal(done.task_id, task.task_id);
  assert.equal(done.status, "success");
  await assert.rejects(
    () => s.run("wait", task.task_id, "--until-done", "--for", "1"),
    (err: NodeJS.ErrnoException & { stdout?: string }) => {
      const body = JSON.parse(err.stdout || "{}") as { summary?: string };
      assert.match(body.summary || "", /--until-done|--for/);
      return true;
    },
  );
});

test("tail human-readable and raw output; -f exits after finish and includes the last event", async (t) => {
  const s = sandbox(t);
  s.env.FAKE_SLEEP = "3";
  const task = await s.run("start", "--target", "codex", "--prompt", "watch");
  const follower = spawn(process.execPath, [cli, "tail", task.task_id, "-f"], { cwd: s.cwd, env: s.env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => follower.kill("SIGKILL"));
  let output = "";
  follower.stdout.on("data", (chunk) => { output += String(chunk); });
  const finished = new Promise((resolve, reject) => { follower.on("close", resolve); follower.on("error", reject); });
  for (const deadline = Date.now() + 5000; !/watch/.test(output) && Date.now() < deadline;) await sleep(50);
  assert.match(output, /watch/);
  assert.equal(s.meta(task.task_id).status, "running");
  await s.until(task.task_id);
  await finished;
  assert.match(output, /ok/);
  assert.match(output, /success/);
  const raw = await exec(process.execPath, [cli, "tail", task.task_id, "--raw"], { cwd: s.cwd, env: s.env });
  assert.equal(raw.stdout, fs.readFileSync(path.join(s.dir(task.task_id), "events.jsonl"), "utf8"));
  const human = await exec(process.execPath, [cli, "tail", task.task_id], { cwd: s.cwd, env: s.env });
  assert.match(human.stdout, /Turn 1/i);
  await assert.rejects(s.run("tail", "../x"));
});

test("ls filters by cwd and sorts by update time descending; prune only removes expired non-running tasks", async (t) => {
  const s = sandbox(t);
  const { randomUUID } = await import("node:crypto");
  const first = await s.run("start", "--target", "codex", "--prompt", "done");
  const done = await s.until(first.task_id);
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const recent = new Date(Date.now() - 1000).toISOString();
  const other = randomUUID();
  const decision = randomUUID();
  const failed = randomUUID();
  for (const meta of [
    { ...done, updated_at: recent },
    { ...done, task_id: other, cwd: path.join(s.home, "elsewhere"), updated_at: old },
    { ...done, task_id: decision, status: "needs_input", updated_at: old },
    { ...done, task_id: failed, status: "failed", updated_at: old },
  ]) {
    fs.mkdirSync(s.dir(meta.task_id), { mode: 0o700, recursive: true });
    fs.writeFileSync(path.join(s.dir(meta.task_id), "meta.json"), JSON.stringify(meta), { mode: 0o600 });
  }
  s.env.FAKE_HANG = "1";
  const running = await s.run("start", "--target", "codex", "--prompt", "keep running");
  await s.until(running.task_id, (m) => !!m.session_id);
  await sleep(50);
  fs.writeFileSync(path.join(s.dir(running.task_id), "meta.json"), JSON.stringify({ ...s.meta(running.task_id), updated_at: old }));
  const listed = await s.run<{ tasks: { task_id: string; liveness?: string }[] }>("ls");
  assert.equal(listed.tasks[0].task_id, first.task_id);
  assert.ok(!listed.tasks.some((m) => m.task_id === other));
  assert.equal(listed.tasks.find((m) => m.task_id === running.task_id)?.liveness, "active");
  const all = await s.run<{ tasks: { task_id: string }[] }>("ls", "--all");
  assert.equal(all.tasks.length, 5);
  const pruned = await s.run<{ deleted: string[] }>("prune", "--older", "5");
  assert.deepEqual(pruned.deleted.sort(), [other, decision, failed].sort());
  assert.ok(fs.existsSync(s.dir(first.task_id)));
  assert.ok(fs.existsSync(s.dir(running.task_id)));
  assert.equal(s.meta(running.task_id).status, "running");
  assert.deepEqual((await s.run<{ deleted: string[] }>("prune", "--older", "5")).deleted, []);
  await s.run("cancel", running.task_id);
  for (const args of [["prune"], ["prune", "--older", "-1"], ["prune", "--older", "NaN"], ["ls", "extra"]]) await assert.rejects(s.run(...args));
});

test("terminal status/wait include git_changes of the current turn", async (t) => {
  const s = sandbox(t);
  for (const args of [["init", "-q"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]]) await exec("git", args, { cwd: s.cwd, env: s.env });
  const started = await s.run("start", "--target", "codex", "--prompt", "hi");
  const done = await s.run<Record<string, any>>("wait", started.task_id, "--for", "5");
  assert.equal(done.status, "success");
  assert.deepEqual(done.git_changes, s.turn(started.task_id).git_changes);
  assert.equal(done.git_changes?.files_changed, 0);
  assert.deepEqual((await s.run<Record<string, any>>("status", started.task_id)).git_changes, done.git_changes);
});

test("Codex turn metrics persist, show in terminal views, and use cumulative deltas on reply", async (t) => {
  const s = sandbox(t);
  s.env.FAKE_FIXTURE = path.join(import.meta.dirname, "fixtures", "usage", "codex.jsonl");
  const { task_id: id } = await s.run("start", "--target", "codex", "--prompt", "hi");
  const done = await s.run<TaskView>("wait", id, "--for", "5");
  assert.equal(done.status, "success");
  const first = s.turn(id);
  const toolCalls = s.events(id).filter((event) => event.type === "tool_call").length;
  assert.ok(toolCalls > 0);
  assert.equal(first.activity?.tool_calls, toolCalls);
  assert.deepEqual(first.usage, {
    input: 5506514, cached_input: 5339520, output: 35027, reasoning: 8812,
    raw: {
      input_tokens: 5506514, cached_input_tokens: 5339520, cache_write_input_tokens: 0,
      output_tokens: 35027, reasoning_output_tokens: 8812,
    },
  });
  assert.deepEqual(done.activity, first.activity);
  assert.deepEqual(done.usage, first.usage);
  const status = await s.run<TaskView>("status", id);
  assert.deepEqual(status.activity, first.activity);
  assert.deepEqual(status.usage, first.usage);
  const { stdout } = await exec(process.execPath, [cli, "tail", id], { cwd: s.cwd, env: s.env });
  assert.match(stdout, /^\[[^\n]+\] turn 1 usage in=5506514 cached=5339520 out=35027 reasoning=8812$/m);

  s.env.FAKE_FIXTURE = path.join(import.meta.dirname, "fixtures", "usage", "codex-turn2.jsonl");
  const resumed = await s.run("reply", id, "--prompt", "more");
  assert.equal(resumed.turn, 2);
  const continued = await s.run<TaskView>("wait", id, "--for", "5");
  assert.equal(continued.status, "success");
  const second = s.turn(id, 2);
  assert.equal(second.activity?.tool_calls, 0);
  assert.deepEqual(second.usage, {
    input: 1000, cached_input: 700, output: 100, reasoning: 20,
    raw: {
      input_tokens: 5507514, cached_input_tokens: 5340220, cache_write_input_tokens: 0,
      output_tokens: 35127, reasoning_output_tokens: 8832,
    },
  });
  assert.deepEqual(continued.activity, second.activity);
  assert.deepEqual(continued.usage, second.usage);

  const client = new Client({ name: "test", version: "0" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [cli, "mcp"], env: s.env as Record<string, string>,
  }));
  const response = await client.callTool({ name: "task_status", arguments: { task_id: id } });
  const view = JSON.parse((response.content as { text: string }[])[0].text);
  assert.equal(view.status, "success");
  assert.equal(view.turn, 2);
  assert.deepEqual(view.activity, second.activity);
  assert.deepEqual(view.usage, second.usage);
});

test("result prints only the final message of a finished turn; summary stays one line", async (t) => {
  const s = sandbox(t);
  const body = "## Findings\n1. token=abc123 leaked in a.ts\n2. fine otherwise";
  fs.writeFileSync(s.fixture, [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "cat a.ts", aggregated_output: "x".repeat(5000), exit_code: 0 } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `${body}\n\nBATON_RESULT\nsummary: reviewed\nBATON_END` } }),
  ].join("\n") + "\n");
  const task = await s.run("start", "--target", "codex", "--prompt", "review");
  const done = await s.until(task.task_id);
  assert.equal(done.summary, "reviewed");
  const out = (await exec(process.execPath, [cli, "result", task.task_id], { cwd: s.cwd, env: s.env })).stdout;
  assert.match(out, /^## Findings\n/);
  assert.match(out, /summary: reviewed/);
  assert.doesNotMatch(out, /abc123|xxxxx/); // redacted; no tool output
  assert.equal((await exec(process.execPath, [cli, "result", task.task_id, "--turn", "1"], { cwd: s.cwd, env: s.env })).stdout, out);
  await assert.rejects(exec(process.execPath, [cli, "result", task.task_id, "--turn", "2"], { cwd: s.cwd, env: s.env }), (err: { stdout: string }) => /from 1 to 1/.test(err.stdout));
});
