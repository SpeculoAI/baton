import spawn from "cross-spawn";
import fs from "node:fs";
import path from "node:path";
import { which } from "./adapters/common.ts";
import { batonHome } from "./store.ts";

export const REPO = "https://github.com/SpeculoAI/baton";
const PLUGIN_ID = "baton@speculoai";
const OLD_ID = "baton@agent-plugin-agent";
const OLD_MARKET = "agent-plugin-agent";

export type Action = "install" | "update" | "uninstall";
export type Step = { args: string[]; soft?: boolean };

type Host = {
  id: string;
  label: string;
  bins: string[];
  note?: string;
  install: Step[];
  update: Step[];
  uninstall: Step[];
  migrate?: Step[];
};

export const HOSTS: Host[] = [
  {
    id: "claude",
    label: "Claude Code",
    bins: ["claude"],
    migrate: [
      { args: ["plugin", "uninstall", OLD_ID], soft: true },
      { args: ["plugin", "marketplace", "remove", OLD_MARKET], soft: true },
    ],
    install: [
      { args: ["plugin", "marketplace", "add", REPO], soft: true },
      { args: ["plugin", "install", PLUGIN_ID] },
    ],
    update: [
      { args: ["plugin", "marketplace", "update", "speculoai"] },
      { args: ["plugin", "update", PLUGIN_ID] },
    ],
    uninstall: [{ args: ["plugin", "uninstall", PLUGIN_ID] }],
  },
  {
    id: "codex",
    label: "Codex CLI",
    bins: ["codex"],
    migrate: [
      { args: ["plugin", "remove", OLD_ID], soft: true },
      { args: ["plugin", "marketplace", "remove", OLD_MARKET], soft: true },
    ],
    install: [
      { args: ["plugin", "marketplace", "add", REPO], soft: true },
      { args: ["plugin", "add", PLUGIN_ID] },
    ],
    update: [
      { args: ["plugin", "marketplace", "upgrade", "speculoai"] },
      { args: ["plugin", "add", PLUGIN_ID] },
    ],
    uninstall: [{ args: ["plugin", "remove", PLUGIN_ID] }],
  },
  {
    id: "cursor",
    label: "Cursor Agent CLI",
    bins: ["agent", "cursor-agent"],
    note: "Run /add-plugin baton in a Cursor chat",
    migrate: [{ args: ["plugin", "marketplace", "remove", OLD_MARKET], soft: true }],
    install: [{ args: ["plugin", "marketplace", "add", REPO] }],
    update: [{ args: ["plugin", "marketplace", "update", "speculoai"] }],
    uninstall: [{ args: ["plugin", "marketplace", "remove", "speculoai"] }],
  },
  {
    id: "agy",
    label: "Antigravity",
    bins: ["agy"],
    install: [{ args: ["plugin", "install", REPO] }],
    update: [{ args: ["plugin", "install", REPO] }],
    uninstall: [{ args: ["plugin", "uninstall", "baton"] }],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bins: ["gemini"],
    install: [{ args: ["extensions", "install", REPO, "--consent"] }],
    update: [{ args: ["extensions", "update", "baton"] }],
    uninstall: [{ args: ["extensions", "uninstall", "baton"] }],
  },
];

export type DetectedHost = { id: string; label: string };
export type ProgressEvent =
  | { type: "global"; phase: "start" | "done"; ok?: boolean; error?: string }
  | { type: "host"; phase: "start" | "done"; id: string; ok?: boolean; note?: string; error?: string };

export function detectedHosts(env: NodeJS.ProcessEnv = process.env): DetectedHost[] {
  return HOSTS.filter((host) => which(host.bins, env)).map((host) => ({ id: host.id, label: host.label }));
}

export function commandsFor(id: string, action: Action, opts: { force?: boolean } = {}): Step[] {
  const host = HOSTS.find((item) => item.id === id);
  if (!host) throw new Error(`Unknown agent: ${id}`);
  if (action !== "install") return host[action];
  const forced = opts.force ? host.uninstall.map((step) => ({ ...step, soft: true })) : [];
  return [...(host.migrate ?? []), ...forced, ...host.install];
}

export type PlannedHost = { id: string; bin: string; commands: string[][]; note?: string };

export function planInstall(input: {
  action: Action;
  only?: string[];
  force?: boolean;
  skipGlobal?: boolean;
  env?: NodeJS.ProcessEnv;
  recorded?: string[];
}): { hosts: PlannedHost[]; missing: string[]; global?: { command: string[] } } {
  const env = input.env ?? process.env;
  const known = new Set(HOSTS.map((host) => host.id));
  for (const id of input.only ?? []) if (!known.has(id)) throw new Error(`Unknown agent: ${id}`);
  const ids = input.only?.length
    ? input.only
    : input.action === "install"
      ? HOSTS.filter((host) => which(host.bins, env)).map((host) => host.id)
      : input.recorded ?? readInstalled();
  const hosts: PlannedHost[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const host = HOSTS.find((item) => item.id === id);
    if (!host) throw new Error(`Unknown agent: ${id}`);
    const bin = which(host.bins, env);
    if (!bin) {
      if (input.only?.length) throw new Error(`${id} not detected.`);
      missing.push(id);
      continue;
    }
    hosts.push({
      id,
      bin,
      commands: commandsFor(id, input.action, { force: input.force }).map((step) => step.args),
      ...(host.note && input.action === "install" ? { note: host.note } : {}),
    });
  }
  if (input.action === "uninstall" || input.skipGlobal) return { hosts, missing };
  const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  const spec = input.action === "update" ? "@speculoai/baton@latest" : `@speculoai/baton@${version}`;
  return { hosts, missing, global: { command: ["npm", "install", "-g", spec] } };
}

export function readInstalled(home = batonHome()): string[] {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(home, "installed.json"), "utf8")) as { hosts?: unknown };
    return Array.isArray(data.hosts) ? data.hosts.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function writeInstalled(ids: string[], home = batonHome()): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "installed.json"), `${JSON.stringify({ hosts: [...new Set(ids)] })}\n`);
}

type SpawnResult = { status: number | null; stdout?: string; stderr?: string };
type SpawnFn = (command: string, args: string[]) => SpawnResult | Promise<SpawnResult>;
type HostResult = { id: string; ok: boolean; note?: string; error?: string };

function defaultSpawn(command: string, args: string[], env: NodeJS.ProcessEnv, quiet = false): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["inherit", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: SpawnResult) => { if (!settled) { settled = true; resolve(result); } };
    // Soft migrate steps and TTY spinners must not live-tee: expected "Failed to uninstall old id"
    // noise looks like a real install failure, and it desyncs clack cursor redraws.
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk; if (!quiet) process.stderr.write(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk; if (!quiet) process.stderr.write(chunk); });
    child.on("error", (error) => finish({ status: 1, stderr: error.message }));
    child.on("close", (status) => finish({ status, stdout, stderr }));
  });
}

function failText(ran: SpawnResult): string {
  return `${ran.stderr || ran.stdout || ""}`.trim().slice(-500) || `exit code ${ran.status}`;
}

export async function runInstall(input: {
  action: Action;
  only?: string[];
  force?: boolean;
  dryRun?: boolean;
  skipGlobal?: boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** When set (typically TTY install without `--only`), ask which detected hosts to use. Empty/null cancels. */
  selectHosts?: (detected: DetectedHost[]) => Promise<string[] | null>;
  onProgress?: (event: ProgressEvent) => void;
  spawn?: SpawnFn;
  /** Suppress live child logs (TTY spinner). Soft migrate steps are always quiet. */
  quiet?: boolean;
}): Promise<{ exitCode: number; result: { action: Action; dry_run?: boolean; global?: { ok?: boolean; command?: string[]; error?: string }; hosts: Array<{ id: string; ok?: boolean; bin?: string; commands?: string[][]; note?: string; error?: string }>; missing?: string[] } }> {
  const env = input.env ?? process.env;
  const home = input.home ?? batonHome();
  let only = input.only;
  if (input.action === "install" && !only?.length && input.selectHosts) {
    const detected = detectedHosts(env);
    if (!detected.length) return { exitCode: 0, result: { action: input.action, hosts: [] } };
    const picked = await input.selectHosts(detected);
    if (!picked?.length) return { exitCode: 0, result: { action: input.action, hosts: [] } };
    only = picked;
  }
  const planned = planInstall({ action: input.action, only, force: input.force, skipGlobal: input.skipGlobal, env, recorded: readInstalled(home) });
  if (input.dryRun) {
    return {
      exitCode: 0,
      result: { action: input.action, dry_run: true, ...(planned.global ? { global: planned.global } : {}), hosts: planned.hosts, ...(planned.missing.length ? { missing: planned.missing } : {}) },
    };
  }
  const run = (command: string, args: string[], quiet: boolean) =>
    input.spawn ? input.spawn(command, args) : defaultSpawn(command, args, env, quiet);
  const report = input.onProgress;
  let global: { ok: boolean; error?: string } | undefined;
  if (planned.global) {
    report?.({ type: "global", phase: "start" });
    const ran = await run(planned.global.command[0]!, planned.global.command.slice(1), Boolean(input.quiet));
    global = ran.status === 0 ? { ok: true } : { ok: false, error: failText(ran) };
    report?.({ type: "global", phase: "done", ok: global.ok, ...(global.error ? { error: global.error } : {}) });
  }
  const hosts: HostResult[] = [];
  for (const host of planned.hosts) {
    report?.({ type: "host", phase: "start", id: host.id });
    let error: string | undefined;
    let skipped = false;
    for (const step of commandsFor(host.id, input.action, { force: input.force })) {
      // Soft steps (old-id migrate) often print "Failed to uninstall…" — hide that when overall install is fine.
      const ran = await run(host.bin, step.args, Boolean(input.quiet) || Boolean(step.soft));
      if (ran.status === 0 || step.soft) continue;
      if (/already installed/i.test(`${ran.stdout || ""}\n${ran.stderr || ""}`)) { skipped = true; continue; }
      error = failText(ran);
      break;
    }
    const note = skipped ? "already installed, skipped" : host.note;
    const row: HostResult = { id: host.id, ok: !error, ...(note ? { note } : {}), ...(error ? { error } : {}) };
    hosts.push(row);
    report?.({ type: "host", phase: "done", id: host.id, ok: row.ok, ...(note ? { note } : {}), ...(error ? { error } : {}) });
  }
  if (input.action !== "update") {
    const recorded = new Set(readInstalled(home));
    for (const host of hosts) {
      if (!host.ok) continue;
      if (input.action === "install") recorded.add(host.id);
      else recorded.delete(host.id);
    }
    writeInstalled([...recorded], home);
  }
  return {
    exitCode: hosts.some((host) => !host.ok) ? 1 : 0,
    result: { action: input.action, ...(global ? { global } : {}), hosts, ...(planned.missing.length ? { missing: planned.missing } : {}) },
  };
}
