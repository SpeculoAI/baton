import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import crossSpawn from "cross-spawn";
import { once } from "node:events";
import { adapters, getAdapter } from "./adapters/index.ts";
import { resolveCursorModelArg } from "./adapters/cursor.ts";
import { readMeta, writeMeta, writeTurn, readTurn, appendEvent, hasTurnEnded, taskDir, cancelRequestPath, lockTask, listTasks } from "./store.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { redact } from "./redact.ts";
import { isAlive, killGroup } from "./process.ts";
import { dirtyPaths, gitRepoRoot, gitSnapshot, snapshotToBaseline } from "./git.ts";
import { normalizeScopeInput, scopePromptPrefix } from "./scope.ts";
import {
  buildRulesyncReport,
  discoverRules,
  hasRulesyncSource,
  readRulesyncConfig,
  resolveRulesync,
  rulesGitRoot,
  rulesPointer,
  unseenRules,
} from "./rules.ts";
import { addWorktree, applyTree, assertNotNestedWorktree, batonWorktreeExemptPaths, diffTrees, forkPoint, headSha, netTree, removeTaskWorktree, resolveRepoRoot } from "./worktree.ts";
import type { Author, Effort, Enforcement, RulesMode, RulesReport, ScopeOnViolation, TaskMeta, TaskMode, TaskStatus, Turn } from "./types.ts";

export type StartInput = {
  target: string;
  prompt: string;
  cwd?: string;
  files?: string[];
  reasoningEffort?: Effort;
  model?: string;
  idleTimeout?: number;
  maxDuration?: number;
  scope?: string[];
  scopeOnViolation?: ScopeOnViolation;
  mode?: TaskMode;
  allowWeak?: boolean;
  isolate?: boolean;
  allowDirty?: boolean;
  /** Default check: discover rules without changing the prompt. */
  rules?: RulesMode;
  /** Shell command Baton runs in the task cwd after each successful turn. */
  check?: string;
};

const DIRTY_PATHS_CAP = 50;

/** Validate --isolate / --allow-dirty against mode. Throws on invalid combos. */
export function resolveWriteSafety(
  mode: TaskMode | undefined,
  isolate: boolean | undefined,
  allowDirty: boolean | undefined,
): void {
  if (mode === "readonly" && (isolate || allowDirty)) {
    throw new Error("--isolate and --allow-dirty are only for --mode write.");
  }
  if (isolate && allowDirty) throw new Error("--isolate and --allow-dirty cannot be combined.");
}

export type DirtyWorktreeResult = {
  status: "dirty_worktree";
  summary: string;
  dirty_paths: string[];
  dirty_paths_truncated?: boolean;
};

/** Resolve readonly enforcement; throws unless allowWeak when strength is none. */
export function resolveReadonlyEnforcement(
  adapter: { id: string; readonlyEnforcement?: Enforcement },
  mode: TaskMode | undefined,
  allowWeak: boolean | undefined,
): { mode?: TaskMode; enforcement?: Enforcement } {
  if (allowWeak && mode !== "readonly") throw new Error("--allow-weak is only for --mode readonly.");
  if (!mode || mode === "write") return {};
  // Runtime guard — CLI casts via `as TaskMode`.
  if (mode !== "readonly") throw new Error("mode must be readonly or write.");
  const enforcement = adapter.readonlyEnforcement ?? "none";
  if (enforcement === "none" && !allowWeak) {
    throw new Error(`${adapter.id} cannot enforce read-only; add --allow-weak to allow it.`);
  }
  if (allowWeak && enforcement !== "none") throw new Error(`${adapter.id} has a read-only mapping; --allow-weak is not needed.`);
  return { mode: "readonly", enforcement };
}
export type StartResult = TaskMeta | { status: "failed" | "not_installed"; summary: string } | DirtyWorktreeResult;

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

// Node boot + module load takes ~150ms idle but >1s on a busy machine; a slow start is not a failure.
// Stay under the 30s no-supervisor orphan window in orphaned().
const SUPERVISOR_READY_MS = 15_000;

async function launch(id: string): Promise<void> {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, `cli${path.extname(import.meta.filename)}`), "_supervise", id], { detached: true, windowsHide: true, stdio: "ignore", env: process.env });
  await once(child, "spawn");
  let exited = false;
  child.once("exit", () => { exited = true; });
  child.unref();
  // supervisor_pid is never cleared, so a supervisor that claimed the task and already finished still counts as ready.
  const ready = () => readMeta(id)?.supervisor_pid === child.pid;
  const deadline = Date.now() + SUPERVISOR_READY_MS;
  while (!exited && Date.now() < deadline) {
    if (ready()) return;
    await sleep(10);
  }
  if (ready()) return;
  child.kill("SIGKILL");
  killGroup(readMeta(id)?.child_pid ?? null);
  throw new Error(exited ? "supervisor exited before it was ready." : "supervisor not ready.");
}

export async function start(input: StartInput): Promise<StartResult> {
  if (process.env.BATON_DELEGATION === "1") return { status: "failed", summary: "BATON_DELEGATION=1; refusing to delegate again." };
  if (!input.prompt?.trim()) throw new Error("prompt is missing.");
  const adapter = getAdapter(input.target);
  if (!adapter) throw new Error(`Unknown target: ${input.target}`);
  const idle = positive(input.idleTimeout ?? 600, "idle_timeout");
  const max = input.maxDuration == null ? null : positive(input.maxDuration, "max_duration");
  if (input.reasoningEffort && !["low", "medium", "high", "ultra"].includes(input.reasoningEffort)) throw new Error("Unknown effort.");
  const model = input.model?.trim() || undefined;
  if (model && adapter.id !== "cursor" && adapter.id !== "codex" && adapter.id !== "claude" && adapter.id !== "kimi") throw new Error(`${adapter.id} does not support --model yet (cursor, codex, claude and kimi only).`);
  let model_argv: string | undefined = adapter.id === "codex" || adapter.id === "claude" || adapter.id === "kimi" ? model : undefined;
  if (adapter.id === "cursor") {
    const resolved = resolveCursorModelArg(model, input.reasoningEffort ?? null);
    if (resolved) model_argv = resolved;
  }
  const modeFields = resolveReadonlyEnforcement(adapter, input.mode, input.allowWeak);
  resolveWriteSafety(input.mode, input.isolate, input.allowDirty);
  const cwd = path.resolve(input.cwd || process.env.BATON_CWD || process.cwd());
  if (!fs.statSync(cwd).isDirectory()) throw new Error("cwd must be a directory.");
  if (!adapter.resolve(process.env)) return { status: "not_installed", summary: `${input.target} is not on PATH.` };
  const rulesMode: RulesMode = input.rules ?? "check";
  if (rulesMode !== "check" && rulesMode !== "pointer" && rulesMode !== "off") {
    throw new Error("rules must be check, pointer, or off.");
  }
  const scopeFields = normalizeScopeInput(input.scope, input.scopeOnViolation);
  const writeMode = !modeFields.mode || modeFields.mode === "write";
  // Dirty-tree guard: in-place write only. --isolate skips this.
  if (writeMode && !input.isolate && !input.allowDirty) {
    const dirty = dirtyPaths(cwd);
    if (dirty) {
      const exempt = batonWorktreeExemptPaths(cwd);
      const filtered = dirty.filter((p) => !exempt.has(p));
      if (filtered.length) {
        const truncated = filtered.length > DIRTY_PATHS_CAP;
        return {
          status: "dirty_worktree",
          summary: "Working tree has uncommitted changes; refuse in-place write. Use --isolate (starts from HEAD, ignores uncommitted changes) or --allow-dirty to proceed.",
          dirty_paths: truncated ? filtered.slice(0, DIRTY_PATHS_CAP) : filtered,
          ...(truncated ? { dirty_paths_truncated: true } : {}),
        };
      }
    }
  }

  const task_id = randomUUID();
  const source_cwd = cwd;
  let taskCwd = cwd;
  let worktree: TaskMeta["worktree"];
  if (input.isolate) {
    if (!gitRepoRoot(cwd)) throw new Error("--isolate requires a git repository.");
    try {
      assertNotNestedWorktree(cwd);
    } catch (error) {
      throw new Error(`${(error as Error).message} Drop --isolate or run from the main checkout.`);
    }
    const repo = resolveRepoRoot(cwd);
    const short = task_id.replace(/-/g, "").slice(0, 8);
    const name = `task-${short}`;
    const added = addWorktree(cwd, { name, branch: `baton/${name}`, base: "HEAD" });
    const realCwd = fs.realpathSync.native(cwd);
    const realRepo = fs.realpathSync.native(repo);
    const rel = path.relative(realRepo, realCwd);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("--isolate cwd must be inside the repository.");
    }
    taskCwd = rel ? path.join(added.path, rel) : added.path;
    if (!fs.existsSync(taskCwd) || !fs.statSync(taskCwd).isDirectory()) {
      throw new Error(`--isolate could not map cwd into worktree: ${rel || "."}`);
    }
    worktree = {
      path: added.path,
      branch: added.branch,
      source_cwd,
      gitignore_updated: added.gitignore_updated,
      base_sha: headSha(added.path),
    };
  }

  let scope_baseline: TaskMeta["scope_baseline"];
  let readonly_baseline: TaskMeta["readonly_baseline"];
  let prompt = input.prompt;
  const needSnap = Boolean(scopeFields.scope?.length) || modeFields.mode === "readonly";
  const snap = needSnap ? gitSnapshot(taskCwd) : null;
  let rules: RulesReport | undefined;
  let pointer = "";
  if (rulesMode !== "off") {
    const found = discoverRules(taskCwd);
    const unseen = unseenRules(found, adapter.rules);
    pointer = rulesMode === "pointer" ? rulesPointer(unseen) : "";
    rules = {
      mode: rulesMode,
      found,
      unseen,
      pointer_injected: Boolean(pointer),
    };
    const repoRoot = rulesGitRoot(taskCwd) ?? taskCwd;
    if (hasRulesyncSource(repoRoot)) {
      const bin = resolveRulesync(repoRoot);
      const config = readRulesyncConfig(repoRoot);
      rules.rulesync = buildRulesyncReport(config, adapter.rules, bin);
    }
  }
  // Prefix order: scope, then rules pointer, then the user prompt (spec 3.5).
  if (pointer) prompt = `${pointer}${prompt}`;
  if (scopeFields.scope?.length) {
    if (!snap?.head) throw new Error("With --scope, cwd must be a git repository (HEAD baseline required).");
    scope_baseline = snapshotToBaseline(snap);
    prompt = `${scopePromptPrefix(scopeFields.scope)}${prompt}`;
  }
  if (modeFields.mode === "readonly" && snap?.head) readonly_baseline = snapshotToBaseline(snap);
  const now = new Date().toISOString();
  const meta: TaskMeta = {
    task_id, target: adapter.id, cwd: taskCwd, created_at: now, updated_at: now,
    status: "running", turn: 1, session_id: null, reasoning_effort: input.reasoningEffort,
    model, model_argv,
    ...modeFields,
    readonly_baseline,
    idle_timeout_s: idle, max_duration_s: max, supervisor_pid: null, child_pid: null,
    heartbeat_at: null, last_event_at: null,
    ...scopeFields,
    scope_baseline,
    rules,
    ...(input.allowDirty ? { allow_dirty: true } : {}),
    ...(input.check?.trim() ? { check_command: input.check.trim() } : {}),
    ...(worktree ? { worktree } : {}),
  };
  writeMeta(meta);
  writeTurn(meta.task_id, { turn: 1, author: "host", prompt, files: input.files, status: "running" });
  return launchTurn(meta);
}

async function launchTurn(meta: TaskMeta): Promise<TaskMeta> {
  try { await launch(meta.task_id); } catch (error) {
    const failed: TaskMeta = { ...readMeta(meta.task_id) ?? meta, status: "failed", updated_at: new Date().toISOString(), summary: redact(`supervisor failed to start: ${(error as Error).message}`) };
    writeTurn(meta.task_id, { ...readTurn(meta.task_id, meta.turn), status: "failed", summary: failed.summary });
    appendEvent(meta.task_id, { ts: failed.updated_at, turn: meta.turn, type: "turn_ended", status: "failed", exit_code: null });
    writeMeta(failed);
    return failed;
  }
  return meta;
}

export type TaskView = TaskMeta & Pick<Turn, "git_changes" | "activity" | "usage"> & {
  liveness?: "active" | "quiet" | "orphaned";
  quiet_for_s?: number;
};

// Let hosts read the terminal view without opening turns/<n>.json.
function finished(meta: TaskMeta): TaskView {
  try {
    const { git_changes, activity, usage } = readTurn(meta.task_id, meta.turn);
    return { ...meta, git_changes, activity, usage };
  } catch { return meta; }
}

function orphaned(meta: TaskMeta): boolean {
  if (!meta.supervisor_pid) return Date.now() - Date.parse(meta.updated_at) > 30_000;
  return !isAlive(meta.supervisor_pid) || !meta.heartbeat_at || Date.now() - Date.parse(meta.heartbeat_at) > 30_000;
}

export function status(id: string): TaskView {
  let meta = readMeta(id);
  if (!meta) throw new Error("No such task.");
  if (meta.status !== "running") return finished(meta);
  const quiet = Math.max(0, (Date.now() - Date.parse(meta.last_event_at || meta.updated_at)) / 1000);
  if (!orphaned(meta)) return { ...meta, liveness: quiet <= 60 ? "active" : "quiet", quiet_for_s: quiet };
  const release = lockTask(id);
  if (!release) return { ...meta, liveness: "orphaned", quiet_for_s: quiet };
  try {
    meta = readMeta(id)!;
    if (meta.status !== "running" || !orphaned(meta)) return meta;
    // The heartbeat may just be a slow write; check the pid again. If the heartbeat is stale and the process is still alive, stop the writer first, then take over.
    if (isAlive(meta.supervisor_pid)) {
      try { process.kill(meta.supervisor_pid!, "SIGKILL"); } catch (error) {
        // EPERM: the pid now belongs to another user's process (reuse); it is not our writer, so recovery goes on.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && code !== "EPERM") throw error;
      }
    }
    killGroup(meta.child_pid);
    const reason = meta.stop_reason ?? (fs.existsSync(cancelRequestPath(id, meta.turn)) ? "cancelled" : undefined);
    const decided = reason === "idle" || reason === "max_duration" || reason === "cancelled";
    meta.status = decided ? (reason === "cancelled" ? "cancelled" : "timed_out") : "failed";
    meta.summary = decided ? (reason === "cancelled" ? "Cancelled." : `Timed out: ${reason}.`) : "supervisor exited unexpectedly";
    delete meta.stop_reason;
    meta.updated_at = new Date().toISOString();
    try { const turn = readTurn(id, meta.turn); writeTurn(id, { ...turn, status: meta.status, summary: meta.summary }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!hasTurnEnded(id, meta.turn)) appendEvent(id, { ts: meta.updated_at, turn: meta.turn, type: "turn_ended", status: meta.status, exit_code: null });
    writeMeta(meta);
    if (decided) return finished(meta);
    return { ...meta, liveness: "orphaned", quiet_for_s: quiet };
  } finally { release(); }
}

// The supervisor polls for the request every 250ms; past this it is treated as stuck and killed, and the orphan path records the cancel.
const CANCEL_FORCE_MS = 5000;

export async function cancel(id: string): Promise<TaskView> {
  let meta = status(id);
  if (meta.status !== "running") return meta;
  fs.writeFileSync(cancelRequestPath(id, meta.turn), "", { flag: "a", mode: 0o600 });
  const start = Date.now();
  let signalled: number | null = null;
  let forced = false;
  while (Date.now() - start < CANCEL_FORCE_MS + 2000) {
    meta = status(id);
    if (meta.status !== "running") return meta;
    // POSIX also signals so the supervisor reacts at once; Windows has no signal that reaches its handler.
    if (process.platform !== "win32" && meta.supervisor_pid !== signalled && isAlive(meta.supervisor_pid)) {
      try { process.kill(meta.supervisor_pid!, "SIGTERM"); signalled = meta.supervisor_pid; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (!forced && Date.now() - start > CANCEL_FORCE_MS && isAlive(meta.supervisor_pid)) {
      forced = true;
      try { process.kill(meta.supervisor_pid!, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await sleep(20);
  }
  throw new Error("Cancellation not yet confirmed; retry status.");
}

/** The agent's full last message of a finished turn (default: the latest turn). */
export function result(id: string, turnNo?: number): { task_id: string; turn: number; status: TaskStatus; final_message: string } {
  const meta = status(id);
  const n = turnNo ?? meta.turn;
  if (!Number.isInteger(n) || n < 1 || n > meta.turn) throw new Error(`turn must be an integer from 1 to ${meta.turn}.`);
  const turn = readTurn(id, n);
  if (turn.status === "running") throw new Error(`Turn ${n} is still running; wait for it first.`);
  if (!turn.final_message) throw new Error(`Turn ${n} has no recorded final message (older baton, or the agent sent none); use baton tail.`);
  return { task_id: id, turn: n, status: turn.status, final_message: turn.final_message };
}

function isolatedWorktree(meta: TaskMeta): NonNullable<TaskMeta["worktree"]> {
  if (!meta.worktree) throw new Error(`Task ${meta.task_id} was not started with --isolate.`);
  return meta.worktree;
}

/** Fork point and net tree of an --isolate task; the temp index lives in the task dir, never in the worktree. */
function netChange(meta: TaskMeta): { worktree: NonNullable<TaskMeta["worktree"]>; base: string; tree: string } {
  const worktree = isolatedWorktree(meta);
  if (!fs.existsSync(worktree.path)) throw new Error(`Worktree ${worktree.path} no longer exists (applied with --remove, or removed by hand).`);
  const base = forkPoint(resolveRepoRoot(worktree.source_cwd), worktree.branch, worktree.base_sha);
  const tree = netTree(worktree.path, path.join(taskDir(meta.task_id), `net.${randomUUID()}.index`));
  return { worktree, base, tree };
}

export function diff(id: string, options: { stat?: boolean } = {}): string {
  const { worktree, base, tree } = netChange(status(id));
  return diffTrees(worktree.path, base, tree, options.stat);
}

export type ApplyResult = {
  task_id: string; status: "applied" | "nothing_to_apply"; repo: string;
  commit?: string; files?: string[]; removed: boolean; warning?: string;
};

/** One squash commit of the task's net change, cherry-picked onto the source repo's current branch. Never pushes. */
export function apply(id: string, options: { remove?: boolean } = {}): ApplyResult {
  const running = new Error("Task is running; wait for it to finish.");
  if (status(id).status === "running") throw running;
  const release = lockTask(id);
  if (!release) throw running;
  try {
    const meta = readMeta(id)!;
    if (meta.status === "running") throw running;
    const { worktree, base, tree } = netChange(meta);
    const repo = resolveRepoRoot(worktree.source_cwd);
    const subject = redact(meta.summary?.split("\n")[0]?.trim() || `apply task ${id.slice(0, 8)}`).slice(0, 72);
    const message = `baton(${meta.target}): ${subject}\n\nBaton-Task: ${id}\nBaton-Target: ${meta.target}\n`;
    const applied = applyTree(repo, base, tree, message);
    const result: ApplyResult = applied
      ? { task_id: id, status: "applied", repo, commit: applied.commit, files: applied.files, removed: false }
      : { task_id: id, status: "nothing_to_apply", repo, removed: false };
    if (options.remove) {
      const problem = removeTaskWorktree(repo, worktree.path, worktree.branch);
      result.removed = problem === null;
      if (problem) result.warning = `Applied, but could not fully remove ${worktree.path} or branch ${worktree.branch}: ${problem}`;
    }
    return result;
  } finally {
    release();
  }
}

export async function wait(ids: string[], seconds = 50): Promise<TaskView | { status: "running"; tasks: TaskView[] }> {
  if (!ids.length) throw new Error("task_ids is missing.");
  ids.forEach(taskDir);
  if (seconds !== Infinity && (!Number.isFinite(seconds) || seconds < 0)) throw new Error("for must be a non-negative number of seconds.");
  const deadline = seconds === Infinity ? Infinity : Date.now() + seconds * 1000;
  for (;;) {
    const views = ids.map(status);
    const done = views.find((view) => view.status !== "running");
    if (done) return done;
    if (Date.now() >= deadline) return views.length === 1 ? views[0] : { status: "running", tasks: views };
    await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
  }
}

export async function reply(id: string, prompt: string, author: Author = "host"): Promise<TaskMeta | { task_id: string; status: "busy"; summary: string }> {
  taskDir(id);
  if (process.env.BATON_DELEGATION === "1") throw new Error("BATON_DELEGATION=1; refusing to delegate again.");
  if (!prompt.trim()) throw new Error("prompt is missing.");
  if (author !== "host" && author !== "human") throw new Error("as must be host or human.");
  const current = status(id);
  const busy = { task_id: id, status: "busy" as const, summary: "This task is running." };
  if (current.status === "running") return busy;
  const release = lockTask(id);
  if (!release) return busy;
  let next: TaskMeta;
  try {
    const meta = readMeta(id)!;
    if (meta.status === "running") return busy;
    if (!["success", "needs_input", "scope_violation", "readonly_violation", "check_failed"].includes(meta.status)) throw new Error(`Cannot continue a task in status ${meta.status}.`);
    if (!meta.session_id) throw new Error("No session_id; cannot resume the session.");
    if (!getAdapter(meta.target)?.resolve(process.env)) throw new Error(`${meta.target} is not on PATH.`);
    next = { ...meta, status: "running", turn: meta.turn + 1, updated_at: new Date().toISOString(), supervisor_pid: null, child_pid: null, heartbeat_at: null, last_event_at: null };
    delete next.decision;
    delete next.summary;
    delete next.warning;
    delete next.scope_violations;
    delete next.check;
    writeTurn(id, { turn: next.turn, author, prompt, status: "running" });
    writeMeta(next);
  } finally { release(); }
  return launchTurn(next);
}

export function taskCwdFilter(cwd = process.cwd()): (meta: TaskMeta) => boolean {
  const here = path.resolve(cwd);
  let hereReal = here;
  try { hereReal = fs.realpathSync.native(here); } catch { /* keep resolved */ }
  return (meta) => {
    if (meta.cwd === here || meta.worktree?.source_cwd === here) return true;
    try {
      if (fs.realpathSync.native(meta.cwd) === hereReal) return true;
      if (meta.worktree?.source_cwd && fs.realpathSync.native(meta.worktree.source_cwd) === hereReal) return true;
    } catch { /* missing path */ }
    return false;
  };
}

export function ls(all = false, cwd = process.cwd()): TaskView[] {
  const tasks = listTasks();
  return (all ? tasks : tasks.filter(taskCwdFilter(cwd))).map((meta) => status(meta.task_id))
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

export function prune(older: number): string[] {
  const cutoff = Date.now() - older * 86_400_000;
  if (!Number.isFinite(older) || older < 0 || !Number.isFinite(cutoff)) throw new Error("older must be a non-negative number of days.");
  const deleted: string[] = [];
  for (const candidate of listTasks()) {
    if (candidate.status === "running" || Date.parse(candidate.updated_at) >= cutoff) continue;
    let release: (() => void) | null;
    try { release = lockTask(candidate.task_id); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!release) continue;
    try {
      const meta = readMeta(candidate.task_id);
      if (!meta || meta.status === "running" || !(Date.parse(meta.updated_at) < cutoff)) continue;
      fs.rmSync(taskDir(meta.task_id), { recursive: true });
      deleted.push(meta.task_id);
    } finally { release(); }
  }
  return deleted;
}

export function agents(env: NodeJS.ProcessEnv = process.env): { id: string; installed: boolean; bin: string | null; version: string | null }[] {
  return Object.values(adapters).map((adapter) => {
    const bin = adapter.resolve(env);
    if (!bin) return { id: adapter.id, installed: false, bin: null, version: null };
    const ran = crossSpawn.sync(bin, ["--version"], { encoding: "utf8", timeout: 5000, env });
    const version = `${ran.stdout || ""}\n${ran.stderr || ""}`.trim().split("\n").filter(Boolean)[0] || null;
    return { id: adapter.id, installed: true, bin, version };
  });
}
