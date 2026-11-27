import fs from "node:fs";
import path from "node:path";
import spawn from "cross-spawn";
import { createInterface } from "node:readline";
import { getAdapter } from "./adapters/index.ts";
import { buildPrompt, interpret } from "./contract.ts";
import { baselineToSnapshot, gitChanges, gitRepoRoot, gitSnapshot, pathsSinceBaseline } from "./git.ts";
import { applyScopePolicy, findScopeViolations, isDirUnderCwd, relativizeToTaskCwd } from "./scope.ts";
import { resolveRulesync, rulesGitRoot, rulesyncCheck } from "./rules.ts";
import { appendEvent, hasTurnEnded, readMeta, writeMeta, readTurn, writeTurn, taskDir, cancelRequestPath, lockTask } from "./store.ts";
import { redact } from "./redact.ts";
import { killGroup } from "./process.ts";
import { summarizeEvents, turnUsage } from "./metrics.ts";
import type { CheckResult, EventData, TaskStatus, TurnUsage } from "./types.ts";
const CHECK_TAIL = 4000;
const QUOTA_PHRASES = ["usage limit", "quota exceeded", "rate limit"];

function withoutHtml(text: string) {
  return String(text || "")
    .replace(/<!doctype[\s\S]*?(?:<\/html>|$)/gi, "")
    .replace(/<html[\s\S]*?(?:<\/html>|$)/gi, "")
    .trim();
}

function terminalReason(text: string) {
  let found = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/turn\.failed/i.test(trimmed)) continue;
    try {
      const obj = JSON.parse(trimmed);
      const msg = obj?.error?.message || obj?.message;
      if (typeof msg === "string" && msg.trim()) {
        found = msg.trim();
        continue;
      }
    } catch {
      // Plain log line, not a JSON event.
    }
    found = trimmed;
  }
  return found;
}

function isQuotaFailure(text: string) {
  const hay = String(text || "").toLowerCase();
  return QUOTA_PHRASES.some((phrase) => hay.includes(phrase));
}

function quotaSentence(text: string) {
  const lines = String(text || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isQuotaFailure(lines[i])) return lines[i].trim();
  }
  return "";
}

function failureSummary(stdout: string, stderr: string) {
  const combined = `${stdout || ""}\n${stderr || ""}`;
  const reason = terminalReason(combined);
  if (reason) return reason.slice(-8192);
  return (withoutHtml(stderr) || withoutHtml(stdout)).slice(-8192);
}

// Only POSIX needs a process group (killGroup). On Windows a detached child under a .cmd shim never produces output, and taskkill /T finds the tree through parent pids anyway.
const DETACHED = process.platform !== "win32";

export async function supervise(id: string): Promise<void> {
  // Test hook: simulate a slow ("<ms>") or crashing ("exit") supervisor start.
  const hook = process.env.BATON_TEST_SUPERVISE_START;
  if (hook === "exit") process.exit(1);
  if (hook) await new Promise((resolve) => setTimeout(resolve, Number(hook)));
  const release = lockTask(id);
  if (!release) return;
  const meta = readMeta(id);
  if (!meta || meta.status !== "running" || meta.supervisor_pid !== null) { release(); return; }
  let childPid: number | null = null;
  let stopped: "idle" | "max_duration" | "cancelled" | null = null;
  const stop = (reason: "idle" | "max_duration" | "cancelled") => {
    if (!stopped) {
      stopped = reason;
      meta.stop_reason = reason;
      meta.updated_at = new Date().toISOString();
      writeMeta(meta);
    }
    try { killGroup(childPid); } catch { /* 决定已落盘；杀进程失败留待孤儿收尾 */ }
    if (process.env.BATON_CRASH_AFTER_STOP_PERSIST === "1") process.exit(1);
  };
  const cancel = () => stop("cancelled");
  process.on("SIGTERM", cancel);
  // The request file is the portable path (Windows has no signal to send); SIGTERM only makes POSIX react sooner.
  const cancelFile = cancelRequestPath(id, meta.turn);
  const cancelWatch = setInterval(() => { if (fs.existsSync(cancelFile)) { clearInterval(cancelWatch); cancel(); } }, 250);
  cancelWatch.unref();
  try {
    meta.supervisor_pid = process.pid;
    meta.heartbeat_at = new Date().toISOString();
    writeMeta(meta);
  } finally { release(); }
  const turn = readTurn(id, meta.turn);
  const adapter = getAdapter(meta.target);
  if (!adapter) throw new Error("Unknown target.");
  const save = () => { meta.updated_at = new Date().toISOString(); writeMeta(meta); };
  const emit = (data: EventData) => {
    meta.last_event_at = new Date().toISOString();
    appendEvent(id, { ...data, ts: meta.last_event_at, turn: meta.turn });
    save();
  };
  emit({ type: "turn_started", author: turn.author, prompt_preview: redact(turn.prompt).slice(0, 200) });
  const heartbeat = setInterval(() => { meta.heartbeat_at = new Date().toISOString(); save(); }, 10_000);
  // Run the --check command in its own process group. Cancel reaches it through childPid; the idle limit only kills the check.
  const runCheck = async (command: string): Promise<CheckResult> => {
    const startedCheck = Date.now();
    const file = path.join(taskDir(id), "raw", `${meta.turn}.check.log`);
    fs.writeFileSync(file, "", { mode: 0o600 });
    let output = "";
    let lastOutput = startedCheck;
    let idle = false;
    let code: number | null = null;
    // The worker's heartbeat has already stopped; without this a check longer than 30s looks orphaned and gets killed.
    const beat = setInterval(() => { meta.heartbeat_at = new Date().toISOString(); save(); }, 10_000);
    let idleTimer: NodeJS.Timeout | undefined;
    try {
      const child = spawn(command, { shell: true, cwd: meta.cwd, env: { ...process.env, BATON_DELEGATION: "1" }, detached: DETACHED, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      childPid = child.pid ?? null;
      meta.child_pid = childPid;
      save();
      if (stopped) killGroup(childPid);
      const onData = (chunk: Buffer) => {
        lastOutput = Date.now();
        fs.appendFileSync(file, chunk);
        output = (output + chunk.toString()).slice(-200_000);
      };
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      idleTimer = setInterval(() => {
        if (Date.now() - lastOutput < meta.idle_timeout_s * 1000) return;
        idle = true;
        try { killGroup(childPid); } catch { /* already gone */ }
      }, 50);
      code = await new Promise<number | null>((resolve) => {
        child.once("error", (error) => { output += `\n${error.message}`; resolve(null); });
        child.once("close", resolve);
      });
    } finally {
      clearInterval(beat);
      clearInterval(idleTimer);
    }
    const result: CheckResult = { command, exit_code: code, duration_ms: Date.now() - startedCheck, output_tail: redact(output).slice(-CHECK_TAIL) };
    if (!stopped) result.status = idle ? "timed_out" : code === 0 ? "passed" : "failed";
    return result;
  };
  // rulesync --check before the idle timer so its duration does not count against the worker.
  if (meta.turn === 1 && meta.rules?.rulesync?.status === "pending") {
    const repoRoot = rulesGitRoot(meta.cwd) ?? meta.cwd;
    const rulesyncBin = resolveRulesync(repoRoot);
    if (rulesyncBin) {
      const checked = await rulesyncCheck(rulesyncBin, repoRoot);
      meta.rules.rulesync = {
        ...meta.rules.rulesync,
        status: checked.status,
        detail: checked.detail,
      };
      save();
    } else {
      meta.rules.rulesync = {
        ...meta.rules.rulesync,
        status: "skipped",
        detail: "rulesync not found in node_modules/.bin or PATH",
      };
      save();
    }
  }
  const before = gitSnapshot(meta.cwd);
  const metricEvents: EventData[] = [];
  let stdout = "";
  let stderr = "";
  let message = "";
  let code: number | null = null;
  let spec;
  let lastMessageCreated = false;
  const startedAt = Date.now();
  let lastByteAt = startedAt;
  const timeout = setInterval(() => {
    if (Date.now() - lastByteAt >= meta.idle_timeout_s * 1000) stop("idle");
    else if (meta.max_duration_s !== null && Date.now() - startedAt >= meta.max_duration_s * 1000) stop("max_duration");
  }, 50);
  try {
    const bin = adapter.resolve(process.env);
    if (!bin) throw new Error(`${meta.target} is not on PATH.`);
    spec = adapter.build({
      bin,
      cwd: meta.cwd,
      prompt: buildPrompt(turn.prompt, turn.files),
      sessionId: meta.session_id,
      reasoningEffort: meta.reasoning_effort ?? null,
      model: meta.model ?? null,
      mode: meta.mode ?? null,
    });
    meta.warning = spec.warning;
    if (meta.mode !== "readonly" && !gitRepoRoot(meta.cwd)) {
      const note = "cwd is not a git repository; changes cannot be tracked or reverted.";
      meta.warning = meta.warning ? `${meta.warning}; ${note}` : note;
    }
    if (spec.modelArg !== undefined) meta.model_argv = spec.modelArg;
    else delete meta.model_argv;
    if (spec.lastMessagePath) {
      fs.writeFileSync(spec.lastMessagePath, "", { mode: 0o600, flag: "wx" });
      lastMessageCreated = true;
    }
    const child = spawn(spec.command, spec.args, { cwd: meta.cwd, env: { ...process.env, BATON_DELEGATION: "1" }, detached: DETACHED, windowsHide: true, stdio: [spec.stdin == null ? "ignore" : "pipe", "pipe", "pipe"] });
    childPid = child.pid ?? null;
    meta.child_pid = childPid;
    if (stopped) killGroup(childPid);
    save();
    for (const stream of ["stdout", "stderr"] as const) {
      const file = path.join(taskDir(id), "raw", `${meta.turn}.${stream}.log`);
      fs.writeFileSync(file, "", { mode: 0o600 });
      const output = child[stream]!;
      output.on("data", (chunk: Buffer) => {
        lastByteAt = Date.now();
        fs.appendFileSync(file, chunk);
        // shortcut: Only the most recent 2MB is kept for interpretation; full output always stays in raw; extend parsing if markers must span windows.
        if (stream === "stdout") stdout = (stdout + chunk.toString()).slice(-2_000_000);
        else stderr = (stderr + chunk.toString()).slice(-2_000_000);
      });
      const reader = createInterface({ input: output, crlfDelay: Infinity });
      reader.on("line", (line) => {
        const session = stream === "stdout" ? adapter.sessionIdFrom(line) : null;
        if (session) meta.session_id = session;
        const events = stream === "stdout" ? adapter.parseLine(line) : null;
        if (events === null) emit({ type: "raw", stream, line });
        else for (const event of events) {
          if (event.type === "message") message = event.text;
          if (event.type === "tool_call" || event.type === "usage") metricEvents.push(event);
          emit(event);
        }
      });
    }
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdin?.on("error", () => {}); // the child CLI may exit before reading stdin; close will deliver the final result.
    child.stdin?.end(spec.stdin ?? undefined);
    code = await exited;
    if (spec.lastMessagePath) {
      try {
        const last = fs.readFileSync(spec.lastMessagePath, "utf8").trim();
        if (last) message = last;
      } catch { /* keep legacy behavior: use stream messages when the CLI wrote no file. */ }
    }
  } catch (error) {
    killGroup(childPid);
    stderr += (error as Error).message;
    emit({ type: "error", text: (error as Error).message });
    code = 1;
  } finally {
    clearInterval(heartbeat);
    clearInterval(timeout);
    if (lastMessageCreated && spec?.lastMessagePath) fs.rmSync(spec.lastMessagePath, { force: true });
  }
  const raw = `${stderr}\n${stdout}`;
  const marker = interpret(message || stdout);
  let final: TaskStatus = "failed";
  let summary = failureSummary(stdout, stderr);
  if (stopped) { final = stopped === "cancelled" ? "cancelled" : "timed_out"; summary = stopped === "cancelled" ? "Cancelled." : `Timed out: ${stopped}.`; }
  else if (code !== 0 && adapter.isAuthFailure(raw)) { final = "not_authenticated"; summary = stderr || message || stdout; }
  else if (code !== 0 && isQuotaFailure(raw)) { final = "quota_exceeded"; summary = terminalReason(raw) || quotaSentence(raw); }
  else if (marker?.kind === "decision") { final = "needs_input"; meta.decision = { question: marker.question, options: marker.options }; summary = marker.question; }
  else if (code === 0) { final = "success"; summary = marker?.kind === "result" ? marker.summary : message || stdout; }
  meta.summary = redact(summary).slice(-8192);
  meta.status = final;
  const after = gitSnapshot(meta.cwd);
  turn.git_changes = gitChanges(meta.cwd, before, after);
  const { activity, usage } = summarizeEvents(metricEvents);
  let previousRaw: TurnUsage["raw"] | null | undefined = meta.turn === 1 ? null : undefined;
  if (meta.turn > 1 && adapter.usageCumulative && usage) {
    try {
      previousRaw = readTurn(id, meta.turn - 1).usage?.raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  turn.activity = activity;
  turn.usage = turnUsage(adapter, usage, previousRaw);
  if (meta.mode === "readonly" && final === "success") {
    if (!meta.readonly_baseline) {
      const note = "readonly: not a git directory; skipping post-run check";
      meta.warning = meta.warning ? `${meta.warning}; ${note}` : note;
    } else if (!after) {
      final = "readonly_violation";
      meta.status = final;
      meta.summary = `readonly_violation: git snapshot failed\n${meta.summary ?? ""}`;
    } else {
      const dirty = pathsSinceBaseline(meta.cwd, baselineToSnapshot(meta.readonly_baseline), after);
      if (dirty.length) {
        final = "readonly_violation";
        meta.status = final;
        meta.summary = `readonly_violation: ${dirty.length} file(s)\n${meta.summary ?? ""}`;
      }
    }
  }
  if (meta.scope?.length && meta.scope_baseline && final !== "readonly_violation") {
    if (!after) {
      const note = "scope_violation: git snapshot failed; cannot verify scope";
      meta.warning = meta.warning ? `${meta.warning}; ${note}` : note;
      meta.scope_violations = ["<snapshot-unavailable>"];
      if ((meta.scope_on_violation ?? "warn") === "fail" && final === "success") {
        final = "scope_violation";
        meta.status = final;
        meta.summary = `scope_violation: see scope_violations\n${meta.summary ?? ""}`;
      }
    } else {
      try {
        const repoRoot = gitRepoRoot(meta.cwd) ?? meta.cwd;
        const relPaths = relativizeToTaskCwd(
          pathsSinceBaseline(meta.cwd, baselineToSnapshot(meta.scope_baseline), after),
          repoRoot,
          meta.cwd,
        );
        const violations = findScopeViolations(relPaths, meta.scope, {
          isDir: (pattern) => isDirUnderCwd(meta.cwd, pattern),
        });
        const applied = applyScopePolicy({
          final,
          policy: meta.scope_on_violation ?? "warn",
          violations,
          summary: meta.summary,
          warning: meta.warning,
        });
        final = applied.status;
        meta.status = final;
        meta.summary = applied.summary;
        meta.warning = applied.warning;
        meta.scope_violations = applied.scope_violations;
      } catch (error) {
        const note = `scope_violation: ${(error as Error).message}`;
        meta.warning = meta.warning ? `${meta.warning}; ${note}` : note;
        meta.scope_violations = ["<diff-unavailable>"];
        if ((meta.scope_on_violation ?? "warn") === "fail" && final === "success") {
          final = "scope_violation";
          meta.status = final;
          meta.summary = `scope_violation: see scope_violations\n${meta.summary ?? ""}`;
        }
      }
    }
  }
  if (final === "success" && meta.check_command && !stopped) {
    // Keep waiters blocked: the turn is not decided until the check ends.
    meta.status = "running";
    emit({ type: "check_started", command: redact(meta.check_command).slice(0, 200) });
    const check = await runCheck(meta.check_command);
    emit({ type: "check_ended", status: check.status ?? "cancelled", exit_code: check.exit_code });
    turn.check = check;
    meta.check = check;
    if (stopped === "cancelled") { final = "cancelled"; meta.summary = "Cancelled."; }
    else if (check.status !== "passed") {
      final = "check_failed";
      meta.summary = `check_failed: ${check.status === "timed_out" ? "timed out" : `exit ${check.exit_code}`}\n${check.output_tail}`.slice(0, 8192);
    }
    meta.status = final;
  }
  delete meta.stop_reason;
  turn.status = final;
  turn.summary = meta.summary;
  if (message.trim()) turn.final_message = redact(message.trim());
  writeTurn(id, turn);
  if (hasTurnEnded(id, meta.turn)) save();
  else emit({ type: "turn_ended", status: final, exit_code: code });
  process.off("SIGTERM", cancel);
  clearInterval(cancelWatch);
}
