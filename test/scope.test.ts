import test from "node:test";
import assert from "node:assert/strict";
import {
  applyScopePolicy,
  findScopeViolations,
  pathInScope,
  validateScopeGlob,
} from "../src/scope.ts";

test("pathInScope: src/auth/** matches nested file", () => {
  assert.equal(pathInScope("src/auth/x.ts", ["src/auth/**"]), true);
  assert.equal(pathInScope("src/other.ts", ["src/auth/**"]), false);
});

test("pathInScope: bare directory prefix when isDir says so", () => {
  const isDir = (p: string) => p === "src/auth";
  assert.equal(pathInScope("src/auth/x.ts", ["src/auth"], { isDir }), true);
  assert.equal(pathInScope("src/auth", ["src/auth"], { isDir }), true);
  assert.equal(pathInScope("src/other/x.ts", ["src/auth"], { isDir }), false);
});

test("pathInScope: exact path without wildcard", () => {
  assert.equal(pathInScope("src/auth.ts", ["src/auth.ts"]), true);
  assert.equal(pathInScope("src/auth.ts", ["src/other.ts"]), false);
});

test("pathInScope: **/* does not match dotdir without explicit segment", () => {
  assert.equal(pathInScope(".github/workflows/a.yml", ["**/*"]), false);
  assert.equal(pathInScope(".github/workflows/a.yml", ["**/.github/**"]), true);
});

test("validateScopeGlob rejects empty and negation", () => {
  assert.throws(() => validateScopeGlob(""), /empty/i);
  assert.throws(() => validateScopeGlob("!foo"), /!|negation/i);
  validateScopeGlob("src/**");
});

test("findScopeViolations: OR globs; ../ always violation", () => {
  const v = findScopeViolations(
    ["src/auth/a.ts", "src/other.ts", "../outside.txt"],
    ["src/auth/**"],
  );
  assert.deepEqual(v.sort(), ["../outside.txt", "src/other.ts"].sort());
});

test("findScopeViolations: all in scope → empty", () => {
  assert.deepEqual(findScopeViolations(["src/auth/a.ts"], ["src/auth/**"]), []);
});

test("applyScopePolicy: warn keeps success", () => {
  const r = applyScopePolicy({
    final: "success",
    policy: "warn",
    violations: ["leak.ts"],
    summary: "done",
  });
  assert.equal(r.status, "success");
  assert.equal(r.summary, "done");
  assert.match(r.warning!, /scope_violation/);
  assert.deepEqual(r.scope_violations, ["leak.ts"]);
});

test("applyScopePolicy: fail upgrades success", () => {
  const r = applyScopePolicy({
    final: "success",
    policy: "fail",
    violations: ["leak.ts"],
    summary: "done",
  });
  assert.equal(r.status, "scope_violation");
  assert.match(r.summary!, /^scope_violation: see scope_violations/);
  assert.match(r.summary!, /done/);
});

test("applyScopePolicy: fail does not override failed", () => {
  const r = applyScopePolicy({
    final: "failed",
    policy: "fail",
    violations: ["leak.ts"],
    summary: "boom",
  });
  assert.equal(r.status, "failed");
  assert.equal(r.summary, "boom");
  assert.deepEqual(r.scope_violations, ["leak.ts"]);
});
