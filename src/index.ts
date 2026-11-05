/**
 * opencode-puli — server part.
 *
 * Two jobs:
 *
 *  1. Commit + push gate. The agent never runs `git commit` /
 *     `git push` (denied in opencode.jsonc — see README). Instead it
 *     calls the `commit_request` / `push_request` tools:
 *       - the plugin stages/collects the proposed commit (or computes
 *         what a push would send) and parks it as
 *         ~/.local/state/puli/pending/<id>.json — a QUEUE: several
 *         proposals (from different sessions) can wait at once
 *       - it opens the herdr app's Changes panel and sends a desktop
 *         notification (both best-effort)
 *       - the human answers OUTSIDE OpenCode, with the `puli` CLI
 *         (`puli approve` / `puli reject -m "..."`), which writes
 *         verdict.json — no ctx.permission, no ask (sessions driven
 *         by the weave adapter auto-approve those, so they prove
 *         nothing)
 *       - approved → the plugin runs `git commit` / `git push` itself
 *         (plugin exec is not the agent's shell tool, so the deny
 *         rules don't apply — they gate the agent, not us);
 *         rejected → the comment text goes back to the agent as the
 *         tool result
 *
 *  2. (nothing else — the tool bodies live in commit.ts / push.ts,
 *     shared plumbing in git.ts / notify.ts / verdict.ts / state.ts)
 */
import { Plugin } from "@opencode/plugin"
import { commitRequestTool } from "./commit.ts"
import { pushRequestTool } from "./push.ts"

export default Plugin.define({
  id: "puli",
  async setup(ctx) {
    // Where this OpenCode instance runs; the default repo starting point.
    const sessionDir = ctx.location.directory

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "puli",
        description: "Puli: the commit and push gate (human-approved git operations)",
      })

      editor.add({
        name: "ping",
        description: "Smoke test: is the puli plugin alive on this server?",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "puli" },
        execute: async () => ({
          content: JSON.stringify({
            alive: true,
            version: "0.0.1",
            at: new Date().toISOString(),
          }),
        }),
      })

      editor.add(commitRequestTool(sessionDir))
      editor.add(pushRequestTool(sessionDir))
    })
  },
})
