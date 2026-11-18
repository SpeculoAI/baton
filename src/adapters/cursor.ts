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
    if (id.includes("[")) throw new Error("模型已含参数括号，不要再传 --effort。");
    if (EMBEDDED_EFFORT.test(id)) throw new Error(`模型 ${id} 已含档位，不要再传 --effort。`);
    return `${id}[effort=${e}]`;
  }
  if (id) return id;
  if (e) return `auto[effort=${e}]`;
  return null;
}

export const cursor: Adapter = {
  id: "cursor",
  resolve(env) {
    // cursor-agent 名字不会撞上 IDE 的 `cursor`，也比 PATH 里别的 `agent` 先命中。
    return which(["cursor-agent", "agent"], env);
  },
  build({ bin, cwd, prompt, sessionId, reasoningEffort, model }) {
    const args = ["--print", "--force", "--trust", "--output-format", "stream-json", "--workspace", cwd];
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
    // init 由 sessionIdFrom 处理；user 是 prompt 回显；thinking 是逐字增量，只会刷屏。
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
      // 最终文本已经以 assistant 消息出过一次，这里只报错误。
      return obj.is_error ? event({ type: "error", text: redact(String(obj.result ?? "cursor 返回错误")) }) : [];
    }
    return null;
  },
  isAuthFailure(text) {
    return authHit(text, AUTH);
  },
};
