/**
 * opencode-puli — server part.
 *
 * Two jobs:
 *
 *  1. Commit gate. The agent never runs `git commit` / `git push`
 *     (denied in opencode.jsonc — see README). Instead it calls the
 *     `commit_request` tool:
 *       - the plugin stages/collects the proposed commit and parks it
 *         as ~/.local/state/puli/pending/<id>.json — a QUEUE: several
 *         proposals (from different sessions) can wait at once
 *       - it opens the herdr app's Changes panel and sends a desktop
 *         notification (both best-effort)
 *       - the human answers OUTSIDE OpenCode, with the `puli` CLI
 *         (`puli approve` / `puli reject -m "..."`), which writes
 *         verdict.json — no ctx.permission, no ask (sessions driven
 *         by the weave adapter auto-approve those, so they prove
 *         nothing)
 *       - approved → the plugin runs `git commit` itself (plugin exec
 *         is not the agent's shell tool, so the deny rules don't apply
 *         — they gate the agent, not us); rejected → the comment text
 *         goes back to the agent as the tool result
 *
 *  2. Serial tools. Thin proxies over serial-broker's unix socket
 *     ($XDG_RUNTIME_DIR/serial-broker.sock): list / read(since cursor) /
 *     write / flash. The broker owns the ports; we just phone it.
 */
import { execFile } from "node:child_process"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { Plugin } from "@opencode/plugin"
import {
  appendHistory,
  clearVerdict,
  firstLine,
  newProposalId,
  parseVerdict,
  readVerdict,
  removeProposal,
  shortId,
  writeProposal,
  type Proposal,
  type Verdict,
} from "./state.ts"

const exec = promisify(execFile)

const POLL_MS = 500
const DECISION_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

/**
 * How long a proposal waits for the human. Precedence: the tool call's
 * `timeoutMs` input (clamped to ≥10 s), then $PULI_DECISION_TIMEOUT_MS,
 * then the 30-minute default.
 */
function decisionTimeoutMs(inputMs?: number): number {
  if (Number.isFinite(inputMs) && (inputMs as number) > 0) {
    return Math.max(10_000, Math.floor(inputMs as number))
  }
  const env = Number(process.env.PULI_DECISION_TIMEOUT_MS)
  return Number.isFinite(env) && env > 0 ? env : DECISION_TIMEOUT_MS
}

/** Sleep that wakes early when the tool call is aborted. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener("abort", done)
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}

/** Cap for the patch captured into a proposal (keeps pending files small). */
const PATCH_CAP = 256 * 1024

/**
 * The staged diff frozen at proposal time — the panel renders exactly
 * this, and approving commits exactly this. Capped at 256 KiB: past the
 * cap the tail is dropped and a trailer points at `puli diff` (which
 * re-runs git live instead of using the frozen copy).
 */
async function capturePatch(repo: string, id: string): Promise<string> {
  const diff = await git(repo, ["diff", "--cached", "--no-color", "--no-ext-diff"])
  if (diff.length <= PATCH_CAP) return diff
  return diff.slice(0, PATCH_CAP) + `\n... (patch truncated — run \`puli diff ${shortId(id)}\` for the full diff)\n`
}

/** Run git in `cwd`, args as an array; throws with git's stderr in the message. */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    throw new Error(`git ${args.join(" ")} failed: ${(e.stderr ?? e.message ?? "").trim()}`)
  }
}

export default Plugin.define({
  id: "puli",
  async setup(ctx) {
    // Where this OpenCode instance runs; the default repo starting point.
    const sessionDir = ctx.location.directory

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "puli",
        description: "Puli: the commit gate (human-approved commits) and serial monitor tools",
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

      editor.add({
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
          const startDir = input.repo?.trim() || sessionDir
          let repo: string
          try {
            repo = (await git(startDir, ["rev-parse", "--show-toplevel"])).trim()
          } catch (err) {
            throw new Error(`not a git repository (or no git): ${startDir} — ${(err as Error).message}`)
          }

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
          // On a repo with zero commits (unborn HEAD) rev-parse fails; fall
          // back to symbolic-ref, which still names the unborn branch.
          let branch: string
          try {
            branch = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
          } catch {
            branch = (await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim()
          }
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
            await exec(
              "notify-send",
              [
                "Puli: commit proposed",
                `${firstLine(message)} — review in the puli panel, then: puli pending | puli approve <id> | puli reject <id> -m 'comment'`,
              ],
              { timeout: 10_000 },
            )
          } catch {
            /* notify-send missing or failed: skip silently */
          }
          try {
            await context.progress({
              status: `waiting for human review (${pending.id}) — puli approve | puli reject (repo ${repo}, branch ${branch})`,
            })
          } catch {
            /* progress is optional */
          }

          // 6. Block for the human's decision (written by the puli CLI /
          //    the panel). Consume ONLY a verdict whose id matches this
          //    proposal; anything else (another waiter's verdict, a
          //    malformed id) is left in place and ignored.
          const timeoutMs = decisionTimeoutMs(input.timeoutMs)
          const deadline = Date.now() + timeoutMs
          let verdict: Verdict | null = null
          while (verdict === null) {
            if (context.signal.aborted) break
            if (Date.now() > deadline) break
            await sleep(POLL_MS, context.signal)
            if (context.signal.aborted) break
            const v = parseVerdict(await readVerdict())
            if (v === null) continue // missing / malformed / half-formed: ignore
            if (v.id !== pending.id) continue // someone else's answer: not ours to take
            verdict = v
            await clearVerdict()
          }

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
            if (verdict?.decision === "reject") {
              const note = verdict.message?.trim()
              await appendHistory({ id: pending.id, subject: firstLine(message), repo, branch,
                decision: "reject", detail: note || undefined, at: new Date().toISOString() })
              return {
                content: note
                  ? `changes requested by user: ${note}`
                  : "user rejected the commit",
                metadata: { id: pending.id, approved: false, comment: note ?? "" },
              }
            }
            if (context.signal.aborted) {
              await appendHistory({ id: pending.id, subject: firstLine(message), repo, branch,
                decision: "abort", at: new Date().toISOString() })
              return {
                content:
                  "commit request cancelled (the tool call was aborted). Nothing was committed; " +
                  "the staged changes are untouched. Ask the user how to proceed.",
                metadata: { id: pending.id, approved: false },
              }
            }
            const waitDesc =
              timeoutMs >= 60_000
                ? `${Math.max(1, Math.round(timeoutMs / 60_000))} minutes`
                : `${Math.round(timeoutMs / 1000)} seconds`
            await appendHistory({ id: pending.id, subject: firstLine(message), repo, branch,
              decision: "timeout", at: new Date().toISOString() })
            return {
              content:
                `timed out after ${waitDesc} waiting for a decision — nothing was committed, ` +
                `the staged changes are untouched. Ask the user directly: they can review with ` +
                `puli pending / puli show / puli diff in a terminal, and you may propose again.`,
              metadata: { id: pending.id, approved: false },
            }
          } finally {
            await removeProposal(pending.id)
          }
        },
      })

      // TODO (next milestones):
      //
      // [ ] serial tools — proxy to serial-broker socket
      //     - serial_list()
      //     - serial_read({ port, since })
      //     - serial_write({ port, data })
      //     - serial_flash({ port, argv })
      //
      // [ ] push gate (after the commit gate proves itself)
    })
  },
})
