import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "./helpers.ts";
import { commandsFor, planInstall, readInstalled, REPO, runInstall, writeInstalled } from "../src/install.ts";

const cli = path.resolve(import.meta.dirname, "../src/cli.ts");

function bins(t: test.TestContext, names: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-bins-"));
  const log = path.join(dir, "log");
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, log };
}

const argsOf = (id: string, action: "install" | "update" | "uninstall", opts?: { force?: boolean }) =>
  commandsFor(id, action, opts).map((step) => step.args);

test("install / update / uninstall commands and specs are consistent for all five agents", () => {
  const id = "baton@speculoai";
  assert.deepEqual(argsOf("claude", "install"), [
    ["plugin", "uninstall", "baton@agent-plugin-agent"],
    ["plugin", "marketplace", "remove", "agent-plugin-agent"],
    ["plugin", "marketplace", "add", REPO],
    ["plugin", "install", id],
  ]);
  assert.deepEqual(argsOf("claude", "update"), [
    ["plugin", "marketplace", "update", "speculoai"],
    ["plugin", "update", id],
  ]);
  assert.deepEqual(argsOf("claude", "uninstall"), [["plugin", "uninstall", id]]);

  assert.deepEqual(argsOf("codex", "install"), [
    ["plugin", "remove", "baton@agent-plugin-agent"],
    ["plugin", "marketplace", "remove", "agent-plugin-agent"],
    ["plugin", "marketplace", "add", REPO],
    ["plugin", "add", id],
  ]);
  assert.deepEqual(argsOf("codex", "update"), [
    ["plugin", "marketplace", "upgrade", "speculoai"],
    ["plugin", "add", id],
  ]);
  assert.deepEqual(argsOf("codex", "uninstall"), [["plugin", "remove", id]]);

  assert.deepEqual(argsOf("cursor", "install"), [
    ["plugin", "marketplace", "remove", "agent-plugin-agent"],
    ["plugin", "marketplace", "add", REPO],
  ]);
  assert.deepEqual(argsOf("cursor", "update"), [["plugin", "marketplace", "update", "speculoai"]]);
  assert.deepEqual(argsOf("cursor", "uninstall"), [["plugin", "marketplace", "remove", "speculoai"]]);

  assert.deepEqual(argsOf("agy", "install"), [["plugin", "install", REPO]]);
  assert.deepEqual(argsOf("agy", "update"), [["plugin", "install", REPO]]);
  assert.deepEqual(argsOf("agy", "uninstall"), [["plugin", "uninstall", "baton"]]);

  assert.deepEqual(argsOf("gemini", "install"), [["extensions", "install", REPO, "--consent"]]);
  assert.deepEqual(argsOf("gemini", "update"), [["extensions", "update", "baton"]]);
  assert.deepEqual(argsOf("gemini", "uninstall"), [["extensions", "uninstall", "baton"]]);
});

test("--force uninstalls the current ID before installing", () => {
  const args = argsOf("gemini", "install", { force: true });
  assert.deepEqual(args, [
    ["extensions", "uninstall", "baton"],
    ["extensions", "install", REPO, "--consent"],
  ]);
});

test("install migration steps are soft failures; the real install is not", () => {
  const steps = commandsFor("claude", "install");
  assert.equal(steps[0].soft, true);
  assert.equal(steps[1].soft, true);
  assert.equal(steps[2].soft, true);
  assert.equal(steps[3].soft, undefined);
});

test("--only with an unknown or undetected agent errors; update uses only the record by default", () => {
  const env = { PATH: "" };
  assert.throws(() => planInstall({ action: "install", only: ["nope"], env }), /unknown/i);
  assert.throws(() => planInstall({ action: "install", only: ["claude"], env }), /not detected/i);
  const update = planInstall({ action: "update", recorded: ["gemini", "claude"], env });
  assert.deepEqual(update.hosts.map((host) => host.id), []);
  assert.deepEqual(update.missing, ["gemini", "claude"]);
});

test("--dry-run only lists commands, does not run them, and does not write installed.json", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { dir, log } = bins(t, ["claude"]);
  const env = { ...process.env, PATH: dir, BATON_HOME: home };
  const out = JSON.parse((await exec(process.execPath, [cli, "install", "--dry-run", "--only", "claude", "--skip-global"], { env, timeout: 8000 })).stdout);
  assert.equal(out.dry_run, true);
  assert.equal(out.global, undefined);
  assert.equal(out.hosts[0].id, "claude");
  assert.deepEqual(out.hosts[0].commands, commandsFor("claude", "install").map((step) => step.args));
  assert.equal(out.hosts[0].bin, path.join(dir, "claude"));
  assert.equal(fs.existsSync(log), false);
  assert.equal(fs.existsSync(path.join(home, "installed.json")), false);
});

test("global install failure still continues; hard failure writes no record; soft failure does not block later agents", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeInstalled(["codex"], home);
  const { dir } = bins(t, ["claude", "gemini"]);
  const calls: string[] = [];
  const ran = await runInstall({
    action: "install",
    only: ["claude", "gemini"],
    env: { PATH: dir },
    home,
    spawn(command, args) {
      calls.push(`${path.basename(command)} ${args.join(" ")}`);
      if (command === "npm") return { status: 1, stderr: "EACCES" };
      if (args.at(-1) === "baton@speculoai") return { status: 1, stderr: "install failed" };
      return { status: 0 };
    },
  });
  assert.equal(ran.exitCode, 1);
  assert.equal(ran.result.global?.ok, false);
  assert.match(ran.result.global?.error ?? "", /EACCES/);
  assert.equal(ran.result.hosts[0].ok, false);
  assert.equal(ran.result.hosts[1].ok, true);
  assert.ok(calls.some((line) => line.startsWith("gemini ")));
  assert.deepEqual(readInstalled(home), ["codex", "gemini"]);
});

test("install calls global npm and the agent, and writes the record on success", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { dir, log } = bins(t, ["gemini", "npm"]);
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH || ""}`, BATON_HOME: home };
  const out = JSON.parse((await exec(process.execPath, [cli, "install", "--only", "gemini"], { env, timeout: 8000 })).stdout);
  assert.equal(out.hosts[0].ok, true);
  assert.equal(out.global.ok, true);
  assert.deepEqual(readInstalled(home), ["gemini"]);
  const text = fs.readFileSync(log, "utf8");
  const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  assert.match(text, new RegExp(`npm install -g @speculoai/baton@${version.replaceAll(".", "\\.")}`));
  assert.match(text, /extensions install https:\/\/github.com\/SpeculoAI\/baton/);
});

test("an already-installed target counts as success and is recorded", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { dir } = bins(t, ["gemini"]);
  const ran = await runInstall({
    action: "install",
    only: ["gemini"],
    skipGlobal: true,
    env: { PATH: dir },
    home,
    spawn: () => ({ status: 1, stderr: 'Extension "baton" is already installed.' }),
  });
  assert.equal(ran.exitCode, 0);
  assert.equal(ran.result.hosts[0].ok, true);
  assert.equal(ran.result.hosts[0].note, "already installed, skipped");
  assert.deepEqual(readInstalled(home), ["gemini"]);
});

test("cancelling host selection does not run the install", async (t) => {
  const { dir } = bins(t, ["claude"]);
  const ran = await runInstall({
    action: "install",
    selectHosts: async () => null,
    env: { PATH: dir },
    spawn() { throw new Error("should not run"); },
  });
  assert.equal(ran.exitCode, 0);
  assert.deepEqual(ran.result.hosts, []);
});

test("selectHosts picks a subset; onProgress reports global and host phases", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { dir } = bins(t, ["claude", "gemini"]);
  const events: string[] = [];
  const ran = await runInstall({
    action: "install",
    skipGlobal: true,
    home,
    env: { PATH: dir },
    selectHosts: async (detected) => {
      assert.deepEqual(detected.map((host) => host.id).sort(), ["claude", "gemini"]);
      return ["gemini"];
    },
    onProgress: (event) => {
      events.push(`${event.type}:${event.phase}:${"id" in event ? event.id : ""}${event.phase === "done" ? `:${event.ok}` : ""}`);
    },
    spawn: () => ({ status: 0 }),
  });
  assert.equal(ran.exitCode, 0);
  assert.deepEqual(ran.result.hosts.map((host) => host.id), ["gemini"]);
  assert.deepEqual(events, ["host:start:gemini", "host:done:gemini:true"]);
});
