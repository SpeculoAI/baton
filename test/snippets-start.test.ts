import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OUTPUT_CONTRACT } from "../src/contract.ts";
import { cli, sandbox } from "./helpers.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function commitFixture(cwd: string): void {
  git(cwd, "init", "-q");
  git(cwd, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".worktrees/\n");
  git(cwd, "add", "-f", ".");
  git(cwd, "-c", "user.name=Baton Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
}

const EXCERPT_HEADER = "Code excerpts (read by baton at task start; current content):";

test("start sends Focus, scope, rules, host prompt, excerpts and output contract in order", async (t) => {
  const s = sandbox(t);
  const inputFile = path.join(s.home, "input.txt");
  s.env.FAKE_INPUT_FILE = inputFile;
  fs.writeFileSync(path.join(s.cwd, "CLAUDE.md"), "# project rules\n");
  fs.writeFileSync(path.join(s.cwd, "code.ts"), "line one\n  code with ``` backticks\r\nlast line\nexcluded\n");
  commitFixture(s.cwd);

  const started = await s.run("start", "--target", "codex", "--prompt", "host prompt",
    "--scope", "code.ts", "--rules", "pointer", "--file", "CLAUDE.md", "--file", "./code.ts:2-3");
  assert.equal((await s.until(started.task_id)).status, "success");
  const expected = [
    "[Baton scope] Only modify these paths (post-check enforced): code.ts",
    "This repository has project rules your CLI does not load automatically:\n- CLAUDE.md\n" +
      "Before editing, read each file above (and any files they reference with @path) and follow those rules.",
    "host prompt",
    `${EXCERPT_HEADER}\n\n./code.ts:2-3\n\`\`\`\`\n  code with \`\`\` backticks\r\nlast line\n\`\`\`\``,
  ].join("\n\n");
  assert.equal(fs.readFileSync(inputFile, "utf8"), `Focus on these files:\n- CLAUDE.md\n\n${expected}\n\n${OUTPUT_CONTRACT}`);
  const turn = s.turn(started.task_id);
  assert.equal(turn.prompt, expected);
  assert.deepEqual(turn.files, ["CLAUDE.md"]);
  assert.deepEqual(turn.excerpts, ["./code.ts:2-3"]);
});

test("start --isolate reads excerpts from HEAD using the mapped task cwd", async (t) => {
  const s = sandbox(t);
  const inputFile = path.join(s.home, "input.txt");
  s.env.FAKE_INPUT_FILE = inputFile;
  const subdir = path.join(s.cwd, "src");
  fs.mkdirSync(subdir);
  const file = path.join(subdir, "code.ts");
  fs.writeFileSync(file, "head content\n");
  commitFixture(s.cwd);
  fs.writeFileSync(file, "uncommitted content\n");

  const started = await s.run("start", "--target", "codex", "--prompt", "inspect", "--cwd", subdir,
    "--isolate", "--file", "code.ts:01");
  assert.equal((await s.until(started.task_id)).status, "success");
  assert.equal(fs.readFileSync(inputFile, "utf8"),
    `inspect\n\n${EXCERPT_HEADER}\n\ncode.ts:1-1\n\`\`\`\nhead content\n\`\`\`\n\n${OUTPUT_CONTRACT}`);
  assert.deepEqual(s.turn(started.task_id).excerpts, ["code.ts:01"]);
});

for (const isolate of [false, true]) {
  test(`start rejects sensitive excerpts without task state (${isolate ? "isolated" : "in-place"})`, async (t) => {
    const s = sandbox(t);
    const state = path.join(s.home, "state");
    fs.mkdirSync(state);
    s.env.BATON_HOME = state;
    fs.writeFileSync(path.join(s.cwd, ".env"), "FAKE_SECRET=xyz\nline 2\nline 3\n");
    commitFixture(s.cwd);
    const worktrees = git(s.cwd, "worktree", "list", "--porcelain");
    const branches = git(s.cwd, "for-each-ref", "refs/heads");

    await assert.rejects(s.run("start", "--target", "codex", "--prompt", "inspect", "--file", ".env:1-3",
      ...(isolate ? ["--isolate"] : [])), (error: { code: number; stdout: string }) => {
      assert.equal(error.code, 1);
      const failure = JSON.parse(error.stdout);
      assert.equal(failure.status, "failed");
      assert.match(failure.summary, /Name the location in the prompt and let the worker read it/);
      assert.doesNotMatch(error.stdout, /FAKE_SECRET/);
      return true;
    });
    assert.deepEqual(fs.readdirSync(state, { recursive: true }), []);
    assert.equal(git(s.cwd, "worktree", "list", "--porcelain"), worktrees);
    assert.equal(git(s.cwd, "for-each-ref", "refs/heads"), branches);
    const worktreeRoot = path.join(s.cwd, ".worktrees");
    if (fs.existsSync(worktreeRoot)) assert.deepEqual(fs.readdirSync(worktreeRoot), []);
  });
}

test("start with ordinary --file paths preserves the previous turn and worker prompt", async (t) => {
  const s = sandbox(t);
  const inputFile = path.join(s.home, "input.txt");
  s.env.FAKE_INPUT_FILE = inputFile;
  const files = ["./code.ts", "later.ts", "./code.ts"];
  const prompt = "  host prompt  \n";
  const started = await s.run("start", "--target", "codex", "--prompt", prompt,
    ...files.flatMap((file) => ["--file", file]));
  assert.equal((await s.until(started.task_id)).status, "success");
  const turn = s.turn(started.task_id);
  assert.equal(turn.prompt, prompt);
  assert.deepEqual(turn.files, files);
  assert.equal(Object.hasOwn(turn, "excerpts"), false);
  assert.equal(fs.readFileSync(inputFile, "utf8"),
    `Focus on these files:\n- ./code.ts\n- later.ts\n- ./code.ts\n\nhost prompt\n\n${OUTPUT_CONTRACT}`);
});

test("MCP delegate_task advertises and accepts line excerpts", async (t) => {
  const s = sandbox(t);
  fs.writeFileSync(path.join(s.cwd, "code.ts"), "mcp excerpt\n");
  const client = new Client({ name: "snippets-test", version: "0" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: s.env as Record<string, string> }));
  const { tools } = await client.listTools();
  const tool = tools.find(({ name }) => name === "delegate_task");
  const files = tool?.inputSchema.properties?.files as { description?: string } | undefined;
  assert.match(files?.description ?? "", /path:N.*path:N-M.*sensitive files/i);

  const result = await client.callTool({ name: "delegate_task", arguments: {
    target_agent: "codex", cwd: s.cwd, prompt: "via MCP", files: ["code.ts:1"],
  } });
  const [{ text }] = result.content as { text: string }[];
  const { task_id } = JSON.parse(text);
  assert.equal((await s.until(task_id)).status, "success");
  assert.equal(s.turn(task_id).prompt, `via MCP\n\n${EXCERPT_HEADER}\n\ncode.ts:1-1\n\`\`\`\nmcp excerpt\n\`\`\``);
});

test("reply reads worktree excerpts and only uses this turn's Focus paths", async (t) => {
  const s = sandbox(t);
  const inputFile = path.join(s.home, "input.txt");
  s.env.FAKE_INPUT_FILE = inputFile;
  fs.mkdirSync(path.join(s.cwd, "src"));
  fs.writeFileSync(path.join(s.cwd, "src", "a.ts"), "source content\n");
  commitFixture(s.cwd);
  const { task_id, cwd } = await s.run("start", "--target", "codex", "--prompt", "first",
    "--isolate", "--file", "first.txt");
  assert.equal((await s.until(task_id)).status, "success");
  assert.equal(fs.readFileSync(inputFile, "utf8"), `Focus on these files:\n- first.txt\n\nfirst\n\n${OUTPUT_CONTRACT}`);
  fs.writeFileSync(path.join(cwd, "src", "a.ts"), "worktree edit\nsecond line\nexcluded\n");

  await s.run("reply", task_id, "--prompt", "second", "--file", "second.txt", "--file", "src/a.ts:1-2");
  assert.equal((await s.until(task_id)).status, "success");
  const prompt = `second\n\n${EXCERPT_HEADER}\n\nsrc/a.ts:1-2\n\`\`\`\nworktree edit\nsecond line\n\`\`\``;
  assert.equal(fs.readFileSync(inputFile, "utf8"), `Focus on these files:\n- second.txt\n\n${prompt}\n\n${OUTPUT_CONTRACT}`);
  const turn = s.turn(task_id, 2);
  assert.equal(turn.prompt, prompt);
  assert.deepEqual(turn.files, ["second.txt"]);
  assert.deepEqual(turn.excerpts, ["src/a.ts:1-2"]);
  assert.deepEqual(s.turn(task_id, 1).files, ["first.txt"]);
});

test("reply rejects sensitive excerpts before writing and can retry without files", async (t) => {
  const s = sandbox(t);
  const inputFile = path.join(s.home, "input.txt");
  s.env.FAKE_INPUT_FILE = inputFile;
  fs.writeFileSync(path.join(s.cwd, ".env"), "FAKE_SECRET=xyz\n");
  const { task_id } = await s.run("start", "--target", "codex", "--prompt", "first", "--file", "first.txt");
  assert.equal((await s.until(task_id)).status, "success");
  const dir = s.dir(task_id);
  const metaFile = path.join(dir, "meta.json");
  const previous = fs.readFileSync(metaFile, "utf8");

  await assert.rejects(s.run("reply", task_id, "--prompt", "blocked", "--file", ".env:1"),
    (error: { code: number; stdout: string }) => {
      assert.equal(error.code, 1);
      const failure = JSON.parse(error.stdout);
      assert.equal(failure.status, "failed");
      assert.match(failure.summary, /Name the location in the prompt and let the worker read it/);
      assert.doesNotMatch(error.stdout, /FAKE_SECRET/);
      return true;
    });
  assert.equal(fs.readFileSync(metaFile, "utf8"), previous);
  assert.equal(fs.existsSync(path.join(dir, "turns", "2.json")), false);
  assert.equal(fs.existsSync(path.join(dir, ".control.lock")), false);
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) assert.doesNotMatch(fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"), /FAKE_SECRET/);
  }
  assert.doesNotMatch(fs.readFileSync(inputFile, "utf8"), /FAKE_SECRET/);

  const prompt = "  retry without files  \n";
  await s.run("reply", task_id, "--prompt", prompt);
  assert.equal((await s.until(task_id)).status, "success");
  const turn = s.turn(task_id, 2);
  assert.equal(turn.prompt, prompt);
  assert.equal(Object.hasOwn(turn, "files"), false);
  assert.equal(Object.hasOwn(turn, "excerpts"), false);
  assert.equal(fs.readFileSync(inputFile, "utf8"), `retry without files\n\n${OUTPUT_CONTRACT}`);
});
