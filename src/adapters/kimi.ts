import type { Adapter, BatonEvent, EventData, SpawnSpec, ToolKind } from "../types.ts";
import { redact } from "../redact.ts";
import { assertArgvSafe, authHit, shellIntent, which } from "./common.ts";

// Verified 2026-11-26 (kimi 2.8.0): stderr when no account or model is set up.
const AUTH = ["no model configured", "use /login"];
// Verified 2026-11-26 (kimi 2.8.0): the Bash tool result has no status field, only this trailer on failure.
const FAILED = /Command failed with exit code: \d+\.\s*$/;
const KINDS = new Map<string, ToolKind>([
  ["Read", "read"], ["Grep", "search"], ["Glob", "search"],
  ["Edit", "edit"], ["Write", "edit"], ["Bash", "shell"],
]);

function stamp(data: EventData): BatonEvent {
  return { ts: new Date().toISOString(), turn: 0, ...data };
}

function parse(line: string): any {
  try { return JSON.parse(line); } catch { return null; }
}

export const kimi: Adapter = {
  id: "kimi",
  // No readonlyEnforcement: -p always runs with auto permission and cannot take --plan (verified 2026-11-26, kimi 2.8.0).
  // `--agent explore` is read-only but its sessions fail to resume ("tool \"Agent\" is not declared"), so reply would break.
  // Verified 2026-11-26: AGENTS.md and .kimi-code/AGENTS.md at every level from the git root to cwd; CLAUDE.md is not read.
  rules: {
    files: ["AGENTS.md", ".kimi-code/AGENTS.md"],
    rulesyncTarget: "kimi-code",
    gates: {
      mcp: "Project .kimi-code/mcp.json loads under kimi -p only in a trusted workspace (or with KIMI_CODE_TRUST_WORKSPACE=1); Baton sets neither.",
      hooks: "rulesync writes kimi-code hooks only with --global; project hooks are not generated.",
    },
  },
  resolve(env) {
    return which(["kimi"], env);
  },
  build({ bin, prompt, sessionId, reasoningEffort, model }) {
    // Verified 2026-11-26 (kimi 2.8.0): -p has no stdin form (`-p -` is taken literally), so the prompt goes in argv.
    const args = ["-p", prompt, "--output-format", "stream-json"];
    // Verified 2026-11-26: -m is honoured on -S resume, so pass it every turn.
    const modelArg = model?.trim() || undefined;
    if (modelArg) args.push("-m", modelArg);
    if (sessionId) args.push("-S", sessionId);
    assertArgvSafe(bin, args, process.platform, "Install the native kimi.exe with the official install.ps1 instead of the npm package.");
    const spec: SpawnSpec = { command: bin, args, stdin: null };
    if (modelArg) spec.modelArg = modelArg;
    // kimi has no thinking-effort flag (only config.toml [thinking] effort).
    if (reasoningEffort) spec.warning = `kimi has no command-line thinking effort; --effort ${reasoningEffort} was ignored.`;
    return spec;
  },
  sessionIdFrom(line) {
    const obj = parse(line);
    return obj?.role === "meta" && obj.type === "session.resume_hint" && typeof obj.session_id === "string" ? obj.session_id : null;
  },
  parseLine(line) {
    const obj = parse(line);
    if (!obj || typeof obj !== "object" || typeof obj.role !== "string") return null;
    // system.version and session.resume_hint (handled by sessionIdFrom) stay out of the event stream.
    if (obj.role === "meta") return [];
    if (obj.role === "assistant") {
      const calls: any[] = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
      const events = calls.map((call) => {
        const name = String(call?.function?.name ?? "tool");
        const kind = KINDS.get(name) ?? "other";
        const raw = call?.function?.arguments;
        const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
        const input = parse(text);
        const command = input?.command;
        const intent = kind === "shell" && typeof command === "string" ? shellIntent(command) : undefined;
        const detail = redact(String(command ?? input?.path ?? input?.file_path ?? text)).slice(0, 200);
        return stamp({ type: "tool_call", name, kind, ...(intent ? { intent } : {}), detail });
      });
      if (typeof obj.content === "string" && obj.content) events.push(stamp({ type: "message", text: obj.content }));
      return events;
    }
    if (obj.role === "tool") {
      const content = typeof obj.content === "string" ? obj.content : JSON.stringify(obj.content ?? "");
      return [stamp({ type: "tool_result", name: "tool", ok: !FAILED.test(content), detail: redact(content).slice(0, 200) })];
    }
    return null;
  },
  isAuthFailure(text) {
    return authHit(text, AUTH);
  },
};
