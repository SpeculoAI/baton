export type Target = "codex" | "claude" | "agy" | "cursor" | "kimi";
export type Effort = "low" | "medium" | "high" | "ultra";
export type TaskStatus = "running" | "needs_input" | "success" | "failed" | "timed_out" | "cancelled" | "not_installed" | "not_authenticated" | "quota_exceeded" | "scope_violation" | "readonly_violation" | "check_failed";
/** Result of the `--check` command Baton ran after a successful turn. `status` is absent when the check was cancelled. */
export type CheckResult = { command: string; status?: "passed" | "failed" | "timed_out"; exit_code: number | null; duration_ms: number; output_tail: string };
export type Author = "host" | "human";
export type ScopeOnViolation = "warn" | "fail";
export type TaskMode = "readonly" | "write";
export type Enforcement = "os-sandbox" | "agent-enforced" | "none";
export type EnvFeature = "mcp" | "hooks";
export type RulesMode = "check" | "pointer" | "off";
export type RuleSupport = {
  /** Rule paths relative to a directory level, e.g. "AGENTS.md", ".cursor/rules". */
  files: string[];
  /** Files read only when none of `unless` exists at the same level (Claude's AGENTS.md rule). */
  conditional?: { file: string; unless: string[] }[];
  /** rulesync target id; omit when rulesync has no matching target. */
  rulesyncTarget?: string;
  /** Why generated config for a feature may not load in Baton's non-interactive run. */
  gates?: Partial<Record<EnvFeature, string>>;
};
export type RulesyncReport = {
  /** pending: start() wrote config info; the supervisor has not run --check yet. */
  status: "pending" | "in_sync" | "stale" | "error" | "skipped";
  detail?: string;
  /** null when rulesync.jsonc could not be parsed. */
  target_configured: boolean | null;
  /** Features rulesync.jsonc configures for this target; empty when unknown or not configured. */
  features: string[];
  /** Load-gate notes for configured features this target may not load (from Adapter.rules.gates). */
  gates: string[];
};
export type RulesReport = {
  mode: "check" | "pointer";
  found: string[];
  unseen: string[];
  pointer_injected: boolean;
  rulesync?: RulesyncReport;
};
export type ScopeBaseline = {
  head: string;
  /** Porcelain lines: path → full porcelain line */
  porcelain: Record<string, string>;
  /** Content digests for dirty paths */
  digests: Record<string, string>;
};
export type TaskMeta = {
  task_id: string;
  target: Target;
  cwd: string;
  created_at: string;
  updated_at: string;
  status: TaskStatus;
  turn: number;
  session_id: string | null;
  reasoning_effort?: Effort;
  /** Requested model id (Cursor `--model`, Codex `-m`); reply keeps this. */
  model?: string;
  /** Last argv value passed as `--model` (requested, not provider-confirmed). */
  model_argv?: string;
  /** Only set when readonly; omit for default write. */
  mode?: TaskMode;
  /** How strongly readonly is enforced for this target. */
  enforcement?: Enforcement;
  /** Task-start git snapshot for readonly post-check (like scope_baseline). */
  readonly_baseline?: ScopeBaseline;
  idle_timeout_s: number;
  max_duration_s: number | null;
  supervisor_pid: number | null;
  child_pid: number | null;
  /** 已决定 stop、终态尚未写盘时存在。终态写入时删除。 */
  stop_reason?: "idle" | "max_duration" | "cancelled";
  heartbeat_at: string | null;
  last_event_at: string | null;
  decision?: { question: string; options: string[] };
  summary?: string;
  warning?: string;
  /** Set when start bypassed the dirty-tree guard via --allow-dirty. */
  allow_dirty?: boolean;
  /** Present when the task was started with --isolate. */
  worktree?: {
    path: string;
    branch: string;
    source_cwd: string;
    gitignore_updated: boolean;
    /** Commit the worktree was created from; `diff` / `apply` compare against it. */
    base_sha?: string;
  };
  scope?: string[];
  scope_on_violation?: ScopeOnViolation;
  scope_violations?: string[];
  scope_baseline?: ScopeBaseline;
  rules?: RulesReport;
  /** `--check` command; kept across reply and run after every successful turn. */
  check_command?: string;
  /** Result of the latest turn's check. */
  check?: CheckResult;
};
export type ToolKind = "read" | "search" | "edit" | "shell" | "other";
export type ShellIntent = "explore" | "verify";
export type TurnActivity = {
  tool_calls: number;
  by_kind: Record<ToolKind, number>;
  explore: number;
  verify: number;
  before_first_edit: number | null;
};
export type TurnUsage = { input: number; cached_input: number; output: number; reasoning?: number; raw: Record<string, number> };
export type EventData =
  | { type: "turn_started"; author: Author; prompt_preview: string }
  | { type: "message"; text: string }
  | { type: "tool_call"; name: string; detail: string; kind?: ToolKind; intent?: ShellIntent }
  | ({ type: "usage" } & TurnUsage)
  | { type: "tool_result"; name: string; ok: boolean; detail: string }
  | { type: "raw"; stream: "stdout" | "stderr"; line: string }
  | { type: "error"; text: string }
  | { type: "check_started"; command: string }
  | { type: "check_ended"; status: "passed" | "failed" | "timed_out" | "cancelled"; exit_code: number | null }
  | { type: "turn_ended"; status: TaskStatus; exit_code: number | null };
export type BatonEvent = { ts: string; turn: number } & EventData;
export type SpawnSpec = {
  command: string;
  args: string[];
  stdin: string | null;
  lastMessagePath?: string;
  warning?: string;
  /** Value passed to the CLI as `--model` when applicable. */
  modelArg?: string;
};
export type Adapter = {
  id: Target;
  usage?(raw: TurnUsage["raw"]): Omit<TurnUsage, "raw"> | undefined;
  usageCumulative?: true;
  resolve(env: NodeJS.ProcessEnv): string | null;
  /** Readonly enforcement strength; omit or return null when unsupported. */
  readonlyEnforcement?: Enforcement;
  /** Native rule-file support and optional rulesync / load-gate metadata. */
  rules?: RuleSupport;
  build(input: {
    bin: string;
    cwd: string;
    prompt: string;
    sessionId: string | null;
    reasoningEffort: Effort | null;
    model?: string | null;
    mode?: TaskMode | null;
  }): SpawnSpec;
  parseLine(line: string): BatonEvent[] | null;
  sessionIdFrom(line: string): string | null;
  isAuthFailure(text: string): boolean;
};
export type GitChanges = { files_changed: number; insertions: number; deletions: number; diff_stat: string };
export type Turn = {
  turn: number; author: Author; prompt: string; files?: string[]; status: TaskStatus; summary?: string; git_changes?: GitChanges;
  excerpts?: string[];
  /** The agent's full last message of this turn (redacted); `baton result` prints it. */
  final_message?: string;
  check?: CheckResult;
  activity?: TurnActivity;
  usage?: TurnUsage;
};
