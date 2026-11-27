export const OUTPUT_CONTRACT = [
  "Before finishing, end with one of the two endings below. Each marker must be on its own line.",
  "If the user must make a choice, stop; do not guess and do not continue with later steps:",
  "BATON_DECISION",
  "question: <one question>",
  "options: <option A> | <option B>",
  "BATON_END",
  "",
  "When done:",
  "BATON_RESULT",
  "summary: <what you did>",
  "BATON_END",
  "",
  "Do not call other agents.",
].join("\n");

const SOURCE_TAG = /\[(read|ran|user|mem|codegraph|guess)\b[^\]\n]*\]/;
const INPUT_CONTRACT = [
  "Facts in this prompt carry source tags.",
  "- [read …], [ran …], [user] and the code excerpts are current: use them directly and do not search the repository again to re-confirm them.",
  "- [mem …], [codegraph] and [guess] may be stale or wrong: verify them before relying on them.",
  "- If what you see contradicts a fact, stop and ask with BATON_DECISION.",
].join("\n");

export function buildPrompt(prompt: unknown, files?: string[]) {
  const focus = files?.length
    ? `Focus on these files:\n${files.map((file) => `- ${file}`).join("\n")}\n\n`
    : "";
  const body = String(prompt).trim();
  // Excerpts are appended to the prompt before this check, so their source tags count too.
  const input = SOURCE_TAG.test(body) ? `${INPUT_CONTRACT}\n\n` : "";
  return `${focus}${body}\n\n${input}${OUTPUT_CONTRACT}`;
}

export function interpret(text: string | null | undefined): { kind: "decision"; question: string; options: string[] } | { kind: "result"; summary: string } | null {
  if (!text) return null;
  const re = /(?:APA|BATON)_(DECISION|RESULT)\r?\n([\s\S]*?)\r?\n(?:APA|BATON)_END/g;
  let last = null;
  for (const match of text.matchAll(re)) last = match;
  if (!last) return null;
  const body = last[2];
  if (last[1] === "DECISION") {
    const question = body.match(/^question:\s*(.*)$/m)?.[1]?.trim() || "";
    const options = (body.match(/^options:\s*(.*)$/m)?.[1] || "")
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean);
    return { kind: "decision", question, options };
  }
  const summary = body.replace(/^summary:\s*/m, "").trim();
  return { kind: "result", summary };
}

