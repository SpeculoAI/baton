import * as p from "@clack/prompts";
import type { Writable } from "node:stream";
import type { Action } from "./install.ts";

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

export function beginAction(action: Action): void {
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

export function createSpinner() {
  return p.spinner(opts);
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
