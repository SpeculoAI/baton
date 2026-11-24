import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { killGroup } from "../src/process.ts";

test("killGroup tolerates a process group that holds only unreaped zombies (macOS: EPERM)", async (t) => {
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
