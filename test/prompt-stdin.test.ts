import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox } from "./helpers.ts";

// Everything cmd.exe or a shell treats specially, plus newlines, which a .cmd shim cuts off when the prompt travels in argv.
const PROMPT = "first line\nsecond & | > < ^ \" % ! ( ) line\n  indented 'single' `tick` $HOME\nlast line";

const decoders: [string, (raw: string) => string][] = [
  ["codex", (raw) => raw],
  ["claude", (raw) => raw],
  ["cursor", (raw) => raw],
  ["agy", (raw) => JSON.parse(raw).message.content],
];

for (const [target, decode] of decoders) {
  test(`${target}: the prompt reaches the worker through stdin byte for byte, never through argv`, async (t) => {
    const s = sandbox(t);
    s.env.FAKE_INPUT_FILE = path.join(s.home, "input.txt");
    s.env.FAKE_ARGS_FILE = path.join(s.home, "args.txt");
    const started = await s.run("start", "--target", target, "--prompt", PROMPT);
    await s.until(started.task_id);
    // Baton appends its result-marker contract after the user's text; the text itself must be untouched.
    assert.ok(decode(fs.readFileSync(s.env.FAKE_INPUT_FILE, "utf8")).startsWith(`${PROMPT}\n\n`), "prompt changed on the way");
    assert.ok(!fs.readFileSync(s.env.FAKE_ARGS_FILE, "utf8").includes("first line"), "prompt leaked into argv");
  });
}
