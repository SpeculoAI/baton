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

test("buildPrompt inserts the input contract before the output contract for every source tag", () => {
  const inputContract = `Facts in this prompt carry source tags.
- [read …], [ran …], [user] and the code excerpts are current: use them directly and do not search the repository again to re-confirm them.
- [mem …], [codegraph] and [guess] may be stale or wrong: verify them before relying on them.
- If what you see contradicts a fact, stop and ask with BATON_DECISION.`;
  for (const tag of ["[read src/a.ts:12]", "[ran npm test]", "[user]", "[mem Hindsight]", "[codegraph]", "[guess]"]) {
    const prompt = `Known facts\n${tag} The file exists.`;
    assert.equal(buildPrompt(prompt), `${prompt}\n\n${inputContract}\n\n${OUTPUT_CONTRACT}`, tag);
  }
});

test("buildPrompt preserves the previous bytes for untagged prompts, even with a tag in Focus", () => {
  assert.equal(buildPrompt("  hi [readme] [x]\n[read\ncontinued]  ", ["src/[user].ts"]), `Focus on these files:
- src/[user].ts

hi [readme] [x]
[read
continued]

Before finishing, end with one of the two endings below. Each marker must be on its own line.
If the user must make a choice, stop; do not guess and do not continue with later steps:
BATON_DECISION
question: <one question>
options: <option A> | <option B>
BATON_END

When done:
BATON_RESULT
summary: <what you did>
BATON_END

Do not call other agents.`);
});
