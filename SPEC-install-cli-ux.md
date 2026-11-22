# Spec: Install / update / uninstall CLI UX

Tracks the confirmed intent in [docs/intent/install-cli-ux.md](docs/intent/install-cli-ux.md). Polish the human-facing TTY experience for `baton install|update|uninstall` with `@clack/prompts`. Do **not** change install semantics, host detection, or the machine-readable JSON contract on stdout.

## Objective

When a human runs these commands in a TTY, the flow should feel like a modern installer: short intro, clear steps, multi-select where needed, spinners while work runs, and ✓/✗ (or clack’s equivalent) per host / global step — without a full-screen TUI.

Scripts and agents that parse stdout JSON must keep working unchanged.

**User stories**

1. As a human, I run `npx @speculoai/baton install`, pick hosts with a multi-select (default: all detected), watch progress, and see a clean summary — without reading a JSON blob.
2. As a human, I run `baton update` / `baton uninstall` and get the same visual language (steps + results), even though there is no host picker.
3. As a script/agent, I still get one JSON object on stdout for the command result, including `--dry-run` and `--only`.

**Non-goals**

- Ink / bubbletea / any full-screen TUI
- Restyling unrelated commands (`start`, `tail`, `agents`, …)
- Changing which hosts are detected, which plugin commands run, or `installed.json` semantics
- Localizing the installer copy (keep English, matching current CLI strings)
- Guaranteeing pixel-perfect look under every exotic terminal; target common macOS/Linux TTYs

## Assumptions

1. **`@clack/prompts` (~1.9.x)** is an acceptable new runtime dependency; pin a caret range consistent with the rest of the package.
2. Clack’s default styling is enough — no custom theme package unless something is broken.
3. **Human UI → stderr; machine JSON → stdout** (already partially true for the picker prompt). Child host CLI noise may still stream to stderr as today.
4. **TTY gate:** pretty UI only when `process.stdin.isTTY` (and we are not in a mode that already skips the picker via `--only`). Non-TTY stays quiet on stderr aside from existing child output, then JSON on stdout.
5. **`--dry-run`:** print a clack-style plan summary on stderr when TTY, still return the same dry-run JSON on stdout; do not run side effects.
6. Canceling the multi-select (Ctrl+C / clack cancel) exits `0` with an empty/cancelled host list equivalent to today’s `q` quit — no partial install.
7. Existing unit tests that drive `runInstall` with injected `selectHosts` / `spawn` remain the source of truth for semantics; UI wiring is tested lightly (cancel / progress hooks), not by snapshotting ANSI art.
8. Spec and product docs stay English; Chinese manuals only under the existing allowlist. A short note in `docs/reference.md` (and zh-CN counterpart if that section is mirrored) is enough — no marketing rewrite.

→ Correct these before implementation if wrong.

## Tech Stack

- Node `>=20.17` (runtime) / existing Node test runner
- New dependency: `@clack/prompts` (current latest at write time: `1.9.0`)
- No new test framework; keep `node --test` + `tsc --noEmit`
- TypeScript ESM as today (`"type": "module"`)

## Commands

```
npm test                 # typecheck + tests
npm run build            # tsc → dist/
npm start -- install     # local CLI via src/cli.ts
npm start -- update
npm start -- uninstall
npm start -- install --dry-run
npm start -- install --only claude
```

Manual TTY smoke (maintainer machine):

```
npx @speculoai/baton install          # multi-select + progress + summary; JSON still on stdout
baton update                          # steps + summary, no picker
baton uninstall                       # same visual language
baton install --only claude           # no picker; still show progress/summary on TTY
baton install --dry-run               # plan on stderr, dry-run JSON on stdout
```

Pipe / non-TTY check:

```
baton install --only claude </dev/null
# expect: no clack chrome (or minimal), JSON on stdout, exit semantics unchanged
```

## Project Structure

Touched areas (implementation later; this section locks intent):

```
package.json              → add @clack/prompts
src/install.ts            → keep plan/run semantics; accept optional UI hooks or stay injectable
src/cli.ts                → wire TTY → clack (intro / multiselect / spinner / outro); JSON stdout unchanged
test/install.test.ts      → keep semantic tests; adjust if readLine contract changes; add thin UI-gate tests if needed
docs/intent/install-cli-ux.md
SPEC-install-cli-ux.md    → this spec (repo root)
docs/reference.md         → short UX note under installation
docs/reference.zh-CN.md   → mirror if that section exists
```

Prefer extracting a small `src/install-ui.ts` (or similar) if `cli.ts` / `install.ts` would otherwise mix prompt chrome with spawn logic. Do not invent a second install planner.

## Code Style

Match existing install/cli style: small functions, explicit types, no unnecessary abstractions, English user-facing strings.

Illustrative shape (not final API):

```ts
import * as p from "@clack/prompts";

if (tty) {
  p.intro("baton install");
  const selected = await p.multiselect({
    message: "Install plugin for which agents?",
    options: detected.map((h) => ({ value: h.id, label: h.label })),
    required: false,
  });
  if (p.isCancel(selected)) {
    p.cancel("Install cancelled.");
    // exit 0, empty hosts — same as today's "q"
  }
  const spin = p.spinner();
  spin.start("Installing…");
  // … runInstall with only: selected …
  spin.stop("Done");
  p.outro(/* short summary */);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
```

Keep `parseChoice` only if still used by tests or a non-clack fallback; otherwise replace the interactive path entirely with clack multiselect and update/remove `parseChoice` tests accordingly.

## Testing Strategy

| Level | What |
|---|---|
| Unit (`test/install.test.ts`) | Unchanged: `commandsFor`, `planInstall`, `runInstall` with fake `spawn` / home / env. Host command matrices stay authoritative. |
| Unit / thin integration | TTY vs non-TTY gating: when `tty: false` or `--only` set, no multiselect path; cancel path returns empty selection without spawning. Prefer injecting UI functions over spawning a real TTY. |
| Manual | Commands listed above on a real TTY. |

Coverage expectation: do not chase ANSI snapshot coverage. Prove semantics + that the pretty path is gated.

## Boundaries

- **Always:** Keep stdout JSON contract; keep install/update/uninstall semantics; run `npm test` before claiming done; update this spec if UX decisions change.
- **Ask first:** Adding dependencies beyond `@clack/prompts` (e.g. `picocolors`, custom themes); changing exit codes; removing JSON from stdout for humans; rewriting reference docs beyond a short note.
- **Never:** Full-screen TUI; change host plugin command sequences “while we’re here”; commit secrets; delete failing tests to greenwash.

## Success Criteria

1. TTY `install` without `--only` uses clack multiselect (default: all detected); cancel ≈ today’s quit.
2. TTY `install` / `update` / `uninstall` show consistent intro → progress → per-step or summary ✓/✗ → outro on **stderr**.
3. stdout remains a single JSON result object (including dry-run / failures), parseable as today.
4. Non-TTY and `--only` / scripted paths do not require interactive input; exit codes match current behavior.
5. `@clack/prompts` is listed in `package.json` dependencies; `npm test` and `npm run build` pass.
6. Intent + this spec are in-repo; reference docs mention the interactive UX briefly.

## Open Questions

None blocking — assumptions above are the defaults unless you correct them on approval.
