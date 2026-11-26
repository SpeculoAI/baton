import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, sandbox } from "./helpers.ts";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("build output runs: version and start launch dist/cli.js _supervise", async (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "baton-dist-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  await exec(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", path.join(root, "tsconfig.build.json"), "--outDir", path.join(out, "dist")], { cwd: root, timeout: 60000 });
  fs.copyFileSync(path.join(root, "package.json"), path.join(out, "package.json"));
  // Like an installed package, dist resolves its runtime dependencies (picomatch) from node_modules.
  fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"));
  const cli = path.join(out, "dist", "cli.js");

  const version = JSON.parse((await exec(process.execPath, [cli, "version"], { cwd: out, timeout: 8000 })).stdout);
  assert.deepEqual(version, { version: pkg.version });

  const s = sandbox(t);
  const run = async (...args: string[]) => JSON.parse((await exec(process.execPath, [cli, ...args], { cwd: s.cwd, env: s.env, timeout: 8000 })).stdout);
  const started = await run("start", "--target", "codex", "--prompt", "hi");
  assert.equal(started.status, "running");
  const done = await s.until(started.task_id);
  assert.equal(done.status, "success");
});
