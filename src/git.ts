import type { GitChanges, ScopeBaseline } from "./types.ts";
export type Snapshot = {
  head: string | null;
  porcelain: Map<string, string>;
  digests: Map<string, string>;
};
type SnapshotInput = Snapshot | Map<string, string> | null;
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function digestFile(cwd: string, filePath: string) {
  try {
    const full = path.join(cwd, filePath);
    const data = fs.readFileSync(full);
    return crypto.createHash("sha256").update(data).digest("hex");
  } catch {
    return null;
  }
}

function revParseHead(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 5000 });
  if (result.error || result.status !== 0) return null;
  const head = (result.stdout || "").trim();
  return head || null;
}

export function gitRepoRoot(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 5000 });
  if (result.error || result.status !== 0) return null;
  const root = (result.stdout || "").trim();
  return root || null;
}

function normalizeSnapshot(snapshot: SnapshotInput): Snapshot | null {
  if (!snapshot) return null;
  if (!(snapshot instanceof Map) && snapshot.porcelain instanceof Map) {
    return {
      head: snapshot.head ?? null,
      porcelain: snapshot.porcelain,
      digests: snapshot.digests ?? new Map(),
    };
  }
  if (snapshot instanceof Map) return { head: null, porcelain: snapshot, digests: new Map() };
  return null;
}

export function gitSnapshot(cwd: string): Snapshot | null {
  const result = spawnSync("git", ["status", "--porcelain", "-uall"], {
    cwd,
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return null;
  // Porcelain paths are relative to the repo root, even when cwd is a subdirectory.
  const root = gitRepoRoot(cwd) ?? cwd;
  const porcelain = new Map<string, string>();
  const digests = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    if (line.length < 4) continue;
    const body = line.slice(3);
    const filePath = body.includes(" -> ") ? body.split(" -> ").pop()! : body;
    porcelain.set(filePath, line);
    const digest = digestFile(root, filePath);
    if (digest) digests.set(filePath, digest);
  }
  return { head: revParseHead(cwd), porcelain, digests };
}

export function snapshotToBaseline(snapshot: Snapshot): ScopeBaseline {
  if (!snapshot.head) throw new Error("scope baseline 需要有效 HEAD。");
  return {
    head: snapshot.head,
    porcelain: Object.fromEntries(snapshot.porcelain),
    digests: Object.fromEntries(snapshot.digests),
  };
}

export function baselineToSnapshot(baseline: ScopeBaseline): Snapshot {
  return {
    head: baseline.head,
    porcelain: new Map(Object.entries(baseline.porcelain)),
    digests: new Map(Object.entries(baseline.digests)),
  };
}

function workingTreeChanged(before: Snapshot, after: Snapshot): string[] {
  const paths: string[] = [];
  for (const key of new Set([...before.porcelain.keys(), ...after.porcelain.keys()])) {
    const lineChanged = before.porcelain.get(key) !== after.porcelain.get(key);
    const digestChanged = before.digests.get(key) !== after.digests.get(key)
      && (before.digests.has(key) || after.digests.has(key));
    if (lineChanged || digestChanged) paths.push(key);
  }
  return paths;
}

/** Committed path names between two HEADs; renames contribute both sides. Throws if git diff fails while HEADs differ. */
export function committedNames(cwd: string, fromHead: string, toHead: string): string[] {
  if (!fromHead || !toHead || fromHead === toHead) return [];
  const result = spawnSync(
    "git",
    ["diff", "--name-status", "-M", `${fromHead}..${toHead}`],
    { cwd, encoding: "utf8", timeout: 10_000 },
  );
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
    throw new Error(`git diff ${fromHead.slice(0, 7)}..${toHead.slice(0, 7)} 失败：${detail || `exit ${result.status}`}`);
  }
  const paths = new Set<string>();
  for (const line of (result.stdout || "").split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      if (parts[1]) paths.add(parts[1]);
      if (parts[2]) paths.add(parts[2]);
    } else if (parts[1]) {
      paths.add(parts[1]);
    }
  }
  return [...paths];
}

/** Task-level net change: commits since baseline HEAD ∪ working-tree digest/porcelain diff. */
export function pathsSinceBaseline(cwd: string, baseline: Snapshot, current: Snapshot): string[] {
  const set = new Set<string>();
  if (baseline.head && current.head) {
    for (const p of committedNames(cwd, baseline.head, current.head)) set.add(p);
  }
  for (const p of workingTreeChanged(baseline, current)) set.add(p);
  return [...set];
}

function untrackedInsertions(cwd: string, filePath: string) {
  try {
    const text = fs.readFileSync(path.join(cwd, filePath), "utf8");
    if (!text) return 0;
    const lines = text.split("\n");
    return text.endsWith("\n") ? Math.max(lines.length - 1, 0) : lines.length;
  } catch {
    return 0;
  }
}

export function gitChanges(cwd: string, beforeRaw: SnapshotInput, afterRaw: SnapshotInput): GitChanges | undefined {
  const before = normalizeSnapshot(beforeRaw);
  const after = normalizeSnapshot(afterRaw);
  if (!before || !after) return undefined;
  const paths = workingTreeChanged(before, after);
  if (paths.length === 0) {
    return { files_changed: 0, insertions: 0, deletions: 0, diff_stat: "" };
  }
  const root = gitRepoRoot(cwd) ?? cwd;

  const untracked = [];
  const tracked = [];
  for (const filePath of paths) {
    const afterLine = after.porcelain.get(filePath);
    const beforeLine = before.porcelain.get(filePath);
    if (afterLine?.startsWith("??") || (!afterLine && beforeLine?.startsWith("??"))) {
      untracked.push(filePath);
    } else {
      tracked.push(filePath);
    }
  }

  let diffStat = "";
  let insertions = 0;
  let deletions = 0;
  if (tracked.length) {
    // shortcut: 超过 50 个路径就不再逐个点名，升级时改成 --raw 再过滤。
    const result = spawnSync("git", ["diff", "--stat", "--", ...tracked.slice(0, 50)], {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
    });
    diffStat = (result.stdout || "").trim();
    insertions = Number(diffStat.match(/(\d+) insertion/)?.[1] || 0);
    deletions = Number(diffStat.match(/(\d+) deletion/)?.[1] || 0);
  }
  if (untracked.length) {
    const extras = [];
    for (const filePath of untracked) {
      if (after.porcelain.has(filePath)) {
        const added = untrackedInsertions(root, filePath);
        insertions += added;
        extras.push(`${filePath} | untracked +${added}`);
      } else {
        extras.push(`${filePath} | untracked deleted`);
      }
    }
    const extra = extras.join("\n");
    diffStat = diffStat ? `${diffStat}\n${extra}` : extra;
  }
  return {
    files_changed: paths.length,
    insertions,
    deletions,
    diff_stat: diffStat,
  };
}
