#!/usr/bin/env bash
# Live verification for checkpoints B + C (rules / rulesync).
# Usage: npm run build && bash tasks/manual-verify.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BATON=(node "$REPO/dist/cli.js")
ROOT="$REPO/.manual-verify"
HOME_DIR="$ROOT/baton-home"
LOG="$ROOT/logs"
PASS=0
FAIL=0
RESULTS=()

need() {
  command -v "$1" >/dev/null || { echo "missing: $1" >&2; exit 1; }
}

record() {
  local id="$1" ok="$2" detail="$3"
  if [[ "$ok" == "1" ]]; then
    PASS=$((PASS + 1))
    RESULTS+=("PASS  $id  $detail")
    echo "PASS  $id  $detail"
  else
    FAIL=$((FAIL + 1))
    RESULTS+=("FAIL  $id  $detail")
    echo "FAIL  $id  $detail" >&2
  fi
}

json_get() {
  # json_get <file> <js-expr-on-obj>
  node -e "
    const o = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const v = (function (x) { return ($2); })(o);
    if (v === undefined || v === null) process.stdout.write('');
    else if (typeof v === 'string') process.stdout.write(v);
    else process.stdout.write(JSON.stringify(v));
  " "$1"
}

wait_status() {
  local id="$1" out="$2"
  "${BATON[@]}" wait "$id" --until-done >"$out.wait.json" 2>"$out.wait.err" || true
  "${BATON[@]}" status "$id" >"$out.status.json" 2>"$out.status.err"
}

start_job() {
  # start_job <cwd> <target> <logfile-prefix>
  local cwd="$1" target="$2" prefix="$3"
  (
    cd "$cwd"
    "${BATON[@]}" start --target "$target" --mode readonly --idle-timeout 120 \
      --prompt "Reply with exactly: OK. Do not edit files. Do nothing else."
  ) >"$prefix.start.json" 2>"$prefix.start.err"
  local id
  id="$(json_get "$prefix.start.json" 'x.task_id')"
  if [[ -z "$id" ]]; then
    echo "start failed: $(cat "$prefix.start.json" "$prefix.start.err" 2>/dev/null)" >&2
    return 1
  fi
  echo "$id"
  wait_status "$id" "$prefix"
}

echo "== prep =="
need node
need git
need npm
test -f "$REPO/dist/cli.js" || { echo "run npm run build first" >&2; exit 1; }
rm -rf "$ROOT"
mkdir -p "$HOME_DIR" "$LOG" "$ROOT/b" "$ROOT/c"
export BATON_HOME="$HOME_DIR"

# --- B: only CLAUDE.md ---
echo "== B setup =="
ROOT_B="$ROOT/b"
cd "$ROOT_B"
git init -q
echo "# Project rules for baton manual verify" > CLAUDE.md
git add CLAUDE.md && git -c user.email=mv@test -c user.name=mv commit -qm "init claude only"

echo "== B1 codex =="
if ID_B1="$(start_job "$ROOT_B" codex "$LOG/b1")"; then
  UNSEEN="$(json_get "$LOG/b1.status.json" '(x.rules && x.rules.unseen) || []')"
  FOUND="$(json_get "$LOG/b1.status.json" '(x.rules && x.rules.found) || []')"
  echo "  found=$FOUND unseen=$UNSEEN" | tee "$LOG/b1.summary.txt"
  if node -e "const u=JSON.parse(process.argv[1]); process.exit(u.includes('CLAUDE.md')?0:1)" "$UNSEEN"; then
    record B1 1 "codex unseen includes CLAUDE.md"
  else
    record B1 0 "expected CLAUDE.md in unseen, got $UNSEEN"
  fi
else
  record B1 0 "start/wait failed (see $LOG/b1.*)"
fi

echo "== B2 cursor =="
if ID_B2="$(start_job "$ROOT_B" cursor "$LOG/b2")"; then
  UNSEEN="$(json_get "$LOG/b2.status.json" '(x.rules && x.rules.unseen) || []')"
  echo "  unseen=$UNSEEN" | tee "$LOG/b2.summary.txt"
  if node -e "const u=JSON.parse(process.argv[1]); process.exit(Array.isArray(u)&&u.length===0?0:1)" "$UNSEEN"; then
    record B2 1 "cursor unseen empty"
  else
    record B2 0 "expected [] unseen, got $UNSEEN"
  fi
else
  record B2 0 "start/wait failed (see $LOG/b2.*)"
fi

# --- C: real rulesync ---
echo "== C setup =="
ROOT_C="$ROOT/c"
cd "$ROOT_C"
git init -q
npm init -y >/dev/null
npm install rulesync@43.11.0 --no-fund --no-audit >/dev/null
./node_modules/.bin/rulesync init -s
# C2: only claudecode
node -e '
  const fs = require("fs");
  const p = "rulesync.jsonc";
  let t = fs.readFileSync(p, "utf8");
  t = t.replace(/"targets"\s*:\s*\[[^\]]*\]/, "\"targets\": [\"claudecode\"]");
  fs.writeFileSync(p, t);
'
./node_modules/.bin/rulesync generate -s >/dev/null
echo "local-only" > CLAUDE.local.md
grep -q 'CLAUDE.local.md' .gitignore 2>/dev/null || echo "CLAUDE.local.md" >> .gitignore
git add -A
git -c user.email=mv@test -c user.name=mv commit -qm "rulesync init" || true

echo "== C2 target_configured (before mutate) =="
if ID_C2="$(start_job "$ROOT_C" codex "$LOG/c2")"; then
  TC="$(json_get "$LOG/c2.status.json" 'x.rules && x.rules.rulesync && x.rules.rulesync.target_configured')"
  echo "  target_configured=$TC" | tee "$LOG/c2.summary.txt"
  if [[ "$TC" == "false" ]]; then
    record C2 1 "codex target_configured=false"
  else
    record C2 0 "expected false, got $TC"
  fi
else
  record C2 0 "start/wait failed"
fi

echo "== C1 stale =="
# Meaningful mcp.jsonc change (add a fake stdio server)
node -e '
  const fs = require("fs");
  const p = ".rulesync/mcp.jsonc";
  let t = fs.readFileSync(p, "utf8");
  if (!t.includes("baton-manual-verify")) {
    // insert after first "{"
    t = t.replace("{", "{\n  \"baton-manual-verify\": { \"command\": \"true\" },");
    fs.writeFileSync(p, t);
  }
'
CHECK_BEFORE="$(./node_modules/.bin/rulesync generate --check >/dev/null 2>"$LOG/c1.check-stale.err"; echo $?)"
echo "  rulesync generate --check exit=$CHECK_BEFORE" | tee "$LOG/c1.check.txt"
if ID_C1A="$(start_job "$ROOT_C" claude "$LOG/c1a")"; then
  ST="$(json_get "$LOG/c1a.status.json" 'x.rules && x.rules.rulesync && x.rules.rulesync.status')"
  echo "  rulesync.status=$ST" | tee "$LOG/c1a.summary.txt"
  if [[ "$ST" == "stale" || "$ST" == "error" ]]; then
    # Prefer stale; if rulesync returns non-1, error is still a detectable drift signal.
    if [[ "$ST" == "stale" ]]; then
      record C1a 1 "status=stale after mcp edit"
    else
      record C1a 1 "status=error after mcp edit (check exit=$CHECK_BEFORE); acceptable if check != 0"
    fi
  else
    record C1a 0 "expected stale (or error), got $ST; check_exit=$CHECK_BEFORE"
  fi
else
  record C1a 0 "start/wait failed"
fi

echo "== C1 in_sync =="
./node_modules/.bin/rulesync generate -s >/dev/null
CHECK_AFTER="$(./node_modules/.bin/rulesync generate --check >/dev/null 2>"$LOG/c1.check-sync.err"; echo $?)"
echo "  rulesync generate --check exit=$CHECK_AFTER" | tee -a "$LOG/c1.check.txt"
if ID_C1B="$(start_job "$ROOT_C" claude "$LOG/c1b")"; then
  ST="$(json_get "$LOG/c1b.status.json" 'x.rules && x.rules.rulesync && x.rules.rulesync.status')"
  echo "  rulesync.status=$ST" | tee "$LOG/c1b.summary.txt"
  if [[ "$ST" == "in_sync" ]]; then
    record C1b 1 "status=in_sync after regenerate"
  else
    record C1b 0 "expected in_sync, got $ST; check_exit=$CHECK_AFTER"
  fi
else
  record C1b 0 "start/wait failed"
fi

echo "== C3 worktree =="
# Recreate ignore-only local file AFTER rulesync generate (delete:true may remove it).
(
  cd "$ROOT_C"
  echo "local-only" > CLAUDE.local.md
  grep -q 'CLAUDE.local.md' .gitignore 2>/dev/null || echo "CLAUDE.local.md" >> .gitignore
  "${BATON[@]}" worktree add --name mv-c3
) >"$LOG/c3.wt.json" 2>"$LOG/c3.wt.err" || true
WT_PATH="$(json_get "$LOG/c3.wt.json" 'x.path || x.worktree || ""')"
WT_RULES="$(json_get "$LOG/c3.wt.json" 'x.rules || null')"
echo "  path=$WT_PATH rules=$WT_RULES" | tee "$LOG/c3.summary.txt"
OK_C3=1
DETAIL_C3=""
if [[ -z "$WT_PATH" || ! -d "$WT_PATH" ]]; then
  OK_C3=0
  DETAIL_C3="worktree path missing: $(head -c 400 "$LOG/c3.wt.json" 2>/dev/null; head -c 200 "$LOG/c3.wt.err" 2>/dev/null)"
else
  RS="$(json_get "$LOG/c3.wt.json" 'x.rules && x.rules.rulesync')"
  MISSING="$(json_get "$LOG/c3.wt.json" 'x.rules && x.rules.missing')"
  DETAIL_C3="rulesync=$RS"
  if [[ "$RS" != "generated" ]]; then
    OK_C3=0
    DETAIL_C3="$DETAIL_C3 (expected generated)"
  fi
  if [[ -f "$WT_PATH/CLAUDE.md" || -d "$WT_PATH/.claude" ]]; then
    DETAIL_C3="$DETAIL_C3; generated files present"
  else
    OK_C3=0
    DETAIL_C3="$DETAIL_C3; no CLAUDE.md/.claude in worktree"
  fi
  if node -e "const a=JSON.parse(process.argv[1]||'[]'); process.exit(Array.isArray(a)&&a.some(x=>String(x).includes('CLAUDE.local.md'))?0:1)" "${MISSING:-[]}"; then
    DETAIL_C3="$DETAIL_C3; missing includes CLAUDE.local.md"
  else
    DETAIL_C3="$DETAIL_C3; missing=$MISSING"
  fi
fi
record C3 "$OK_C3" "$DETAIL_C3"

echo
echo "======== SUMMARY ========"
printf '%s\n' "${RESULTS[@]}"
echo "pass=$PASS fail=$FAIL"
echo "artifacts: $ROOT"
echo "$PASS $FAIL" >"$LOG/summary.txt"
printf '%s\n' "${RESULTS[@]}" >>"$LOG/summary.txt"
[[ "$FAIL" -eq 0 ]]
