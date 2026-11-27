import * as p from "@clack/prompts";
import type { Writable } from "node:stream";
import type { Action } from "./install.ts";
import type { InstallChoice, Preview, RulesInitResult, RulesPrompter, SourceChoice } from "./rulesync-setup.ts";

/**
 * Prefer stdout when it is a TTY — clack cursor redraws are more reliable there (iTerm2).
 * Soft migrate noise is suppressed separately in install.ts; pad columns when the stream reports 0.
 */
function uiOutput(): Writable {
  const stream = process.stdout.isTTY ? process.stdout : process.stderr;
  const columns = Math.max(stream.columns || 0, process.stdout.columns || 0, process.stderr.columns || 0, Number(process.env.COLUMNS) || 0, 80);
  if (stream.columns === columns) return stream;
  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === "columns") return columns;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const out = uiOutput();
const opts = { output: out };

export type HostChoice = { id: string; label: string };

export function beginAction(action: string): void {
  p.intro(`baton ${action}`, opts);
}

export function endAction(message: string): void {
  p.outro(message, opts);
}

export function cancelAction(message = "Cancelled."): void {
  p.cancel(message, opts);
}

/** Returns selected host ids, or `null` if the user cancelled / selected none. */
export async function multiselectHosts(detected: HostChoice[]): Promise<string[] | null> {
  const ids = detected.map((host) => host.id);
  const selected = await p.multiselect({
    message: "Install plugin for which agents?",
    options: detected.map((host) => ({ value: host.id, label: `${host.label} (${host.id})` })),
    initialValues: ids,
    required: false,
    ...opts,
  });
  if (p.isCancel(selected) || selected.length === 0) return null;
  return selected;
}

export function notePlan(title: string, lines: string[]): void {
  p.note(lines.join("\n") || "(nothing)", title, opts);
}

export function logSuccess(message: string): void {
  p.log.success(message, opts);
}

export function logError(message: string): void {
  p.log.error(message, opts);
}

export function logInfo(message: string): void {
  p.log.info(message, opts);
}

export function logWarning(message: string): void {
  p.log.warn(message, opts);
}

export function createSpinner() {
  return p.spinner(opts);
}

const INSTALL_LABELS: Record<InstallChoice, string> = {
  project: "Install into this project (npm i -D rulesync)",
  global: "Install globally (npm i -g rulesync)",
  skip: "Skip",
};

const GROUP_LABELS: Record<Preview["items"][number]["group"], string> = {
  overwrite: "Overwrite",
  delete: "Delete",
  setting: "Change settings",
  create: "Create",
};

export function formatPreview(preview: Preview): string[] {
  const lines: string[] = [];
  for (const group of ["overwrite", "delete", "setting", "create"] as const) {
    const items = preview.items.filter((item) => item.group === group);
    if (!items.length) continue;
    lines.push(`${GROUP_LABELS[group]}:`);
    for (const item of items) {
      const keys = item.keys?.length ? ` (${item.keys.join(", ")})` : "";
      const unsaved = item.unsaved === "untracked" ? " — not in git" : item.unsaved === "modified" ? " — uncommitted changes" : "";
      const warn = item.warn ? " ⚠ changes how this CLI runs hooks/approvals" : "";
      lines.push(`  ${item.path}${keys}${unsaved}${warn}`);
    }
  }
  for (const warning of preview.warnings) lines.push(`⚠ ${warning}`);
  return lines;
}

export function rulesPrompter(): RulesPrompter {
  const spin = p.spinner(opts);
  return {
    async install({ choices, projectUnavailable }) {
      if (projectUnavailable) p.log.info(`Project install unavailable: ${projectUnavailable}.`, opts);
      const picked = await p.select({
        message: "Recommended: rulesync keeps rules, MCP, skills and hooks in sync across your agents. Install it?",
        options: choices.map((value) => ({ value, label: INSTALL_LABELS[value] })),
        initialValue: choices[0],
        ...opts,
      });
      if (p.isCancel(picked)) return null;
      return picked;
    },
    async source(sources) {
      const picked = await p.select<string>({
        message: "Existing rule files found. How should rulesync start?",
        options: [
          ...sources.map((source) => ({ value: source.target, label: `Import from ${source.label}`, hint: source.target })),
          { value: "", label: "Start from an empty template", hint: "existing files stay as they are" },
        ],
        ...opts,
      });
      if (p.isCancel(picked)) return null;
      return (picked ? { kind: "import", target: picked } : { kind: "template" }) satisfies SourceChoice;
    },
    async confirm(preview) {
      p.note(formatPreview(preview).join("\n"), "rulesync generate will", opts);
      const ok = await p.confirm({ message: "Apply these changes?", initialValue: false, ...opts });
      return ok === true;
    },
    step(message) {
      spin.start(message);
    },
    stepDone(message, ok) {
      if (ok) spin.stop(message);
      else spin.error(message);
    },
  };
}

export function showRulesResult(result: RulesInitResult): void {
  for (const note of result.notes ?? []) p.log.info(note, opts);
  const detail = result.detail ? `: ${result.detail}` : "";
  switch (result.status) {
    case "generated":
      p.log.success(`rulesync set up${detail}`, opts);
      break;
    case "already_initialized":
      p.log.info("rulesync is already initialized in this project (.rulesync/ exists).", opts);
      break;
    case "no_changes":
      p.log.info("rulesync is set up; generated files are already up to date.", opts);
      break;
    case "failed":
      p.log.error(`rulesync${detail}`, opts);
      break;
    default:
      if (result.detail) p.log.info(result.detail, opts);
  }
}

export function summarizeResult(input: {
  action: Action;
  dry_run?: boolean;
  global?: { ok?: boolean; error?: string; command?: string[] };
  hosts: Array<{ id: string; ok?: boolean; note?: string; error?: string; commands?: string[][] }>;
  missing?: string[];
}): string {
  if (input.dry_run) {
    const n = input.hosts.length + (input.global ? 1 : 0);
    return `Dry run: ${n} step(s) planned.`;
  }
  const ok = input.hosts.filter((host) => host.ok).length;
  const fail = input.hosts.filter((host) => host.ok === false).length;
  const parts = [`${input.action} complete`];
  if (input.hosts.length) parts.push(`${ok} ok` + (fail ? `, ${fail} failed` : ""));
  if (input.global?.ok === false) parts.push("global failed");
  else if (input.global?.ok) parts.push("global ok");
  if (input.missing?.length) parts.push(`missing: ${input.missing.join(", ")}`);
  return parts.join(" · ");
}
