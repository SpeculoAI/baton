import type { Adapter, BatonEvent, Effort, EventData } from "../types.ts";
import { redact } from "../redact.ts";
import { authHit, which } from "./common.ts";

const AUTH = ["not authenticated", "please log in", "agent login"];
const EMBEDDED_EFFORT = /-(low|medium|high|xhigh|ultra|max)(-fast)?$/i;

function event(data: EventData): BatonEvent[] {
  return [{ ts: new Date().toISOString(), turn: 0, ...data }];
}

function parse(line: string): any {
  try { return JSON.parse(line); } catch { return null; }
}

/** Build the Cursor `--model` value. Never emits two competing model args. */
export function resolveCursorModelArg(
  model: string | null | undefined,
  effort: Effort | null | undefined,
): string | null {
  const id = typeof model === "string" ? model.trim() : "";
  const e = effort || null;
  if (id && e) {
    if (id.includes("[")) throw new Error("Model already has a parameter bracket; do not pass --effort.");
    if (EMBEDDED_EFFORT.test(id)) throw new Error(`Model ${id} already includes an effort level; do not pass --effort.`);
    return `${id}[effort=${e}]`;
  }
  if (id) return id;
  if (e) return `auto[effort=${e}]`;
  return null;
}

export const cursor: Adapter = {
  id: "cursor",
  readonlyEnforcement: "agent-enforced",
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
    args.push(prompt);
    return { command: bin, args, stdin: null, modelArg: modelArg ?? undefined };
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
