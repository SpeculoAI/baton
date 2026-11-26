#!/usr/bin/env node
import fs from "node:fs";
import { parseArgs } from "node:util";
import { agents, start, status, cancel, wait, reply, ls, prune, diff, apply, result as turnResult } from "./tasks.ts";
import { addWorktree, listWorktrees, removeWorktree } from "./worktree.ts";
import { redact } from "./redact.ts";
import { detectedHosts, runInstall, type Action } from "./install.ts";
import { mappedAgents, rulesInit, type InstallChoice, type RulesInitResult } from "./rulesync-setup.ts";
import type { Author, Effort, ScopeOnViolation, TaskMode } from "./types.ts";
import { COMMANDS, commandList, hasSubcommand, isCommand, renderHelp, wantsHelp } from "./usage.ts";

function installChoice(value: string | undefined, flag: string): InstallChoice | undefined {
  if (value === undefined) return undefined;
  if (value === "project" || value === "global" || value === "skip") return value;
  throw new Error(`${flag} must be project, global or skip.`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  let result: unknown;
  if (command === undefined || command === "help" || command === "-h" || command === "--help") {
    const name = command === "help" ? args[0] : undefined;
    const sub = command === "help" ? args[1] : undefined;
    if (name === undefined) process.stdout.write(renderHelp());
    else if (isCommand(name)) {
      if (sub === undefined) process.stdout.write(renderHelp(name));
      else if (hasSubcommand(name, sub)) process.stdout.write(renderHelp(name, sub));
      else throw new Error(`Usage: ${COMMANDS[name].usage}`);
    } else throw new Error(commandList);
    return;
  }
  // Before parsing, so `start --help` neither trips strict parsing nor waits on stdin.
  if (isCommand(command) && wantsHelp(args)) {
    process.stdout.write(renderHelp(command, hasSubcommand(command, args[0]) ? args[0] : undefined));
    return;
  }
  if (command === "_supervise") {
    if (args.length !== 1) throw new Error("task_id is missing.");
    await (await import("./supervisor.ts")).supervise(args[0]);
    return;
  }
  if (command === "mcp") {
    await (await import("./mcp.ts")).startMcp();
    return;
  }
  if (command === "report") {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMANDS.report.options });
    if (positionals.length > 1) throw new Error("report takes at most one task_id.");
    const { buildReport, submitReport } = await import("./report.ts");
    const report = buildReport(positionals[0], { title: values.title });
    if (values.submit) {
      result = submitReport(report);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    process.stdout.write(`${report.markdown}\n\nOpen issue: ${report.issueUrl}\n`);
    return;
  }
  if (command === "version" || command === "--version") {
    result = { version: JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version };
  } else if (command === "agents") {
    result = { agents: agents() };
  } else if (command === "start") {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMANDS.start.options });
    if (positionals.length) throw new Error("start takes no positional arguments.");
    result = await start({ target: values.target || "", prompt: values.prompt ?? fs.readFileSync(0, "utf8"), cwd: values.cwd, files: values.file,
      reasoningEffort: values.effort as Effort | undefined, model: values.model,
      idleTimeout: values["idle-timeout"] === undefined ? undefined : Number(values["idle-timeout"]), maxDuration: values["max-duration"] === undefined ? undefined : Number(values["max-duration"]),
      scope: values.scope, scopeOnViolation: values["scope-on-violation"] as ScopeOnViolation | undefined,
      mode: values.mode as TaskMode | undefined, allowWeak: values["allow-weak"],
      isolate: values.isolate, allowDirty: values["allow-dirty"],
      rules: values.rules as import("./types.ts").RulesMode | undefined,
      check: values.check,
    });
    if ((result as { status: string }).status !== "running") process.exitCode = 1;
  } else if (command === "status") {
    if (args.length !== 1) throw new Error("status requires one task_id.");
    result = status(args[0]);
  } else if (command === "reply") {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMANDS.reply.options });
    if (positionals.length !== 1) throw new Error("reply requires one task_id.");
    result = await reply(positionals[0], values.prompt ?? fs.readFileSync(0, "utf8"), (values.as ?? "host") as Author);
    if ((result as { status: string }).status !== "running") process.exitCode = 1;
  } else if (command === "wait") {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true,
      options: COMMANDS.wait.options,
    });
    if (values["until-done"] && values.for !== undefined) throw new Error("--until-done and --for cannot be used together.");
    result = await wait(positionals, values["until-done"] ? Infinity : values.for === undefined ? 50 : Number(values.for));
  } else if (command === "result") {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMANDS.result.options });
    if (positionals.length !== 1) throw new Error("result requires one task_id.");
    // Plain text, like tail: the point is to read the answer without JSON escaping or the full transcript.
    process.stdout.write(`${turnResult(positionals[0], values.turn === undefined ? undefined : Number(values.turn)).final_message}\n`);
    return;
  } else if (command === "diff") {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMANDS.diff.options });
    if (positionals.length !== 1) throw new Error("diff requires one task_id.");
    // Plain text, like result: a patch is read, not parsed.
    process.stdout.write(diff(positionals[0], { stat: values.stat }));
    return;
  } else if (command === "tail") {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMANDS.tail.options });
    if (positionals.length !== 1) throw new Error("tail requires one task_id.");
    await (await import("./tail.ts")).tail(positionals[0], { follow: values.follow, raw: values.raw });
    return;
  } else if (command === "ls") {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMANDS.ls.options });
    if (positionals.length) throw new Error("ls takes no positional arguments.");
    result = { tasks: ls(values.all) };
  } else if (command === "prune") {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMANDS.prune.options });
    if (positionals.length || values.older === undefined) throw new Error("prune requires --older days.");
    result = { deleted: prune(Number(values.older)) };
  } else if (command === "apply") {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: COMMANDS.apply.options });
    if (positionals.length !== 1) throw new Error("apply requires one task_id.");
    result = apply(positionals[0], { remove: values.remove });
  } else if (command === "cancel") {
    if (args.length !== 1) throw new Error("cancel requires one task_id.");
    result = await cancel(args[0]);
  } else if (command === "worktree") {
    const [action, ...rest] = args;
    if (action === "add") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: COMMANDS.worktree.subcommands.add.options,
      });
      if (positionals.length) throw new Error("worktree add takes no positional arguments.");
      result = addWorktree(process.cwd(), { name: values.name, branch: values.branch, base: values.base });
    } else if (action === "ls") {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
      if (positionals.length) throw new Error("worktree ls takes no positional arguments.");
      result = { worktrees: listWorktrees(process.cwd()) };
    } else if (action === "rm") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: COMMANDS.worktree.subcommands.rm.options,
      });
      if (positionals.length !== 1) throw new Error("worktree rm requires one name or path.");
      result = removeWorktree(process.cwd(), positionals[0]!, { force: values.force });
    } else {
      throw new Error("Usage: baton worktree add|ls|rm");
    }
  } else if (command === "rules") {
    const [action, ...rest] = args;
    if (action !== "init") throw new Error("Usage: baton rules init");
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: COMMANDS.rules.options,
    });
    if (positionals.length) throw new Error("rules init takes no positional arguments.");
    if (values.source && values.template) throw new Error("--source and --template cannot be used together.");
    const install = installChoice(values.install, "--install");
    const known = mappedAgents();
    const requested = (values.targets ?? []).flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
    for (const id of requested) if (!known.includes(id)) throw new Error(`Unknown agent: ${id} (expected ${known.join(", ")})`);
    const agentIds = requested.length ? requested : detectedHosts().map((host) => host.id).filter((id) => known.includes(id));
    const dryRun = Boolean(values["dry-run"]);
    const ui = process.stdin.isTTY ? await import("./install-ui.ts") : null;
    ui?.beginAction("rules init");
    const res = await rulesInit({
      cwd: process.cwd(), agents: agentIds, install, dryRun, yes: values.yes,
      source: values.template ? { kind: "template" } : values.source ? { kind: "import", target: values.source } : undefined,
      prompt: ui && !dryRun ? ui.rulesPrompter() : undefined,
    });
    if (res.status === "failed" || res.status === "needs_input") process.exitCode = 1;
    if (ui) {
      ui.showRulesResult(res);
      ui.endAction(process.exitCode ? "Finished with errors" : "Done");
      return;
    }
    result = res;
  } else if (command === "install" || command === "update" || command === "uninstall") {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true,
      // Each command parses with its own table (update/uninstall reject install-only flags); typed as install's superset.
      options: COMMANDS[command].options as typeof COMMANDS.install.options,
    });
    if (positionals.length) throw new Error(`${command} takes no positional arguments.`);
    const rulesyncChoice = installChoice(values.rulesync, "--rulesync");
    const action = command as Action;
    const pretty = Boolean(process.stdin.isTTY);
    const interactive = action === "install" && !values.only?.length && pretty;
    const dryRun = Boolean(values["dry-run"]);
    const ui = pretty ? await import("./install-ui.ts") : null;
    if (ui) ui.beginAction(action);
    let cancelled = false;
    const spin = ui && !dryRun ? ui.createSpinner() : null;
    let spinning = false;
    const ran = await runInstall({
      action,
      only: values.only,
      force: values.force,
      skipGlobal: values["skip-global"],
      dryRun,
      quiet: Boolean(spin),
      selectHosts: interactive && ui
        ? async (detected) => {
            const picked = await ui.multiselectHosts(detected);
            if (!picked) {
              cancelled = true;
              ui.cancelAction("Install cancelled.");
              return null;
            }
            return picked;
          }
        : undefined,
      onProgress: spin && ui
        ? (event) => {
            if (event.phase === "start") {
              const msg = event.type === "global" ? "Installing global baton…" : `${action} ${event.id}…`;
              if (!spinning) { spin.start(msg); spinning = true; }
              else spin.message(msg);
              return;
            }
            const label = event.type === "global"
              ? (event.ok ? "global baton" : `global: ${event.error ?? "failed"}`)
              : (event.ok
                ? `${event.id}${event.note ? ` — ${event.note}` : ""}`
                : `${event.id}: ${event.error ?? "failed"}`);
            if (spinning) {
              if (event.ok) spin.stop(label);
              else spin.error(label);
              spinning = false;
            } else if (event.ok) {
              ui.logSuccess(label);
            } else {
              ui.logError(label);
            }
          }
        : undefined,
    });
    if (spinning) spin!.stop(ran.exitCode ? "Finished with errors" : "Done");
    let rulesync: RulesInitResult | undefined;
    const installedAgents = ran.result.hosts.filter((host) => host.ok).map((host) => host.id);
    if (action === "install" && !dryRun && !cancelled && installedAgents.length && (rulesyncChoice || interactive)) {
      try {
        rulesync = await rulesInit({
          cwd: process.cwd(), agents: installedAgents, install: rulesyncChoice,
          prompt: interactive && ui ? ui.rulesPrompter() : undefined,
        });
      } catch (error) {
        rulesync = { status: "failed", detail: redact((error as Error).message) };
      }
      ui?.showRulesResult(rulesync);
    }
    if (ui && !cancelled) {
      if (dryRun) {
        const lines: string[] = [];
        if (ran.result.global && "command" in ran.result.global && ran.result.global.command) {
          lines.push(`global: ${ran.result.global.command.join(" ")}`);
        }
        for (const host of ran.result.hosts) {
          for (const args of host.commands ?? []) lines.push(`${host.id}: ${args.join(" ")}`);
        }
        if (ran.result.missing?.length) lines.push(`missing: ${ran.result.missing.join(", ")}`);
        ui.notePlan("Dry run", lines);
      } else if (ran.result.missing?.length) {
        ui.logInfo(`missing: ${ran.result.missing.join(", ")}`);
      }
      ui.endAction(ui.summarizeResult(ran.result));
    }
    result = rulesync ? { ...ran.result, rulesync } : ran.result;
    if (ran.exitCode) process.exitCode = ran.exitCode;
    // TTY already showed the human summary; dumping JSON on top is noise. Scripts (non-TTY) still get JSON.
    if (!pretty) process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  } else throw new Error(commandList);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try { await main(); } catch (error) {
  process.stdout.write(`${JSON.stringify({ status: "failed", summary: redact((error as Error).message) })}\n`);
  process.exitCode = 1;
}
