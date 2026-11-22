import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildRulesyncReport,
  discoverRules,
  readRulesyncConfig,
  resolveRulesync,
  rulesPointer,
  stripJsonc,
  unseenRules,
} from "../src/rules.ts";
import type { RuleSupport } from "../src/types.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "baton-rules-"));
}

function gitInit(dir: string) {
  spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "t@test"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
}

function touch(file: string, body = "x") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const CLAUDE: RuleSupport = {
  files: ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"],
  conditional: [{ file: "AGENTS.md", unless: ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"] }],
  rulesyncTarget: "claudecode",
};

const CODEX: RuleSupport = {
  files: ["AGENTS.md", "AGENTS.override.md"],
  rulesyncTarget: "codexcli",
};

const CURSOR: RuleSupport = {
  files: ["AGENTS.md", "CLAUDE.md", ".cursor/rules", ".cursorrules"],
  rulesyncTarget: "cursor",
};

const AGY: RuleSupport = {
  files: ["AGENTS.md", "GEMINI.md", ".agents/AGENTS.md", ".agents/GEMINI.md", ".agents/rules", ".agent/rules"],
  rulesyncTarget: "antigravity-cli",
};

test("discoverRules: walks cwd up to git root; skips empty rule dirs; ignores below cwd", () => {
  const root = tmp();
  gitInit(root);
  touch(path.join(root, "CLAUDE.md"));
  touch(path.join(root, "pkg", "AGENTS.md"));
  fs.mkdirSync(path.join(root, "pkg", ".cursor", "rules"), { recursive: true }); // empty → ignored
  touch(path.join(root, "pkg", "src", "nested", "CLAUDE.md")); // below cwd → ignored
  const cwd = path.join(root, "pkg");
  const found = discoverRules(cwd);
  assert.deepEqual(found, ["../CLAUDE.md", "AGENTS.md"]);
});

test("discoverRules: non-git directory only scans cwd", () => {
  const root = tmp();
  touch(path.join(root, "CLAUDE.md"));
  touch(path.join(root, "sub", "AGENTS.md"));
  assert.deepEqual(discoverRules(path.join(root, "sub")), ["AGENTS.md"]);
  assert.deepEqual(discoverRules(root), ["CLAUDE.md"]);
});

test("discoverRules: non-empty .cursor/rules counts", () => {
  const root = tmp();
  gitInit(root);
  touch(path.join(root, ".cursor", "rules", "a.mdc"));
  assert.deepEqual(discoverRules(root), [".cursor/rules"]);
});

test("unseenRules: no support → all found are unseen", () => {
  assert.deepEqual(unseenRules(["CLAUDE.md", "AGENTS.md"], undefined), ["AGENTS.md", "CLAUDE.md"]);
});

test("unseenRules: only CLAUDE.md — codex/agy see it; claude/cursor do not", () => {
  const found = ["CLAUDE.md"];
  assert.deepEqual(unseenRules(found, CODEX), ["CLAUDE.md"]);
  assert.deepEqual(unseenRules(found, AGY), ["CLAUDE.md"]);
  assert.deepEqual(unseenRules(found, CLAUDE), []);
  assert.deepEqual(unseenRules(found, CURSOR), []);
});

test("unseenRules: only AGENTS.md — none unseen for all four", () => {
  const found = ["AGENTS.md"];
  for (const s of [CLAUDE, CODEX, CURSOR, AGY]) assert.deepEqual(unseenRules(found, s), []);
});

test("unseenRules: CLAUDE.md + AGENTS.md — claude treats AGENTS.md as unseen", () => {
  const found = ["AGENTS.md", "CLAUDE.md"];
  assert.deepEqual(unseenRules(found, CLAUDE), ["AGENTS.md"]);
  assert.deepEqual(unseenRules(found, CODEX), ["CLAUDE.md"]);
  assert.deepEqual(unseenRules(found, CURSOR), []);
});

test("rulesPointer: empty unseen → empty string", () => {
  assert.equal(rulesPointer([]), "");
});

test("rulesPointer: files and dirs use different wording", () => {
  const text = rulesPointer(["../../CLAUDE.md", ".cursor/rules"]);
  assert.match(text, /does not load automatically/);
  assert.match(text, /- \.\.\/\.\.\/CLAUDE\.md/);
  assert.match(text, /- \.cursor\/rules\/ \(read the rule files that apply/);
  assert.match(text, /@path/);
});

test("stripJsonc: comments, trailing commas, keeps // inside strings", () => {
  const raw = `{
    // comment
    "targets": ["claudecode",], /* block */
    "note": "keep // here",
  }`;
  assert.deepEqual(JSON.parse(stripJsonc(raw)), {
    targets: ["claudecode"],
    note: "keep // here",
  });
});

test("readRulesyncConfig: local overlay, array/object/*, parse failure", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "rulesync.jsonc"), `{
    "targets": ["claudecode"],
    "features": ["rules", "mcp"],
  }`);
  fs.writeFileSync(path.join(root, "rulesync.local.jsonc"), `{
    "targets": { "cursor": ["rules", "mcp"] },
  }`);
  const cfg = readRulesyncConfig(root)!;
  assert.deepEqual(cfg.targets, { cursor: ["rules", "mcp"] });
  assert.deepEqual(cfg.features, ["rules", "mcp"]);

  fs.writeFileSync(path.join(root, "rulesync.jsonc"), `{ "targets": "*" }`);
  fs.rmSync(path.join(root, "rulesync.local.jsonc"));
  assert.equal(readRulesyncConfig(root)!.targets, "*");

  fs.writeFileSync(path.join(root, "rulesync.jsonc"), `{ broken`);
  assert.equal(readRulesyncConfig(root), null);
});

test("resolveRulesync: project bin before PATH", () => {
  const root = tmp();
  const binDir = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const local = path.join(binDir, "rulesync");
  fs.writeFileSync(local, "#!/bin/sh\n");
  fs.chmodSync(local, 0o755);
  assert.equal(resolveRulesync(root, undefined, { PATH: "/nope" }), local);
  assert.equal(resolveRulesync(tmp(), undefined, { PATH: "" }), null);
});

test("buildRulesyncReport: target_configured, features, gates, skipped", () => {
  const support: RuleSupport = {
    files: ["AGENTS.md"],
    rulesyncTarget: "cursor",
    gates: { mcp: "need --approve-mcps" },
  };
  const pending = buildRulesyncReport(
    { targets: { cursor: ["rules", "mcp"] }, features: ["rules"] },
    support,
    "/bin/rulesync",
  );
  assert.equal(pending.status, "pending");
  assert.equal(pending.target_configured, true);
  assert.deepEqual(pending.features, ["rules", "mcp"]);
  assert.deepEqual(pending.gates, ["need --approve-mcps"]);

  const skipped = buildRulesyncReport(
    { targets: ["claudecode"], features: ["rules"] },
    support,
    null,
  );
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.target_configured, false);
  assert.deepEqual(skipped.gates, []);
});
