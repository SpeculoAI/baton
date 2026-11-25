#!/usr/bin/env node
import fs from "node:fs";
import { parseArgs } from "node:util";
import { agents, start, status, cancel, wait, reply, ls, prune, result as turnResult } from "./tasks.ts";
import { addWorktree, listWorktrees, removeWorktree } from "./worktree.ts";
import { redact } from "./redact.ts";
import { detectedHosts, runInstall, type Action } from "./install.ts";
import { mappedAgents, rulesInit, type InstallChoice, type RulesInitResult } from "./rulesync-setup.ts";
import type { Author, Effort, ScopeOnViolation, TaskMode } from "./types.ts";

function installChoice(value: string | undefined, flag: string): InstallChoice | undefined {
  if (value === undefined) return undefined;
  if (value === "project" || value === "global" || value === "skip") return value;
  throw new Error(`${flag} must be project, global or skip.`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  let result: unknown;
  if (command === "_supervise") {
    if (args.length !== 1) throw new Error("task_id is missing.");
    await (await import("./supervisor.ts")).supervise(args[0]);
    return;
  }
  if (command === "mcp") {
    await (await import("./mcp.ts")).startMcp();
    return;
  }
  if (command === "version" || command === "--version") {
    result = { version: JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version };
  } else if (command === "agents") {
    result = { agents: agents() };
  } else if (command === "start") {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      target: { type: "string" }, prompt: { type: "string" }, cwd: { type: "string" },
      file: { type: "string", multiple: true }, effort: { type: "string" }, model: { type: "string" },
      "idle-timeout": { type: "string" }, "max-duration": { type: "string" },
      scope: { type: "string", multiple: true }, "scope-on-violation": { type: "string" },
      mode: { type: "string" }, "allow-weak": { type: "boolean" },
      isolate: { type: "boolean" }, "allow-dirty": { type: "boolean" },
      rules: { type: "string" }, check: { type: "string" },
    } });
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
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { prompt: { type: "string" }, as: { type: "string" } } });
    if (positionals.length !== 1) throw new Error("reply requires one task_id.");
    result = await reply(positionals[0], values.prompt ?? fs.readFileSync(0, "utf8"), (values.as ?? "host") as Author);
    if ((result as { status: string }).status !== "running") process.exitCode = 1;
  } else if (command === "wait") {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true,
      options: { for: { type: "string" }, "until-done": { type: "boolean" } },
    });
    if (values["until-done"] && values.for !== undefined) throw new Error("--until-done and --for cannot be used together.");
    result = await wait(positionals, values["until-done"] ? Infinity : values.for === undefined ? 50 : Number(values.for));
  } else if (command === "result") {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { turn: { type: "string" } } });
    if (positionals.length !== 1) throw new Error("result requires one task_id.");
    // Plain text, like tail: the point is to read the answer without JSON escaping or the full transcript.
    process.stdout.write(`${turnResult(positionals[0], values.turn === undefined ? undefined : Number(values.turn)).final_message}\n`);
    return;
  } else if (command === "tail") {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { follow: { type: "boolean", short: "f" }, raw: { type: "boolean" } } });
    if (positionals.length !== 1) throw new Error("tail requires one task_id.");
    await (await import("./tail.ts")).tail(positionals[0], { follow: values.follow, raw: values.raw });
    return;
  } else if (command === "ls") {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { all: { type: "boolean" } } });
    if (positionals.length) throw new Error("ls takes no positional arguments.");
    result = { tasks: ls(values.all) };
  } else if (command === "prune") {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { older: { type: "string" } } });
    if (positionals.length || values.older === undefined) throw new Error("prune requires --older days.");
    result = { deleted: prune(Number(values.older)) };
  } else if (command === "cancel") {
    if (args.length !== 1) throw new Error("cancel requires one task_id.");
    result = await cancel(args[0]);
  } else if (command === "worktree") {
    const [action, ...rest] = args;
    if (action === "add") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { name: { type: "string" }, branch: { type: "string" }, base: { type: "string" } },
      });
      if (positionals.length) throw new Error("worktree add takes no positional arguments.");
      result = addWorktree(process.cwd(), { name: values.name, branch: values.branch, base: values.base });
    } else if (action === "ls") {
      if (rest.length) throw new Error("worktree ls takes no extra arguments.");
      result = { worktrees: listWorktrees(process.cwd()) };
    } else if (action === "rm") {
      if (rest.length !== 1) throw new Error("worktree rm requires one name or path.");
      result = removeWorktree(process.cwd(), rest[0]!);
    } else {
      throw new Error("Usage: baton worktree add|ls|rm");
    }
  } else if (command === "rules") {
    const [action, ...rest] = args;
    if (action !== "init") throw new Error("Usage: baton rules init");
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: {
        install: { type: "string" }, source: { type: "string" }, template: { type: "boolean" },
        targets: { type: "string", multiple: true }, yes: { type: "boolean" }, "dry-run": { type: "boolean" },
      },
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
      options: {
        only: { type: "string", multiple: true }, force: { type: "boolean" },
        "dry-run": { type: "boolean" }, "skip-global": { type: "boolean" },
        rulesync: { type: "string" },
      },
    });
    if (positionals.length) throw new Error(`${command} takes no positional arguments.`);
    if (command !== "install" && values.force) throw new Error(`${command} does not accept --force.`);
    if (command === "uninstall" && values["skip-global"]) throw new Error("uninstall does not accept --skip-global.");
    if (command !== "install" && values.rulesync !== undefined) throw new Error(`${command} does not accept --rulesync.`);
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
  } else throw new Error("Usage: baton version | agents | start | status | cancel | wait | result | tail | reply | ls | prune | worktree | rules | install | update | uninstall | mcp");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try { await main(); } catch (error) {
  process.stdout.write(`${JSON.stringify({ status: "failed", summary: redact((error as Error).message) })}\n`);
  process.exitCode = 1;
}
