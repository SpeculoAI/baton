import test from "node:test";
import assert from "node:assert/strict";
import { resolveCursorModelArg } from "../src/adapters/cursor.ts";
import { cursor } from "../src/adapters/cursor.ts";

test("resolveCursorModelArg: effort only → auto[effort=…]", () => {
  assert.equal(resolveCursorModelArg(null, "ultra"), "auto[effort=ultra]");
  assert.equal(resolveCursorModelArg(undefined, "low"), "auto[effort=low]");
});

test("resolveCursorModelArg: model only → bare id", () => {
  assert.equal(resolveCursorModelArg("grok-4.7-xhigh", null), "grok-4.7-xhigh");
});

test("resolveCursorModelArg: model + effort → bracket form", () => {
  assert.equal(resolveCursorModelArg("claude-opus-4-8", "high"), "claude-opus-4-8[effort=high]");
});

test("resolveCursorModelArg: model with embedded tier + effort → throw", () => {
  assert.throws(() => resolveCursorModelArg("grok-4.7-xhigh", "high"), /tier|effort/i);
  assert.throws(() => resolveCursorModelArg("grok-4.7-high-fast", "low"), /tier|effort/i);
});

test("resolveCursorModelArg: model already bracketed + effort → throw", () => {
  assert.throws(() => resolveCursorModelArg("claude-opus-4-8[context=1m]", "high"), /bracket|effort/i);
});

test("resolveCursorModelArg: neither → null", () => {
  assert.equal(resolveCursorModelArg(null, null), null);
});

test("cursor.build: single --model, no duplicate", () => {
  const onlyEffort = cursor.build({
    bin: "c", cwd: "/w", prompt: "p", sessionId: null, reasoningEffort: "low", model: null,
  });
  assert.equal(onlyEffort.args.filter((a) => a === "--model").length, 1);
  assert.ok(onlyEffort.args.includes("auto[effort=low]"));

  const onlyModel = cursor.build({
    bin: "c", cwd: "/w", prompt: "p", sessionId: null, reasoningEffort: null, model: "grok-4.7-xhigh",
  });
  assert.equal(onlyModel.args.filter((a) => a === "--model").length, 1);
  assert.ok(onlyModel.args.includes("grok-4.7-xhigh"));
  assert.equal(onlyModel.args.includes("auto[effort=ultra]"), false);

  const both = cursor.build({
    bin: "c", cwd: "/w", prompt: "p", sessionId: "s1", reasoningEffort: "high", model: "claude-opus-4-8",
  });
  assert.equal(both.args.filter((a) => a === "--model").length, 1);
  assert.ok(both.args.includes("claude-opus-4-8[effort=high]"));
});
