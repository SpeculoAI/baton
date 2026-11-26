import fs from "node:fs";
import path from "node:path";

// Windows variable names are case-insensitive ("Path"), but a copied env object is not.
const envValue = (env: NodeJS.ProcessEnv, key: string) =>
  process.platform === "win32" ? env[Object.keys(env).find((name) => name.toUpperCase() === key) ?? key] : env[key];

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
