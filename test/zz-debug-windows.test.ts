// TEMPORARY: prints what the .cmd launchers do on Windows. Delete before merging.
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import crossSpawn from "cross-spawn";

const dir = path.join(import.meta.dirname, "fake-cli");
const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");

function run(label: string, spawnFn: typeof crossSpawn, command: string, args: string[], options: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    let out = ""; let err = ""; let events = "";
    const child = spawnFn(command, args, { stdio: ["pipe", "pipe", "pipe"], ...options });
    child.stdout!.on("data", (c: Buffer) => { out += c; });
    child.stderr!.on("data", (c: Buffer) => { err += c; });
    child.once("error", (e: Error) => { events += ` error=${e.message}`; });
    child.once("exit", (code: number | null) => { events += ` exit=${code}`; });
    child.once("close", (code: number | null) => { events += ` close=${code}`; finish(); });
    child.stdin!.on("error", (e: Error) => { events += ` stdinerr=${e.message}`; });
    child.stdin!.end("hello prompt");
    const timer = setTimeout(() => { events += " TIMEOUT"; try { child.kill(); } catch {} finish(); }, 5000);
    let done = false;
    function finish() {
      if (done) return; done = true; clearTimeout(timer);
      console.log(`DEBUG[${label}] events:${events}\n  stdout=${JSON.stringify(out.slice(0, 300))}\n  stderr=${JSON.stringify(err.slice(0, 600))}`);
      resolve();
    }
  });
}

test("DEBUG windows .cmd launchers", { skip: process.platform !== "win32" }, async () => {
  console.log("DEBUG codex.cmd bytes:", JSON.stringify(fs.readFileSync(path.join(dir, "codex.cmd"), "utf8")));
  const fixture = path.join(dir, "..", "fixtures", "codex.stream.jsonl");
  const env = { ...process.env, BATON_TEST_NODE: process.execPath, PATH: [dir, system32].join(path.delimiter), FAKE_FIXTURE: fixture };
  delete (env as Record<string, unknown>).Path;
  const args = ["exec", "--json", "--color", "never", "--approve-for-me", "--skip-git-repo-check", "--cd", process.cwd(), "--output-last-message", path.join(process.env.RUNNER_TEMP ?? ".", "x.txt"), "-"];
  const cmd = path.join(dir, "codex.cmd");
  await run("cross-spawn plain", crossSpawn, cmd, args, { env });
  await run("cross-spawn detached+hide", crossSpawn, cmd, args, { env, detached: true, windowsHide: true });
  await run("cross-spawn no args", crossSpawn, cmd, [], { env });
  await run("cmd.exe /c direct", nodeSpawn as unknown as typeof crossSpawn, "cmd.exe", ["/d", "/s", "/c", `"${cmd}" exec --json -`], { env, windowsVerbatimArguments: true });
  const rulesync = path.join(dir, "rulesync.cmd");
  await run("rulesync generate", crossSpawn, rulesync, ["generate"], { env: { ...env, FAKE_RULESYNC_STDERR: "hi" } });
});
