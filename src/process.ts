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
    const killed = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    // 128 = no such process. libuv ends a worker's direct child (a .cmd shim's cmd.exe) when the supervisor dies, but the shim's own
    // children keep that dead pid as their parent, so sweep them by it.
    if (killed.status === 128) {
      spawnSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }`], { windowsHide: true, stdio: "ignore", timeout: 15_000 });
    }
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch (error) {
    // macOS returns EPERM for a group whose members have all exited but are not reaped yet (zombies); nothing is left to kill.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}
