import test from "node:test";
import assert from "node:assert/strict";
import { resolveCursorModelArg } from "../src/adapters/cursor.ts";
import { cursor } from "../src/adapters/cursor.ts";

test("resolveCursorModelArg: any effort → throw (cursor-agent rejects [effort=…])", () => {
  assert.throws(() => resolveCursorModelArg(null, "ultra"), /does not support --effort/);
  assert.throws(() => resolveCursorModelArg(undefined, "low"), /--list-models/);
  assert.throws(() => resolveCursorModelArg("claude-opus-4-8", "high"), /does not support --effort/);
});

test("resolveCursorModelArg: model only → bare id", () => {
  assert.equal(resolveCursorModelArg("grok-4.7-xhigh", null), "grok-4.7-xhigh");
  assert.equal(resolveCursorModelArg("  gpt-5.2  ", null), "gpt-5.2");
});

test("resolveCursorModelArg: neither → null", () => {
  assert.equal(resolveCursorModelArg(null, null), null);
});

test("cursor.build: model passed once; no model → no --model", () => {
  const onlyModel = cursor.build({
    bin: "c", cwd: "/w", prompt: "p", sessionId: null, reasoningEffort: null, model: "grok-4.7-xhigh",
  });
  assert.equal(onlyModel.args.filter((a) => a === "--model").length, 1);
  assert.ok(onlyModel.args.includes("grok-4.7-xhigh"));
  const none = cursor.build({ bin: "c", cwd: "/w", prompt: "p", sessionId: null, reasoningEffort: null, model: null });
  assert.equal(none.args.includes("--model"), false);
  assert.throws(() => cursor.build({ bin: "c", cwd: "/w", prompt: "p", sessionId: null, reasoningEffort: "low", model: null }), /--effort/);
});
