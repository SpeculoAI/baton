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

test("killGroup kills the children of a root that is already gone (Windows: libuv's job ends cmd.exe, its child lives on)", { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
  // P (a node with libuv's kill-on-close job) starts cmd.exe, which starts node N. Killing P ends cmd.exe; N keeps cmd.exe's dead pid as parent.
  const inner = `"${process.execPath}" -e "console.log(process.pid);setInterval(()=>{},1000)"`;
  const code = `const c=require('child_process').spawn('cmd.exe',['/d','/s','/c',${JSON.stringify(`"${inner}"`)}],{windowsVerbatimArguments:true,stdio:['ignore','pipe','inherit']});console.log('C '+c.pid);c.stdout.on('data',(d)=>console.log('N '+d));setInterval(()=>{},1000)`;
  const parent = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { try { parent.kill("SIGKILL"); } catch { /* gone */ } });
  let seen = "";
  parent.stdout.on("data", (chunk) => { seen += chunk; });
  for (let i = 0; i < 200 && !/C \d+\s+N \d+/.test(seen); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  const found = /C (\d+)\s+N (\d+)/.exec(seen);
  assert.ok(found, `no pids from the helper: ${JSON.stringify(seen)}`);
  const root = Number(found[1]);
  const orphan = Number(found[2]);
  t.after(() => { try { process.kill(orphan, "SIGKILL"); } catch { /* gone */ } });
  parent.kill("SIGKILL");
  for (let i = 0; i < 100 && isAlive(root); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!isAlive(root), "cmd.exe should end with its parent");
  assert.ok(isAlive(orphan), "its child should have survived");
  killGroup(root);
  for (let i = 0; i < 100 && isAlive(orphan); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!isAlive(orphan), "orphan still alive");
});
