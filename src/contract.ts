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

export function buildPrompt(prompt: unknown, files?: string[]) {
  const focus = files?.length
    ? `Focus on these files:\n${files.map((file) => `- ${file}`).join("\n")}\n\n`
    : "";
  return `${focus}${String(prompt).trim()}\n\n${OUTPUT_CONTRACT}`;
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

