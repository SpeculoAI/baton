import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { exec } from "./helpers.ts";
import { classifyPlan, detectSources, rulesInit, rulesyncTargets, type Preview, type RulesPrompter, type RunFn } from "../src/rulesync-setup.ts";

const cli = path.resolve(import.meta.dirname, "../src/cli.ts");

function repo(t: test.TestContext, opts: { git?: boolean; pkg?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "baton-rulesync-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (opts.git !== false) {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  }
  if (opts.pkg) fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  const emptyPath = path.join(root, ".no-bin");
  fs.mkdirSync(emptyPath);
  return { root, env: { ...process.env, PATH: emptyPath } as NodeJS.ProcessEnv };
}

function write(root: string, rel: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

function installLocalBin(root: string) {
  write(root, "node_modules/.bin/rulesync", "#!/bin/sh\n");
  fs.chmodSync(path.join(root, "node_modules/.bin/rulesync"), 0o755);
}

/** In-process stand-in for npm and rulesync. `ops` is what `generate --dry-run --json` reports. */
function fakeRun(root: string, opts: { ops?: Array<Record<string, unknown>>; npmFails?: boolean; npmInstalls?: boolean } = {}) {
  const calls: string[] = [];
  const run: RunFn = async (command, args) => {
    calls.push([path.basename(command), ...args].join(" "));
    const ok = { status: 0, stdout: "", stderr: "" };
    if (path.basename(command).startsWith("npm")) {
      if (opts.npmFails) return { status: 1, stdout: "", stderr: "EACCES: permission denied" };
      if (opts.npmInstalls !== false && args.includes("-D")) installLocalBin(root);
      return ok;
    }
    if (args[0] === "init") {
      write(root, ".rulesync/rules/overview.md", "---\nroot: true\n---\nUse TypeScript for all new code\n");
      write(root, ".rulesync/mcp.jsonc", "{\"mcpServers\":{\"deepwiki\":{}}}");
      write(root, ".rulesync/hooks.jsonc", "{}");
      write(root, ".rulesync/permissions.jsonc", "{\"codexcli\":{\"base_permission_profile\":\":danger-full-access\"}}");
      write(root, ".rulesync/subagents/planner.md", "x");
      write(root, ".rulesync/skills/project-context/SKILL.md", "x");
      if (!fs.existsSync(path.join(root, "rulesync.jsonc"))) write(root, "rulesync.jsonc", "{\"delete\":true}");
      return ok;
    }
    if (args[0] === "import") {
      write(root, ".rulesync/rules/CLAUDE.md", "imported");
      write(root, ".rulesync/hooks.jsonc", "{\"version\":1,\"hooks\":{}}");
      write(root, ".rulesync/mcp.jsonc", "{\"mcpServers\":{\"mine\":{\"command\":\"echo\"}}}");
      if (fs.existsSync(path.join(root, "CLAUDE.local.md"))) write(root, ".rulesync/rules/CLAUDE.local.md", "personal");
      return ok;
    }
    if (args[0] === "generate" && args.includes("--dry-run")) {
      return { status: 0, stdout: JSON.stringify({ success: true, warnings: [], data: { plan: { operations: opts.ops ?? [] } } }), stderr: "" };
    }
    if (args[0] === "generate") {
      write(root, "AGENTS.md", "generated");
      return ok;
    }
    return { status: 2, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  return { run, calls };
}

function prompter(answers: Partial<{ install: "project" | "global" | "skip" | null; source: ReturnType<RulesPrompter["source"]> extends Promise<infer T> ? T : never; confirm: boolean }>) {
  const seen: { installChoices?: string[]; projectUnavailable?: string; sources?: string[]; preview?: Preview } = {};
  const prompt: RulesPrompter = {
    async install(input) {
      seen.installChoices = input.choices;
      seen.projectUnavailable = input.projectUnavailable;
      return answers.install === undefined ? "skip" : answers.install;
    },
    async source(sources) {
      seen.sources = sources.map((s) => s.target);
      return answers.source === undefined ? { kind: "template" } : answers.source;
    },
    async confirm(preview) {
      seen.preview = preview;
      return answers.confirm ?? false;
    },
  };
  return { prompt, seen };
}

test("agent ids map to rulesync targets; agents without one are dropped", () => {
  assert.deepEqual(rulesyncTargets(["claude", "codex", "cursor", "agy", "gemini"]), ["claudecode", "codexcli", "cursor", "antigravity-cli"]);
});

test("detectSources lists importable rule files at the repo root", (t) => {
  const { root } = repo(t);
  write(root, "CLAUDE.md", "a");
  write(root, "AGENTS.md", "b");
  write(root, ".cursor/rules/x.mdc", "c");
  assert.deepEqual(detectSources(root).map((s) => s.target), ["claudecode", "codexcli", "cursor"]);
});

test("already initialized: says so and touches nothing", async (t) => {
  const { root, env } = repo(t, { pkg: true });
  installLocalBin(root);
  fs.mkdirSync(path.join(root, ".rulesync"));
  const { run, calls } = fakeRun(root);
  const res = await rulesInit({ cwd: root, agents: ["claude"], env, run, prompt: prompter({}).prompt });
  assert.equal(res.status, "already_initialized");
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(root, "rulesync.jsonc")), false);
});

test("outside a git repo: only global/skip, and no initialization", async (t) => {
  const { root, env } = repo(t, { git: false, pkg: true });
  const { run, calls } = fakeRun(root);
  const { prompt, seen } = prompter({ install: "skip" });
  const res = await rulesInit({ cwd: root, agents: ["claude"], env, run, prompt });
  assert.deepEqual(seen.installChoices, ["global", "skip"]);
  assert.match(seen.projectUnavailable ?? "", /git repository/);
  assert.equal(res.status, "skipped");
  assert.deepEqual(calls, []);
});

test("no package.json: project install is not offered and is refused when forced", async (t) => {
  const { root, env } = repo(t);
  const { run } = fakeRun(root);
  const { prompt, seen } = prompter({ install: "skip" });
  await rulesInit({ cwd: root, agents: ["claude"], env, run, prompt });
  assert.deepEqual(seen.installChoices, ["global", "skip"]);
  assert.match(seen.projectUnavailable ?? "", /package\.json/);
  const forced = await rulesInit({ cwd: root, agents: ["claude"], env, run, install: "project" });
  assert.equal(forced.status, "failed");
});

test("project install runs npm, re-detects, then initializes from the template with samples removed", async (t) => {
  const { root, env } = repo(t, { pkg: true });
  const { run, calls } = fakeRun(root, { ops: [{ action: "write", kind: "file", feature: "rules", path: "AGENTS.md" }] });
  const { prompt, seen } = prompter({ install: "project", confirm: true });
  const res = await rulesInit({ cwd: root, agents: ["claude", "codex"], env, run, prompt });
  assert.equal(res.status, "generated", res.detail);
  assert.deepEqual(res.install, { choice: "project", ok: true, command: ["npm", "install", "-D", "rulesync"] });
  assert.deepEqual(calls.slice(0, 2), ["npm install -D rulesync", "rulesync init --silent"]);
  assert.equal(seen.sources, undefined, "no rule files → template without asking");
  for (const gone of ["mcp.jsonc", "hooks.jsonc", "permissions.jsonc", "subagents/planner.md", "skills/project-context", "rules/overview.md"]) {
    assert.equal(fs.existsSync(path.join(root, ".rulesync", gone)), false, gone);
  }
  assert.match(fs.readFileSync(path.join(root, ".rulesync/rules/project.md"), "utf8"), /root: true/);
  const config = JSON.parse(fs.readFileSync(path.join(root, "rulesync.jsonc"), "utf8"));
  assert.deepEqual(config.targets, ["claudecode", "codexcli"]);
  assert.deepEqual(config.features, ["rules", "mcp", "subagents", "skills", "hooks"]);
  assert.equal(config.delete, false);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "generated");
});

test("npm failure or a missing binary after npm stops before initialization", async (t) => {
  const { root, env } = repo(t, { pkg: true });
  const failing = fakeRun(root, { npmFails: true });
  const res = await rulesInit({ cwd: root, agents: ["claude"], env, run: failing.run, install: "global" });
  assert.equal(res.status, "failed");
  assert.match(res.detail ?? "", /EACCES/);

  const silent = fakeRun(root);
  const missing = await rulesInit({ cwd: root, agents: ["claude"], env, run: silent.run, install: "global" });
  assert.equal(missing.status, "failed");
  assert.match(missing.detail ?? "", /not on PATH/);
  assert.deepEqual(silent.calls, ["npm install -g rulesync"]);
  assert.equal(fs.existsSync(path.join(root, ".rulesync")), false);
});

test("import from Claude: preview flags AGENTS.md overwrite; cancelling keeps it intact", async (t) => {
  const { root, env } = repo(t, { pkg: true });
  installLocalBin(root);
  write(root, "CLAUDE.md", "# claude");
  write(root, "AGENTS.md", "# codex original");
  write(root, "CLAUDE.local.md", "personal");
  spawnSync("git", ["add", "CLAUDE.md", "AGENTS.md"], { cwd: root });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "rules"], { cwd: root });
  write(root, "AGENTS.md", "# codex edited");
  const before = new Set(fs.readdirSync(root));
  const { run, calls } = fakeRun(root, { ops: [
    { action: "write", kind: "file", feature: "rules", path: "AGENTS.md" },
    { action: "write", kind: "file", feature: "skills", path: ".agents/skills/demo/SKILL.md" },
  ] });
  const { prompt, seen } = prompter({ source: { kind: "import", target: "claudecode" }, confirm: false });
  const res = await rulesInit({ cwd: root, agents: ["claude", "codex"], env, run, prompt });
  assert.deepEqual(seen.sources, ["claudecode", "codexcli"]);
  assert.ok(calls.includes("rulesync import --targets claudecode --features rules,mcp,subagents,skills,hooks --silent"));
  assert.deepEqual(seen.preview?.items.map((i) => [i.group, i.path, i.unsaved ?? ""]), [
    ["overwrite", "AGENTS.md", "modified"],
    ["create", ".agents/skills/demo/SKILL.md", ""],
  ]);
  assert.equal(res.status, "cancelled");
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "# codex edited");
  assert.equal(fs.existsSync(path.join(root, ".rulesync/rules/CLAUDE.local.md")), false);
  assert.equal(fs.existsSync(path.join(root, ".rulesync/hooks.jsonc")), false, "empty hooks source is dropped");
  assert.equal(fs.existsSync(path.join(root, ".rulesync/mcp.jsonc")), true, "non-empty MCP source is kept");
  assert.ok(res.notes?.some((n) => /CLAUDE\.local\.md/.test(n)));
  const added = fs.readdirSync(root).filter((f) => !before.has(f)).sort();
  assert.deepEqual(added, [".rulesync", "rulesync.jsonc"]);
  assert.ok(!calls.includes("rulesync generate --silent"));
});

test("non-interactive: existing rule files need --source; without --yes it only previews", async (t) => {
  const { root, env } = repo(t, { pkg: true });
  installLocalBin(root);
  write(root, "CLAUDE.md", "# claude");
  const { run, calls } = fakeRun(root, { ops: [{ action: "write", kind: "file", feature: "rules", path: "AGENTS.md" }] });
  const needs = await rulesInit({ cwd: root, agents: ["claude"], env, run });
  assert.equal(needs.status, "needs_input");
  assert.match(needs.detail ?? "", /--source/);
  const previewed = await rulesInit({ cwd: root, agents: ["claude"], env, run, source: { kind: "import", target: "claudecode" } });
  assert.equal(previewed.status, "previewed");
  assert.ok(!calls.includes("rulesync generate --silent"));
});

test("existing rulesync.jsonc is kept as is", async (t) => {
  const { root, env } = repo(t, { pkg: true });
  installLocalBin(root);
  write(root, "rulesync.jsonc", "{\"targets\":[\"cursor\"]}");
  const { run } = fakeRun(root);
  const res = await rulesInit({ cwd: root, agents: ["claude"], env, run, prompt: prompter({}).prompt });
  assert.equal(res.status, "no_changes");
  assert.equal(fs.readFileSync(path.join(root, "rulesync.jsonc"), "utf8"), "{\"targets\":[\"cursor\"]}");
  assert.ok(res.notes?.some((n) => /existing rulesync\.jsonc/.test(n)));
});

test("classifyPlan groups setting keys per file and warns on hooks/permissions", (t) => {
  const { root } = repo(t);
  write(root, ".claude/settings.json", "{}");
  write(root, ".codex/config.toml", "");
  write(root, "CLAUDE.local.md", "x");
  const items = classifyPlan(root, [
    { action: "write", kind: "file", feature: "hooks", path: ".claude/settings.json" },
    { action: "write", kind: "key", feature: "hooks", path: ".claude/settings.json", key: "hooks" },
    { action: "write", kind: "file", feature: "mcp", path: ".codex/config.toml" },
    { action: "write", kind: "key", feature: "mcp", path: ".codex/config.toml", key: "mcp_servers" },
    { action: "write", kind: "file", feature: "hooks", path: ".codex/hooks.json" },
    { action: "delete", kind: "file", feature: "rules", path: "CLAUDE.local.md" },
  ]);
  assert.deepEqual(items.map((i) => [i.group, i.path, i.keys?.join(",") ?? "", Boolean(i.warn), i.unsaved ?? ""]), [
    ["delete", "CLAUDE.local.md", "", false, "untracked"],
    ["setting", ".claude/settings.json", "hooks", true, "untracked"],
    ["setting", ".codex/config.toml", "mcp_servers", false, "untracked"],
    ["create", ".codex/hooks.json", "", false, ""],
  ]);
});

test("non-TTY install without --rulesync has no rulesync step", async (t) => {
  const { root, env } = repo(t);
  const home = path.join(root, ".home");
  const result = await exec(process.execPath, [cli, "install", "--skip-global"], { cwd: root, env: { ...env, BATON_HOME: home }, timeout: 8000 });
  const out = JSON.parse(result.stdout);
  assert.equal(out.rulesync, undefined);
});

test("rules init CLI (non-TTY) reports needs_input as JSON with exit code 1", async (t) => {
  const { root, env } = repo(t);
  await assert.rejects(
    exec(process.execPath, [cli, "rules", "init", "--targets", "claude"], { cwd: root, env, timeout: 8000 }),
    (error: { code?: number; stdout?: string }) => {
      assert.equal(error.code, 1);
      const out = JSON.parse(error.stdout ?? "{}");
      assert.equal(out.status, "needs_input");
      assert.match(out.detail, /--install/);
      return true;
    },
  );
});

test("rules init CLI rejects unknown agents", async (t) => {
  const { root, env } = repo(t);
  await assert.rejects(
    exec(process.execPath, [cli, "rules", "init", "--targets", "gemini"], { cwd: root, env, timeout: 8000 }),
    (error: { stdout?: string }) => /Unknown agent: gemini/.test(error.stdout ?? ""),
  );
});
