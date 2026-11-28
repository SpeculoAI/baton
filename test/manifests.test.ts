import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
const pkg = read("package.json");

/** [file, JSON path to the plugin entry] for every place that repeats version/description. */
const entries: Array<[string, (json: any) => any]> = [
  ["plugin.json", (j) => j],
  ["gemini-extension.json", (j) => j],
  [".claude-plugin/plugin.json", (j) => j],
  [".claude-plugin/marketplace.json", (j) => j.plugins.find((p: any) => p.name === "baton")],
  [".codex-plugin/plugin.json", (j) => j],
  [".cursor-plugin/plugin.json", (j) => j],
  [".agents/plugins/marketplace.json", (j) => j.plugins.find((p: any) => p.name === "baton")],
];

test("every manifest repeats package.json version and description", () => {
  const stale: string[] = [];
  for (const [file, pick] of entries) {
    const entry = pick(read(file));
    assert.ok(entry, `${file}: no baton entry`);
    if (entry.version !== pkg.version) stale.push(`${file}: version ${entry.version} != ${pkg.version}`);
    if (entry.description !== pkg.description) stale.push(`${file}: description differs from package.json`);
  }
  const market = read(".claude-plugin/marketplace.json");
  if (market.metadata?.version && market.metadata.version !== pkg.version) {
    stale.push(`.claude-plugin/marketplace.json: metadata.version ${market.metadata.version} != ${pkg.version}`);
  }
  assert.deepEqual(stale, [], `Stale manifests:\n${stale.join("\n")}`);
});

test("skills name the package.json version as the minimum baton CLI", () => {
  const stale: string[] = [];
  for (const name of fs.readdirSync(path.join(root, "skills"))) {
    const text = fs.readFileSync(path.join(root, "skills", name, "SKILL.md"), "utf8");
    for (const [, version] of text.matchAll(/baton \*\*(\d+\.\d+\.\d+)\*\* or newer/g)) {
      if (version !== pkg.version) stale.push(`skills/${name}/SKILL.md: ${version} != ${pkg.version}`);
    }
  }
  assert.deepEqual(stale, [], `Stale skill versions:\n${stale.join("\n")}`);
});
