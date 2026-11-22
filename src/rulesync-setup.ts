import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { adapters } from "./adapters/index.ts";
import { which } from "./adapters/common.ts";
import { redact } from "./redact.ts";
import { hasRulesyncSource, resolveRulesync, rulesGitRoot, stripJsonc } from "./rules.ts";

/** Without permissions: rulesync rewrites Codex approval settings whenever that feature is on, even with an empty source. */
export const SETUP_FEATURES = ["rules", "mcp", "subagents", "skills", "hooks"] as const;
const SCHEMA = "https://github.com/dyoshikawa/rulesync/releases/latest/download/config-schema.json";

export type InstallChoice = "project" | "global" | "skip";
export type RulesSource = { target: string; label: string };
export type SourceChoice = { kind: "import"; target: string } | { kind: "template" };
export type PreviewItem = {
  group: "create" | "overwrite" | "setting" | "delete";
  path: string;
  feature: string;
  keys?: string[];
  /** Not tracked by git, or has uncommitted changes — overwriting loses data git cannot restore. */
  unsaved?: "untracked" | "modified";
  warn?: boolean;
};
export type Preview = { items: PreviewItem[]; warnings: string[] };
export type RulesInitStatus =
  | "generated" | "already_initialized" | "no_changes" | "previewed" | "installed"
  | "skipped" | "cancelled" | "planned" | "needs_input" | "failed";
export type RulesInitResult = {
  status: RulesInitStatus;
  root?: string;
  install?: { choice: InstallChoice; ok: boolean; command?: string[] };
  source?: string;
  targets?: string[];
  preview?: Preview;
  notes?: string[];
  detail?: string;
};

export type RulesPrompter = {
  install(input: { choices: InstallChoice[]; projectUnavailable?: string }): Promise<InstallChoice | null>;
  source(sources: RulesSource[]): Promise<SourceChoice | null>;
  confirm(preview: Preview): Promise<boolean>;
  step?(message: string): void;
  stepDone?(message: string, ok: boolean): void;
};

export type RunResult = { status: number | null; stdout: string; stderr: string };
export type RunFn = (command: string, args: string[], cwd: string) => Promise<RunResult>;

/** Baton agent id → rulesync target id. Agents without a rulesync target are not mapped. */
export function rulesyncTargets(agentIds: string[]): string[] {
  const out: string[] = [];
  for (const id of agentIds) {
    const target = Object.hasOwn(adapters, id) ? adapters[id]!.rules?.rulesyncTarget : undefined;
    if (target && !out.includes(target)) out.push(target);
  }
  return out;
}

export function mappedAgents(): string[] {
  return Object.keys(adapters).filter((id) => adapters[id]!.rules?.rulesyncTarget);
}

const SOURCES: Array<{ target: string; label: string; files: string[] }> = [
  { target: "claudecode", label: "CLAUDE.md", files: ["CLAUDE.md", ".claude/CLAUDE.md"] },
  { target: "codexcli", label: "AGENTS.md", files: ["AGENTS.md"] },
  { target: "cursor", label: ".cursor/rules", files: [".cursor/rules", ".cursorrules"] },
];

function nonEmpty(full: string): boolean {
  try {
    const st = fs.statSync(full);
    return st.isDirectory() ? fs.readdirSync(full).length > 0 : st.isFile();
  } catch {
    return false;
  }
}

/** Rule files at the repo root that `rulesync import` can read, one entry per importable tool. */
export function detectSources(root: string): RulesSource[] {
  return SOURCES
    .filter((source) => source.files.some((file) => nonEmpty(path.join(root, file))))
    .map(({ target, label }) => ({ target, label }));
}

function defaultRun(env: NodeJS.ProcessEnv): RunFn {
  return (command, args, cwd) => new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunResult) => { if (!settled) { settled = true; resolve(result); } };
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ status: 1, stdout, stderr: (error as Error).message });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.on("error", (error) => finish({ status: 1, stdout, stderr: error.message }));
    child.on("close", (status) => finish({ status, stdout, stderr }));
  });
}

function failText(ran: RunResult): string {
  return redact(`${ran.stderr || ran.stdout || ""}`.trim().slice(-300)) || `exit code ${ran.status}`;
}

function parseJsonOutput(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function gitUnsaved(root: string): Map<string, "untracked" | "modified"> {
  const map = new Map<string, "untracked" | "modified">();
  const ran = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored"], { cwd: root, encoding: "utf8", timeout: 5000 });
  if (ran.status !== 0) return map;
  for (const entry of ran.stdout.split("\0")) {
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    map.set(file, code === "??" || code === "!!" ? "untracked" : "modified");
  }
  return map;
}

/** Turn `rulesync generate --dry-run --json` operations into a grouped, user-facing preview. */
export function classifyPlan(root: string, operations: Array<Record<string, unknown>>, unsaved = gitUnsaved(root)): PreviewItem[] {
  const keyed = new Map<string, { feature: string; keys: string[] }>();
  for (const op of operations) {
    if (op.kind !== "key" || op.action !== "write" || typeof op.path !== "string") continue;
    const entry = keyed.get(op.path) ?? { feature: String(op.feature ?? ""), keys: [] };
    if (typeof op.key === "string" && !entry.keys.includes(op.key)) entry.keys.push(op.key);
    keyed.set(op.path, entry);
  }
  const items: PreviewItem[] = [];
  const seen = new Set<string>();
  for (const op of operations) {
    if (typeof op.path !== "string") continue;
    const rel = op.path;
    const feature = String(op.feature ?? "");
    const exists = fs.existsSync(path.join(root, rel));
    const mark = exists && unsaved.has(rel) ? { unsaved: unsaved.get(rel)! } : {};
    if (op.action === "delete") {
      items.push({ group: "delete", path: rel, feature, ...mark });
      continue;
    }
    if (op.action !== "write" || seen.has(rel)) continue;
    const keys = keyed.get(rel);
    if (keys && exists) {
      seen.add(rel);
      const features = operations.filter((o) => o.path === rel).map((o) => String(o.feature ?? ""));
      items.push({
        group: "setting", path: rel, feature: keys.feature, keys: keys.keys, ...mark,
        ...(features.some((f) => f === "hooks" || f === "permissions") ? { warn: true } : {}),
      });
      continue;
    }
    if (op.kind !== "file") continue;
    seen.add(rel);
    items.push({ group: exists ? "overwrite" : "create", path: rel, feature, ...(exists ? mark : {}) });
  }
  const order = { overwrite: 0, delete: 1, setting: 2, create: 3 } as const;
  return items.sort((a, b) => order[a.group] - order[b.group] || a.path.localeCompare(b.path));
}

const TEMPLATE_RULE = `---
root: true
targets: ["*"]
description: "Project rules"
globs: ["**/*"]
---

# Project rules
`;

/** `rulesync init` ships samples (Codex danger-full-access, demo MCP servers, a hook to a missing script). */
function cleanTemplate(root: string): void {
  const dir = path.join(root, ".rulesync");
  for (const rel of ["mcp.jsonc", "hooks.jsonc", "permissions.jsonc", "subagents/planner.md", "skills/project-context"]) {
    fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
  }
  const rules = path.join(dir, "rules");
  fs.mkdirSync(rules, { recursive: true });
  fs.rmSync(path.join(rules, "overview.md"), { force: true });
  fs.writeFileSync(path.join(rules, "project.md"), TEMPLATE_RULE);
}

/** An imported tool with no MCP servers or hooks still yields empty sources, which would blank those files for every target. */
function pruneEmptySources(root: string): void {
  for (const [file, field] of [["mcp.jsonc", "mcpServers"], ["hooks.jsonc", "hooks"]] as const) {
    const full = path.join(root, ".rulesync", file);
    try {
      const value = (JSON.parse(stripJsonc(fs.readFileSync(full, "utf8"))) as Record<string, unknown>)[field];
      if (!value || (typeof value === "object" && !Object.keys(value).length)) fs.rmSync(full);
    } catch {
      // missing or unreadable: leave it for rulesync to report
    }
  }
}

function writeConfig(root: string, targets: string[]): void {
  const config = { $schema: SCHEMA, targets, features: [...SETUP_FEATURES], delete: false };
  fs.writeFileSync(path.join(root, "rulesync.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
}

export async function rulesInit(input: {
  cwd: string;
  /** Baton agent ids to generate for. */
  agents: string[];
  install?: InstallChoice;
  source?: SourceChoice;
  yes?: boolean;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  prompt?: RulesPrompter;
  run?: RunFn;
}): Promise<RulesInitResult> {
  const env = input.env ?? process.env;
  const run = input.run ?? defaultRun(env);
  const prompt = input.prompt;
  const root = rulesGitRoot(input.cwd);
  const locate = () => (root ? resolveRulesync(root, undefined, env) : which(["rulesync"], env));
  const base = root ? { root } : {};
  let bin = locate();
  let install: RulesInitResult["install"];

  if (!bin) {
    const projectUnavailable = !root
      ? "not inside a git repository"
      : !fs.existsSync(path.join(root, "package.json")) ? "no package.json at the repository root" : undefined;
    const choices: InstallChoice[] = projectUnavailable ? ["global", "skip"] : ["project", "global", "skip"];
    const choice = input.install ?? (prompt ? await prompt.install({ choices, ...(projectUnavailable ? { projectUnavailable } : {}) }) : null);
    if (!choice) {
      return prompt
        ? { ...base, status: "cancelled" }
        : { ...base, status: "needs_input", detail: "rulesync is not installed; pass --install project|global|skip" };
    }
    if (choice === "skip") return { ...base, status: "skipped", detail: "Run `baton rules init` later to set up rulesync." };
    if (choice === "project" && projectUnavailable) {
      return { ...base, status: "failed", detail: `Cannot install rulesync into the project: ${projectUnavailable}` };
    }
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const command = choice === "project" ? [npm, "install", "-D", "rulesync"] : [npm, "install", "-g", "rulesync"];
    if (input.dryRun) return { ...base, status: "planned", install: { choice, ok: false, command } };
    prompt?.step?.(`Installing rulesync (${command.slice(1).join(" ")})…`);
    const ran = await run(command[0]!, command.slice(1), root ?? input.cwd);
    if (ran.status !== 0) {
      prompt?.stepDone?.("rulesync install failed", false);
      return { ...base, status: "failed", install: { choice, ok: false, command }, detail: failText(ran) };
    }
    bin = locate();
    if (!bin) {
      prompt?.stepDone?.("rulesync installed but not found", false);
      return {
        ...base, status: "failed", install: { choice, ok: false, command },
        detail: choice === "global"
          ? "npm finished but rulesync is not on PATH; add the npm global bin directory (`npm prefix -g`) to PATH"
          : "npm finished but node_modules/.bin/rulesync is missing",
      };
    }
    prompt?.stepDone?.(`rulesync installed (${choice})`, true);
    install = { choice, ok: true, command };
  }

  const withInstall = install ? { ...base, install } : base;
  if (!root) {
    return { ...withInstall, status: install ? "installed" : "skipped", detail: "Not inside a git repository; run `baton rules init` inside a project to set it up." };
  }
  if (hasRulesyncSource(root)) return { ...withInstall, status: "already_initialized" };

  const targets = rulesyncTargets(input.agents);
  if (!targets.length) {
    return { ...withInstall, status: "needs_input", detail: `No agent maps to a rulesync target; choose from: ${mappedAgents().join(", ")}` };
  }
  const sources = detectSources(root);
  let source = input.source ?? null;
  if (!source) {
    if (!sources.length) source = { kind: "template" };
    else if (prompt) source = await prompt.source(sources);
    else {
      return {
        ...withInstall, status: "needs_input", targets,
        detail: `Existing rule files found (${sources.map((s) => s.label).join(", ")}); pass --source <${sources.map((s) => s.target).join("|")}> or --template`,
      };
    }
    if (!source) return { ...withInstall, status: "cancelled", targets };
  }
  const sourceLabel = source.kind === "template" ? "template" : source.target;
  if (input.dryRun) return { ...withInstall, status: "planned", source: sourceLabel, targets };

  const hadConfig = fs.existsSync(path.join(root, "rulesync.jsonc"));
  const notes: string[] = [];
  prompt?.step?.(source.kind === "template" ? "Creating .rulesync/ from template…" : `Importing from ${source.target}…`);
  const created = source.kind === "template"
    ? await run(bin, ["init", "--silent"], root)
    : await run(bin, ["import", "--targets", source.target, "--features", SETUP_FEATURES.join(","), "--silent"], root);
  if (created.status !== 0 || !hasRulesyncSource(root)) {
    prompt?.stepDone?.("rulesync setup failed", false);
    return { ...withInstall, status: "failed", source: sourceLabel, targets, detail: failText(created) };
  }
  if (source.kind === "template") cleanTemplate(root);
  else pruneEmptySources(root);
  const local = path.join(root, ".rulesync", "rules", "CLAUDE.local.md");
  if (fs.existsSync(local)) {
    fs.rmSync(local);
    notes.push("CLAUDE.local.md is personal; it was not imported into .rulesync/.");
  }
  if (!hadConfig) writeConfig(root, targets);
  else notes.push("Kept the existing rulesync.jsonc; its targets and features were not changed.");
  prompt?.stepDone?.(source.kind === "template" ? "Created .rulesync/" : `Imported from ${source.target}`, true);

  const dry = await run(bin, ["generate", "--dry-run", "--json"], root);
  const parsed = parseJsonOutput(dry.stdout);
  const data = parsed?.data as { plan?: { operations?: Array<Record<string, unknown>> } } | undefined;
  if (dry.status !== 0 || !parsed || parsed.success === false || !data?.plan) {
    const error = (parsed?.error as { message?: string } | undefined)?.message;
    return { ...withInstall, status: "failed", source: sourceLabel, targets, notes, detail: error ? redact(error).slice(0, 300) : failText(dry) };
  }
  const preview: Preview = {
    items: classifyPlan(root, data.plan.operations ?? []),
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((w): w is string => typeof w === "string") : [],
  };
  const common = { ...withInstall, source: sourceLabel, targets, preview, ...(notes.length ? { notes } : {}) };
  if (!preview.items.length) return { ...common, status: "no_changes" };

  const confirmed = input.yes || (prompt ? await prompt.confirm(preview) : false);
  if (!confirmed) {
    return {
      ...common, status: prompt ? "cancelled" : "previewed",
      detail: "Kept .rulesync/ and rulesync.jsonc; review them, then run `npx rulesync generate`.",
    };
  }
  prompt?.step?.("Generating agent files…");
  const gen = await run(bin, ["generate", "--silent"], root);
  if (gen.status !== 0) {
    prompt?.stepDone?.("rulesync generate failed", false);
    return { ...common, status: "failed", detail: failText(gen) };
  }
  prompt?.stepDone?.("Generated agent files", true);
  return { ...common, status: "generated", detail: "Review the changes, then commit .rulesync/, rulesync.jsonc and the generated files." };
}
