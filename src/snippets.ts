import fs from "node:fs";
import path from "node:path";

type LineRange = { start: number; end: number };
type FileArg = { path: string; range?: LineRange };
export type Excerpt = LineRange & { path: string; content: string };

const MAX_LINES = 400;
const MAX_BYTES = 64 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;
const SENSITIVE_PATHS = {
  filenames: [
    /^\.env(?:\..*)?$/s,
    /\.(?:pem|key|p12|pfx|jks|keystore)$/,
    /^id_(?:rsa|dsa|ecdsa|ed25519)/,
    /^(?:\.npmrc|\.netrc|\.pypirc|\.pgpass|\.git-credentials|credentials|credentials.*\.json)$/s,
  ],
  allowedFilenames: [".env.example", ".env.sample", ".env.template", ".env.dist"],
  directories: [".ssh", ".aws", ".gnupg"],
};

export function parseFileArg(arg: string, cwd: string): FileArg {
  const suffix = /:(\d+)(?:-(\d+))?$/.exec(arg);
  if (!suffix || fs.statSync(path.resolve(cwd, arg), { throwIfNoEntry: false })?.isFile()) {
    return { path: arg };
  }

  const file = arg.slice(0, suffix.index);
  const stat = file && fs.statSync(path.resolve(cwd, file), { throwIfNoEntry: false });
  if (!stat) throw new Error(`${arg}: file does not exist.`);
  if (!stat.isFile()) throw new Error(`${arg}: expected a regular file.`);
  const start = Number(suffix[1]);
  return { path: file, range: { start, end: Number(suffix[2] ?? suffix[1]) } };
}

function rejectSensitivePath(file: string, arg: string): void {
  const parts = file.toLowerCase().split(process.platform === "win32" ? /[\\/]/ : "/");
  const filename = parts.pop() ?? "";
  const sensitiveName = !SENSITIVE_PATHS.allowedFilenames.includes(filename)
    && SENSITIVE_PATHS.filenames.some((pattern) => pattern.test(filename));
  if (sensitiveName || parts.some((part) => SENSITIVE_PATHS.directories.includes(part))) {
    throw new Error(`${arg}: sensitive file. Name the location in the prompt and let the worker read it.`);
  }
}

export function loadExcerpts(cwd: string, args: readonly string[]): (Excerpt & { arg: string })[] {
  const ranged = args.flatMap((arg) => {
    const { path: file, range } = parseFileArg(arg, cwd);
    return range ? [{ arg, file, range }] : [];
  });
  if (ranged.length === 0) return [];

  const root = fs.realpathSync.native(cwd);
  const files = ranged.map(({ arg, file, range }) => {
    const displayPath = path.isAbsolute(file) ? path.relative(cwd, file) : file;
    rejectSensitivePath(displayPath, arg);
    const real = fs.realpathSync.native(path.resolve(cwd, file));
    const relative = path.relative(root, real);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`${arg}: file resolves outside the task cwd.`);
    }
    rejectSensitivePath(relative, arg);
    return { arg, displayPath, real, ...range };
  });

  let totalBytes = 0;
  return files.map(({ arg, displayPath, real, start, end }) => {
    const bytes = fs.readFileSync(real);
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
      throw new Error(`${arg}: binary file (NUL in the first 8 KB).`);
    }
    const lines = bytes.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (start < 1 || start > end || end > lines.length) {
      throw new Error(`${arg}: invalid line range ${start}-${end}; file has ${lines.length} lines.`);
    }
    if (end - start + 1 > MAX_LINES) throw new Error(`${arg}: excerpt exceeds ${MAX_LINES} lines.`);

    const content = lines.slice(start - 1, end).join("\n");
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > MAX_BYTES) throw new Error(`${arg}: combined excerpts exceed 64 KB.`);
    return { arg, path: displayPath, start, end, content };
  });
}

export function renderExcerpts(excerpts: readonly Excerpt[]): string {
  if (excerpts.length === 0) return "";
  const sections = excerpts.map(({ path: file, start, end, content }) => {
    let fenceLength = 3;
    for (const match of content.matchAll(/`+/g)) {
      fenceLength = Math.max(fenceLength, match[0].length + 1);
    }
    const fence = "`".repeat(fenceLength);
    return [`${file.replaceAll("\\", "/")}:${start}-${end}`, fence, content, fence].join("\n");
  });
  return ["Code excerpts (read by baton at task start; current content):", ...sections].join("\n\n");
}
