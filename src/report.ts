import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import spawn from "cross-spawn";
import { redact } from "./redact.ts";
import { readMeta, taskDir } from "./store.ts";
import { agents } from "./tasks.ts";
import type { BatonEvent, TaskMeta } from "./types.ts";

const REPO = "SpeculoAI/baton";
const ISSUE_NEW_URL = `https://github.com/${REPO}/issues/new`;
const MAX_URL_LEN = 3500;
const MAX_EVENTS = 30;
const MAX_TEXT = 200;

export interface DiagnosticReport {
  title: string;
  labels: string[];
  markdown: string;
  issueUrl: string;
}

export interface ReportOptions {
  title?: string;
  /** Replaces the "What happened" placeholder; sanitized like everything else. */
  body?: string;
  /** Repo labels to apply; defaults to `bug`. */
  labels?: string[];
}

export interface SubmitResult {
  method: "gh" | "browser" | "url";
  url: string;
  submitted: boolean;
}

export interface SubmitDeps {
  spawnSync?: typeof spawn.sync;
  openBrowser?: (url: string) => boolean;
}

function replaceAllCase(text: string, needle: string, replacement: string): string {
  if (!needle) return text;
  if (process.platform !== "win32") return text.split(needle).join(replacement);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "gi"), replacement);
}

/** Redact secrets and replace home/cwd paths so user-specific paths never leave the machine. */
export function sanitize(text: string, cwd?: string): string {
  let out = redact(text);
  const paths: [string, string][] = [];
  if (cwd) {
    paths.push([cwd, "<cwd>"]);
    try {
      const real = fs.realpathSync.native(cwd);
      if (real !== cwd) paths.push([real, "<cwd>"]);
    } catch {}
  }
  const home = os.homedir();
  if (home) paths.push([home, "~"]);
  // Longest first so a cwd under home becomes <cwd>, not ~/...
  paths.sort((a, b) => b[0].length - a[0].length);
  for (const [needle, repl] of paths) out = replaceAllCase(out, needle, repl);
  return out;
}

function clip(text: string, limit = MAX_TEXT): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit)}...` : single;
}

function readVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Keep only baton-generated diagnostic summaries; drop agent-authored business summaries from success/needs_input. */
function safeSummary(meta: TaskMeta): string | undefined {
  if (!meta.summary || meta.status === "success" || meta.status === "needs_input") return undefined;
  const firstLine = meta.summary.split(/\r?\n/, 1)[0] ?? "";
  return clip(sanitize(firstLine, meta.cwd));
}

function readEventSkeleton(id: string, cwd?: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(taskDir(id), "events.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: BatonEvent;
    try { ev = JSON.parse(line) as BatonEvent; } catch { continue; }
    const parts = [ev.ts, `t${ev.turn}`, ev.type];
    if (ev.type === "turn_ended") {
      parts.push(`status=${ev.status}`, `exit=${ev.exit_code ?? "null"}`);
    } else if (ev.type === "check_ended") {
      parts.push(`status=${ev.status}`, `exit=${ev.exit_code ?? "null"}`);
    } else if (ev.type === "error") {
      parts.push(clip(sanitize(ev.text, cwd)));
    }
    lines.push(parts.join(" "));
  }
  return lines.slice(-MAX_EVENTS);
}

function makeIssueUrl(title: string, labels: string[], body: string, shortBody: string): string {
  const make = (b: string) => `${ISSUE_NEW_URL}?${new URLSearchParams({ title, labels: labels.join(","), body: b }).toString()}`;
  const full = make(body);
  return full.length <= MAX_URL_LEN ? full : make(shortBody);
}

export function buildReport(taskId?: string, opts: ReportOptions = {}): DiagnosticReport {
  const meta = taskId ? readMeta(taskId) : null;
  if (taskId && !meta) throw new Error("No such task.");

  const detected = agents().map((a) => `- ${a.id}: ${a.installed ? (a.version ? clip(sanitize(a.version), 80) : "installed") : "not installed"}`);
  const envSection = [
    "### Environment",
    `- baton: ${readVersion()}`,
    `- node: ${process.version}`,
    `- os: ${process.platform} ${process.arch} (${os.release()})`,
    "- agents:",
    ...detected.map((line) => `  ${line}`),
  ];

  const taskSection: string[] = [];
  if (meta) {
    const fields: [string, string | number | boolean | undefined][] = [
      ["target", meta.target],
      ["status", meta.status],
      ["turn", meta.turn],
      ["mode", meta.mode],
      ["enforcement", meta.enforcement],
      ["isolated", Boolean(meta.worktree)],
      ["stop_reason", meta.stop_reason],
      ["idle_timeout_s", meta.idle_timeout_s],
      ["max_duration_s", meta.max_duration_s ?? undefined],
      ["scope_on_violation", meta.scope_on_violation],
      ["rules_mode", meta.rules?.mode],
      ["rulesync_status", meta.rules?.rulesync?.status],
      ["check", meta.check ? `${meta.check.status} (exit=${meta.check.exit_code ?? "null"}, ${meta.check.duration_ms}ms)` : undefined],
      ["summary", safeSummary(meta)],
    ];
    taskSection.push(
      "",
      "### Task (redacted)",
      ...fields.filter(([, value]) => value !== undefined).map(([key, value]) => `- ${key}: ${value}`),
    );
    const timeline = readEventSkeleton(meta.task_id, meta.cwd);
    if (timeline.length) {
      taskSection.push("", "### Event timeline", "```text", ...timeline, "```");
    }
  }

  const header = [
    "> Review before posting: remove any project-specific terms if present.",
    "",
    "### What happened",
    opts.body?.trim() ? sanitize(opts.body.trim(), meta?.cwd) : "<!-- Describe what you expected vs. what happened -->",
    "",
  ];
  const markdown = [...header, ...envSection, ...taskSection].join("\n");
  const title = opts.title?.trim() || (meta ? `bug(${meta.target}): ${meta.status}` : "bug: <describe issue>");
  const given = (opts.labels ?? []).map((l) => l.trim()).filter(Boolean);
  const labels = given.length ? given : ["bug"];
  const shortBody = [
    ...header,
    ...envSection,
    "",
    "<!-- Full task timeline omitted for URL length; paste the output of `baton report` here -->",
  ].join("\n");
  const issueUrl = makeIssueUrl(title, labels, markdown, shortBody);
  return { title, labels, markdown, issueUrl };
}

function defaultOpenBrowser(url: string): boolean {
  try {
    // Windows: rundll32 avoids cmd.exe, which would split the URL on `&`.
    const [cmd, args] = process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function submitReport(report: DiagnosticReport, deps: SubmitDeps = {}): SubmitResult {
  const runSync = deps.spawnSync ?? spawn.sync;
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;

  const auth = runSync("gh", ["auth", "status"], { stdio: "ignore", windowsHide: true });
  if (auth.status === 0) {
    const ghOpts = { input: report.markdown, encoding: "utf8" as const, windowsHide: true };
    const args = (labels: string[]) => ["issue", "create", "-R", REPO, "--title", report.title, ...labels.flatMap((l) => ["--label", l]), "--body-file", "-"];
    let created = runSync("gh", args(report.labels), ghOpts);
    // External users without triage/label rights may fail on --label; retry once without it.
    if (created.status !== 0 && report.labels.length && /label|permission/i.test(created.stderr ?? "")) {
      created = runSync("gh", args([]), ghOpts);
    }
    const url = (created.stdout ?? "").trim();
    if (created.status === 0 && url) return { method: "gh", url, submitted: true };
  }

  if (openBrowser(report.issueUrl)) return { method: "browser", url: report.issueUrl, submitted: false };
  return { method: "url", url: report.issueUrl, submitted: false };
}
