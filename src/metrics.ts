import fs from "node:fs";
import path from "node:path";
import { getAdapter } from "./adapters/index.ts";
import { listTasks, readTurn, taskDir } from "./store.ts";
import type { Adapter, EventData, TaskMeta, Turn, TurnActivity, TurnUsage } from "./types.ts";

export function summarizeEvents(events: Iterable<EventData>): { activity: TurnActivity; usage?: TurnUsage } {
  const activity: TurnActivity = {
    tool_calls: 0,
    by_kind: { read: 0, search: 0, edit: 0, shell: 0, other: 0 },
    explore: 0,
    verify: 0,
    before_first_edit: null,
  };
  let usage: TurnUsage | undefined;
  for (const event of events) {
    if (event.type === "usage") {
      const { input, cached_input, output, reasoning, raw } = event;
      usage = { input, cached_input, output, raw, ...(reasoning === undefined ? {} : { reasoning }) };
    }
    if (event.type !== "tool_call") continue;
    const kind = event.kind ?? "other";
    if (kind === "edit" && activity.before_first_edit === null) {
      activity.before_first_edit = activity.tool_calls;
    }
    activity.tool_calls++;
    activity.by_kind[kind]++;
    if (kind === "read" || kind === "search" || (kind === "shell" && event.intent === "explore")) activity.explore++;
    if (kind === "shell" && event.intent === "verify") activity.verify++;
  }
  return usage ? { activity, usage } : { activity };
}

function countDelta(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined || previous === undefined) return undefined;
  const delta = current - previous;
  return Number.isFinite(delta) && delta >= 0 ? delta : undefined;
}

/** A null baseline marks a new session; undefined means a resumed session has no previous snapshot. */
export function turnUsage(
  adapter: Pick<Adapter, "usage" | "usageCumulative">,
  current: TurnUsage | undefined,
  previousRaw: TurnUsage["raw"] | null | undefined,
): TurnUsage | undefined {
  if (!current || previousRaw === null || !adapter.usageCumulative) return current;
  if (!previousRaw) return undefined;

  const previous = adapter.usage?.(previousRaw);
  if (!previous) return undefined;
  const input = countDelta(current.input, previous.input);
  const cached_input = countDelta(current.cached_input, previous.cached_input);
  const output = countDelta(current.output, previous.output);
  if (input === undefined || cached_input === undefined || output === undefined) return undefined;

  const reasoning = countDelta(current.reasoning, previous.reasoning);
  return { input, cached_input, output, raw: current.raw, ...(reasoning === undefined ? {} : { reasoning }) };
}

function readStoredTurn(id: string, number: number): Turn | undefined {
  try {
    return readTurn(id, number);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function readFirstTurnStdout(id: string): string | undefined {
  try {
    return fs.readFileSync(path.join(taskDir(id), "raw", "1.stdout.log"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function* replayEvents(adapter: Adapter, stdout: string): Iterable<EventData> {
  for (const line of stdout.split(/\r\n?|\n/)) {
    const events = adapter.parseLine(line);
    if (events) yield* events;
  }
}

function firstTurnMetrics(meta: TaskMeta, turn: Turn | undefined): Pick<Turn, "activity" | "usage"> {
  if (turn?.activity) return { activity: turn.activity, usage: turn.usage };
  const adapter = getAdapter(meta.target);
  const stdout = adapter ? readFirstTurnStdout(meta.task_id) : undefined;
  if (!adapter || stdout === undefined) return { usage: turn?.usage };
  const { activity, usage } = summarizeEvents(replayEvents(adapter, stdout));
  return { activity, usage: turnUsage(adapter, usage, null) ?? turn?.usage };
}

function hasFailedCheck(meta: TaskMeta, first: Turn | undefined): boolean {
  for (let n = 1; n <= meta.turn; n++) {
    const turn = n === 1 ? first : readStoredTurn(meta.task_id, n);
    if (turn?.check?.status === "failed" || turn?.check?.status === "timed_out") return true;
  }
  return false;
}

function parseSince(value: string, now: number): number {
  const days = /^(\d+)d$/.exec(value);
  if (days) {
    const cutoff = new Date(now - Number(days[1]) * 86_400_000).getTime();
    if (Number.isFinite(cutoff)) return cutoff;
  }
  const iso = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))?$/.exec(value);
  if (iso && new Date(iso[1]).toJSON()?.slice(0, 10) === iso[1]) {
    const cutoff = Date.parse(value);
    if (Number.isFinite(cutoff)) return cutoff;
  }
  throw new Error("--since must be an ISO date or a non-negative number of days (for example, 7d).");
}

function percentile(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null;
  const position = q * (sorted.length - 1);
  const low = Math.floor(position);
  return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
}

function share(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function summarizeTarget(tasks: readonly TaskMeta[]) {
  const beforeFirstEdit: number[] = [];
  const input: number[] = [];
  const output: number[] = [];
  let measured = 0;
  let toolCalls = 0;
  let explore = 0;
  let cachedInput = 0;
  let reworked = 0;
  let checked = 0;
  let checkFailed = 0;
  for (const meta of tasks) {
    const first = readStoredTurn(meta.task_id, 1);
    const { activity, usage } = firstTurnMetrics(meta, first);
    if (activity) {
      measured++;
      toolCalls += activity.tool_calls;
      explore += activity.explore;
      if (activity.before_first_edit !== null) beforeFirstEdit.push(activity.before_first_edit);
    }
    if (usage) {
      input.push(usage.input);
      output.push(usage.output);
      cachedInput += usage.cached_input;
    }
    if (meta.turn >= 2) reworked++;
    if (meta.check_command) {
      checked++;
      if (hasFailedCheck(meta, first)) checkFailed++;
    }
  }
  for (const values of [beforeFirstEdit, input, output]) values.sort((a, b) => a - b);
  return {
    tasks: tasks.length,
    measured,
    first_turn: {
      before_first_edit: { median: percentile(beforeFirstEdit, 0.5), p75: percentile(beforeFirstEdit, 0.75), n: beforeFirstEdit.length },
      explore_share: share(explore, toolCalls),
      input: { median: percentile(input, 0.5), n: input.length },
      output: { median: percentile(output, 0.5), n: output.length },
      cached_share: share(cachedInput, input.reduce((sum, count) => sum + count, 0)),
    },
    rework_rate: share(reworked, tasks.length),
    check_failed_rate: share(checkFailed, checked),
  };
}

export function stats(
  { target, since }: { target?: string; since?: string },
  matchesCwd?: (meta: TaskMeta) => boolean,
) {
  if (target !== undefined && !getAdapter(target)) throw new Error(`Unknown target: ${target}`);
  const now = Date.now();
  const cutoff = since === undefined ? undefined : parseSince(since, now);
  const groups = new Map<string, TaskMeta[]>();
  for (const meta of listTasks()) {
    if (meta.status === "running" || (target !== undefined && meta.target !== target)) continue;
    if (cutoff !== undefined && !(Date.parse(meta.created_at) >= cutoff)) continue;
    if (matchesCwd && !matchesCwd(meta)) continue;
    const group = groups.get(meta.target);
    if (group) group.push(meta);
    else groups.set(meta.target, [meta]);
  }
  return {
    schema_version: 1 as const,
    generated_at: new Date(now).toISOString(),
    note: "Usage accounting differs across CLIs. Only compare changes over time within the same CLI.",
    targets: Object.fromEntries([...groups].map(([id, tasks]) => [id, summarizeTarget(tasks)])),
  };
}
