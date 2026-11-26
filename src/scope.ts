import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import type { TaskStatus } from "./types.ts";

export type ScopeMatchOptions = {
  /** When set, bare (no-wildcard) patterns that name a directory match as prefixes. */
  isDir?: (pattern: string) => boolean;
};

export type ScopePolicy = "warn" | "fail";

const HAS_WILDCARD = /[*?[\]]/;

export function validateScopeGlob(glob: string): void {
  if (!glob || !glob.trim()) throw new Error("scope must not be empty.");
  if (glob.trimStart().startsWith("!")) throw new Error("scope does not support ! negation patterns.");
}

/** Normalize CLI/MCP scope list; throws if policy set without scopes. */
export function normalizeScopeInput(
  scopes: string[] | undefined,
  policy: ScopePolicy | undefined,
): { scope?: string[]; scope_on_violation?: ScopePolicy } {
  const cleaned = (scopes ?? []).map((s) => s.trim()).filter(Boolean);
  if (policy && !cleaned.length) throw new Error("--scope-on-violation cannot be used without --scope.");
  if (!cleaned.length) return {};
  for (const g of cleaned) validateScopeGlob(g);
  const scope_on_violation: ScopePolicy = policy ?? "warn";
  if (scope_on_violation !== "warn" && scope_on_violation !== "fail") {
    throw new Error("scope-on-violation must be warn or fail.");
  }
  return { scope: cleaned, scope_on_violation };
}

export function scopePromptPrefix(scopes: string[]): string {
  return `[Baton scope] Only modify these paths (post-check enforced): ${scopes.join(", ")}\n\n`;
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function hasWildcard(glob: string): boolean {
  return HAS_WILDCARD.test(glob);
}

export function pathInScope(filePath: string, globs: string[], opts: ScopeMatchOptions = {}): boolean {
  const file = normalizeRel(filePath);
  if (file.startsWith("../") || file === "..") return false;
  for (const raw of globs) {
    const glob = normalizeRel(raw);
    if (!glob) continue;
    if (hasWildcard(glob)) {
      // dot: `dir/**` must cover dotfiles like `.env.example` (#72); path.matchesGlob cannot opt in.
      if (picomatch.isMatch(file, glob, { dot: true })) return true;
      continue;
    }
    if (file === glob) return true;
    const isDir = opts.isDir?.(glob) ?? false;
    if (isDir && (file === glob || file.startsWith(`${glob}/`))) return true;
  }
  return false;
}

export function findScopeViolations(
  paths: string[],
  globs: string[],
  opts: ScopeMatchOptions = {},
): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const file = normalizeRel(p);
    if (file.startsWith("../") || file === ".." || !pathInScope(file, globs, opts)) {
      out.push(file);
    }
  }
  return out;
}

/** Map repo-root-relative git paths into task-cwd-relative paths; cwd escapes → `../…`. */
export function relativizeToTaskCwd(
  repoRelativePaths: string[],
  repoRoot: string,
  cwd: string,
): string[] {
  const root = path.resolve(repoRoot);
  const base = path.resolve(cwd);
  return repoRelativePaths.map((rel) => {
    const abs = path.resolve(root, rel);
    return normalizeRel(path.relative(base, abs));
  });
}

export function isDirUnderCwd(cwd: string, pattern: string): boolean {
  try {
    return fs.statSync(path.resolve(cwd, pattern)).isDirectory();
  } catch {
    return false;
  }
}

export type ScopePolicyInput = {
  final: TaskStatus;
  policy: ScopePolicy;
  violations: string[];
  summary?: string;
  warning?: string;
};

export type ScopePolicyResult = {
  status: TaskStatus;
  summary?: string;
  warning?: string;
  scope_violations: string[];
};

/** Apply warn/fail after transport final status is known. */
export function applyScopePolicy(input: ScopePolicyInput): ScopePolicyResult {
  const violations = [...input.violations];
  if (!violations.length) {
    return {
      status: input.final,
      summary: input.summary,
      warning: input.warning,
      scope_violations: [],
    };
  }
  const note = `scope_violation: ${violations.length} file(s)`;
  const warning = input.warning ? `${input.warning}; ${note}` : note;
  if (input.policy === "fail" && input.final === "success") {
    const body = input.summary ?? "";
    const summary = body.startsWith("scope_violation:")
      ? body
      : `scope_violation: see scope_violations${body ? `\n${body}` : ""}`;
    return { status: "scope_violation", summary, warning, scope_violations: violations };
  }
  return {
    status: input.final,
    summary: input.summary,
    warning,
    scope_violations: violations,
  };
}
