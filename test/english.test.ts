import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Chinese manuals are the only allowed Han-script files. */
const ALLOW = new Set(["README.zh-CN.md", "docs/reference.zh-CN.md"]);
const HAN = /\p{Script=Han}/u;

test("tracked files are English-only (except zh-CN manuals)", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "buffer" })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);

  const hits: string[] = [];
  for (const rel of files) {
    if (ALLOW.has(rel)) continue;
    const full = path.join(root, rel);
    let text: string;
    try {
      const buf = fs.readFileSync(full);
      if (buf.includes(0)) continue; // skip binary
      text = buf.toString("utf8");
    } catch {
      continue;
    }
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (HAN.test(line)) hits.push(`${rel}:${index + 1}: ${line.trim().slice(0, 120)}`);
    }
  }

  assert.equal(hits.length, 0, `Chinese text found outside allowlisted manuals:\n${hits.join("\n")}`);
});
