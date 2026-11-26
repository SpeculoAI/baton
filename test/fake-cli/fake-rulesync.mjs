// Fake rulesync for baton tests. Behaviour via env:
//   FAKE_RULESYNC_EXIT   exit code (default 0)
//   FAKE_RULESYNC_SLEEP  seconds to sleep before exiting
//   FAKE_RULESYNC_ARGS   if set, write argv to this file
//   FAKE_RULESYNC_TOUCH  if set, append a line to that path (for generate dirtied tests)
//   FAKE_RULESYNC_STDERR text written to stderr
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const env = process.env;
const args = process.argv.slice(2);

if (env.FAKE_RULESYNC_ARGS) fs.writeFileSync(env.FAKE_RULESYNC_ARGS, args.length ? args.map((arg) => `${arg}\n`).join("") : "\n");
if (env.FAKE_RULESYNC_TOUCH) fs.appendFileSync(env.FAKE_RULESYNC_TOUCH, "touched\n");
if (env.FAKE_RULESYNC_STDERR) process.stderr.write(`${env.FAKE_RULESYNC_STDERR}\n`);
if (env.FAKE_RULESYNC_SLEEP) await sleep(Number(env.FAKE_RULESYNC_SLEEP) * 1000);
process.exitCode = Number(env.FAKE_RULESYNC_EXIT || 0);
