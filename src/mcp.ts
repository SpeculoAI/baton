import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { agents, apply, cancel, diff, ls, reply, result, start, status, wait } from "./tasks.ts";
import { redact } from "./redact.ts";
import type { Author, Effort, RulesMode, ScopeOnViolation, TaskMode } from "./types.ts";

const MAX_WAIT_SECONDS = 55;
const PROGRESS_MS = 15_000;

// Each tool only delegates to tasks.ts; the MCP process keeps no task state, so tasks remain readable after a restart.
async function respond(run: () => unknown): Promise<{ content: { type: "text"; text: string }[] }> {
  let value: unknown;
  try { value = await run(); } catch (error) {
    value = { status: "failed", summary: redact((error as Error).message) };
  }
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "baton", version: JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version });
  server.registerTool("list_agents", { description: "List local CLIs available for delegation and whether each is installed." }, () => respond(() => ({ agents: agents() })));
  server.registerTool("delegate_task", {
    description: "Delegate a bounded task to another local AI CLI. Returns task_id immediately (status=running); the task runs in a separate process and survives exit of this MCP process or the host session. Then use task_wait for a bounded wait.",
    inputSchema: {
      target_agent: z.enum(["codex", "claude", "cursor", "agy", "kimi"]),
      prompt: z.string(),
      files: z.array(z.string()).optional(),
      reasoning_effort: z.enum(["low", "medium", "high", "ultra"]).optional(),
      model: z.string().optional().describe("Per-task model (cursor, codex, claude and kimi; stored in meta and carried over by reply)."),
      idle_timeout_seconds: z.number().optional().describe("Stop after this long with no output at all; default 600."),
      max_duration_seconds: z.number().optional().describe("Maximum total duration per turn; default unlimited."),
      cwd: z.string().optional(),
      scope: z.array(z.string()).optional().describe("Path globs allowed to change (repeatable); checked against the net changes after the task ends."),
      scope_on_violation: z.enum(["warn", "fail"]).optional().describe("Out-of-scope policy; default warn."),
      mode: z.enum(["readonly", "write"]).optional().describe("Permission mode; default write. readonly maps to each CLI's read-only flags."),
      allow_weak: z.boolean().optional().describe("Explicitly allow --mode readonly only when the target cannot enforce read-only."),
      isolate: z.boolean().optional().describe("Create a git worktree and run the write job there (default false)."),
      allow_dirty: z.boolean().optional().describe("Allow in-place write on a dirty working tree (default false)."),
      rules: z.enum(["check", "pointer", "off"]).optional().describe("Project rules discovery; default check. pointer injects unread rule paths into the first-turn prompt."),
      check: z.string().optional().describe("Shell command Baton runs in the task cwd after each successful turn; a non-zero exit ends the turn as check_failed."),
    },
  }, (args) => respond(() => start({
    target: args.target_agent, prompt: args.prompt, files: args.files, cwd: args.cwd,
    reasoningEffort: args.reasoning_effort as Effort | undefined, model: args.model,
    idleTimeout: args.idle_timeout_seconds, maxDuration: args.max_duration_seconds,
    scope: args.scope, scopeOnViolation: args.scope_on_violation as ScopeOnViolation | undefined,
    mode: args.mode as TaskMode | undefined, allowWeak: args.allow_weak,
    isolate: args.isolate, allowDirty: args.allow_dirty,
    rules: args.rules as RulesMode | undefined,
    check: args.check,
  })));
  server.registerTool("task_status", {
    description: "Get a task's current status. While running, includes liveness (active/quiet/orphaned) and quiet_for_s.",
    inputSchema: { task_id: z.string() },
  }, (args) => respond(() => status(args.task_id)));
  server.registerTool("task_wait", {
    description: `Bounded wait: returns as soon as any task leaves running; if still running at wait_seconds (default 50, max ${MAX_WAIT_SECONDS}), returns running and the caller can simply call again.`,
    inputSchema: { task_ids: z.array(z.string()).min(1), wait_seconds: z.number().optional() },
  }, (args, extra) => respond(async () => {
    const seconds = Math.min(Math.max(args.wait_seconds ?? 50, 0), MAX_WAIT_SECONDS);
    const token = extra?._meta?.progressToken;
    let step = 0;
    const timer = token == null ? null : setInterval(() => {
      step += 1;
      const quiet = args.task_ids.map((id) => { try { return `${id.slice(0, 8)} ${status(id).quiet_for_s ?? "?"}s without output`; } catch { return id; } }).join("; ");
      extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: step, message: quiet } }).catch(() => {});
    }, PROGRESS_MS);
    try { return await wait(args.task_ids, seconds); } finally { if (timer) clearInterval(timer); }
  }));
  server.registerTool("task_result", {
    description: "Get the agent's full final message of a finished turn (default: the latest), without the tool-call transcript. task_status/task_wait only carry the one-line summary.",
    inputSchema: { task_id: z.string(), turn: z.number().int().optional() },
  }, (args) => respond(() => result(args.task_id, args.turn)));
  server.registerTool("task_diff", {
    description: "Net change of an --isolate task since its worktree was created (worker commits, edits and new files; Baton's own worktree files excluded). stat=true returns a diffstat instead of the patch.",
    inputSchema: { task_id: z.string(), stat: z.boolean().optional() },
  }, (args) => respond(() => ({ task_id: args.task_id, diff: diff(args.task_id, { stat: args.stat }) })));
  server.registerTool("task_apply", {
    description: "Bring an --isolate task's net change onto the source repo's current branch as one local commit (three-way cherry-pick; never pushes). Refuses, changing nothing, on staged changes, overlapping dirty or untracked files, an operation in progress, or a conflict. remove=true then deletes the worktree and branch. Only with the user's consent.",
    inputSchema: { task_id: z.string(), remove: z.boolean().optional() },
  }, (args) => respond(() => apply(args.task_id, { remove: args.remove })));
  server.registerTool("task_reply", {
    description: "After a task stops at needs_input, success, scope_violation, readonly_violation or check_failed, start the next turn in the same session. as=human means a human said it; default host. Returns busy while running.",
    inputSchema: { task_id: z.string(), prompt: z.string(), as: z.enum(["host", "human"]).optional() },
  }, (args) => respond(() => reply(args.task_id, args.prompt, (args.as ?? "host") as Author)));
  server.registerTool("task_cancel", {
    description: "Stop a running task (kills the whole process group).",
    inputSchema: { task_id: z.string() },
  }, (args) => respond(() => cancel(args.task_id)));
  server.registerTool("task_list", {
    description: "List tasks, newest update first. By default lists only tasks under cwd (or BATON_CWD); all=true lists everything.",
    inputSchema: { all: z.boolean().optional(), cwd: z.string().optional() },
  }, (args) => respond(() => ({ tasks: ls(args.all ?? false, args.cwd ?? process.env.BATON_CWD ?? process.cwd()) })));
  return server;
}

export async function startMcp(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
