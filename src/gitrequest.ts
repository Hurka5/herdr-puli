/**
 * The `git_request` tool: propose ANY fenced git subcommand (merge,
 * rebase, cherry-pick, revert, plumbing — and raw commit/push) for
 * human review. Same queue, same verdict machinery as commit_request /
 * push_request; the panel shows the command line instead of a diff, so
 * commit/push proposals are better served by their dedicated tools.
 */
import type { Info } from "@opencode/plugin/promise/tool"
import path from "node:path"
import {
  appendHistory,
  newProposalId,
  removeProposal,
  writeProposal,
  type Proposal,
} from "./state.ts"
import { currentBranch, gitAll, resolveRepoRoot } from "./git.ts"
import { desktopNotify } from "./notify.ts"
import { awaitVerdict, decisionTimeoutMs, settleNotApproved } from "./verdict.ts"

/** The subcommands the user's fence denies — the only ones this gate accepts. */
const DENIED_SUBCOMMANDS = new Set([
  "commit",
  "push",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "commit-tree",
  "update-ref",
])

/** The message doubles as the card subject and the panel's command line. */
const SUBJECT_CAP = 120

export function gitRequestTool(sessionDir: string): Info {
  return {
    name: "git_request",
    description:
      "Propose a denied git subcommand for human review (git merge / rebase / cherry-pick / " +
      "revert / commit / push / commit-tree / update-ref are denied to you). " +
      "Records the exact command in the review queue (it may not be the only one waiting), " +
      "then WAITS (up to 30 min) for the human's verdict in the Commits panel or " +
      "`puli approve` / `puli reject`. " +
      "Approved → the plugin runs exactly that command and returns its output; " +
      "rejected → returns the human's comments. " +
      "For plain commits/pushes prefer commit_request / push_request — the reviewer sees a " +
      "diff there; here they only see the command line. Unfenced subcommands (status, log, " +
      "add…) are NOT accepted — run those with git directly.",
    input: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description:
            "The git arguments AFTER the `git` binary, starting with the subcommand: " +
            'e.g. ["merge", "--no-ff", "feature"] or ["rebase", "main"].',
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
      required: ["args"],
      additionalProperties: false,
    },
    options: { namespace: "puli", codemode: true },
    execute: async (raw, context) => {
      const input = raw as { args?: unknown[]; repo?: string; timeoutMs?: number }

      // 1. The command. args[0] must be one of the fenced subcommands —
      //    anything else has a direct path (plain git) and is refused
      //    here, BEFORE anything is staged in the queue.
      if (!Array.isArray(input.args) || input.args.length === 0) {
        throw new Error(
          "git_request: `args` is required — the git arguments starting with the subcommand, " +
            'e.g. ["merge", "--no-ff", "feature"].',
        )
      }
      if (input.args.some((a) => typeof a !== "string" || a.trim() === "")) {
        throw new Error("git_request: every `args` item must be a non-empty string")
      }
      const args = input.args as string[]
      const sub = args[0] as string
      if (!DENIED_SUBCOMMANDS.has(sub)) {
        throw new Error(
          `git_request: 'git ${sub}' is not fenced — run it directly with your shell tool. ` +
            `This gate only takes the denied subcommands: ` +
            `${[...DENIED_SUBCOMMANDS].join(", ")}.`,
        )
      }

      // 2. Resolve the repo root (git walks up from the directory itself).
      const repo = await resolveRepoRoot(input.repo?.trim() || sessionDir)
      const branch = await currentBranch(repo)

      // 3. One line: the command IS the subject (capped; the card wraps
      //    it anyway). stat carries the repo · branch context for `puli show`.
      const full = `git ${args.join(" ")}`
      const message = full.length > SUBJECT_CAP ? full.slice(0, SUBJECT_CAP - 1) + "…" : full
      const stat = `${path.basename(repo)} · ${branch}`

      // 4. Park the proposal in the same queue (empty files/patch — the
      //    panel shows the command line instead of a diff).
      const id = newProposalId()
      const pending: Proposal = {
        id,
        repo,
        branch,
        kind: "git",
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
          "Puli: git command proposed",
          `${message} — review in the Commits panel, then: puli pending | puli approve <id> | puli reject <id> -m 'comment'`,
        )
      } catch {
        /* notification is best-effort */
      }
      try {
        await context.progress({
          status: `waiting for human review (${pending.id}) — puli approve | puli reject (${message} in ${repo})`,
        })
      } catch {
        /* progress is optional */
      }

      // 6. Block for the human's decision, then settle (same contract
      //    as the other gates: only our id's verdict counts).
      const timeoutMs = decisionTimeoutMs(input.timeoutMs)
      const verdict = await awaitVerdict(pending.id, Date.now() + timeoutMs, context.signal)
      try {
        if (verdict?.decision === "approve") {
          // execFile + args array, never a shell string.
          let cmdErr: string | null = null
          let out = ""
          try {
            out = await gitAll(repo, args)
          } catch (err) {
            cmdErr = (err as Error).message
          }
          if (cmdErr !== null) {
            await appendHistory({ id: pending.id, subject: message, repo, branch,
              decision: "approve", detail: `command failed: ${cmdErr}`, at: new Date().toISOString() })
            return {
              content:
                `The user APPROVED the git command, but git refused it — the repo may sit ` +
                `mid-operation now (check git status).\n` +
                `${cmdErr}\n` +
                `Fix the problem and call git_request again.`,
              metadata: { id: pending.id, approved: true, ran: false },
            }
          }
          await appendHistory({ id: pending.id, subject: message, repo, branch,
            decision: "approve", detail: message, at: new Date().toISOString() })
          return {
            content:
              `ran ${message} on ${branch} in ${repo} (approved by the user)\n` +
              (out !== "" ? `\n${out}\n` : ""),
            metadata: { id: pending.id, approved: true, ran: true, command: message, output: out },
          }
        }

        // Rejected / timed out / cancelled.
        return await settleNotApproved(pending, verdict, context.signal.aborted, timeoutMs, {
          noun: "git command",
          untouched: "the git command was not run",
          reviewCmds: "puli pending / puli show",
        })
      } finally {
        await removeProposal(pending.id)
      }
    },
  }
}
