---
name: commit-gate
description: Use whenever the task involves committing, git commit, pushing, or versioning work — commits go through the puli gate.
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

The human reviews the diff in the herdr app's Changes panel and answers in a
terminal — `puli approve` or `puli reject -m "comment"` — and your tool call
returns when they do:

- approved → the result contains the new commit hash and the stat; carry on.
- rejected → the result contains the human's comments ("changes requested by
  user: …"). Address them and call `commit_request` again.
- timeout → the result says it timed out: tell the user the commit is still
  pending and ask them directly.

Never attempt workarounds: no `--no-verify`, no plumbing commands, no
committing via another tool or from another directory. If `commit_request`
is unavailable, say so to the user instead of improvising.
