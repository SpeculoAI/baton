import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redact } from "./redact.ts";
import { isAlive } from "./process.ts";
import type { BatonEvent, TaskMeta, Turn } from "./types.ts";

export function batonHome(): string {
  return path.resolve(process.env.BATON_HOME || path.join(os.homedir(), ".baton"));
}

/** A cancel request is a file, not a signal: Windows cannot deliver one, and a file also survives a supervisor that has not started yet. One per turn, so a later reply is not hit by an old request. */
export function cancelRequestPath(id: string, turn: number): string {
  return path.join(taskDir(id), `cancel_requested.${turn}`);
}

export function taskDir(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("task_id must be a UUID.");
  return path.join(batonHome(), "tasks", id);
}

export function ensureTask(id: string): string {
  const dir = taskDir(id);
  for (const name of [batonHome(), path.dirname(dir), dir, path.join(dir, "turns"), path.join(dir, "raw")]) {
    fs.mkdirSync(name, { recursive: true, mode: 0o700 });
    fs.chmodSync(name, 0o700);
  }
  return dir;
}

// Windows refuses to replace a file another process has open (EPERM/EBUSY/EACCES), and `start` polls meta.json while the supervisor rewrites it.
// Readers hold it for microseconds, so a short bounded retry is enough. POSIX never needs it.
function renameReplacing(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try { return fs.renameSync(from, to); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") || attempt >= 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameReplacing(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function writeMeta(meta: TaskMeta): void {
  writeJson(path.join(ensureTask(meta.task_id), "meta.json"), meta);
}

export function readMeta(id: string): TaskMeta | null {
  const dir = taskDir(id);
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as TaskMeta;
  } catch {
    return null;
  }
}

export function hasTurnEnded(id: string, turn: number): boolean {
  let text: string;
  try { text = fs.readFileSync(path.join(taskDir(id), "events.jsonl"), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line) as BatonEvent;
    if (event.type === "turn_ended" && event.turn === turn) return true;
  }
  return false;
}

export function appendEvent(id: string, event: BatonEvent): void {
  const safe = Object.fromEntries(Object.entries(event).map(([key, value]) => [key, typeof value === "string" ? redact(value) : value]));
  fs.appendFileSync(path.join(ensureTask(id), "events.jsonl"), `${JSON.stringify(safe)}\n`, { mode: 0o600 });
}

export function writeTurn(id: string, turn: Turn): void {
  if (!Number.isSafeInteger(turn.turn) || turn.turn < 1) throw new Error("turn must be a positive integer.");
  writeJson(path.join(ensureTask(id), "turns", `${turn.turn}.json`), turn);
}

export function readTurn(id: string, turn: number): Turn {
  return JSON.parse(fs.readFileSync(path.join(taskDir(id), "turns", `${turn}.json`), "utf8")) as Turn;
}

export function listTasks(): TaskMeta[] {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(batonHome(), "tasks"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => /^[0-9a-f-]{36}$/i.test(name)).flatMap((name) => {
    try { return readMeta(name) ?? []; } catch { return []; }
  });
}

export function lockTask(id: string): (() => void) | null {
  const file = path.join(taskDir(id), ".control.lock");
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, String(process.pid), { mode: 0o600, flag: "wx" });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fs.linkSync(temp, file); return () => fs.rmSync(file, { force: true }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (isAlive(Number(fs.readFileSync(file, "utf8")))) return null;
          fs.rmSync(file, { force: true });
        } catch (readError) { if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError; }
      }
    }
    return null;
  } finally { fs.rmSync(temp, { force: true }); }
}
