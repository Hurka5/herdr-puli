# herdr-puli

![puli](puli.png)

Commit gate for OpenCode agents, reviewed inside the Herdr app.
Agents cannot commit or push on their own — they propose commits, and you
approve, reject, or comment on them in the **Commits** panel.

## What it does

- `commit_request` tool for OpenCode agents: stages the files, snapshots
  the diff, and waits for your verdict (default 30 min, then it gives up
  and tells the agent).
- **Commits panel** in the Herdr app (the tab next to Files and Changes):
  a queue of proposals, each a card with the full commit message and the
  changed files. Click a file to expand its color-coded diff. Approve or
  Reject with a comment, directly on the card.
- History of settled proposals: approved (with hash), rejected (with your
  comment), timed out.
- `puli` CLI with the same powers from any terminal:
  `puli pending` · `puli show <id>` · `puli diff <id>` · `puli approve <id>` · `puli reject <id> -m "comment"`
- The plugin — and only the plugin — runs `git commit`, after your approval.

## How it works

State lives in `~/.local/state/puli`:

| file | what |
|---|---|
| `pending/<id>.json` | one file per proposed commit: message, files, diff snapshot |
| `verdict.json` | your answer (approve/reject + comment), consumed by the waiting plugin |
| `history.jsonl` | every settled proposal, one JSON line each |

The fence matters as much as the gate: without deny rules, agents can just
run `git commit` themselves. Both are part of this setup.

## Install

Needs: OpenCode v2, Bun, the Herdr app (for the panel).

```sh
git clone git@github.com:Hurka5/herdr-puli.git
cd herdr-puli
bun install
./install.sh
```

`install.sh` is idempotent. It symlinks the plugin, the panel mod, the
commit-gate skill, and the `puli` CLI, tries to register the plugin in
`~/.config/opencode/opencode.jsonc`, and adds the Commits button to the
Herdr tab bar if your tab-bar mod supports it. Anything it cannot do
safely itself, it prints exactly what to paste.

Then put the deny rules into `~/.config/opencode/opencode.jsonc` (the
installer prints this block too):

```jsonc
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
```

## Agent usage

Agents never run `git commit` (denied). They stage, write the message,
and call:

```
commit_request({ message, files?, repo?, timeoutMs? })
```

The installed commit-gate skill teaches every OpenCode session this flow.
On reject, the tool returns your comment; the agent fixes and re-proposes.

## Repo layout

| path | what |
|---|---|
| `src/` | OpenCode plugin (server part) |
| `bin/puli` | CLI |
| `herdr-app/mods/puli/` | the Commits panel mod |
| `skills/commit-gate/` | global OpenCode skill |
| `install.sh` | machine setup |

## Notes

- The answer file is `verdict.json`. On some machines a file named
  `decision.json` gets deleted by an external watcher within moments —
  do not rename it.
- Panel edits hot-reload. Under heavy load the Herdr app's watcher can
  lag for a minute; saving any mod file snaps it current.
- Serial-port tooling (`serial_*` tools) comes from the separate
  serial-broker project.
