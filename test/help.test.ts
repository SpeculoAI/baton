import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { cli, exec } from "./helpers.ts";
import { COMMANDS, wantsHelp } from "../src/usage.ts";

const run = (...args: string[]) => exec(process.execPath, [cli, ...args], { cwd: os.tmpdir(), timeout: 8000 });

test("every command prints help with exit 0, listing each option it parses", async () => {
  for (const [name, def] of Object.entries(COMMANDS)) {
    const { stdout } = await run(name, "--help");
    assert.ok(stdout.startsWith(`Usage: baton ${name}`), name);
    for (const key of Object.keys("options" in def ? def.options : {})) assert.ok(stdout.includes(`--${key}`), `${name} --${key}`);
    assert.ok(stdout.includes("-h, --help"), name);
  }
});

test("-h works after other flags and on nested actions; start does not read stdin", async () => {
  assert.match((await run("start", "--target", "codex", "-h")).stdout, /^Usage: baton start/);
  assert.match((await run("rules", "init", "--help")).stdout, /^Usage: baton rules init/);
  assert.match((await run("worktree", "ls", "-h")).stdout, /^Usage: baton worktree/);
});

test("global help: no command, --help, -h and help <command>", async () => {
  for (const args of [[], ["--help"], ["-h"], ["help"]]) {
    const { stdout } = await run(...args);
    assert.match(stdout, /^Usage: baton <command>/);
    for (const name of Object.keys(COMMANDS)) assert.ok(stdout.includes(`  ${name} `), name);
  }
  assert.match((await run("help", "wait")).stdout, /^Usage: baton wait/);
  await assert.rejects(run("help", "nope"), (error: { stdout: string }) => JSON.parse(error.stdout).status === "failed");
});

test("wantsHelp ignores anything after --", () => {
  assert.equal(wantsHelp(["--prompt", "x", "--", "--help"]), false);
  assert.equal(wantsHelp(["--prompt=--help"]), false);
  assert.equal(wantsHelp(["x", "-h"]), true);
});

test("update and uninstall reject install-only flags", async () => {
  await assert.rejects(run("update", "--force"), (error: { stdout: string }) => /--force/.test(JSON.parse(error.stdout).summary));
  await assert.rejects(run("uninstall", "--skip-global"), (error: { stdout: string }) => /--skip-global/.test(JSON.parse(error.stdout).summary));
});
