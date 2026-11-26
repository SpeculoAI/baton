import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import spawn from "cross-spawn";
import { which } from "./adapters/common.ts";
import { redact } from "./redact.ts";
import type { EnvFeature, RuleSupport, RulesyncReport } from "./types.ts";

const ALL_FEATURES = ["rules", "mcp", "subagents", "skills", "hooks", "permissions", "checks"] as const;
const GATE_FEATURES: EnvFeature[] = ["mcp", "hooks"];

/** Rule entries scanned at each directory level (union across adapters). */
export const RULE_ENTRIES = [
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  "AGENTS.override.md",
  "GEMINI.md",
  ".agents/AGENTS.md",
  ".agents/GEMINI.md",
  ".agents/rules",
  ".agent/rules",
  ".cursor/rules",
  ".cursorrules",
] as const;

const DIR_ENTRIES = new Set<string>([".agents/rules", ".agent/rules", ".cursor/rules"]);

/** Nearest git toplevel, or null when cwd is not inside a repo. */
export function rulesGitRoot(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) return null;
  const root = result.stdout.trim();
  return root || null;
}

function existsEntry(dir: string, entry: string): boolean {
  const full = path.join(dir, entry);
  try {
    const st = fs.statSync(full);
    if (DIR_ENTRIES.has(entry)) {
      if (!st.isDirectory()) return false;
      return fs.readdirSync(full).length > 0;
    }
    return st.isFile();
  } catch {
    return false;
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function isDirEntry(rel: string): boolean {
  const n = toPosix(rel);
  return [...DIR_ENTRIES].some((d) => n === d || n.endsWith(`/${d}`));
}

/** Discover rule files from cwd up to the git root (or cwd only when not a repo). Paths are cwd-relative, sorted. */
export function discoverRules(cwd: string): string[] {
  const start = path.resolve(cwd);
  const root = rulesGitRoot(start) ?? start;
  const found = new Set<string>();
  let cur = start;
  for (;;) {
    for (const entry of RULE_ENTRIES) {
      if (!existsEntry(cur, entry)) continue;
      found.add(toPosix(path.relative(start, path.join(cur, entry)) || entry));
    }
    if (path.resolve(cur) === path.resolve(root)) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return [...found].sort();
}

function basenameMatch(foundRel: string, entry: string): boolean {
  const n = toPosix(foundRel);
  return n === entry || n.endsWith(`/${entry}`);
}

function levelHasAny(found: string[], foundRel: string, names: string[]): boolean {
  const dir = path.posix.dirname(toPosix(foundRel));
  const prefix = dir === "." ? "" : `${dir}/`;
  return names.some((name) => {
    const candidate = `${prefix}${name}`;
    return found.some((f) => toPosix(f) === candidate);
  });
}

function readsNatively(foundRel: string, found: string[], support: RuleSupport): boolean {
  const n = toPosix(foundRel);
  for (const entry of support.files) {
    if (basenameMatch(n, entry)) return true;
  }
  for (const cond of support.conditional ?? []) {
    if (!basenameMatch(n, cond.file)) continue;
    if (!levelHasAny(found, n, cond.unless)) return true;
  }
  return false;
}

/** Rule files the target will not load natively; paths are cwd-relative, sorted. */
export function unseenRules(found: string[], support: RuleSupport | undefined): string[] {
  const list = [...found].map(toPosix).sort();
  if (!support) return list;
  return list.filter((rel) => !readsNatively(rel, list, support));
}

/** English pointer block for `--rules pointer`. Empty when nothing to inject. */
export function rulesPointer(unseen: string[]): string {
  if (!unseen.length) return "";
  const lines = unseen.map((rel) => {
    const n = toPosix(rel);
    return isDirEntry(n)
      ? `- ${n}/ (read the rule files that apply to the files you change)`
      : `- ${n}`;
  });
  return (
    `This repository has project rules your CLI does not load automatically:\n` +
    `${lines.join("\n")}\n` +
    `Before editing, read each file above (and any files they reference with @path) and follow those rules.\n\n`
  );
}

/** Strip line/block comments and trailing commas outside strings. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      i += 1;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /[\s\r\n]/.test(text[j]!)) j += 1;
      if (text[j] === "}" || text[j] === "]") {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

export type RulesyncConfig = {
  targets: string[] | Record<string, string[] | "*"> | "*";
  features: string[] | "*";
};

function asStringList(value: unknown): string[] | "*" | null {
  if (value === "*") return "*";
  if (!Array.isArray(value)) return null;
  const list = value.filter((item): item is string => typeof item === "string");
  return list.length === value.length ? list : null;
}

function loadJsoncObject(file: string): Record<string, unknown> | "missing" | "error" {
  if (!fs.existsSync(file)) return "missing";
  try {
    const parsed = JSON.parse(stripJsonc(fs.readFileSync(file, "utf8")));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "error";
    return parsed as Record<string, unknown>;
  } catch {
    return "error";
  }
}

/** Read rulesync.jsonc (+ local overlay). Returns null when missing or unreadable. */
export function readRulesyncConfig(repoRoot: string): RulesyncConfig | null {
  const base = loadJsoncObject(path.join(repoRoot, "rulesync.jsonc"));
  const local = loadJsoncObject(path.join(repoRoot, "rulesync.local.jsonc"));
  if (base === "missing" && local === "missing") return null;
  if (base === "error" || local === "error") return null;
  const raw: Record<string, unknown> = { ...(base === "missing" ? {} : base), ...(local === "missing" ? {} : local) };
  const features = asStringList(raw.features) ?? ["rules"];
  const targetsRaw = raw.targets;
  let targets: RulesyncConfig["targets"] = ["claudecode", "codexcli", "opencode"];
  if (targetsRaw === "*") targets = "*";
  else if (Array.isArray(targetsRaw)) {
    const list = asStringList(targetsRaw);
    if (!list || list === "*") return null;
    targets = list;
  } else if (targetsRaw && typeof targetsRaw === "object") {
    const obj: Record<string, string[] | "*"> = {};
    for (const [key, value] of Object.entries(targetsRaw as Record<string, unknown>)) {
      const feats = value === "*" ? "*" : asStringList(value);
      if (feats == null) return null;
      obj[key] = feats;
    }
    targets = obj;
  } else if (targetsRaw !== undefined) {
    return null;
  }
  return { targets, features: features === "*" ? "*" : features };
}

function expandFeatures(value: string[] | "*"): string[] {
  return value === "*" ? [...ALL_FEATURES] : value;
}

/** Locate rulesync: project node_modules → main repo node_modules → PATH. Never uses npx. */
export function resolveRulesync(repoRoot: string, mainRepoRoot?: string, env = process.env): string | null {
  for (const root of [repoRoot, mainRepoRoot].filter(Boolean) as string[]) {
    const local = which(["rulesync"], { PATH: path.join(root, "node_modules", ".bin") });
    if (local) return local;
  }
  return which(["rulesync"], env);
}

/** Build the rulesync slice of RulesReport from config + adapter support. */
export function buildRulesyncReport(
  config: RulesyncConfig | null,
  support: RuleSupport | undefined,
  bin: string | null,
): RulesyncReport {
  const target = support?.rulesyncTarget;
  let target_configured: boolean | null = null;
  let features: string[] = [];
  if (config && target) {
    if (config.targets === "*") {
      target_configured = true;
      features = expandFeatures(config.features);
    } else if (Array.isArray(config.targets)) {
      target_configured = config.targets.includes("*") || config.targets.includes(target);
      features = target_configured ? expandFeatures(config.features) : [];
    } else {
      target_configured = Object.hasOwn(config.targets, target) || Object.hasOwn(config.targets, "*");
      if (target_configured) {
        const per = config.targets[target] ?? config.targets["*"];
        features = per ? expandFeatures(per) : expandFeatures(config.features);
      }
    }
  } else if (config) {
    target_configured = false;
  }

  const gates: string[] = [];
  if (support?.gates && target_configured) {
    for (const feat of GATE_FEATURES) {
      if (features.includes(feat) && support.gates[feat]) gates.push(support.gates[feat]!);
    }
  }

  if (!bin) {
    return {
      status: "skipped",
      detail: "rulesync not found in node_modules/.bin or PATH",
      target_configured,
      features,
      gates,
    };
  }
  return { status: "pending", target_configured, features, gates };
}

/** True when `<repo>/.rulesync` exists as a directory. */
export function hasRulesyncSource(repoRoot: string): boolean {
  try {
    return fs.statSync(path.join(repoRoot, ".rulesync")).isDirectory();
  } catch {
    return false;
  }
}

export type RulesyncCheckResult = {
  status: "in_sync" | "stale" | "error";
  detail?: string;
};

/** Run `rulesync generate --check` asynchronously. Never throws. */
export function rulesyncCheck(
  bin: string,
  repoRoot: string,
  timeoutMs?: number,
): Promise<RulesyncCheckResult> {
  const ms = timeoutMs
    ?? (Number(process.env.BATON_RULESYNC_CHECK_MS) > 0 ? Number(process.env.BATON_RULESYNC_CHECK_MS) : 15_000);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: RulesyncCheckResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let stderr = "";
    let child;
    try {
      child = spawn(bin, ["generate", "--check"], {
        cwd: repoRoot,
        env: { ...process.env, BATON_DELEGATION: "1" },
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      finish({ status: "error", detail: redact((error as Error).message).slice(0, 200) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish({ status: "error", detail: `rulesync generate --check timed out after ${ms}ms` });
    }, ms);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ status: "error", detail: redact(error.message).slice(0, 200) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) finish({ status: "in_sync" });
      else if (code === 1) finish({ status: "stale" });
      else finish({ status: "error", detail: redact(stderr || `rulesync exited ${code}`).slice(0, 200) });
    });
  });
}

/** Run `rulesync generate` (writes files). Never throws; returns ok/error. */
export function rulesyncGenerate(
  bin: string,
  worktreeRoot: string,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; detail?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; detail?: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let stderr = "";
    let child;
    try {
      child = spawn(bin, ["generate"], {
        cwd: worktreeRoot,
        env: { ...process.env, BATON_DELEGATION: "1" },
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      finish({ ok: false, detail: redact((error as Error).message).slice(0, 200) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish({ ok: false, detail: `rulesync generate timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, detail: redact(error.message).slice(0, 200) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, detail: redact(stderr || `rulesync exited ${code}`).slice(0, 200) });
    });
  });
}
