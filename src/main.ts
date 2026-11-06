/**
 * opencode-puli — start here.
 *
 * WHAT HAPPENS (the whole system in one read):
 *
 *   1. The OpenCode fence (README) denies the git subcommands that
 *      change history: commit / push / merge / rebase / cherry-pick /
 *      revert / commit-tree / update-ref. The agent cannot run them.
 *
 *   2. Instead it calls one of the three tools registered below:
 *        commit_request  — stages, snapshots the diff     (commit.ts)
 *        push_request    — computes what a push would send (push.ts)
 *        git_request     — proposes any other fenced command (gitrequest.ts)
 *      Each parks a proposal in ~/.local/state/puli/pending/<id>.json
 *      (a queue — several sessions can wait at once), notifies the
 *      human, then WAITS (verdict.ts) for their verdict.
 *
 *   3. The human answers outside OpenCode — in the herdr Commits
 *      panel (herdr-app/mods/puli) or with the `puli` CLI (bin/puli).
 *      Either writes ~/.local/state/puli/verdict.json. No OpenCode
 *      permission prompts are used: non-interactive clients
 *      auto-approve them, so they would prove nothing.
 *
 *   4. On approve, the plugin runs the approved git command itself
 *      (plugin exec, not the agent's shell — the fence gates the
 *      agent, not the plugin) and appends to history.jsonl.
 *      On reject, the human's comments return to the agent as the
 *      tool result, with file:line references when they commented
 *      on diff lines.
 *
 * File map: commit.ts / push.ts / gitrequest.ts — the three tools;
 * verdict.ts — the shared wait loop and settle paths; git.ts — git
 * exec helpers; notify.ts — desktop notification; state.ts — the
 * on-disk contract (queue, verdict, history).
 */
import { Plugin } from "@opencode/plugin"
import { commitRequestTool } from "./commit.ts"
import { pushRequestTool } from "./push.ts"
import { gitRequestTool } from "./gitrequest.ts"

export default Plugin.define({
  id: "puli",
  async setup(ctx) {
    // Where this OpenCode instance runs; the default repo starting point.
    const sessionDir = ctx.location.directory

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "puli",
        description: "Puli: the git gate — every fenced git operation (commit, push, merge, rebase, cherry-pick, revert, plumbing) runs only after human approval",
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
      editor.add(gitRequestTool(sessionDir))
    })
  },
})
