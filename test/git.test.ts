import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { gitSnapshot, gitChanges, pathsSinceBaseline } from "../src/git.ts";
test("gitChanges reports only paths whose porcelain line changed", () => {
  const cwd = mkdtempSync(path.join(import.meta.dirname, "tmp-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init"]);
  writeFileSync(path.join(cwd, "a.txt"), "one\n");
  git(["add", "a.txt"]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init"]);
  const before = gitSnapshot(cwd);
  writeFileSync(path.join(cwd, "a.txt"), "one\ntwo\n");
  writeFileSync(path.join(cwd, "b.txt"), "new\n");
  const after = gitSnapshot(cwd);
  const changes = gitChanges(cwd, before, after);
  assert.ok(changes);
  assert.equal(changes.files_changed, 2);
  assert.ok(changes.insertions >= 1);
  assert.match(changes.diff_stat, /a\.txt/);
  assert.match(changes.diff_stat, /b\.txt \| untracked \+1/);
  rmSync(cwd, { recursive: true, force: true });
});

test("gitChanges detects content edits to files that stay untracked", () => {
  const cwd = mkdtempSync(path.join(import.meta.dirname, "tmp-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init"]);
  writeFileSync(path.join(cwd, "u.txt"), "aaa\n");
  const before = gitSnapshot(cwd);
  writeFileSync(path.join(cwd, "u.txt"), "aaa\nbbb\nccc\n");
  const after = gitSnapshot(cwd);
  const changes = gitChanges(cwd, before, after);
  assert.ok(changes);
  assert.equal(changes.files_changed, 1);
  assert.ok(changes.insertions >= 2);
  assert.match(changes.diff_stat, /u\.txt \| untracked/);
  rmSync(cwd, { recursive: true, force: true });
});

test("gitChanges detects dirty tracked edits and changes in nested untracked dirs (issue #30)", () => {
  const cwd = mkdtempSync(path.join(import.meta.dirname, "tmp-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init"]);
  writeFileSync(path.join(cwd, "README.md"), "# Init\n");
  git(["add", "README.md"]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init"]);

  // 1. Pre-dirty a tracked file
  writeFileSync(path.join(cwd, "README.md"), "# Init\npre-edit line\n");

  // 2. Create nested untracked dir with files
  mkdirSync(path.join(cwd, "services/sandbox-gateway/nginx"), { recursive: true });
  writeFileSync(path.join(cwd, "services/sandbox-gateway/docker-compose.yml"), "version: 3\n");
  writeFileSync(path.join(cwd, "services/sandbox-gateway/nginx/conf.txt"), "server {}\n");

  const before = gitSnapshot(cwd);

  // 3. Worker modifies dirty tracked file again
  writeFileSync(path.join(cwd, "README.md"), "# Init\npre-edit line\nworker line\n");

  // 4. Worker adds a new file in untracked dir
  mkdirSync(path.join(cwd, "services/sandbox-gateway/frpc"), { recursive: true });
  writeFileSync(path.join(cwd, "services/sandbox-gateway/frpc/frpc.toml"), "server_addr = 127.0.0.1\n");

  // 5. Worker renames conf.txt to template.txt (delete old, add new)
  unlinkSync(path.join(cwd, "services/sandbox-gateway/nginx/conf.txt"));
  writeFileSync(path.join(cwd, "services/sandbox-gateway/nginx/template.txt"), "server template {}\n");

  const after = gitSnapshot(cwd);
  const changes = gitChanges(cwd, before, after);
  assert.ok(changes);

  // docker-compose.yml unchanged, so 4 files changed:
  // README.md, frpc.toml, conf.txt (deleted), template.txt (added)
  assert.equal(changes.files_changed, 4);
  assert.match(changes.diff_stat, /README\.md/);
  assert.match(changes.diff_stat, /services\/sandbox-gateway\/frpc\/frpc\.toml \| untracked \+1/);
  assert.match(changes.diff_stat, /services\/sandbox-gateway\/nginx\/template\.txt \| untracked \+1/);
  assert.match(changes.diff_stat, /services\/sandbox-gateway\/nginx\/conf\.txt \| untracked deleted/);
  rmSync(cwd, { recursive: true, force: true });
});

test("gitSnapshot includes HEAD", () => {
  const cwd = mkdtempSync(path.join(import.meta.dirname, "tmp-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init"]);
  writeFileSync(path.join(cwd, "a.txt"), "one\n");
  git(["add", "a.txt"]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init"]);
  const snap = gitSnapshot(cwd);
  assert.ok(snap?.head);
  assert.match(snap!.head!, /^[0-9a-f]{40}$/);
  rmSync(cwd, { recursive: true, force: true });
});

test("pathsSinceBaseline includes committed files after clean worktree", () => {
  const cwd = mkdtempSync(path.join(import.meta.dirname, "tmp-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init"]);
  writeFileSync(path.join(cwd, "ok.txt"), "ok\n");
  git(["add", "ok.txt"]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init"]);
  const baseline = gitSnapshot(cwd)!;
  writeFileSync(path.join(cwd, "leak.txt"), "leak\n");
  git(["add", "leak.txt"]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "leak"]);
  const current = gitSnapshot(cwd)!;
  assert.equal(current.porcelain.size, 0);
  const paths = pathsSinceBaseline(cwd, baseline, current);
  assert.ok(paths.includes("leak.txt"));
  rmSync(cwd, { recursive: true, force: true });
});

test("pathsSinceBaseline: pre-dirty unchanged excluded; content change included", () => {
  const cwd = mkdtempSync(path.join(import.meta.dirname, "tmp-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init"]);
  writeFileSync(path.join(cwd, "a.txt"), "one\n");
  writeFileSync(path.join(cwd, "b.txt"), "b\n");
  git(["add", "."]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init"]);
  writeFileSync(path.join(cwd, "a.txt"), "one\ndirty\n");
  writeFileSync(path.join(cwd, "b.txt"), "b\ndirty\n");
  const baseline = gitSnapshot(cwd)!;
  writeFileSync(path.join(cwd, "b.txt"), "b\ndirty\nchanged\n");
  const current = gitSnapshot(cwd)!;
  const paths = pathsSinceBaseline(cwd, baseline, current);
  assert.equal(paths.includes("a.txt"), false);
  assert.equal(paths.includes("b.txt"), true);
  rmSync(cwd, { recursive: true, force: true });
});

test("gitSnapshot digests resolve against repo root when cwd is subdirectory", () => {
  const cwd = mkdtempSync(path.join(import.meta.dirname, "tmp-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init"]);
  mkdirSync(path.join(cwd, "pkg"));
  writeFileSync(path.join(cwd, "pkg", "a.ts"), "one\n");
  git(["add", "pkg/a.ts"]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init"]);
  writeFileSync(path.join(cwd, "pkg", "a.ts"), "one\ndirty\n");
  const sub = path.join(cwd, "pkg");
  const snap = gitSnapshot(sub)!;
  assert.ok(snap.digests.get("pkg/a.ts"), "digest must be keyed by repo-root-relative path");
  rmSync(cwd, { recursive: true, force: true });
});

test("pathsSinceBaseline: rename lists both paths; delete listed", () => {
  const cwd = mkdtempSync(path.join(import.meta.dirname, "tmp-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init"]);
  writeFileSync(path.join(cwd, "old.txt"), "x\n");
  writeFileSync(path.join(cwd, "gone.txt"), "g\n");
  git(["add", "."]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init"]);
  const baseline = gitSnapshot(cwd)!;
  git(["mv", "old.txt", "new.txt"]);
  git(["rm", "gone.txt"]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "move"]);
  const current = gitSnapshot(cwd)!;
  const paths = pathsSinceBaseline(cwd, baseline, current);
  assert.ok(paths.includes("old.txt"));
  assert.ok(paths.includes("new.txt"));
  assert.ok(paths.includes("gone.txt"));
  rmSync(cwd, { recursive: true, force: true });
});

