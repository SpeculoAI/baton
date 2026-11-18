import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

export type WorktreeConfig = {
  dir?: string;
  base?: string;
  copy: string[];
  symlink: string[];
  post_create: string[];
};

export type WorktreeMeta = {
  name: string;
  branch: string;
  base: string;
  created_at: string;
};

export type WorktreeAddResult = {
  status: "ok";
  path: string;
  branch: string;
  base: string;
  name: string;
  gitignore_updated: boolean;
};

export type WorktreeListItem = {
  name: string;
  path: string;
  branch: string;
  base: string;
};

const META_NAME = ".baton-worktree.json";

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const ran = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: ran.status ?? 1, stdout: ran.stdout || "", stderr: ran.stderr || "" };
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
    throw new Error(`.baton.json 无效：${(error as Error).message}`);
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
    throw new Error("worktree 根目录必须在仓库内。");
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
  if (dir.status !== 0 || common.status !== 0) throw new Error("当前目录不是 git 仓库。");
  const gitDir = path.resolve(cwd, dir.stdout.trim());
  const gitCommon = path.resolve(cwd, common.stdout.trim());
  if (gitDir === gitCommon) return;
  const superproject = git(cwd, ["rev-parse", "--show-superproject-working-tree"]);
  if (superproject.status === 0 && superproject.stdout.trim()) return;
  throw new Error("已在 linked worktree 中，请回到主仓再 add（禁止嵌套）。");
}

export function resolveRepoRoot(cwd: string): string {
  const ran = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (ran.status !== 0) throw new Error("当前目录不是 git 仓库。");
  return ran.stdout.trim();
}

function defaultBase(repo: string, configured?: string): string {
  if (configured) return configured;
  for (const candidate of ["main", "master"]) {
    const check = git(repo, ["rev-parse", "--verify", candidate]);
    if (check.status === 0) return candidate;
  }
  const head = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.status === 0 && head.stdout.trim() && head.stdout.trim() !== "HEAD") return head.stdout.trim();
  throw new Error("无法探测 base 分支，请在 .baton.json 或 --base 指定。");
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
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("worktree name 含非法字符。");
  const worktreePath = path.join(root, name);
  if (fs.existsSync(worktreePath)) throw new Error(`worktree 已存在：${worktreePath}`);

  const branch = options.branch || `baton/${name}`;
  const base = defaultBase(repo, options.base ?? cfg.base);
  const created = git(repo, ["worktree", "add", "-b", branch, worktreePath, base]);
  if (created.status !== 0) {
    throw new Error(`git worktree add 失败：${(created.stderr || created.stdout).trim()}`);
  }

  const meta: WorktreeMeta = { name, branch, base, created_at: new Date().toISOString() };
  writeMeta(worktreePath, meta);
  return { status: "ok", path: worktreePath, branch, base, name, gitignore_updated };
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
