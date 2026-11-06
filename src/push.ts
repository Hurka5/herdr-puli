/** The `push_request` tool: propose a push, wait for the human's verdict. */
import type { Info } from "@opencode/plugin/promise/tool"
import {
  appendHistory,
  firstLine,
  newProposalId,
  removeProposal,
  writeProposal,
  type Proposal,
} from "./state.ts"
import { git, gitAll, resolveRepoRoot } from "./git.ts"
import { desktopNotify } from "./notify.ts"
import { awaitVerdict, decisionTimeoutMs, settleNotApproved } from "./verdict.ts"

/** "behind\tahead" from `rev-list --left-right --count` → [behind, ahead]. */
function parseLeftRight(out: string): [number, number] {
  const [l = "0", r = "0"] = out.trim().split(/\s+/)
  return [parseInt(l, 10) || 0, parseInt(r, 10) || 0]
}

export function pushRequestTool(sessionDir: string): Info {
  return {
    name: "push_request",
    description:
      "Propose a git push for human review (git push is denied to you). " +
      "Computes what WOULD be pushed (ahead/behind vs the branch's upstream, " +
      "or a new remote branch — nothing is sent yet), records the proposal in the " +
      "review queue (it may not be the only one waiting), then WAITS (up to 30 min) " +
      "for the human to answer `puli approve` / `puli reject` in a terminal. " +
      "Approved → the plugin pushes and returns the pushed refs; " +
      "rejected → returns the human's comments.",
    input: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description:
            "Directory to resolve the git repo from (defaults to this session's directory).",
        },
        remote: {
          type: "string",
          description: 'Remote to push to (default "origin").',
        },
        branch: {
          type: "string",
          description: "Branch to push (default: the current branch).",
        },
        timeoutMs: {
          type: "number",
          description:
            "How long to wait for the human verdict, in milliseconds (default 30 min, min 10 s). " +
            "Use a short value (e.g. 120000) for tests so the call cannot strand a session.",
        },
      },
      additionalProperties: false,
    },
    options: { namespace: "puli", codemode: true },
    execute: async (raw, context) => {
      const input = raw as { repo?: string; remote?: string; branch?: string; timeoutMs?: number }

      // 1. Resolve the repo root (git walks up from the directory itself).
      const repo = await resolveRepoRoot(input.repo?.trim() || sessionDir)

      const remote = (input.remote ?? "").trim() || "origin"
      try {
        await git(repo, ["remote", "get-url", remote])
      } catch {
        throw new Error(`push_request: no remote '${remote}' in ${repo} — pass the right \`remote\`.`)
      }

      // 2. The branch to push (default: the current one). An unborn
      //    HEAD has nothing to push — symbolic-ref's error says so.
      const branch =
        (input.branch ?? "").trim() ||
        (await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim()

      // 3. What WOULD be pushed — computed only, nothing is sent.
      //    A quiet fetch of the remote first refreshes the tracking
      //    refs so the counts below are the real ones. Offline / bad
      //    remote → fall back to the local tracking refs (as stale as
      //    `git status` would report) and say so in the stat.
      let stale = false
      try {
        await git(repo, ["fetch", "--quiet", remote], { timeout: 15_000 })
      } catch {
        stale = true
      }
      //    Compare against the branch's upstream; without one, the
      //    remote-tracking ref; without that, it's a new remote branch
      //    (everything on the branch goes).
      let base: string | null = null
      try {
        base = (await git(repo, [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          `${branch}@{u}`,
        ])).trim()
      } catch {
        base = null // no upstream configured for this branch
      }
      let ahead = 0
      let behind = 0
      let note = "" // set when the upstream was not the comparison base
      if (base !== null) {
        ;[behind, ahead] = parseLeftRight(
          await git(repo, ["rev-list", "--left-right", "--count", `${base}...${branch}`]),
        )
      } else {
        const trackingRef = `refs/remotes/${remote}/${branch}`
        const known = await git(repo, ["rev-parse", "--verify", "--quiet", trackingRef])
          .then(() => true)
          .catch(() => false)
        if (known) {
          ;[behind, ahead] = parseLeftRight(
            await git(repo, ["rev-list", "--left-right", "--count", `${trackingRef}...${branch}`]),
          )
          note = `no upstream configured — comparing with ${remote}/${branch}`
        } else {
          ahead = parseInt((await git(repo, ["rev-list", "--count", branch])).trim(), 10) || 0
          note = "new remote branch"
        }
      }
      if (ahead <= 0) {
        throw new Error(
          `push_request: nothing to push — ${branch} is ahead of ` +
            `${base ?? `${remote}/${branch}`} by 0 commits` +
            (behind > 0 ? ` (and ${behind} behind)` : ""),
        )
      }
      const message = `push ${branch} → ${remote} (${ahead} commit${ahead === 1 ? "" : "s"})`
      const stat =
        `ahead ${ahead}` + (behind > 0 ? `, behind ${behind}` : "") + (note !== "" ? ` (${note})` : "") +
        (stale ? " (stale — offline)" : "")

      // 4. Park the proposal in the same queue (same contract as a
      //    commit proposal; empty files/patch — the panel shows the
      //    push line instead of a diff).
      const id = newProposalId()
      const pending: Proposal = {
        id,
        repo,
        branch,
        kind: "push",
        remote,
        message,
        stat,
        files: [],
        patch: "",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + decisionTimeoutMs(input.timeoutMs)).toISOString(),
      }
      await writeProposal(pending)

      // 5. Best-effort attention getter — never fatal.
      try {
        await desktopNotify(
          "Puli: push proposed",
          `${message} — review in the Commits panel, then: puli pending | puli approve <id> | puli reject <id> -m 'comment'`,
        )
      } catch {
        /* notification is best-effort */
      }
      try {
        await context.progress({
          status: `waiting for human review (${pending.id}) — puli approve | puli reject (push ${branch} → ${remote} in ${repo})`,
        })
      } catch {
        /* progress is optional */
      }

      // 6. Block for the human's decision, then settle (same
      //    contract as commit_request: only our id's verdict counts).
      const timeoutMs = decisionTimeoutMs(input.timeoutMs)
      const verdict = await awaitVerdict(pending.id, Date.now() + timeoutMs, context.signal)
      try {
        if (verdict?.decision === "approve") {
          // execFile + args array, never a shell string.
          let pushErr: string | null = null
          let pushOut = ""
          try {
            pushOut = await gitAll(repo, ["push", remote, branch])
          } catch (err) {
            pushErr = (err as Error).message
          }
          if (pushErr !== null) {
            await appendHistory({ id: pending.id, subject: firstLine(message), repo, branch,
              decision: "approve", detail: `push failed: ${pushErr}`, at: new Date().toISOString() })
            return {
              content:
                `The user APPROVED the push, but git refused it — nothing was pushed.\n` +
                `${pushErr}\n` +
                `Fix the problem and call push_request again.`,
              metadata: { id: pending.id, approved: true, pushed: false },
            }
          }
          const refs = pushOut
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => /\S+ -> \S+$/.test(l))
          await appendHistory({ id: pending.id, subject: firstLine(message), repo, branch,
            decision: "approve", detail: `pushed ${branch} → ${remote}`, at: new Date().toISOString() })
          return {
            content:
              `pushed ${branch} → ${remote} (${ahead} commit${ahead === 1 ? "" : "s"}, approved by the user)\n\n` +
              (refs.length > 0 ? `refs:\n${refs.map((r) => `  ${r}`).join("\n")}\n\n` : "") +
              (behind > 0
                ? `note: the base ${base ?? `${remote}/${branch}`} is ${behind} commit${behind === 1 ? "" : "s"} behind\n`
                : "") +
              (note !== "" ? `${note}\n` : ""),
            metadata: { id: pending.id, approved: true, pushed: true, remote, branch, refs, ahead, behind },
          }
        }

        // Rejected / timed out / cancelled.
        return await settleNotApproved(pending, verdict, context.signal.aborted, timeoutMs, {
          noun: "push",
          untouched: "nothing was pushed",
          reviewCmds: "puli pending / puli show",
        })
      } finally {
        await removeProposal(pending.id)
      }
    },
  }
}
