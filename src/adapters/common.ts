import fs from "node:fs";
import path from "node:path";
import type { Adapter, EventData, ShellIntent, TurnUsage } from "../types.ts";

const VERIFY_COMMAND = /^(?:npm|pnpm|yarn|npx|node[ \t]+--test|vitest|jest|tsc|eslint|prettier|pytest|go[ \t]+test|cargo|make)(?=\s|$)/;
const EXPLORE_COMMAND = /^(?:rg|grep|cat|sed[ \t]+-n|head|tail|ls|find|fd|wc|nl|tree|stat|git[ \t]+(?:status|log|show|diff|grep|ls-files|blame)|codegraph)(?=\s|$)/;

export function shellIntent(command: string): ShellIntent | undefined {
  const text = command.trim();
  const wrapper = /^(?:[^\s]+\/)?(?:zsh|bash|sh)[ \t]+-(?:lc|c)[ \t]+(['"])([\s\S]*)\1$/.exec(text);
  // shortcut: skips common single heredocs, use a shell parser if complex syntax needs accurate classification.
  const body = (wrapper?.[2] ?? text).replace(
    /(?<!<)<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\b\1([^\r\n]*)\r?\n[\s\S]*?^\t*\2\r?$/gm,
    "$3",
  );
  const segments: string[] = [];
  let start = 0;
  for (const match of body.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|\\[^\r\n]|(&&|\|\||[;|\n])/g)) {
    if (!match[1]) continue;
    segments.push(body.slice(start, match.index));
    start = match.index + match[0].length;
  }
  segments.push(body.slice(start));
  const commands = segments.map((segment) => segment.trim()).filter(Boolean);
  if (commands.some((segment) => VERIFY_COMMAND.test(segment))) return "verify";
  if (commands.length && commands.every((segment) => EXPLORE_COMMAND.test(segment))) return "explore";
  return undefined;
}

export function usageEvent(
  value: unknown,
  normalize: NonNullable<Adapter["usage"]>,
): Extract<EventData, { type: "usage" }> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw: TurnUsage["raw"] = Object.fromEntries(
    Object.entries(value).filter(([, count]) => typeof count === "number" && Number.isFinite(count)),
  );
  const usage = normalize(raw);
  return usage && { type: "usage", ...usage, raw };
}

// Windows variable names are case-insensitive ("Path"), but a copied env object is not.
const envValue = (env: NodeJS.ProcessEnv, key: string) =>
  process.platform === "win32" ? env[key] ?? env[Object.keys(env).find((name) => name.toUpperCase() === key) ?? key] : env[key];

// Windows: only the extensions cross-spawn can run. The extensionless npm shim next to a .cmd is a sh script and must not match.
function fileNames(name: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [name];
  const runnable = [".com", ".exe", ".bat", ".cmd"];
  const exts = (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.toLowerCase());
  return exts.filter((ext) => runnable.includes(ext)).map((ext) => name + ext);
}

export function which(names: string[], env = process.env) {
  const dirs = (envValue(env, "PATH") || "").split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      for (const file of fileNames(name, env)) {
        const full = path.join(dir, file);
        try {
          const stat = fs.statSync(full);
          if (!stat.isFile()) continue;
          fs.accessSync(full, fs.constants.X_OK);
          return full;
        } catch {
          // Try the next PATH entry.
        }
      }
    }
  }
  return null;
}

export function authHit(text: string, phrases: string[]) {
  const hay = String(text || "").toLowerCase();
  return phrases.some((phrase) => hay.includes(phrase));
}

// cmd.exe cuts a .cmd/.bat argument at the first newline and has no safe escaping for these.
const CMD_UNSAFE = /[\r\n&|<>^%!"()]/;
const WIN_CMDLINE_MAX = 32767;

/** For CLIs that take the prompt in argv: refuse what Windows would truncate or reinterpret, instead of running a damaged prompt. */
export function assertArgvSafe(bin: string, args: string[], platform: NodeJS.Platform = process.platform, hint?: string) {
  if (platform !== "win32") return;
  const base = path.win32.basename(bin);
  if (/\.(cmd|bat)$/i.test(base) && args.some((arg) => CMD_UNSAFE.test(arg))) {
    throw new Error(`${base} is a .cmd/.bat shim: Windows runs it through cmd.exe, which cuts a multi-line prompt at the first newline and cannot safely pass & | < > ^ % ! " ( ).${hint ? ` ${hint}` : ""}`);
  }
  // shortcut: counts each argument plus quotes and a space, ignoring escape growth; exact enough to fail before CreateProcess does.
  const length = [bin, ...args].reduce((sum, arg) => sum + arg.length + 3, 0);
  if (length > WIN_CMDLINE_MAX) throw new Error(`The command line is ${length} characters; Windows allows at most ${WIN_CMDLINE_MAX}.`);
}
