/** One table per subcommand: cli.ts parses with `options`, and `--help` renders from the same entries. */
type Opt = { type: "string" | "boolean"; short?: string; multiple?: boolean; arg?: string; desc: string };
type Cmd = { usage: string; summary: string; options?: Record<string, Opt>; notes?: string[]; examples?: string[] };

const INSTALL_OPTIONS = {
  only: { type: "string", multiple: true, arg: "agent", desc: "Only this agent: claude, codex, cursor, agy or gemini (repeatable)" },
  force: { type: "boolean", desc: "Reinstall even when already installed" },
  "dry-run": { type: "boolean", desc: "Print the commands without running them" },
  "skip-global": { type: "boolean", desc: "Do not install or update the global baton command" },
  rulesync: { type: "string", arg: "project|global|skip", desc: "Answer the rulesync install question up front" },
} as const satisfies Record<string, Opt>;
const UPDATE_OPTIONS = { only: INSTALL_OPTIONS.only, "dry-run": INSTALL_OPTIONS["dry-run"], "skip-global": INSTALL_OPTIONS["skip-global"] };
const UNINSTALL_OPTIONS = { only: INSTALL_OPTIONS.only, "dry-run": INSTALL_OPTIONS["dry-run"] };

export const COMMANDS = {
  version: { usage: "baton version", summary: "Print the installed baton version." },
  agents: { usage: "baton agents", summary: "List the local agent CLIs baton can delegate to and whether each is installed." },
  start: {
    usage: "baton start --target <agent> [--prompt <text> | stdin] [options]",
    summary: "Start a job in the background and return its task_id.",
    options: {
      target: { type: "string", arg: "agent", desc: "Agent CLI to run: codex, claude, cursor or agy (required)" },
      prompt: { type: "string", arg: "text", desc: "Task prompt; read from stdin when omitted" },
      cwd: { type: "string", arg: "dir", desc: "Working directory for the job (default: current directory)" },
      file: { type: "string", multiple: true, arg: "path", desc: "File the agent should focus on (repeatable)" },
      effort: { type: "string", arg: "low|medium|high|ultra", desc: "Reasoning effort, mapped to the CLI's native flag (not cursor)" },
      model: { type: "string", arg: "id", desc: "Model id for cursor, codex or claude; kept across reply" },
      "idle-timeout": { type: "string", arg: "s", desc: "Stop after this many seconds with no output (default 600)" },
      "max-duration": { type: "string", arg: "s", desc: "Maximum seconds per turn (default unlimited)" },
      scope: { type: "string", multiple: true, arg: "glob", desc: "Paths allowed to change, checked after each turn (repeatable)" },
      "scope-on-violation": { type: "string", arg: "warn|fail", desc: "What an out-of-scope change does (default warn)" },
      mode: { type: "string", arg: "readonly|write", desc: "Permission mode (default write)" },
      "allow-weak": { type: "boolean", desc: "Allow --mode readonly on a target that cannot enforce it" },
      isolate: { type: "boolean", desc: "Run in a new git worktree; bring the work back with baton apply" },
      "allow-dirty": { type: "boolean", desc: "Allow an in-place write job on a dirty working tree" },
      rules: { type: "string", arg: "check|pointer|off", desc: "Project rule file discovery (default check)" },
      check: { type: "string", arg: "cmd", desc: "Shell command run after each successful turn; non-zero ends it as check_failed" },
    },
    examples: [
      "baton start --target codex --isolate --prompt \"fix the failing test in test/a.test.ts\"",
      "baton start --target claude --mode readonly --scope \"src/**\" < task.md",
    ],
  },
  status: { usage: "baton status <task_id>", summary: "Print a job's current status; while running, includes liveness." },
  cancel: { usage: "baton cancel <task_id>", summary: "Stop a running job and its whole process group." },
  wait: {
    usage: "baton wait <task_id>... [--for <s> | --until-done]",
    summary: "Wait until any of the jobs leaves running, or until the time runs out.",
    options: {
      for: { type: "string", arg: "s", desc: "Seconds to wait (default 50)" },
      "until-done": { type: "boolean", desc: "Block until a job leaves running" },
    },
  },
  result: {
    usage: "baton result <task_id> [--turn <n>]",
    summary: "Print the agent's full final message of a finished turn as plain text.",
    options: { turn: { type: "string", arg: "n", desc: "Turn number (default latest)" } },
  },
  diff: {
    usage: "baton diff <task_id> [--stat]",
    summary: "Print the net change of an --isolate job as a plain-text patch.",
    options: { stat: { type: "boolean", desc: "Print a diffstat instead of the patch" } },
  },
  apply: {
    usage: "baton apply <task_id> [--remove]",
    summary: "Bring an --isolate job's net change onto the current branch as one local commit; never pushes.",
    options: { remove: { type: "boolean", desc: "Delete the worktree and its branch after a successful apply" } },
  },
  tail: {
    usage: "baton tail <task_id> [-f] [--raw]",
    summary: "Print a job's events in readable form.",
    options: {
      follow: { type: "boolean", short: "f", desc: "Keep following until the job stops" },
      raw: { type: "boolean", desc: "Print the raw events.jsonl lines" },
    },
  },
  reply: {
    usage: "baton reply <task_id> [--prompt <text> | stdin] [--as host|human]",
    summary: "Start the next turn of a stopped job in the same session.",
    options: {
      prompt: { type: "string", arg: "text", desc: "Reply text; read from stdin when omitted" },
      as: { type: "string", arg: "host|human", desc: "Who is speaking (default host)" },
    },
  },
  ls: {
    usage: "baton ls [--all]",
    summary: "List jobs for the current directory, newest first.",
    options: { all: { type: "boolean", desc: "List jobs from every directory" } },
  },
  prune: {
    usage: "baton prune --older <days>",
    summary: "Delete non-running task directories older than N days (worktrees are kept).",
    options: { older: { type: "string", arg: "days", desc: "Age threshold in days (required)" } },
  },
  worktree: {
    usage: "baton worktree add [options] | ls | rm <name-or-path>",
    summary: "Manage baton worktrees under .worktrees/.",
    options: {
      name: { type: "string", arg: "id", desc: "Worktree name (add)" },
      branch: { type: "string", arg: "name", desc: "Branch to create (add)" },
      base: { type: "string", arg: "ref", desc: "Ref to start from (add; default HEAD)" },
    },
    notes: ["rm refuses dirty or unmerged trees; when clean it removes the tree and deletes the local branch."],
  },
  rules: {
    usage: "baton rules init [options]",
    summary: "Set up rulesync so your agents share one set of rules.",
    options: {
      install: { type: "string", arg: "project|global|skip", desc: "How to install rulesync when it is missing" },
      source: { type: "string", arg: "agent", desc: "Import existing rules from claudecode, codexcli or cursor" },
      template: { type: "boolean", desc: "Start from baton's template instead of importing" },
      targets: { type: "string", multiple: true, arg: "agent[,agent]", desc: "Agents to generate for (default: detected hosts)" },
      yes: { type: "boolean", desc: "Apply the generated changes without asking" },
      "dry-run": { type: "boolean", desc: "Preview only" },
    },
  },
  install: {
    usage: "baton install [options]",
    summary: "Install the global baton command and the plugin into your agent CLIs.",
    options: INSTALL_OPTIONS,
  },
  update: {
    usage: "baton update [--only <agent>]... [--dry-run] [--skip-global]",
    summary: "Update the global baton command and the installed plugins.",
    options: UPDATE_OPTIONS,
  },
  uninstall: {
    usage: "baton uninstall [--only <agent>]... [--dry-run]",
    summary: "Remove the baton plugin from your agent CLIs.",
    options: UNINSTALL_OPTIONS,
  },
  mcp: { usage: "baton mcp", summary: "Start the MCP server on stdio." },
  report: {
    usage: "baton report [task_id] [--title <text>] [--submit]",
    summary: "Generate a redacted diagnostic report and GitHub issue link (optionally submit).",
    options: {
      title: { type: "string", arg: "text", desc: "Issue title override" },
      submit: { type: "boolean", desc: "Create the issue via gh if logged in, otherwise open the prefilled form in a browser" },
    },
    notes: ["Never includes prompts, raw logs, file names, or credentials; still review before posting."],
  },
} as const satisfies Record<string, Cmd>;

export type CommandName = keyof typeof COMMANDS;

export function isCommand(name: string | undefined): name is CommandName {
  return name !== undefined && Object.hasOwn(COMMANDS, name);
}

/** `-h` / `--help` anywhere before `--`. */
export function wantsHelp(args: string[]): boolean {
  const end = args.indexOf("--");
  return (end < 0 ? args : args.slice(0, end)).some((arg) => arg === "-h" || arg === "--help");
}

export const commandList = `Usage: baton ${Object.keys(COMMANDS).join(" | ")}`;

function columns(rows: [string, string][]): string[] {
  const width = Math.max(...rows.map(([left]) => left.length)) + 2;
  return rows.map(([left, right]) => `  ${left.padEnd(width)}${right}`);
}

export function renderHelp(name?: CommandName): string {
  if (!name) {
    return [
      "Usage: baton <command> [options]",
      "",
      "Hand a bounded coding task to another local agent CLI, then continue the same session.",
      "",
      "Commands:",
      ...columns(Object.entries(COMMANDS).map(([cmd, def]) => [cmd, def.summary])),
      "",
      "Run `baton <command> --help` for a command's options.",
      "",
    ].join("\n");
  }
  const cmd: Cmd = COMMANDS[name];
  const options: [string, string][] = Object.entries(cmd.options ?? {}).map(([key, opt]) => [
      `${opt.short ? `-${opt.short}, ` : ""}--${key}${opt.type === "string" ? ` <${opt.arg ?? "value"}>` : ""}`,
      opt.desc,
    ]);
  options.push(["-h, --help", "Show this help"]);
  return [
    `Usage: ${cmd.usage}`,
    "",
    cmd.summary,
    "",
    "Options:",
    ...columns(options),
    ...(cmd.notes?.length ? ["", ...cmd.notes] : []),
    ...(cmd.examples?.length ? ["", "Examples:", ...cmd.examples.map((line) => `  ${line}`)] : []),
    "",
  ].join("\n");
}
