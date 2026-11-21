import test from "node:test";
import assert from "node:assert/strict";
import { interpret, buildPrompt, OUTPUT_CONTRACT } from "../src/contract.ts";
test("interpret reads the last decision or result block", () => {
  const legacy = interpret("noise\nAPA_DECISION\nquestion: Use Redis?\noptions: Redis | Memory\nAPA_END\n");
  assert.deepEqual(legacy, { kind: "decision", question: "Use Redis?", options: ["Redis", "Memory"] });
  const decision = interpret("noise\nBATON_DECISION\nquestion: Use Redis?\noptions: Redis | Memory\nBATON_END\n");
  assert.deepEqual(decision, { kind: "decision", question: "Use Redis?", options: ["Redis", "Memory"] });
  const result = interpret("BATON_RESULT\nsummary: Changed auth.ts\nBATON_END");
  assert.ok(result && result.kind === "result");
  assert.equal(result.summary, "Changed auth.ts");
  assert.deepEqual(interpret("APA_RESULT\nsummary: legacy marker\nAPA_END"), { kind: "result", summary: "legacy marker" });
  assert.equal(interpret("no marker"), null);
});


test("buildPrompt keeps files and output contract", () => {
  assert.equal(buildPrompt(" hi "), `hi\n\n${OUTPUT_CONTRACT}`);
  assert.match(buildPrompt(" hi ", ["src/a.ts"]), /Focus on these files:\n- src\/a.ts\n\nhi/);
});
