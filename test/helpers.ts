import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { TestContext } from "node:test";
import type { TaskMeta, BatonEvent, Turn } from "../src/types.ts";
import { killGroup } from "../src/process.ts";

export const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
export function exec(file: string, args: string[], options: ExecFileOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr })); else resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });
}
export { sleep };
/** File name of a command stub on this platform: Windows resolves bare names through PATHEXT, so stubs are .cmd files. */
export const exe = (name: string) => (process.platform === "win32" ? `${name}.cmd` : name);
/** Writes a stub command `name` into `dir` that runs `js` with node (a sh launcher, plus a .cmd launcher for Windows); returns its path. */
export function fakeBin(dir: string, name: string, js = ""): string {
  const base = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${base}.mjs`, js);
  fs.writeFileSync(base, `#!/bin/sh\nexec "${process.execPath}" "$0.mjs" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(`${base}.cmd`, `@"${process.execPath}" "%~dpn0.mjs" %*\r\n`);
  return path.join(dir, exe(name));
}
const fakeCli = path.join(import.meta.dirname, "fake-cli");
/** PATH for sandboxed runs: fake CLIs first, then only what a child needs (node itself is passed in BATON_TEST_NODE). */
function sandboxPath(): string {
  if (process.platform !== "win32") return [fakeCli, "/usr/bin", "/bin"].join(path.delimiter);
  const git = (process.env.PATH ?? "").split(path.delimiter).find((dir) => dir && fs.existsSync(path.join(dir, "git.exe")));
  return [fakeCli, git, path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")].filter(Boolean).join(path.delimiter);
}
export function sandbox(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "baton-integration-"));
  const cwd = path.join(home, "work");
  fs.mkdirSync(cwd);
  const fixture = path.join(home, "fixture.jsonl");
  fs.writeFileSync(fixture, `${JSON.stringify({ type: "thread.started", thread_id: "thread-fake-1" })}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "BATON_RESULT\nsummary: ok\nBATON_END" } })}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, BATON_HOME: home, BATON_DELEGATION: "0", BATON_TEST_NODE: process.execPath, PATH: sandboxPath(), FAKE_FIXTURE: fixture, FAKE_SLEEP: "0", FAKE_EXIT: "0", FAKE_HANG: "0" };
  // Windows spells the variable "Path"; a second "PATH" key would be ambiguous.
  for (const key of Object.keys(env)) if (key !== "PATH" && key.toUpperCase() === "PATH") delete env[key];
  t.after(() => {
    const root = path.join(home, "tasks");
    if (fs.existsSync(root)) for (const id of fs.readdirSync(root)) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(root, id, "meta.json"), "utf8")) as TaskMeta;
        if (meta.status === "running") {
          if (meta.supervisor_pid) try { process.kill(meta.supervisor_pid, "SIGKILL"); } catch {}
          if (meta.child_pid) try { killGroup(meta.child_pid); } catch {}
        }
      } catch {}
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  async function run<T = TaskMeta & { liveness?: string; quiet_for_s?: number }>(...args: string[]): Promise<T> {
    const result = await exec(process.execPath, [cli, ...args], { cwd, env, timeout: 8000 });
    return JSON.parse(result.stdout);
  }
  const dir = (id: string) => path.join(home, "tasks", id);
  const meta = (id: string): TaskMeta => JSON.parse(fs.readFileSync(path.join(dir(id), "meta.json"), "utf8"));
  const turn = (id: string, n = 1): Turn => JSON.parse(fs.readFileSync(path.join(dir(id), "turns", `${n}.json`), "utf8"));
  const events = (id: string): BatonEvent[] => fs.readFileSync(path.join(dir(id), "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  async function until(id: string, predicate: (meta: TaskMeta) => boolean = (meta) => meta.status !== "running", timeout = 6000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const m = meta(id); if (predicate(m)) return m; await sleep(20); }
    throw new Error(`task did not reach the expected state: ${JSON.stringify(meta(id))}`);
  }
  return { home, cwd, env, fixture, run, dir, meta, turn, events, until };
}
