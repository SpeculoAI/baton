import { spawnSync } from "node:child_process";

export function isAlive(pid: number | null): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return false;
  // shortcut: PID reuse can cause misjudgment; add the process start time if stricter identity checks are needed.
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function killGroup(pid: number | null): void {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return;
  if (process.platform === "win32") {
    // shortcut: taskkill follows parent pids, so a grandchild whose parent already exited escapes; a Job Object would need a native addon.
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); // exit 128 = already gone
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch (error) {
    // macOS returns EPERM for a group whose members have all exited but are not reaped yet (zombies); nothing is left to kill.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}
