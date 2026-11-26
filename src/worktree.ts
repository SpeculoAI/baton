import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import crossSpawn from "cross-spawn";
import { hasRulesyncSource, resolveRulesync, RULE_ENTRIES } from "./rules.ts";
import { redact } from "./redact.ts";

export type WorktreeConfig = {
  dir?: string;
  base?: string;
  copy: string[];
  symlink: string[];
  post_create: string[];
  /** When false, skip rulesync generate in new worktrees. Default true. */
  rulesync?: boolean;
};

export type WorktreeMeta = {
  name: string;
  branch: string;
  base: string;
  created_at: string;
};

export type WorktreeRulesResult = {
  rulesync: "generated" | "skipped" | "error";
  detail?: string;
  missing: string[];
  dirtied: string[];
};

export type WorktreeAddResult = {
  status: "ok";
  path: string;
  branch: string;
  base: string;
  name: string;
  gitignore_updated: boolean;
  rules?: WorktreeRulesResult;
};

export type WorktreeListItem = {
  name: string;
  path: string;
  branch: string;
  base: string;
};

const META_NAME = ".baton-worktree.json";

function git(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): { status: number; stdout: string; stderr: string } {
  const ran = spawnSync("git", args, {
    cwd, encoding: "utf8", input: options.input, maxBuffer: 256 * 1024 * 1024,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  return { status: ran.status ?? 1, stdout: ran.stdout || "", stderr: ran.stderr || "" };
}

function mustGit(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  const ran = git(cwd, args, options);
  if (ran.status !== 0) throw new Error(`git ${args[0]} failed: ${(ran.stderr || ran.stdout).trim()}`);
  return ran.stdout;
}

export function headSha(cwd: string): string {
  return mustGit(cwd, ["rev-parse", "HEAD"]).trim();
}

/** Commit the task worktree forked from: the recorded sha, or (older tasks) the merge-base with the source HEAD. */
export function forkPoint(sourceRepo: string, branch: string, recorded?: string): string {
  if (recorded) return recorded;
  const ran = git(sourceRepo, ["merge-base", branch, "HEAD"]);
  if (ran.status !== 0 || !ran.stdout.trim()) throw new Error(`Cannot find where ${branch} forked from; no base_sha recorded and merge-base failed.`);
  return ran.stdout.trim();
}

/**
 * The worktree's net state as a tree object: HEAD plus every non-ignored working-tree change,
 * minus Baton's own files (.baton-worktree.json, copy / symlink entries). Built in a throwaway
 * index so the worktree's own index, branch and files stay untouched.
 */
export function netTree(worktreePath: string, indexFile: string): string {
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    mustGit(worktreePath, ["read-tree", "HEAD"], { env });
    const exclude = [...batonWorktreeExemptPaths(worktreePath)].map((entry) => `:(exclude,glob)${entry}`);
    mustGit(worktreePath, ["add", "-A", "--", ".", ...exclude], { env });
    return mustGit(worktreePath, ["write-tree"], { env }).trim();
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

export function diffTrees(cwd: string, base: string, tree: string, stat = false): string {
  return mustGit(cwd, ["diff", stat ? "--stat" : "--binary", base, tree]);
}

/** Paths touched between two trees; --no-renames so a rename lists both its old and new path. */
export function changedPaths(cwd: string, base: string, tree: string): string[] {
  return mustGit(cwd, ["diff", "--name-only", "--no-renames", "-z", base, tree]).split("\0").filter(Boolean);
}

const IN_PROGRESS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"];

/** Why bringing `files` into `repo` is unsafe right now, or null. Checked before anything is written. */
function applyBlocker(repo: string, files: string[]): string | null {
  for (const name of IN_PROGRESS) {
    if (fs.existsSync(path.resolve(repo, mustGit(repo, ["rev-parse", "--git-path", name]).trim()))) {
      return `${repo} is in the middle of a merge, rebase, cherry-pick or revert (${name}); finish or abort it first.`;
    }
  }
  if (git(repo, ["diff", "--cached", "--quiet"]).status !== 0) return `Staged changes in ${repo}; commit or unstage them first.`;
  // porcelain v1 -z: "XY path\0", and a rename / copy adds its source path as the next field.
  const fields = mustGit(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0");
  const dirty = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    dirty.add(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") dirty.add(fields[++i]!);
  }
  const overlap = files.filter((file) => dirty.has(file));
  return overlap.length ? `Uncommitted or untracked files in ${repo} overlap the task's changes: ${overlap.join(", ")}. Commit, stash or move them first.` : null;
}

/**
 * Bring `tree` (forked at `base`) onto the current branch of `repo` as one commit: commit-tree, then cherry-pick
 * for a three-way merge. Any refusal or conflict leaves HEAD, index and working tree as they were.
 */
export function applyTree(repo: string, base: string, tree: string, message: string): { commit: string; files: string[] } | null {
  const files = changedPaths(repo, base, tree);
  if (!files.length) return null;
  const blocker = applyBlocker(repo, files);
  if (blocker) throw new Error(blocker);
  const squash = mustGit(repo, ["commit-tree", tree, "-p", base, "-F", "-"], { input: message }).trim();
  const picked = git(repo, ["cherry-pick", squash]);
  if (picked.status !== 0) {
    const conflicts = git(repo, ["diff", "--name-only", "--diff-filter=U", "-z"]).stdout.split("\0").filter(Boolean);
    git(repo, ["cherry-pick", "--abort"]);
    const detail = (picked.stderr || picked.stdout).trim();
    throw new Error(`cherry-pick failed and was aborted; ${repo} is unchanged.${conflicts.length ? ` Conflicts: ${conflicts.join(", ")}.` : ""} ${detail}`.trim());
  }
  return { commit: headSha(repo), files };
}

/** Delete a task's worktree and branch regardless of their state; true when both are gone. */
/** Removes an --isolate worktree and its branch; null on success, otherwise what stayed behind and what git said. */
export function removeTaskWorktree(repo: string, worktreePath: string, branch: string): string | null {
  const problems = cleanupWorktree(repo, worktreePath, branch);
  if (fs.existsSync(worktreePath)) problems.push(`${worktreePath} still exists`);
  if (git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0) problems.push(`branch ${branch} still exists`);
  return problems.length ? problems.join("; ") : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function loadWorktreeConfig(repo: string): WorktreeConfig {
  const file = path.join(repo, ".baton.json");
  if (!fs.existsSync(file)) return { copy: [], symlink: [], post_create: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`.baton.json is invalid: ${(error as Error).message}`);
  }
  const section = raw && typeof raw === "object" && "worktree" in raw
    ? (raw as { worktree?: Record<string, unknown> }).worktree
    : undefined;
  if (!section || typeof section !== "object") return { copy: [], symlink: [], post_create: [] };
  return {
    dir: typeof section.dir === "string" ? section.dir : undefined,
    base: typeof section.base === "string" ? section.base : undefined,
    copy: strings(section.copy),
    symlink: strings(section.symlink),
    post_create: strings(section.post_create),
    rulesync: typeof section.rulesync === "boolean" ? section.rulesync : undefined,
  };
}

export function resolveWorktreeRoot(repo: string, cfg: Pick<WorktreeConfig, "dir">): string {
  if (cfg.dir) return path.resolve(repo, cfg.dir);
  const hidden = path.join(repo, ".worktrees");
  const plain = path.join(repo, "worktrees");
  if (fs.existsSync(hidden)) return hidden;
  if (fs.existsSync(plain)) return plain;
  return hidden;
}

export function ensureIgnored(repo: string, worktreeRoot: string): boolean {
  const rel = path.relative(repo, worktreeRoot) || ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("worktree root must be inside the repository.");
  }
  const check = git(repo, ["check-ignore", "-q", rel]);
  if (check.status === 0) return false;
  const ignorePath = path.join(repo, ".gitignore");
  const entry = rel.endsWith("/") ? rel : `${rel}/`;
  const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf8") : "";
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(ignorePath, `${existing}${prefix}${entry}\n`);
  return true;
}

export function assertNotNestedWorktree(cwd: string): void {
  const dir = git(cwd, ["rev-parse", "--git-dir"]);
  const common = git(cwd, ["rev-parse", "--git-common-dir"]);
  if (dir.status !== 0 || common.status !== 0) throw new Error("Current directory is not a git repository.");
  // realpath: on macOS /var vs /private/var must not look like a linked worktree.
  const gitDir = fs.realpathSync.native(path.resolve(cwd, dir.stdout.trim()));
  const gitCommon = fs.realpathSync.native(path.resolve(cwd, common.stdout.trim()));
  if (gitDir === gitCommon) return;
  const superproject = git(cwd, ["rev-parse", "--show-superproject-working-tree"]);
  if (superproject.status === 0 && superproject.stdout.trim()) return;
  throw new Error("Already in a linked worktree; return to the main repository before add (nesting is not allowed).");
}

export function resolveRepoRoot(cwd: string): string {
  const ran = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (ran.status !== 0) throw new Error("Current directory is not a git repository.");
  return ran.stdout.trim();
}

/**
 * Paths the dirty-tree guard should ignore when `cwd` is inside a Baton-managed
 * linked worktree (has `.baton-worktree.json` and git-dir ≠ common-dir).
 * Empty when not in such a worktree — so a stray `.baton-worktree.json` in the
 * main checkout still counts as dirty.
 */
export function batonWorktreeExemptPaths(cwd: string): Set<string> {
  const dir = git(cwd, ["rev-parse", "--git-dir"]);
  const common = git(cwd, ["rev-parse", "--git-common-dir"]);
  if (dir.status !== 0 || common.status !== 0) return new Set();
  const gitDir = fs.realpathSync.native(path.resolve(cwd, dir.stdout.trim()));
  const gitCommon = fs.realpathSync.native(path.resolve(cwd, common.stdout.trim()));
  if (gitDir === gitCommon) return new Set(); // main checkout
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return new Set();
  const worktreeRoot = top.stdout.trim();
  if (!fs.existsSync(path.join(worktreeRoot, META_NAME))) return new Set();
  const exempt = new Set<string>([META_NAME]);
  const mainRepo = path.dirname(gitCommon);
  const cfg = loadWorktreeConfig(mainRepo);
  for (const entry of [...cfg.copy, ...cfg.symlink]) exempt.add(entry);
  return exempt;
}

function defaultBase(repo: string, configured?: string): string {
  if (configured) return configured;
  for (const candidate of ["main", "master"]) {
    const check = git(repo, ["rev-parse", "--verify", candidate]);
    if (check.status === 0) return candidate;
  }
  const head = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.status === 0 && head.stdout.trim() && head.stdout.trim() !== "HEAD") return head.stdout.trim();
  throw new Error("Cannot detect the base branch; set it in .baton.json or with --base.");
}

function writeMeta(worktreePath: string, meta: WorktreeMeta): void {
  fs.writeFileSync(path.join(worktreePath, META_NAME), `${JSON.stringify(meta, null, 2)}\n`);
}

function readMeta(worktreePath: string): WorktreeMeta | null {
  const file = path.join(worktreePath, META_NAME);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as WorktreeMeta;
  } catch {
    return null;
  }
}

export function addWorktree(
  cwd: string,
  options: { name?: string; branch?: string; base?: string } = {},
): WorktreeAddResult {
  assertNotNestedWorktree(cwd);
  const repo = resolveRepoRoot(cwd);
  const cfg = loadWorktreeConfig(repo);
  const root = resolveWorktreeRoot(repo, cfg);
  const gitignore_updated = ensureIgnored(repo, root);
  fs.mkdirSync(root, { recursive: true });

  const name = options.name || randomBytes(4).toString("hex");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("worktree name contains invalid characters.");
  const worktreePath = path.join(root, name);
  if (fs.existsSync(worktreePath)) throw new Error(`worktree already exists: ${worktreePath}`);

  const branch = options.branch || `baton/${name}`;
  const base = defaultBase(repo, options.base ?? cfg.base);
  const created = git(repo, ["worktree", "add", "-b", branch, worktreePath, base]);
  if (created.status !== 0) {
    throw new Error(`git worktree add failed: ${(created.stderr || created.stdout).trim()}`);
  }

  const meta: WorktreeMeta = { name, branch, base, created_at: new Date().toISOString() };
  writeMeta(worktreePath, meta);
  try {
    prepareWorktree(repo, worktreePath, cfg);
  } catch (error) {
    cleanupWorktree(repo, worktreePath, branch);
    throw error;
  }
  const rules = applyWorktreeRulesync(repo, worktreePath, cfg);
  return { status: "ok", path: worktreePath, branch, base, name, gitignore_updated, rules };
}

function rootRuleEntries(dir: string): string[] {
  const found: string[] = [];
  for (const entry of RULE_ENTRIES) {
    const full = path.join(dir, entry);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        if (fs.readdirSync(full).length) found.push(entry);
      } else if (st.isFile()) {
        found.push(entry);
      }
    } catch {
      // absent
    }
  }
  return found.sort();
}

function applyWorktreeRulesync(repo: string, worktreePath: string, cfg: WorktreeConfig): WorktreeRulesResult {
  const missing = rootRuleEntries(repo).filter((entry) => !fs.existsSync(path.join(worktreePath, entry)));
  if (cfg.rulesync === false) {
    return { rulesync: "skipped", detail: "disabled in .baton.json", missing, dirtied: [] };
  }
  if (!hasRulesyncSource(worktreePath)) {
    return { rulesync: "skipped", detail: "no .rulesync/ in worktree", missing, dirtied: [] };
  }
  const bin = resolveRulesync(worktreePath, repo);
  if (!bin) {
    return { rulesync: "skipped", detail: "rulesync not found in node_modules/.bin or PATH", missing, dirtied: [] };
  }
  const ran = crossSpawn.sync(bin, ["generate"], {
    cwd: worktreePath,
    encoding: "utf8",
    env: { ...process.env, BATON_DELEGATION: "1" },
    timeout: 60_000,
  });
  if ((ran.status ?? 1) !== 0) {
    const detail = redact((ran.stderr || ran.stdout || `rulesync exited ${ran.status}`).trim()).slice(0, 200);
    return { rulesync: "error", detail, missing: rootRuleEntries(repo).filter((entry) => !fs.existsSync(path.join(worktreePath, entry))), dirtied: [] };
  }
  const porcelain = git(worktreePath, ["status", "--porcelain", "--untracked-files=no"]);
  const dirtied = porcelain.status === 0
    ? porcelain.stdout.split("\n").map((line) => line.slice(3).trim()).filter(Boolean)
    : [];
  return {
    rulesync: "generated",
    missing: rootRuleEntries(repo).filter((entry) => !fs.existsSync(path.join(worktreePath, entry))),
    dirtied,
  };
}

export function listWorktrees(cwd: string): WorktreeListItem[] {
  const repo = resolveRepoRoot(cwd);
  const cfg = loadWorktreeConfig(repo);
  const root = resolveWorktreeRoot(repo, cfg);
  if (!fs.existsSync(root)) return [];
  const items: WorktreeListItem[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const worktreePath = path.join(root, entry.name);
    const meta = readMeta(worktreePath);
    if (!meta) continue;
    items.push({ name: meta.name, path: worktreePath, branch: meta.branch, base: meta.base });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/** Minimal gitignore-style match for basename patterns (`*` / `?`). */
export function matchBasename(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(name);
}

function prepareWorktree(repo: string, worktreePath: string, cfg: WorktreeConfig): void {
  const names = fs.readdirSync(repo);
  for (const pattern of cfg.copy) {
    for (const name of names) {
      if (!matchBasename(name, pattern)) continue;
      const src = path.join(repo, name);
      const dest = path.join(worktreePath, name);
      const stat = fs.lstatSync(src);
      if (stat.isDirectory()) fs.cpSync(src, dest, { recursive: true });
      else fs.copyFileSync(src, dest);
    }
  }
  for (const pattern of cfg.symlink) {
    for (const name of names) {
      if (!matchBasename(name, pattern)) continue;
      const src = path.join(repo, name);
      const dest = path.join(worktreePath, name);
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      try {
        // junction: Windows lets any user link a directory this way; file links need Developer Mode or admin.
        fs.symlinkSync(src, dest, fs.statSync(src).isDirectory() ? "junction" : "file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        throw new Error(`cannot symlink ${name}: Windows needs Developer Mode or admin rights for file links; list it under "copy" in .baton.json instead.`);
      }
    }
  }
  for (const command of cfg.post_create) {
    const ran = spawnSync(command, {
      cwd: worktreePath,
      shell: true,
      encoding: "utf8",
      env: { ...process.env, BATON_MAIN_REPO: repo, BATON_WORKTREE: worktreePath },
      timeout: 600_000,
    });
    if (ran.status !== 0) {
      const detail = (ran.stderr || ran.stdout || "").trim() || `exit ${ran.status}`;
      throw new Error(`post_create failed (${command}): ${detail}`);
    }
  }
}

function cleanupWorktree(repo: string, worktreePath: string, branch: string): string[] {
  const errors: string[] = [];
  for (const args of [["worktree", "remove", "--force", worktreePath], ["branch", "-D", branch], ["worktree", "prune"]]) {
    const ran = git(repo, args);
    if (ran.status !== 0) errors.push(`git ${args.slice(0, 2).join(" ")}: ${(ran.stderr || ran.stdout).trim()}`);
  }
  return errors;
}

function resolveManagedPath(cwd: string, nameOrPath: string): { repo: string; root: string; worktreePath: string; meta: WorktreeMeta } {
  const repo = resolveRepoRoot(cwd);
  const cfg = loadWorktreeConfig(repo);
  const root = resolveWorktreeRoot(repo, cfg);
  const candidate = path.isAbsolute(nameOrPath) ? path.resolve(nameOrPath) : path.resolve(cwd, nameOrPath);
  const byName = path.join(root, nameOrPath);
  const worktreePath = fs.existsSync(path.join(candidate, META_NAME))
    ? candidate
    : fs.existsSync(path.join(byName, META_NAME))
      ? byName
      : candidate;
  const rel = path.relative(root, worktreePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Can only remove baton-managed trees under the worktree root.");
  }
  const meta = readMeta(worktreePath);
  if (!meta) throw new Error(`Not a baton-managed worktree: ${worktreePath}`);
  return { repo, root, worktreePath, meta };
}

function isDirty(worktreePath: string): boolean {
  // Ignore untracked (copy/.baton-worktree.json); only block on tracked edits.
  const status = git(worktreePath, ["status", "--porcelain", "--untracked-files=no"]);
  return status.status === 0 && status.stdout.trim().length > 0;
}

function hasUnmergedCommits(repo: string, branch: string, base: string): boolean {
  const ran = git(repo, ["rev-list", "--count", `${base}..${branch}`]);
  if (ran.status !== 0) return true;
  return Number(ran.stdout.trim()) > 0;
}

export type WorktreeRemoveResult = { status: "ok"; path: string; branch: string; name: string };

export function removeWorktree(cwd: string, nameOrPath: string): WorktreeRemoveResult {
  const { repo, worktreePath, meta } = resolveManagedPath(cwd, nameOrPath);
  if (isDirty(worktreePath)) {
    throw new Error(`worktree has uncommitted changes; refusing to remove: ${worktreePath}`);
  }
  if (hasUnmergedCommits(repo, meta.branch, meta.base)) {
    throw new Error(`Branch ${meta.branch} has commits not merged into ${meta.base}; refusing to remove.`);
  }
  // ponytail: --force after our tracked-dirty + unmerged checks; untracked copy/meta are expected
  const removed = git(repo, ["worktree", "remove", "--force", worktreePath]);
  if (removed.status !== 0) {
    throw new Error(`git worktree remove failed: ${(removed.stderr || removed.stdout).trim()}`);
  }
  const deleted = git(repo, ["branch", "-d", meta.branch]);
  if (deleted.status !== 0) {
    throw new Error(`Failed to delete branch: ${(deleted.stderr || deleted.stdout).trim()}`);
  }
  git(repo, ["worktree", "prune"]);
  return { status: "ok", path: worktreePath, branch: meta.branch, name: meta.name };
}
