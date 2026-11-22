import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sandbox, cli } from "./helpers.ts";

function gitInit(cwd: string) {
  execFileSync("git", ["init"], { cwd });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "t"], { cwd });
  fs.writeFileSync(path.join(cwd, "keep.txt"), "keep\n");
  execFileSync("git", ["add", "keep.txt"], { cwd });
  execFileSync("git", ["commit", "-m", "init"], { cwd });
}

async function connect(env: NodeJS.ProcessEnv): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: env as Record<string, string> }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse((result.content as { text: string }[])[0].text);
}

test("MCP thin shell: tool list, dispatch, bounded wait, reply, list, cancel; all state lives on disk", async (t) => {
  const s = sandbox(t);
  let client = await connect(s.env);
  t.after(() => client.close());
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["delegate_task", "list_agents", "task_cancel", "task_list", "task_reply", "task_status", "task_wait"]);
  assert.ok((await call(client, "list_agents")).agents.some((a: any) => a.id === "codex" && a.installed));

  const started = await call(client, "delegate_task", { target_agent: "codex", prompt: "hi", cwd: s.cwd });
  assert.equal(started.status, "running");
  // After an MCP restart the same task is still readable: the MCP process keeps no task state.
  await client.close();
  client = await connect(s.env);
  const done = await call(client, "task_wait", { task_ids: [started.task_id], wait_seconds: 10 });
  assert.equal(done.status, "success");
  assert.equal((await call(client, "task_status", { task_id: started.task_id })).status, "success");

  const again = await call(client, "task_reply", { task_id: started.task_id, prompt: "more", as: "human" });
  assert.equal(again.status, "running");
  assert.equal((await call(client, "task_wait", { task_ids: [started.task_id], wait_seconds: 10 })).turn, 2);
  assert.ok((await call(client, "task_list", { all: true })).tasks.some((task: any) => task.task_id === started.task_id));

  s.env.FAKE_HANG = "1";
  await client.close();
  client = await connect(s.env);
  const slow = await call(client, "delegate_task", { target_agent: "codex", prompt: "slow", cwd: s.cwd });
  const begin = performance.now();
  assert.equal((await call(client, "task_wait", { task_ids: [slow.task_id], wait_seconds: 1 })).status, "running");
  assert.ok(performance.now() - begin < 3000);
  assert.equal((await call(client, "task_cancel", { task_id: slow.task_id })).status, "cancelled");

  const bad = await call(client, "task_status", { task_id: "../x" });
  assert.equal(bad.status, "failed");
});

test("MCP delegate_task accepts rules=check and surfaces meta.rules", async (t) => {
  const s = sandbox(t);
  const client = await connect(s.env);
  t.after(() => client.close());
  fs.writeFileSync(path.join(s.cwd, "CLAUDE.md"), "# rules\n");
  const started = await call(client, "delegate_task", {
    target_agent: "codex", prompt: "hi", cwd: s.cwd, rules: "check",
  });
  assert.equal(started.status, "running");
  await call(client, "task_wait", { task_ids: [started.task_id], wait_seconds: 10 });
  const view = await call(client, "task_status", { task_id: started.task_id });
  assert.equal(view.rules?.mode, "check");
  assert.deepEqual(view.rules?.unseen, ["CLAUDE.md"]);
});

test("MCP delegate_task: dirty_worktree / allow_dirty / isolate", async (t) => {
  const s = sandbox(t);
  gitInit(s.cwd);
  fs.writeFileSync(path.join(s.cwd, "keep.txt"), "dirty\n");
  const client = await connect(s.env);
  t.after(() => client.close());

  const blocked = await call(client, "delegate_task", { target_agent: "codex", prompt: "hi", cwd: s.cwd });
  assert.equal(blocked.status, "dirty_worktree");
  assert.ok(blocked.dirty_paths.includes("keep.txt"));

  const allowed = await call(client, "delegate_task", {
    target_agent: "codex", prompt: "hi", cwd: s.cwd, allow_dirty: true,
  });
  assert.equal(allowed.status, "running");
  assert.equal(allowed.allow_dirty, true);
  await call(client, "task_wait", { task_ids: [allowed.task_id], wait_seconds: 10 });

  const isolated = await call(client, "delegate_task", {
    target_agent: "codex", prompt: "hi", cwd: s.cwd, isolate: true,
  });
  assert.equal(isolated.status, "running");
  assert.ok(isolated.worktree?.path);
  assert.match(isolated.worktree.branch, /^baton\/task-/);
  await call(client, "task_wait", { task_ids: [isolated.task_id], wait_seconds: 10 });
});
