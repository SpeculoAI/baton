import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadExcerpts, parseFileArg, renderExcerpts } from "../src/snippets.ts";
import { sandbox } from "./helpers.ts";

test("parseFileArg distinguishes Focus paths, single lines, and ranges", (t) => {
  const { cwd } = sandbox(t);
  fs.writeFileSync(path.join(cwd, "code.ts"), "first\nsecond\nthird\n");
  assert.deepEqual(parseFileArg("./code.ts", cwd), { path: "./code.ts" });
  assert.deepEqual(parseFileArg("later.ts", cwd), { path: "later.ts" });
  assert.deepEqual(parseFileArg("code.ts:2", cwd), { path: "code.ts", range: { start: 2, end: 2 } });
  assert.deepEqual(parseFileArg("code.ts:2-3", cwd), { path: "code.ts", range: { start: 2, end: 3 } });
  assert.throws(() => parseFileArg("missing.ts:1", cwd), /missing\.ts/);
});

test("parseFileArg preserves a Windows drive colon when splitting a range", (t) => {
  const { cwd } = sandbox(t);
  const file = path.win32.join(process.platform === "win32" ? cwd : "C:\\", "code.ts");
  fs.writeFileSync(path.resolve(cwd, file), "example\n");
  assert.deepEqual(parseFileArg(`${file}:10-20`, cwd), { path: file, range: { start: 10, end: 20 } });
});

test("parseFileArg prefers a literal filename containing a colon", (t) => {
  if (process.platform === "win32") return t.skip("Windows filenames reserve colons");
  const { cwd } = sandbox(t);
  for (const file of ["a:1.txt", "a:1", "a"]) fs.writeFileSync(path.join(cwd, file), "example\n");
  assert.deepEqual(parseFileArg("a:1.txt", cwd), { path: "a:1.txt" });
  assert.deepEqual(parseFileArg("a:1", cwd), { path: "a:1" });
  assert.deepEqual(parseFileArg("a:1.txt:1", cwd), { path: "a:1.txt", range: { start: 1, end: 1 } });
});

test("loadExcerpts preserves CRLF content and ignores Focus paths", (t) => {
  const { cwd } = sandbox(t);
  fs.writeFileSync(path.join(cwd, "code.ts"), "one\r\ntwo\r\n\n");
  assert.deepEqual(loadExcerpts(cwd, ["later.ts", "./code.ts:2-3"]), [
    { arg: "./code.ts:2-3", path: "./code.ts", start: 2, end: 3, content: "two\r\n" },
  ]);
});

test("loadExcerpts displays absolute file arguments relative to cwd", (t) => {
  const { cwd } = sandbox(t);
  const file = path.join(cwd, "code.ts");
  fs.writeFileSync(file, "one\n");
  assert.equal(loadExcerpts(cwd, [`${file}:1`])[0].path, "code.ts");
});

test("loadExcerpts ignores sensitive directory names above cwd", (t) => {
  const { cwd } = sandbox(t);
  const nestedCwd = path.join(cwd, ".aws", "repo");
  fs.mkdirSync(path.join(nestedCwd, "src"), { recursive: true });
  const file = path.join(nestedCwd, "src", "a.ts");
  fs.writeFileSync(file, "safe\n");
  assert.equal(loadExcerpts(nestedCwd, ["src/a.ts:1"])[0].content, "safe");
  assert.equal(loadExcerpts(nestedCwd, [`${file}:1`])[0].content, "safe");
});

test("line range errors include the actual line count", (t) => {
  const { cwd } = sandbox(t);
  fs.writeFileSync(path.join(cwd, "code.ts"), "first\nsecond\n");
  fs.writeFileSync(path.join(cwd, "empty.ts"), "");
  for (const range of ["2-1", "0", "1-0", "3", "2-3"]) {
    assert.throws(() => loadExcerpts(cwd, [`code.ts:${range}`]), /code\.ts.*2 lines/, range);
  }
  assert.throws(() => loadExcerpts(cwd, ["empty.ts:1"]), /empty\.ts.*0 lines/);
});

test("loadExcerpts caps each excerpt at 400 lines", (t) => {
  const { cwd } = sandbox(t);
  const contents = Array<string>(400).fill("line").join("\n");
  fs.writeFileSync(path.join(cwd, "long.ts"), `${contents}\nextra\n`);
  assert.equal(loadExcerpts(cwd, ["long.ts:1-400"])[0].content, contents);
  assert.throws(() => loadExcerpts(cwd, ["long.ts:1-401"]), /long\.ts.*400 lines/);
});

test("loadExcerpts caps combined UTF-8 bytes at 64 KB", (t) => {
  const { cwd } = sandbox(t);
  const contents = "é".repeat(16_384);
  fs.writeFileSync(path.join(cwd, "a.ts"), contents);
  fs.writeFileSync(path.join(cwd, "b.ts"), `${contents}\nx`);
  assert.equal(loadExcerpts(cwd, ["a.ts:1", "b.ts:1"]).length, 2);
  assert.throws(() => loadExcerpts(cwd, ["a.ts:1", "b.ts:1-2"]), /b\.ts.*64 KB/);
});

test("loadExcerpts checks the first 8 KB for binary NUL bytes", (t) => {
  const { cwd } = sandbox(t);
  const prefix = "é".repeat(4095);
  fs.writeFileSync(path.join(cwd, "binary.dat"), `${prefix}x\0\ntext`);
  fs.writeFileSync(path.join(cwd, "text.dat"), `${prefix}xx\0\ntext`);
  assert.throws(() => loadExcerpts(cwd, ["binary.dat:2"]), /binary\.dat.*binary/);
  assert.equal(loadExcerpts(cwd, ["text.dat:2"])[0].content, "text");
});

test("loadExcerpts rejects directories and paths escaping cwd", (t) => {
  const { cwd } = sandbox(t);
  fs.mkdirSync(path.join(cwd, "dir"));
  fs.mkdirSync(`${cwd}-other`);
  fs.writeFileSync(path.join(`${cwd}-other`, "outside.ts"), "outside\n");
  assert.throws(() => loadExcerpts(cwd, ["dir:1"]), /dir.*regular file/);
  assert.throws(() => loadExcerpts(cwd, ["../work-other/outside.ts:1"]), /outside\.ts.*outside/);
});

test("loadExcerpts checks both symlink names and their real targets", (t) => {
  if (process.platform === "win32") return t.skip("POSIX symlink fixtures");
  const { cwd, home } = sandbox(t);
  fs.writeFileSync(path.join(home, "outside.ts"), "outside\n");
  fs.writeFileSync(path.join(cwd, ".env"), "secret\n");
  fs.writeFileSync(path.join(cwd, "safe.txt"), "safe\n");
  fs.symlinkSync("../outside.ts", path.join(cwd, "outside-link.ts"));
  fs.symlinkSync(".env", path.join(cwd, "notes.txt"));
  fs.symlinkSync("safe.txt", path.join(cwd, ".NETRC"));
  fs.symlinkSync("safe.txt", path.join(cwd, "alias.txt"));
  assert.throws(() => loadExcerpts(cwd, ["outside-link.ts:1"]), /outside-link\.ts.*outside/);
  assert.throws(() => loadExcerpts(cwd, ["notes.txt:1"]), /notes\.txt.*Name the location in the prompt and let the worker read it/);
  assert.throws(() => loadExcerpts(cwd, [".NETRC:1"]), /\.NETRC.*Name the location in the prompt and let the worker read it/);
  assert.equal(loadExcerpts(cwd, ["alias.txt:1"])[0].content, "safe");
});

test("loadExcerpts blocks each sensitive name and directory case-insensitively", (t) => {
  const { cwd } = sandbox(t);
  const blocked = [
    ".env", ".env.local", "cert.pem", "private.key", "cert.p12", "cert.pfx", "store.jks", "store.keystore",
    "id_rsa.pub", "id_dsa", "id_ecdsa_backup", "id_ed25519", ".npmrc", ".netrc", ".pypirc", ".pgpass",
    ".git-credentials", "credentials", "credentials.json", "credentials-test.json",
    "repo/.ssh/config", ".aws/config", ".gnupg/config", ".env.example.local",
  ];
  for (const name of blocked.map((name) => name.toUpperCase())) {
    const file = path.join(cwd, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "blocked\n");
    assert.throws(() => loadExcerpts(cwd, [`${name}:1`]), /Name the location in the prompt and let the worker read it/, name);
  }
});

test("loadExcerpts accepts the four env templates case-insensitively", (t) => {
  const { cwd } = sandbox(t);
  for (const name of [".env.example", ".env.sample", ".ENV.TEMPLATE", ".ENV.DIST"]) {
    fs.writeFileSync(path.join(cwd, name), "TOKEN=example\n");
    assert.equal(loadExcerpts(cwd, [`${name}:1`])[0].content, "TOKEN=example");
  }
});

test("loadExcerpts checks all paths for sensitive names before reading content", (t) => {
  const { cwd } = sandbox(t);
  fs.writeFileSync(path.join(cwd, "binary.dat"), "\0");
  fs.writeFileSync(path.join(cwd, ".env"), "secret\n");
  assert.throws(() => loadExcerpts(cwd, ["binary.dat:1", ".env:1"]), /Name the location in the prompt and let the worker read it/);
});

test("renderExcerpts preserves titles and uses a longer fence for embedded backticks", () => {
  assert.equal(renderExcerpts([]), "");
  assert.equal(renderExcerpts([
    { path: ".\\src\\sample.ts", start: 10, end: 11, content: "a```b\r\n" },
    { path: "other.ts", start: 2, end: 2, content: "last" },
  ]), [
    "Code excerpts (read by baton at task start; current content):",
    "",
    "./src/sample.ts:10-11",
    "````",
    "a```b\r",
    "",
    "````",
    "",
    "other.ts:2-2",
    "```",
    "last",
    "```",
  ].join("\n"));
});
