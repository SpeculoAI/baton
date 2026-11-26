import path from "node:path";
import { spawnSync } from "node:child_process";

// Absolute, because a sandboxed or trimmed PATH need not contain them.
const SYSTEM32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");

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
    const killed = spawnSync(path.join(SYSTEM32, "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    // libuv ends a worker's direct child (a .cmd shim's cmd.exe) when the supervisor dies, but the shim's own children keep that dead pid
    // as their parent, so taskkill finds nothing (or only a half-closed root). Kill whatever still names it as parent.
    if (killed.status !== 0) {
      const listed = spawnSync(path.join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}').ProcessId`], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
      for (const child of (listed.stdout ?? "").split(/\s+/).map(Number)) {
        if (Number.isSafeInteger(child) && child > 1) spawnSync(path.join(SYSTEM32, "taskkill.exe"), ["/PID", String(child), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      }
    }
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch (error) {
    // macOS returns EPERM for a group whose members have all exited but are not reaped yet (zombies); nothing is left to kill.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}
