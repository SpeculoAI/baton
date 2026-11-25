import type { Adapter, BatonEvent, EventData } from "../types.ts";
import { redact } from "../redact.ts";
import { authHit, which } from "./common.ts";

const AUTH = ["not logged in", "please run /login", "invalid api key"];

function stamp(data: EventData): BatonEvent {
  return { ts: new Date().toISOString(), turn: 0, ...data };
}

function parse(line: string): any {
  try { return JSON.parse(line); } catch { return null; }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("");
}

export const claude: Adapter = {
  id: "claude",
  readonlyEnforcement: "agent-enforced",
  // Verified 2026-11-21/22: CLAUDE.md hierarchy; AGENTS.md only when none of those three exist.
  // Baton uses -p, which loads project .mcp.json without an approval prompt (no mcp gate).
  rules: {
    files: ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"],
    conditional: [{ file: "AGENTS.md", unless: ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"] }],
    rulesyncTarget: "claudecode",
  },
  resolve(env) {
    return which(["claude"], env);
  },
  build({ bin, prompt, sessionId, reasoningEffort, model, mode }) {
    // stream-json requires --verbose with -p.
    const permission = mode === "readonly" ? "plan" : "acceptEdits";
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", permission, "--permission-prompts", "none"];
    if (reasoningEffort) args.push("--effort", reasoningEffort === "ultra" ? "max" : reasoningEffort);
    // Verified 2026-11-24 (Claude Code 2.1.332): --resume without --model falls back to the default model, so pass it every turn.
    const modelArg = model?.trim() || undefined;
    if (modelArg) args.push("--model", modelArg);
    if (sessionId) args.push("--resume", sessionId);
    args.push(prompt);
    return { command: bin, args, stdin: null, modelArg };
  },
  sessionIdFrom(line) {
    const obj = parse(line);
    return obj?.type === "system" && obj.subtype === "init" && typeof obj.session_id === "string" ? obj.session_id : null;
  },
  parseLine(line) {
    const obj = parse(line);
    if (!obj || typeof obj !== "object" || typeof obj.type !== "string") return null;
    // system: init is handled by sessionIdFrom; hook_* carries host hook output and stays out of the event stream.
    if (obj.type === "system" || obj.type === "rate_limit_event") return [];
    const parts: any[] = Array.isArray(obj.message?.content) ? obj.message.content : [];
    if (obj.type === "assistant") {
      const events: BatonEvent[] = [];
      const text = parts.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("");
      for (const p of parts) {
        if (p?.type !== "tool_use") continue;
        const input = p.input ?? {};
        const detail = redact(String(input.command ?? input.file_path ?? input.path ?? JSON.stringify(input))).slice(0, 200);
        events.push(stamp({ type: "tool_call", name: String(p.name ?? "tool"), detail }));
      }
      if (text) events.push(stamp({ type: "message", text }));
      return events;
    }
    if (obj.type === "user") {
      return parts
        .filter((p) => p?.type === "tool_result")
        .map((p) => stamp({ type: "tool_result", name: "tool", ok: p.is_error !== true, detail: redact(contentText(p.content)).slice(0, 200) }));
    }
    if (obj.type === "result") {
      // The final text was already emitted once as an assistant message; only report errors here.
      return obj.is_error ? [stamp({ type: "error", text: redact(String(obj.result ?? obj.subtype ?? "claude returned an error")) })] : [];
    }
    return null;
  },
  isAuthFailure(text) {
    return authHit(text, AUTH);
  },
};
