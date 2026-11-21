import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Node runs TypeScript natively in development; the published package is dist/ and requires Node >= 20.17", () => {
  const value: number = 24;
  assert.ok(Number(process.versions.node.split(".")[0]) >= value);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "@speculoai/baton");
  assert.equal(pkg.engines.node, ">=20.17");
  assert.equal(pkg.bin.baton, "dist/cli.js");
  assert.deepEqual(pkg.files, ["dist"]);
  assert.equal(pkg.publishConfig.access, "public");
  assert.equal(pkg.scripts.typecheck, "tsc --noEmit");
});
