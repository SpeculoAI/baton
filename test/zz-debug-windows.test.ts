// TEMPORARY: reproduces the orphaned-worker tree kill on Windows and prints what taskkill does. Delete before merging.
import test from "node:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { execFileSync, spawn, spawnSync } from "node:child_process";

const dir = path.join(import.meta.dirname, "fake-cli");
const crossSpawnPath = createRequire(import.meta.url).resolve("cross-spawn");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const list = (label: string) => {
  const out = execFileSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'node.exe','cmd.exe' } | Select-Object ProcessId,ParentProcessId,Name | Format-Table -HideTableHeaders | Out-String -Width 200"], { encoding: "utf8", timeout: 20000 });
  console.log(`DEBUG[${label}]\n${out.trim().split("\n").map((l) => l.trim()).filter(Boolean).join("\n")}`);
};

test("DEBUG taskkill after the spawning parent was terminated", { skip: process.platform !== "win32", timeout: 90000 }, async () => {
  const pidFile = path.join(os.tmpdir(), `dbg-grandchild-${process.pid}.pid`);
  const env = { ...process.env, BATON_TEST_NODE: process.execPath, FAKE_HANG: "1", FAKE_CHILD_PID_FILE: pidFile, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
  const code = `const s=require(${JSON.stringify(crossSpawnPath)});const c=s(${JSON.stringify(path.join(dir, "codex.cmd"))},['exec','-'],{stdio:['pipe','pipe','pipe']});console.log(c.pid);c.stdin.end('x');setInterval(()=>{},1000)`;
  const parent = spawn(process.execPath, ["-e", code], { env, stdio: ["ignore", "pipe", "inherit"] });
  let out = ""; parent.stdout!.on("data", (c) => { out += c; });
  await sleep(3000);
  const cmdPid = Number(out.trim());
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
  console.log(`DEBUG parent=${parent.pid} cmd=${cmdPid} grandchild=${grandchild}`);
  try {
    list("tree before");
    process.kill(parent.pid!, "SIGKILL");
    await sleep(500);
    list("after parent terminated");
    const r = spawnSync("taskkill", ["/PID", String(cmdPid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
    console.log(`DEBUG taskkill status=${r.status} error=${r.error?.message} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
    await sleep(500);
    list("after taskkill");
  } finally {
    for (const pid of [cmdPid, grandchild]) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    for (const pid of [grandchild]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
});
