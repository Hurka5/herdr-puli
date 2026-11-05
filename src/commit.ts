/** The `commit_request` tool: propose a commit, wait for the human's verdict. */
import type { Info } from "@opencode/plugin/promise/tool"
import {
  appendHistory,
  firstLine,
  newProposalId,
  removeProposal,
  writeProposal,
  type Proposal,
} from "./state.ts"
import { capturePatch, currentBranch, git, resolveRepoRoot } from "./git.ts"
import { desktopNotify } from "./notify.ts"
import { awaitVerdict, decisionTimeoutMs, settleNotApproved } from "./verdict.ts"

export function commitRequestTool(sessionDir: string): Info {
  return {
    name: "commit_request",
    description:
      "Propose a commit for human review (git commit is denied to you). " +
      "Stages `files` if given, records the proposed commit in the review queue (it may " +
      "not be the only one waiting), opens the review panel, then WAITS (up to 30 min) for " +
      "the human to answer `puli approve` / `puli reject` in a terminal. " +
      "Approved → the plugin commits and returns the hash + stat; " +
      "rejected → returns the human's change requests.",
    input: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The full commit message: subject line, optional body.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Paths to stage (git add -- ...), relative to the repo root. " +
            "Omit to propose what is already staged.",
        },
        repo: {
          type: "string",
          description:
            "Directory to resolve the git repo from (defaults to this session's directory).",
        },
        timeoutMs: {
          type: "number",
          description:
            "How long to wait for the human verdict, in milliseconds (default 30 min, min 10 s). " +
            "Use a short value (e.g. 120000) for tests so the call cannot strand a session.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
    options: { namespace: "puli", codemode: true },
    execute: async (raw, context) => {
      const input = raw as { message: string; files?: string[]; repo?: string; timeoutMs?: number }
      const message = (input.message ?? "").trim()
      if (!message) throw new Error("commit_request: `message` is required")

      // 1. Resolve the repo root (git walks up from the directory itself).
      const repo = await resolveRepoRoot(input.repo?.trim() || sessionDir)

      // 2. Stage requested files (relative to the repo root).
      const files = (input.files ?? []).filter((f) => typeof f === "string" && f.trim() !== "")
      if (files.length > 0) await git(repo, ["add", "--", ...files])

      // 3. Something must be staged.
      const stat = await git(repo, ["diff", "--cached", "--stat"])
      if (stat.trim() === "") {
        throw new Error(
          "nothing staged to commit in " +
            repo +
            ". Stage the files first (`git add` is allowed for you) or pass `files` in the commit_request call.",
        )
      }
      const branch = await currentBranch(repo)
      const stagedFiles = (await git(repo, ["diff", "--cached", "--name-only"]))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "")

      // 4. Freeze the staged diff into the proposal (what the panel
      //    renders, and exactly what approval commits), then park the
      //    proposal in the queue (one file per proposal, so several
      //    sessions can wait at once). NO verdict clearing here: a
      //    verdict already in flight may belong to another waiter —
      //    each waiter only ever consumes a verdict matching its own id.
      const id = newProposalId()
      const pending: Proposal = {
        id,
        repo,
        branch,
        message,
        stat: stat.trim(),
        files: stagedFiles,
        patch: await capturePatch(repo, id),
        createdAt: new Date().toISOString(),
        // the waiter's deadline: past this, no one will consume a verdict
        // for this id — the panel expires the card instead of sticking
        expiresAt: new Date(Date.now() + decisionTimeoutMs(input.timeoutMs)).toISOString(),
      }
      await writeProposal(pending)

      // 5. Best-effort attention getter — never fatal.
      // (No view changes: the review panel in the herdr app lists proposals
      // on its own; jumping panels/spaces from here is forbidden by design.)
      try {
        await desktopNotify(
          "Puli: commit proposed",
          `${firstLine(message)} — review in the Commits panel, then: puli pending | puli approve <id> | puli reject <id> -m 'comment'`,
        )
      } catch {
        /* notification is best-effort */
      }
      try {
        await context.progress({
          status: `waiting for human review (${pending.id}) — puli approve | puli reject (repo ${repo}, branch ${branch})`,
        })
      } catch {
        /* progress is optional */
      }

      // 6. Block for the human's decision (written by the puli CLI /
      //    the panel). awaitVerdict consumes ONLY a verdict whose id
      //    matches this proposal; anything else (another waiter's
      //    verdict, a malformed id) is left in place and ignored.
      const timeoutMs = decisionTimeoutMs(input.timeoutMs)
      const verdict = await awaitVerdict(pending.id, Date.now() + timeoutMs, context.signal)

      // 7. Settle. Whatever the outcome, this proposal leaves the queue.
      try {
        // Approved → we commit (execFile + args array, never a shell string).
        if (verdict?.decision === "approve") {
          let commitErr: string | null = null
          let hash = ""
          try {
            await git(repo, ["commit", "-m", message])
            hash = (await git(repo, ["rev-parse", "HEAD"])).trim()
          } catch (err) {
            commitErr = (err as Error).message
          }
          if (commitErr !== null) {
            await appendHistory({ id: pending.id, subject: firstLine(message), repo, branch,
              decision: "approve", detail: `commit failed: ${commitErr}`, at: new Date().toISOString() })
            return {
              content:
                `The user APPROVED the commit, but git refused it — the staged changes are untouched.\n` +
                `${commitErr}\n` +
                `Fix the problem and call commit_request again with the same message.`,
              metadata: { id: pending.id, approved: true, committed: false },
            }
          }
          await appendHistory({ id: pending.id, subject: firstLine(message), repo, branch,
            decision: "approve", detail: hash, at: new Date().toISOString() })
          return {
            content:
              `committed ${hash} on ${branch} (approved by the user)\n\n` +
              `${pending.stat}\n\n` +
              (pending.files.length > 0
                ? `files:\n${pending.files.map((f) => `  ${f}`).join("\n")}\n\n`
                : "") +
              message,
            metadata: {
              id: pending.id,
              hash,
              branch,
              repo: pending.repo,
              files: pending.files,
              approved: true,
            },
          }
        }

        // Rejected / timed out / cancelled.
        return await settleNotApproved(pending, verdict, context.signal.aborted, timeoutMs, {
          noun: "commit",
          untouched: "nothing was committed; the staged changes are untouched",
          reviewCmds: "puli pending / puli show / puli diff",
        })
      } finally {
        await removeProposal(pending.id)
      }
    },
  }
}
