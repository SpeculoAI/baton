import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { isAlive, killGroup } from "../src/process.ts";

test("killGroup tolerates a process group that holds only unreaped zombies (macOS: EPERM)", { skip: process.platform === "win32" }, async (t) => {
  // The child moves to its own group and exits; the parent never waits, so the group is zombie-only.
  const parent = spawn("perl", ["-e", '$|=1; $p=fork; if(!$p){setpgrp(0,0); exit 0} print "$p\\n"; sleep 30'], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => parent.kill("SIGKILL"));
  const [chunk] = await once(parent.stdout, "data");
  const zombie = Number(String(chunk).trim());
  assert.ok(zombie > 1);
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (process.platform === "darwin") assert.throws(() => process.kill(-zombie, "SIGKILL"), { code: "EPERM" });
  assert.doesNotThrow(() => killGroup(zombie));
});

test("killGroup kills the whole tree, grandchildren included", async (t) => {
  const code = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)";
  const parent = spawn(process.execPath, ["-e", code], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { try { parent.kill("SIGKILL"); } catch { /* already gone */ } });
  const [chunk] = await once(parent.stdout, "data");
  const grandchild = Number(String(chunk).trim());
  assert.ok(isAlive(parent.pid!) && isAlive(grandchild));
  killGroup(parent.pid!);
  for (let i = 0; i < 100 && (isAlive(parent.pid!) || isAlive(grandchild)); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!isAlive(parent.pid!), "parent still alive");
  assert.ok(!isAlive(grandchild), "grandchild still alive");
});

test("killGroup ignores a process that already exited", async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  assert.doesNotThrow(() => killGroup(child.pid!));
});
