import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cli, exec, sandbox } from "./helpers.ts";
import type { TaskMeta } from "../src/types.ts";

type Sandbox = ReturnType<typeof sandbox>;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** Repo with a copy entry, a symlink entry and an ignored dir, all of which must never reach a diff. */
function repo(s: Sandbox) {
  git(s.cwd, "init", "-q");
  git(s.cwd, "config", "user.email", "t@example.com");
  git(s.cwd, "config", "user.name", "t");
  fs.writeFileSync(path.join(s.cwd, "keep.txt"), "keep\n");
  fs.writeFileSync(path.join(s.cwd, "lines.txt"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n");
  fs.writeFileSync(path.join(s.cwd, ".gitignore"), "build/\n.worktrees/\n");
  fs.writeFileSync(path.join(s.cwd, ".baton.json"), JSON.stringify({ worktree: { copy: ["local.cfg"], symlink: ["shared"] } }));
  git(s.cwd, "add", ".");
  git(s.cwd, "commit", "-qm", "init");
  // Untracked, not ignored in the main tree: only the exemption keeps them out of the diff.
  fs.writeFileSync(path.join(s.cwd, "local.cfg"), "secret=1\n");
  fs.mkdirSync(path.join(s.cwd, "shared"));
  fs.writeFileSync(path.join(s.cwd, "shared", "x.txt"), "x\n");
}

async function isolatedTask(s: Sandbox): Promise<TaskMeta> {
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--isolate");
  return s.until(started.task_id);
}

/** What a worker leaves behind: an edit, a new file, a commit, and an ignored build output. */
function workerChanges(wt: string) {
  fs.writeFileSync(path.join(wt, "committed.txt"), "committed\n");
  git(wt, "add", "committed.txt");
  git(wt, "-c", "user.email=w@example.com", "-c", "user.name=w", "commit", "-qm", "worker commit");
  fs.writeFileSync(path.join(wt, "keep.txt"), "keep\nedited\n");
  fs.writeFileSync(path.join(wt, "new.txt"), "new\n");
  fs.mkdirSync(path.join(wt, "build"));
  fs.writeFileSync(path.join(wt, "build", "out.txt"), "artifact\n");
}

async function text(s: Sandbox, ...args: string[]) {
  return (await exec(process.execPath, [cli, ...args], { cwd: s.cwd, env: s.env })).stdout;
}

function worktreeState(wt: string) {
  return {
    head: git(wt, "rev-parse", "HEAD"),
    status: git(wt, "status", "--porcelain", "--untracked-files=all"),
    index: git(wt, "ls-files", "-s"),
  };
}

test("--isolate records base_sha; diff shows commits, edits and new files, never Baton's files", async (t) => {
  const s = sandbox(t);
  repo(s);
  const head = git(s.cwd, "rev-parse", "HEAD").trim();
  const done = await isolatedTask(s);
  assert.equal(done.worktree?.base_sha, head);
  const wt = done.worktree!.path;
  assert.ok(fs.existsSync(path.join(wt, "local.cfg")));
  assert.ok(fs.lstatSync(path.join(wt, "shared")).isSymbolicLink());
  workerChanges(wt);
  const before = worktreeState(wt);

  const patch = await text(s, "diff", done.task_id);
  assert.match(patch, /diff --git a\/committed\.txt b\/committed\.txt/);
  assert.match(patch, /\+edited/);
  assert.match(patch, /diff --git a\/new\.txt b\/new\.txt/);
  for (const hidden of [".baton-worktree.json", "local.cfg", "shared", "build/out.txt", ".gitignore"]) {
    assert.doesNotMatch(patch, new RegExp(`b/${hidden.replace(/[.]/g, "\\.")}`), hidden);
  }
  const stat = await text(s, "diff", done.task_id, "--stat");
  assert.match(stat, /committed\.txt/);
  assert.match(stat, /keep\.txt/);
  assert.match(stat, /new\.txt/);
  assert.match(stat, /3 files changed/);
  assert.deepEqual(worktreeState(wt), before);
  assert.deepEqual(fs.readdirSync(s.dir(done.task_id)).filter((name) => name.endsWith(".index")), []);
});

test("diff with no changes is empty; a task without --isolate is refused", async (t) => {
  const s = sandbox(t);
  repo(s);
  const done = await isolatedTask(s);
  assert.equal(await text(s, "diff", done.task_id), "");
  const plain = await s.run("start", "--target", "codex", "--prompt", "hi", "--allow-dirty");
  await s.until(plain.task_id);
  await assert.rejects(text(s, "diff", plain.task_id), (error: { stdout?: string }) => {
    assert.match(JSON.parse(error.stdout || "{}").summary, /was not started with --isolate/);
    return true;
  });
});

test("an older task without base_sha falls back to merge-base", async (t) => {
  const s = sandbox(t);
  repo(s);
  const done = await isolatedTask(s);
  workerChanges(done.worktree!.path);
  const expected = await text(s, "diff", done.task_id);
  const file = path.join(s.dir(done.task_id), "meta.json");
  const meta = JSON.parse(fs.readFileSync(file, "utf8")) as TaskMeta;
  delete meta.worktree!.base_sha;
  fs.writeFileSync(file, JSON.stringify(meta));
  assert.equal(await text(s, "diff", done.task_id), expected);
});

type Applied = { task_id: string; status: string; repo: string; commit?: string; files?: string[]; removed: boolean; warning?: string };

async function refused(s: Sandbox, ...args: string[]): Promise<string> {
  try {
    await s.run(...args);
  } catch (error) {
    return JSON.parse((error as { stdout?: string }).stdout || "{}").summary;
  }
  throw new Error(`${args.join(" ")} was expected to fail`);
}

/** Everything apply must leave alone when it refuses. */
function sourceState(cwd: string) {
  return {
    head: git(cwd, "rev-parse", "HEAD"),
    status: git(cwd, "status", "--porcelain", "--untracked-files=all"),
    staged: git(cwd, "diff", "--cached"),
    unstaged: git(cwd, "diff"),
  };
}

const branchExists = (cwd: string, branch: string) => git(cwd, "branch", "--list", branch).trim() !== "";

test("diff and apply exclude ignored copy and symlink entries and preserve tracked exemptions (#95)", async (t) => {
  const s = sandbox(t);
  repo(s);
  fs.appendFileSync(path.join(s.cwd, ".gitignore"), "node_modules\n.env.local\n.env.tracked\n");
  fs.writeFileSync(path.join(s.cwd, ".baton.json"), JSON.stringify({
    worktree: { copy: ["local.cfg", ".env.local", ".env*"], symlink: ["shared", "node_modules"] },
  }));
  fs.writeFileSync(path.join(s.cwd, ".env.tracked"), "tracked\n");
  git(s.cwd, "add", "-f", ".env.tracked");
  git(s.cwd, "add", ".gitignore", ".baton.json");
  git(s.cwd, "commit", "-qm", "configure worktree exemptions");
  fs.mkdirSync(path.join(s.cwd, "node_modules"));
  fs.writeFileSync(path.join(s.cwd, ".env.local"), "ignored\n");
  fs.writeFileSync(path.join(s.cwd, ".env.example"), "untracked\n");

  const done = await isolatedTask(s);
  const wt = done.worktree!.path;
  assert.ok(fs.lstatSync(path.join(wt, "node_modules")).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(wt, ".env.local"), "utf8"), "ignored\n");
  assert.equal(fs.readFileSync(path.join(wt, ".env.example"), "utf8"), "untracked\n");
  assert.equal(git(wt, "check-ignore", ".env.local", "node_modules"), ".env.local\nnode_modules\n");
  fs.writeFileSync(path.join(wt, ".env.tracked"), "worker edit\n");
  workerChanges(wt);
  const patch = await text(s, "diff", done.task_id);
  assert.deepEqual(patch.match(/^diff --git .*$/gm), [
    "diff --git a/committed.txt b/committed.txt",
    "diff --git a/keep.txt b/keep.txt",
    "diff --git a/new.txt b/new.txt",
  ]);
  const stat = await text(s, "diff", done.task_id, "--stat");
  assert.match(stat, /3 files changed/);
  assert.doesNotMatch(stat, /node_modules|\.env|local\.cfg|shared|build|\.baton/);
  const before = worktreeState(wt);
  const head = git(s.cwd, "rev-parse", "HEAD").trim();

  const applied = await s.run<Applied>("apply", done.task_id);
  assert.equal(applied.status, "applied");
  assert.equal(applied.removed, false);
  // git reports C:/long/path on Windows; the cwd may be an 8.3 short name.
  assert.equal(path.normalize(applied.repo), fs.realpathSync.native(s.cwd));
  assert.equal(applied.commit, git(s.cwd, "rev-parse", "HEAD").trim());
  assert.equal(git(s.cwd, "rev-parse", "HEAD~1").trim(), head);
  assert.deepEqual(applied.files, ["committed.txt", "keep.txt", "new.txt"]);
  const message = git(s.cwd, "log", "-1", "--format=%B");
  assert.match(message, /^baton\(codex\): \S/);
  assert.match(message, new RegExp(`Baton-Task: ${done.task_id}`));
  assert.match(message, /Baton-Target: codex/);
  assert.equal(git(s.cwd, "show", "--format=", "--name-only", "HEAD").trim().split("\n").join(","), "committed.txt,keep.txt,new.txt");
  assert.equal(git(s.cwd, "diff", "--binary", head, "HEAD"), patch);
  assert.equal(git(s.cwd, "show", "HEAD:.env.tracked"), "tracked\n");
  assert.equal(fs.readFileSync(path.join(s.cwd, "keep.txt"), "utf8"), "keep\nedited\n");
  assert.deepEqual(worktreeState(wt), before);
  assert.ok(fs.existsSync(wt));
  assert.ok(branchExists(s.cwd, done.worktree!.branch));
  // Untracked local.cfg / shared in the source were never touched or committed.
  assert.match(git(s.cwd, "status", "--porcelain"), /\?\? local\.cfg/);
});

test("apply merges three-way when the branch moved on; unrelated dirty and untracked files stay out of the commit", async (t) => {
  const s = sandbox(t);
  repo(s);
  const done = await isolatedTask(s);
  const wt = done.worktree!.path;
  fs.writeFileSync(path.join(wt, "lines.txt"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8-worker\n");
  fs.writeFileSync(path.join(wt, "new.txt"), "new\n");
  fs.writeFileSync(path.join(s.cwd, "lines.txt"), "l1-user\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n");
  git(s.cwd, "commit", "-qam", "user moved on");
  fs.writeFileSync(path.join(s.cwd, "keep.txt"), "keep\nuser wip\n");
  fs.writeFileSync(path.join(s.cwd, "scratch.txt"), "mine\n");

  const applied = await s.run<Applied>("apply", done.task_id);
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.files, ["lines.txt", "new.txt"]);
  assert.equal(fs.readFileSync(path.join(s.cwd, "lines.txt"), "utf8"), "l1-user\nl2\nl3\nl4\nl5\nl6\nl7\nl8-worker\n");
  assert.equal(fs.readFileSync(path.join(s.cwd, "keep.txt"), "utf8"), "keep\nuser wip\n");
  assert.equal(git(s.cwd, "show", "--format=", "--name-only", "HEAD").trim(), "lines.txt\nnew.txt");
  const status = git(s.cwd, "status", "--porcelain");
  assert.match(status, /^ M keep\.txt$/m);
  assert.match(status, /^\?\? scratch\.txt$/m);
});

test("apply refuses, changing nothing and keeping the worktree even with --remove", async (t) => {
  const s = sandbox(t);
  repo(s);
  const done = await isolatedTask(s);
  workerChanges(done.worktree!.path);
  const cases: { name: string; setup: () => void; undo: () => void; expect: RegExp }[] = [
    {
      name: "staged",
      setup: () => { fs.appendFileSync(path.join(s.cwd, "lines.txt"), "l9\n"); git(s.cwd, "add", "lines.txt"); },
      undo: () => { git(s.cwd, "reset", "-q"); git(s.cwd, "checkout", "--", "lines.txt"); },
      expect: /Staged changes/,
    },
    {
      name: "overlapping dirty file",
      setup: () => fs.appendFileSync(path.join(s.cwd, "keep.txt"), "wip\n"),
      undo: () => git(s.cwd, "checkout", "--", "keep.txt"),
      expect: /overlap the task's changes: keep\.txt/,
    },
    {
      name: "overlapping untracked file",
      setup: () => fs.writeFileSync(path.join(s.cwd, "new.txt"), "mine\n"),
      undo: () => fs.rmSync(path.join(s.cwd, "new.txt")),
      expect: /overlap the task's changes: new\.txt/,
    },
    {
      name: "merge in progress",
      setup: () => fs.writeFileSync(path.join(s.cwd, ".git", "MERGE_HEAD"), git(s.cwd, "rev-parse", "HEAD")),
      undo: () => fs.rmSync(path.join(s.cwd, ".git", "MERGE_HEAD")),
      expect: /middle of a merge.*MERGE_HEAD/,
    },
    {
      name: "conflict",
      setup: () => { fs.writeFileSync(path.join(s.cwd, "keep.txt"), "keep\nuser\n"); git(s.cwd, "commit", "-qam", "conflicting"); },
      undo: () => git(s.cwd, "reset", "-q", "--hard", "HEAD~1"),
      expect: /aborted.*Conflicts: keep\.txt/s,
    },
  ];
  for (const c of cases) {
    c.setup();
    const before = sourceState(s.cwd);
    assert.match(await refused(s, "apply", done.task_id, "--remove"), c.expect, c.name);
    assert.deepEqual(sourceState(s.cwd), before, c.name);
    assert.ok(fs.existsSync(done.worktree!.path), c.name);
    assert.ok(branchExists(s.cwd, done.worktree!.branch), c.name);
    c.undo();
  }
  // After every refusal the same task still applies cleanly.
  assert.equal((await s.run<Applied>("apply", done.task_id)).status, "applied");
});

test("apply --remove deletes the worktree and branch; nothing_to_apply also removes", async (t) => {
  const s = sandbox(t);
  repo(s);
  const done = await isolatedTask(s);
  workerChanges(done.worktree!.path);
  const applied = await s.run<Applied>("apply", done.task_id, "--remove");
  assert.equal(applied.status, "applied");
  assert.equal(applied.removed, true, JSON.stringify(applied));
  assert.equal(applied.warning, undefined);
  assert.equal(fs.existsSync(done.worktree!.path), false);
  assert.equal(branchExists(s.cwd, done.worktree!.branch), false);

  const empty = await isolatedTask(s);
  const head = git(s.cwd, "rev-parse", "HEAD");
  // pnpm rewrote a main-repo shim from inside the worktree (#107): removal must say so.
  fs.mkdirSync(path.join(s.cwd, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(path.join(s.cwd, "node_modules", ".bin", "eslint"), `exec node "${empty.worktree!.path}/node_modules/eslint/bin/eslint.js"\n`);
  const nothing = await s.run<Applied>("apply", empty.task_id, "--remove");
  assert.match(nothing.warning ?? "", /node_modules\/\.bin\/eslint.*pnpm install --force/);
  assert.equal(nothing.status, "nothing_to_apply");
  assert.equal(nothing.removed, true, JSON.stringify(nothing));
  assert.equal(git(s.cwd, "rev-parse", "HEAD"), head);
  assert.equal(fs.existsSync(empty.worktree!.path), false);
  assert.equal(branchExists(s.cwd, empty.worktree!.branch), false);
});

test("apply refuses a running task and a task without --isolate", async (t) => {
  const s = sandbox(t);
  repo(s);
  s.env.FAKE_SLEEP = "2";
  const started = await s.run("start", "--target", "codex", "--prompt", "hi", "--isolate");
  assert.match(await refused(s, "apply", started.task_id), /Task is running/);
  await s.until(started.task_id);
  s.env.FAKE_SLEEP = "0";
  const plain = await s.run("start", "--target", "codex", "--prompt", "hi", "--allow-dirty");
  await s.until(plain.task_id);
  assert.match(await refused(s, "apply", plain.task_id), /was not started with --isolate/);
});
