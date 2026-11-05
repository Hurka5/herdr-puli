#!/usr/bin/env bash
# herdr-puli installer — idempotent. Run from the repo root.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OC="$HOME/.config/opencode"
HA="$HOME/.config/herdr-app"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m ->\033[0m %s\n' "$*"; }

command -v bun  >/dev/null || { echo "bun is required (https://bun.sh)"; exit 1; }
command -v git  >/dev/null || { echo "git is required"; exit 1; }

# 1. CLI
mkdir -p "$HOME/.local/bin"
ln -sfn "$REPO/bin/puli" "$HOME/.local/bin/puli"
say "CLI: ~/.local/bin/puli -> $REPO/bin/puli"

# 2. OpenCode plugin registration (prefer the config array; keep auto-scan out of it
#    so the plugin can never load twice).
mkdir -p "$OC"
rm -f "$OC/plugins/puli"   # remove any auto-scan symlink from older installs
CFG="$OC/opencode.jsonc"; [ -f "$CFG" ] || CFG="$OC/opencode.json"
if [ ! -f "$CFG" ]; then
  printf '{\n  "plugins": ["%s"]\n}\n' "$REPO" > "$CFG"
  say "created $CFG with the plugin entry"
elif grep -q '"plugins"' "$CFG"; then
  if grep -q "\"$REPO\"" "$CFG"; then
    say "plugin already registered in $(basename "$CFG")"
  else
    warn "your $(basename "$CFG") already has a \"plugins\" key — add this path to it:"
    warn "  \"$REPO\""
  fi
else
  # insert a plugins array right after the opening brace (text-only, keeps comments)
  python3 - "$CFG" "$REPO" <<'PY'
import re, sys
path, repo = sys.argv[1], sys.argv[2]
text = open(path).read()
i = text.index("{")
text = text[:i+1] + '\n  "plugins": ["%s"],' % repo + text[i+1:]
open(path, "w").write(text)
PY
  say "added the plugin entry to $(basename "$CFG")"
fi

# 3. commit-gate skill
mkdir -p "$OC/skills"
ln -sfn "$REPO/skills/commit-gate" "$OC/skills/commit-gate"
say "skill: $OC/skills/commit-gate"

# 4. Herdr app panel mod
if [ -d "$HA" ]; then
  mkdir -p "$HA/mods"
  ln -sfn "$REPO/herdr-app/mods/puli" "$HA/mods/puli"
  say "panel mod: $HA/mods/puli"
  herdr-app check "$HA/mods/puli" >/dev/null 2>&1 || warn "herdr-app check failed for the puli mod — is the app installed?"
else
  warn "Herdr app not found (~/.config/herdr-app) — panel skipped; CLI and gate still work."
fi

# 5. Commits button in the Herdr tab bar (only if a personal tabs mod exists)
if [ -f "$HA/mods/tabs-sm/main.js" ] && grep -q 'panelButton("puli"' "$HA/mods/tabs-sm/main.js"; then
  say "tab-bar button already present"
elif [ -f "$HA/mods/tabs-sm/main.js" ]; then
  python3 - "$HA/mods/tabs-sm/main.js" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
if 'panelButton("puli"' in t:
    sys.exit(0)
t = t.replace(
  'const enabled = shared("workspace.panels") ?? ["files", "changes"];',
  'const enabled = [...new Set([...(shared("workspace.panels") ?? ["files", "changes"]), "puli"])];')
t = t.replace(
  '.when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))',
  '.when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))\n'
  '      .when(enabled.includes("puli"), el => el.child(panelButton("puli", "Commits", "mods/tabs-sm/puli.svg")))')
open(p, "w").write(t)
PY
  cp "$REPO/herdr-app/puli.svg" "$HA/mods/tabs-sm/puli.svg" 2>/dev/null || true
  say "added the Commits button to your tab bar (tabs-sm)"
else
  warn "no personal tabs mod found — the panel is reachable, but no Commits button was added."
fi

# 6. The fence
cat <<'EOF'

Done. Last step — make sure these deny rules are in ~/.config/opencode/opencode.jsonc
(without them, agents can commit around the gate):

  "permissions": [
    { "action": "shell", "resource": "git commit*",      "effect": "deny" },
    { "action": "shell", "resource": "git * commit*",    "effect": "deny" },
    { "action": "shell", "resource": "git push*",        "effect": "deny" },
    { "action": "shell", "resource": "git * push*",      "effect": "deny" },
    { "action": "shell", "resource": "*--no-verify*",    "effect": "deny" },
    { "action": "shell", "resource": "git merge*",       "effect": "deny" },
    { "action": "shell", "resource": "git rebase*",      "effect": "deny" },
    { "action": "shell", "resource": "git cherry-pick*", "effect": "deny" },
    { "action": "shell", "resource": "git revert*",      "effect": "deny" },
    { "action": "shell", "resource": "git commit-tree*", "effect": "deny" },
    { "action": "shell", "resource": "git update-ref*",  "effect": "deny" }
  ]

Then restart OpenCode (or touch its config) and test: ask any agent to
commit something, and answer it with `puli approve` or in the Commits panel.
EOF
