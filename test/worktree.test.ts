import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadWorktreeConfig,
  resolveWorktreeRoot,
  ensureIgnored,
  assertNotNestedWorktree,
} from "../src/worktree.ts";

function tempRepo(): { cwd: string; git: (args: string[]) => string; cleanup: () => void } {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "baton-wt-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  writeFileSync(path.join(cwd, "README.md"), "init\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "init"]);
  return { cwd, git, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("loadWorktreeConfig 读 .baton.json，缺省给安全默认值", () => {
  const { cwd, cleanup } = tempRepo();
  try {
    const empty = loadWorktreeConfig(cwd);
    assert.equal(empty.dir, undefined);
    assert.deepEqual(empty.copy, []);
    assert.deepEqual(empty.symlink, []);
    assert.deepEqual(empty.post_create, []);
    assert.equal(empty.base, undefined);

    writeFileSync(path.join(cwd, ".baton.json"), JSON.stringify({
      worktree: {
        dir: ".worktrees",
        base: "main",
        copy: [".env"],
        symlink: ["node_modules"],
        post_create: ["echo hi"],
      },
    }));
    const cfg = loadWorktreeConfig(cwd);
    assert.equal(cfg.dir, ".worktrees");
    assert.equal(cfg.base, "main");
    assert.deepEqual(cfg.copy, [".env"]);
    assert.deepEqual(cfg.symlink, ["node_modules"]);
    assert.deepEqual(cfg.post_create, ["echo hi"]);
  } finally {
    cleanup();
  }
});

test("resolveWorktreeRoot：配置 dir > .worktrees > worktrees > 默认 .worktrees", () => {
  const { cwd, cleanup } = tempRepo();
  try {
    assert.equal(resolveWorktreeRoot(cwd, {}), path.join(cwd, ".worktrees"));

    mkdirSync(path.join(cwd, "worktrees"));
    assert.equal(resolveWorktreeRoot(cwd, {}), path.join(cwd, "worktrees"));

    mkdirSync(path.join(cwd, ".worktrees"));
    assert.equal(resolveWorktreeRoot(cwd, {}), path.join(cwd, ".worktrees"));

    assert.equal(
      resolveWorktreeRoot(cwd, { dir: "custom-trees" }),
      path.join(cwd, "custom-trees"),
    );
  } finally {
    cleanup();
  }
});

test("ensureIgnored：未忽略则追加 .gitignore，已忽略则不动", () => {
  const { cwd, git, cleanup } = tempRepo();
  try {
    const root = path.join(cwd, ".worktrees");
    mkdirSync(root);
    const first = ensureIgnored(cwd, root);
    assert.equal(first, true);
    assert.match(readFileSync(path.join(cwd, ".gitignore"), "utf8"), /\.worktrees\/?/);
    assert.equal(execFileSync("git", ["check-ignore", "-q", ".worktrees"], { cwd, encoding: "utf8" }), "");

    const second = ensureIgnored(cwd, root);
    assert.equal(second, false);
  } finally {
    cleanup();
  }
});

test("assertNotNestedWorktree：主仓通过，linked worktree 拒绝", () => {
  const { cwd, git, cleanup } = tempRepo();
  try {
    assert.doesNotThrow(() => assertNotNestedWorktree(cwd));

    writeFileSync(path.join(cwd, ".gitignore"), ".worktrees/\n");
    git(["add", ".gitignore"]);
    git(["commit", "-m", "ignore"]);
    mkdirSync(path.join(cwd, ".worktrees"));
    const linked = path.join(cwd, ".worktrees", "feat");
    git(["worktree", "add", "-b", "feat-branch", linked]);

    assert.throws(() => assertNotNestedWorktree(linked), /linked worktree|嵌套|main repo/i);
  } finally {
    cleanup();
  }
});
