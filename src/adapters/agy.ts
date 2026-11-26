import type { Adapter, BatonEvent, EventData } from "../types.ts";
import { redact } from "../redact.ts";
import { authHit, which } from "./common.ts";

const AUTH = ["not logged in", "please log in", "authentication required"];

function event(data: EventData): BatonEvent[] {
  return [{ ts: new Date().toISOString(), turn: 0, ...data }];
}

function parse(line: string): any {
  try { return JSON.parse(line); } catch { return null; }
}

export const agy: Adapter = {
  id: "agy",
  readonlyEnforcement: "agent-enforced",
  // Verified 2026-11-21: AGENTS.md / GEMINI.md / .agents/rules (and legacy .agent/rules). No load gates surveyed.
  rules: {
    files: ["AGENTS.md", "GEMINI.md", ".agents/AGENTS.md", ".agents/GEMINI.md", ".agents/rules", ".agent/rules"],
    rulesyncTarget: "antigravity-cli",
  },
  resolve(env) {
    return which(["agy"], env);
  },
  build({ bin, prompt, sessionId, reasoningEffort, mode }) {
    // Verified 2026-11-25: agy has no plain-text stdin. `--print=` (empty) plus stream-json input reads one {"event":"user","message":{"content":…}} line per turn from stdin.
    const args = ["--print=", "--mode", mode === "readonly" ? "plan" : "accept-edits", "--input-format", "stream-json", "--output-format", "stream-json"];
    if (reasoningEffort) args.push("--effort", reasoningEffort === "ultra" ? "max" : reasoningEffort);
    if (sessionId) args.push("--conversation", sessionId);
    return { command: bin, args, stdin: `${JSON.stringify({ event: "user", message: { content: prompt } })}\n` };
  },
  sessionIdFrom(line) {
    const obj = parse(line);
    return obj?.event === "init" && typeof obj.conversation_id === "string" ? obj.conversation_id : null;
  },
  parseLine(line) {
    const obj = parse(line);
    if (!obj || typeof obj !== "object" || typeof obj.event !== "string") return null;
    if (obj.event === "init") return [];
    if (obj.event === "step_update") {
      const step = obj.step_update ?? {};
      // agent_response text_delta events are per-character increments; the full reply appears once in result.response,
      // otherwise marker parsing would only see the last increment.
      if (step.step_type !== "tool") return [];
      const name = String(step.tool_name ?? step.tool_info?.name ?? "tool");
      const detail = redact(JSON.stringify(step.tool_info?.parameters ?? {})).slice(0, 200);
      if (step.state === "ACTIVE") return event({ type: "tool_call", name, detail });
      return event({ type: "tool_result", name, ok: step.state === "DONE", detail });
    }
    if (obj.event === "result") {
      const result = obj.result ?? {};
      if (result.status !== "SUCCESS") return event({ type: "error", text: redact(String(result.response || result.status || "agy returned an error")) });
      return typeof result.response === "string" && result.response ? event({ type: "message", text: result.response }) : [];
    }
    return null;
  },
  isAuthFailure(text) {
    return authHit(text, AUTH);
  },
};
