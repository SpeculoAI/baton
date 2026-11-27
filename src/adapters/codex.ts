import type { Adapter, BatonEvent, EventData, TurnUsage } from "../types.ts";
import { redact } from "../redact.ts";
import os from "node:os";
import path from "node:path";
import { authHit, shellIntent, usageEvent, which } from "./common.ts";

const AUTH = ["not logged in", "please log in", "authentication required", "codex login"];

function normalizeUsage(raw: TurnUsage["raw"]): Omit<TurnUsage, "raw"> | undefined {
  const { input_tokens: input, cached_input_tokens: cached_input, output_tokens: output, reasoning_output_tokens: reasoning } = raw;
  if (![input, cached_input, output].every(Number.isFinite)) return undefined;
  return { input, cached_input, output, ...(reasoning === undefined ? {} : { reasoning }) };
}

export const codex: Adapter = {
  id: "codex",
  usage: normalizeUsage,
  usageCumulative: true,
  readonlyEnforcement: "os-sandbox",
  // Verified 2026-11-21/22: AGENTS.md (+ override). Project .codex/config.toml MCP/hooks need trust.
  rules: {
    files: ["AGENTS.md", "AGENTS.override.md"],
    rulesyncTarget: "codexcli",
    gates: {
      mcp: "Project .codex/config.toml (where rulesync writes Codex MCP) loads only for trusted project paths; a baton worktree is a separate absolute path and does not inherit the main repo's trust_level.",
      hooks: "Project hooks require persisted hook trust; codex exec has --dangerously-bypass-hook-trust (Baton does not pass it).",
    },
  },
  resolve(env) {
    return which(["codex"], env);
  },
  build({ bin, cwd, prompt, sessionId, reasoningEffort, model, mode }) {
    const lastMessagePath = path.join(os.tmpdir(), `baton-codex-${process.pid}-${Date.now()}.txt`);
    // `-m` is accepted by both `exec` and `exec resume` (codex-cli 0.171.0).
    const modelArg = model?.trim() || undefined;
    const optionArgs = [
      ...(modelArg ? ["-m", modelArg] : []),
      ...(reasoningEffort ? ["-c", `model_reasoning_effort="${reasoningEffort}"`] : []),
    ];
    const readonly = mode === "readonly";
    // `exec resume` does not accept --cd/--color/--sandbox. The first write turn uses --approve-for-me (workspace-write; do not add --sandbox).
    if (sessionId) {
      return {
        command: bin,
        args: [
          "exec",
          "resume",
          "--json",
          "--skip-git-repo-check",
          "--output-last-message",
          lastMessagePath,
          ...optionArgs,
          sessionId,
          "-",
        ],
        stdin: prompt,
        lastMessagePath,
        modelArg,
      };
    }
    return {
      command: bin,
      args: [
        "exec",
        "--json",
        "--color",
        "never",
        ...(readonly ? ["--sandbox", "read-only"] : ["--approve-for-me"]),
        "--skip-git-repo-check",
        "--cd",
        cwd,
        "--output-last-message",
        lastMessagePath,
        ...optionArgs,
        "-",
      ],
      stdin: prompt,
      lastMessagePath,
      modelArg,
    };
  },
  sessionIdFrom(line) {
    try {
      const obj = JSON.parse(line);
      return obj?.type === "thread.started" && typeof obj.thread_id === "string" ? obj.thread_id : null;
    } catch { return null; }
  },
  parseLine(line) {
    let obj;
    try { obj = JSON.parse(line); } catch { return null; }
    if (!obj || typeof obj !== "object") return null;
    const event = (data: EventData): BatonEvent[] => [{ ts: new Date().toISOString(), turn: 0, ...data }];
    if (obj.type === "turn.failed" && typeof obj.error?.message === "string") return event({ type: "error", text: obj.error.message });
    if (obj.type === "turn.completed") {
      const usage = usageEvent(obj.usage, normalizeUsage);
      return usage ? event(usage) : [];
    }
    // The session ID and turn lifecycle are handled separately by the supervisor.
    if (obj.type === "thread.started" || obj.type === "turn.started") return [];
    const item = obj.item;
    if (obj.type === "item.completed" && item?.type === "error" && typeof item.message === "string") {
      return event({ type: "error", text: redact(item.message) });
    }
    if (!item || !["item.started", "item.completed"].includes(obj.type)) return null;
    const completed = obj.type === "item.completed";
    if (item.type === "agent_message" && typeof item.text === "string") return completed ? event({ type: "message", text: item.text }) : [];
    if (item.type === "command_execution" && typeof item.command === "string") {
      if (completed) {
        return event({ type: "tool_result", name: "command_execution", ok: item.exit_code === 0, detail: redact(String(item.aggregated_output || item.command)).slice(0, 200) });
      }
      const intent = shellIntent(item.command);
      return event({ type: "tool_call", name: "command_execution", kind: "shell", ...(intent ? { intent } : {}), detail: redact(item.command).slice(0, 200) });
    }
    if (item.type === "file_change" && Array.isArray(item.changes)) {
      const detail = redact(JSON.stringify(item.changes)).slice(0, 200);
      return event(completed
        ? { type: "tool_result", name: "file_change", ok: item.status === "completed", detail }
        : { type: "tool_call", name: "file_change", kind: "edit", detail });
    }
    if (!completed && typeof item.type === "string" && item.type.endsWith("_tool_call")) {
      const detail = [item.server, item.tool].filter((value) => typeof value === "string").join(":");
      return event({ type: "tool_call", name: item.type, kind: "other", detail: redact(detail).slice(0, 200) });
    }
    return null;
  },
  isAuthFailure(text) {
    return authHit(text, AUTH);
  },
};
