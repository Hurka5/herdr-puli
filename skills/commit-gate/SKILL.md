---
name: commit-gate
description: Use whenever the task involves committing, git commit, pushing, or other fenced git commands (merge, rebase, cherry-pick, revert, plumbing) — they go through the puli gate.
---

`git commit` / `git push` (and merge / rebase / cherry-pick / revert / plumbing
like commit-tree, update-ref, `--no-verify`) are DENIED for you on this
machine. Do not fight it — that fence is the point.

To commit:

1. Stage your files with `git add` (that is allowed). Check with
   `git diff --cached --stat`.
2. Write the commit message (subject + body, the usual care).
3. Call the `commit_request` tool with `message` (and `files` if you want it
   to stage for you).

To push (`git push` is denied too): call the `push_request` tool (defaults:
current branch → origin). The human approves it in the Commits panel like a
commit; on approval the tool pushes and returns the pushed refs.

Every other denied command — `git merge`, `git rebase`, `git cherry-pick`,
`git revert`, plumbing like `commit-tree` / `update-ref` — goes through the
generic `git_request` tool: pass the arguments after `git`, e.g.
`git_request({ args: ["merge", "--no-ff", "feature"] })`. Approval runs
exactly that command; rejection returns the human's comments. For commit and
push keep using the dedicated `commit_request` / `push_request` tools — the
reviewer sees the full diff there; a `git_request` card shows only the
command line.

The human reviews the diff in the herdr app's Changes panel and answers in a
terminal — `puli approve` or `puli reject -m "comment"` — and your tool call
returns when they do:

- approved → the result contains the new commit hash and the stat; carry on.
- rejected → the result contains the human's comments ("changes requested by
  user: …"). Address them and call `commit_request` again.
- timeout → the result says it timed out: tell the user the commit is still
  pending and ask them directly.

Never attempt workarounds: no `--no-verify`, no committing or pushing via
another tool or from another directory. A fenced command's only path is this
gate (`commit_request` / `push_request` / `git_request`). If the tools are
unavailable, say so to the user instead of improvising.
