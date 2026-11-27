import test from "node:test";
import assert from "node:assert/strict";
import { shellIntent } from "../src/adapters/common.ts";
import { summarizeEvents, turnUsage } from "../src/metrics.ts";
import type { Adapter, BatonEvent, EventData, TurnUsage } from "../src/types.ts";

test("shellIntent 类别和优先级", () => {
  const cases = [
    ["/bin/zsh -lc 'git status --short && ls src'", "explore"],
    ['bash -lc "rg buildPrompt src || cat src/contract.ts"', "explore"],
    ["sh -c 'npm test'", "verify"],
    ["git log; git diff\nhead README.md", "explore"],
    ["cat src/contract.ts | rg buildPrompt", "explore"],
    ["rg 'read|write;edit' src", "explore"],
    ["rg buildPrompt src && node --test test/metrics.test.ts", "verify"],
    ["cd /tmp && go test ./...", "verify"],
    ["cat <<'EOF'\nnpm test\nEOF", "explore"],
    ["cat <<-EOF\n\tnpm test\n\tEOF\npnpm test", "verify"],
    ["cat <<EOF > out\ntext\nEOF\nmv out result", undefined],
    ["ls src && git add src/contract.ts", undefined],
    ["git add . && npm test", "verify"],
    ["sed -n '1,5p' src/contract.ts", "explore"],
    ["sed -i '' 's/a/b/' src/contract.ts", undefined],
    ["node script.js", undefined],
    ["go build ./...", undefined],
    ["npm-extra test", undefined],
    ["", undefined],
    [" \n ", undefined],
  ] as const;
  for (const [command, expected] of cases) assert.equal(shellIntent(command), expected, command);
});

function tool(kind?: Extract<EventData, { type: "tool_call" }>["kind"],
              intent?: Extract<EventData, { type: "tool_call" }>["intent"]): EventData {
  return { type: "tool_call", name: "tool", detail: "", kind, intent };
}

test("summarizeEvents 统计所有工具调用及首次编辑位置", () => {
  const events: EventData[] = [
    { type: "message", text: "开始" },
    tool("read"), tool("search"), tool("shell", "explore"), tool("shell", "verify"),
    tool("shell"), tool("other", "verify"), tool(), tool("edit"), tool("edit"),
    { type: "tool_result", name: "tool", detail: "", ok: true },
  ];
  assert.deepEqual(summarizeEvents(events), {
    activity: {
      tool_calls: 9,
      by_kind: { read: 1, search: 1, edit: 2, shell: 3, other: 2 },
      explore: 3, verify: 1, before_first_edit: 7,
    },
  });
  assert.equal(summarizeEvents([tool("edit"), tool("read")]).activity.before_first_edit, 0);
  assert.equal(summarizeEvents([tool("read")]).activity.before_first_edit, null);
  assert.equal(summarizeEvents([]).activity.tool_calls, 0);
});

test("summarizeEvents 取最后一个 usage 并去除事件元数据", () => {
  const first: TurnUsage = { input: 10, cached_input: 1, output: 2, reasoning: 1, raw: { input_tokens: 10 } };
  const last: TurnUsage = { input: 15, cached_input: 3, output: 4, raw: { input_tokens: 15 } };
  const events: BatonEvent[] = [
    { type: "usage", ts: "", turn: 2, ...first },
    { type: "usage", ts: "", turn: 2, ...last },
  ];
  assert.deepEqual(summarizeEvents(events).usage, last);
});

const raw = { received: 45, cached: 25, sent: 12, thoughts: 2 };
const current: TurnUsage = { input: 45, cached_input: 25, output: 12, reasoning: 2, raw };
const previous = { received: 30, cached: 18, sent: 10, thoughts: 2 };
const cumulative: Pick<Adapter, "usageCumulative" | "usage"> = {
  usageCumulative: true,
  usage(raw) {
    const { received: input, cached: cached_input, sent: output, thoughts: reasoning } = raw;
    if (![input, cached_input, output].every(Number.isFinite)) return undefined;
    return { input, cached_input, output, reasoning };
  },
};

test("turnUsage 使用 adapter 的归一方法并保留当前原始快照", () => {
  assert.deepEqual(turnUsage(cumulative, current, previous), {
    input: 15, cached_input: 7, output: 2, reasoning: 0, raw,
  });
});

test("turnUsage 区分新会话、续轮缺基线、本轮值和无 usage", () => {
  assert.equal(turnUsage(cumulative, current, null), current);
  assert.equal(turnUsage(cumulative, current, undefined), undefined);
  assert.equal(turnUsage(cumulative, current, {}), undefined);
  assert.equal(turnUsage({}, current, previous), current);
  assert.equal(turnUsage({}, current, undefined), current);
  assert.equal(turnUsage({}, undefined, null), undefined);
  assert.equal(turnUsage(cumulative, undefined, previous), undefined);
});

test("turnUsage 处理必填计数回退和 reasoning 缺值或回退", () => {
  for (const field of ["received", "cached", "sent"] as const) {
    assert.equal(turnUsage(cumulative, current, { ...previous, [field]: raw[field] + 1 }), undefined, field);
  }
  const { thoughts: _, ...previousWithoutReasoning } = previous;
  const withoutReasoning = { input: 45, cached_input: 25, output: 12, raw: { received: 45, cached: 25, sent: 12 } };
  const expected = { input: 15, cached_input: 7, output: 2, raw };
  assert.deepEqual(turnUsage(cumulative, current, previousWithoutReasoning), expected);
  assert.deepEqual(turnUsage(cumulative, withoutReasoning, previous), { ...expected, raw: withoutReasoning.raw });
  assert.deepEqual(turnUsage(cumulative, current, { ...previous, thoughts: 3 }), expected);
});
