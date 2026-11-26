import type { Adapter, BatonEvent, Effort, EventData } from "../types.ts";
import { redact } from "../redact.ts";
import { authHit, which } from "./common.ts";

const AUTH = ["not authenticated", "please log in", "agent login"];

function event(data: EventData): BatonEvent[] {
  return [{ ts: new Date().toISOString(), turn: 0, ...data }];
}

function parse(line: string): any {
  try { return JSON.parse(line); } catch { return null; }
}

/**
 * Build the Cursor `--model` value.
 * Verified 2026-11-23 (cursor-agent 2026.11.22): any `<id>[effort=…]` form is rejected ("Cannot use this model");
 * the tier lives in the model id itself (e.g. gpt-5.3-codex-high), so `--effort` cannot be mapped.
 */
export function resolveCursorModelArg(
  model: string | null | undefined,
  effort: Effort | null | undefined,
): string | null {
  if (effort) throw new Error("cursor does not support --effort; pick a model id that embeds the tier (see `cursor-agent --list-models`), e.g. --model gpt-5.3-codex-high.");
  const id = typeof model === "string" ? model.trim() : "";
  return id || null;
}

export const cursor: Adapter = {
  id: "cursor",
  readonlyEnforcement: "agent-enforced",
  // Verified 2026-11-21: AGENTS.md, CLAUDE.md, .cursor/rules/*.mdc, .cursorrules. --approve-mcps defaults false.
  rules: {
    files: ["AGENTS.md", "CLAUDE.md", ".cursor/rules", ".cursorrules"],
    rulesyncTarget: "cursor",
    gates: {
      mcp: "Project MCP servers need --approve-mcps; Baton only passes --trust, so project MCP may not load.",
    },
  },
  resolve(env) {
    // The cursor-agent name does not collide with the IDE's `cursor` and is matched before any other `agent` on PATH.
    return which(["cursor-agent", "agent"], env);
  },
  build({ bin, cwd, prompt, sessionId, reasoningEffort, model, mode }) {
    const args = ["--print"];
    if (mode === "readonly") args.push("--mode", "ask");
    else args.push("--force");
    args.push("--trust", "--output-format", "stream-json", "--workspace", cwd);
    const modelArg = resolveCursorModelArg(model, reasoningEffort);
    if (modelArg) args.push("--model", modelArg);
    if (sessionId) args.push("--resume", sessionId);
    // Prompt on stdin, not argv (see claude.ts).
    return { command: bin, args, stdin: prompt, modelArg: modelArg ?? undefined };
  },
  sessionIdFrom(line) {
    const obj = parse(line);
    return obj?.type === "system" && obj.subtype === "init" && typeof obj.session_id === "string" ? obj.session_id : null;
  },
  parseLine(line) {
    const obj = parse(line);
    if (!obj || typeof obj !== "object" || typeof obj.type !== "string") return null;
    // init is handled by sessionIdFrom; user is the prompt echo; thinking is a per-character increment that would only flood the output.
    if (["system", "user", "thinking"].includes(obj.type)) return [];
    if (obj.type === "assistant") {
      const text = (obj.message?.content ?? [])
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("");
      return text ? event({ type: "message", text }) : [];
    }
    if (obj.type === "tool_call" && obj.tool_call && typeof obj.tool_call === "object") {
      const key = Object.keys(obj.tool_call)[0];
      if (!key) return null;
      const call = obj.tool_call[key] ?? {};
      const name = key.replace(/ToolCall$/, "");
      const args = call.args ?? {};
      const detail = redact(String(args.command ?? args.path ?? JSON.stringify(args))).slice(0, 200);
      if (obj.subtype === "started") return event({ type: "tool_call", name, detail });
      if (obj.subtype === "completed") return event({ type: "tool_result", name, ok: Boolean(call.result?.success), detail });
      return null;
    }
    if (obj.type === "result") {
      // The final text was already emitted once as an assistant message; only report errors here.
      return obj.is_error ? event({ type: "error", text: redact(String(obj.result ?? "cursor returned an error")) }) : [];
    }
    return null;
  },
  isAuthFailure(text) {
    return authHit(text, AUTH);
  },
};
