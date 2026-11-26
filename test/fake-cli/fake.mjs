// Fake agent CLI for baton tests (codex, claude, cursor-agent, agent). Behaviour comes from FAKE_* env vars:
//   FAKE_ARGS_FILE        write argv, one per line
//   FAKE_INPUT_FILE       write stdin to this file (otherwise stdin is drained)
//   FAKE_CHILD_PID_FILE   start a grandchild that ignores SIGTERM and write its pid here
//   FAKE_TICKS            print this many "." (FAKE_TICK_SLEEP seconds apart, default 0.1)
//   FAKE_SLEEP            seconds to wait before output
//   FAKE_WRITE            write FAKE_WRITE_CONTENT (default "x") to this file
//   FAKE_FIXTURE          copy this file to stdout
//   FAKE_HANG=1           never exit
//   FAKE_REMOVE_LAST=1    delete the file named after --output-last-message
//   FAKE_EXIT             exit code (default 0)
import fs from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const env = process.env;
const args = process.argv.slice(2);
const seconds = (value) => sleep(Number(value) * 1000);

if (env.FAKE_ARGS_FILE) fs.writeFileSync(env.FAKE_ARGS_FILE, args.length ? args.map((arg) => `${arg}\n`).join("") : "\n");

const input = [];
for await (const chunk of process.stdin) input.push(chunk);
if (env.FAKE_INPUT_FILE) fs.writeFileSync(env.FAKE_INPUT_FILE, Buffer.concat(input));

if (env.FAKE_CHILD_PID_FILE) {
  // Inherits stdio like a shell background job, so the worker's pipes stay open until the grandchild dies.
  const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "inherit" });
  grandchild.unref();
  fs.writeFileSync(env.FAKE_CHILD_PID_FILE, `${grandchild.pid}\n`);
}

if (env.FAKE_TICKS) {
  for (let i = 0; i < Number(env.FAKE_TICKS); i++) {
    process.stdout.write(".");
    await seconds(env.FAKE_TICK_SLEEP || 0.1);
  }
  process.stdout.write("\n");
}
if (env.FAKE_SLEEP) await seconds(env.FAKE_SLEEP);
if (env.FAKE_WRITE) fs.writeFileSync(env.FAKE_WRITE, env.FAKE_WRITE_CONTENT || "x");
if (env.FAKE_FIXTURE) {
  try { process.stdout.write(fs.readFileSync(env.FAKE_FIXTURE)); } catch (error) { process.stderr.write(`${error.message}\n`); }
}
if (env.FAKE_HANG === "1") {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (env.FAKE_REMOVE_LAST === "1") {
  const at = args.indexOf("--output-last-message");
  if (at >= 0 && args[at + 1]) fs.rmSync(args[at + 1], { force: true });
}
process.exitCode = Number(env.FAKE_EXIT || 0);
