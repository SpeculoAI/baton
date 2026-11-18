import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type WorktreeConfig = {
  dir?: string;
  base?: string;
  copy: string[];
  symlink: string[];
  post_create: string[];
};

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
