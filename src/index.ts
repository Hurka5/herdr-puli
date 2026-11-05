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
  type HistoryEntry,
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

/**
 * Desktop notification shown as coming from "herdr-puli" with the puli
 * icon — gdbus is the only way to control the app name (notify-send
 * hardcodes its own). Falls back to icon-less notify-send.
 */
async function desktopNotify(title: string, body: string): Promise<void> {
  const icon = new URL("../puli.png", import.meta.url).pathname
  try {
    await exec(
      "gdbus",
      [
        "call", "--session",
        "--dest", "org.freedesktop.Notifications",
        "--object-path", "/org/freedesktop/Notifications",
        "--method", "org.freedesktop.Notifications.Notify",
        "herdr-puli", "0", icon, title, body, "[]", "{}", "8000",
      ],
      { timeout: 10_000 },
    )
    return
  } catch {
    /* gdbus missing or the session bus refused: try the plain tool */
  }
  try {
    await exec("notify-send", ["-i", icon, title, body], { timeout: 10_000 })
  } catch {
    /* no notifier at all: skip silently */
  }
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
  return gitRun(cwd, args).then((r) => r.stdout)
}

/** Like git(), but stdout+stderr combined — push writes its ref summary to stderr. */
async function gitAll(cwd: string, args: string[]): Promise<string> {
  return gitRun(cwd, args).then((r) => (r.stdout + r.stderr).trim())
}

async function gitRun(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec("git", ["-C", cwd, ...args], {
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    throw new Error(`git ${args.join(" ")} failed: ${(e.stderr ?? e.message ?? "").trim()}`)
  }
}

/**
 * Poll the shared verdict slot until the answer for OUR id lands, the
 * deadline passes, or the tool call is aborted. Only a verdict whose id
 * matches is consumed (and cleared); anything else — another waiter's
 * answer, a malformed id — is left in place and ignored.
 */
async function awaitVerdict(id: string, deadline: number, signal: AbortSignal): Promise<Verdict | null> {
  for (;;) {
    if (signal.aborted) return null
    if (Date.now() > deadline) return null
    await sleep(POLL_MS, signal)
    if (signal.aborted) return null
    const v = parseVerdict(await readVerdict())
    if (v === null) continue // missing / malformed / half-formed: ignore
    if (v.id !== id) continue // someone else's answer: not ours to take
    await clearVerdict()
    return v
  }
}

/** Wording knobs that differ between the commit and push gates. */
type GateNoun = {
  /** "commit" | "push" — names the request in every not-approved text. */
  noun: string
  /** mid-sentence "nothing happened" phrase, e.g. "nothing was pushed". */
  untouched: string
  /** CLI review commands for the timeout guidance. */
  reviewCmds: string
}

/**
 * Settle every not-approved outcome (reject / abort / timeout) the same
 * way for both gates: history line + tool result. The caller returns
 * the result and removes the proposal from the queue.
 */
async function settleNotApproved(
  pending: Proposal,
  verdict: Verdict | null,
  aborted: boolean,
  timeoutMs: number,
  gate: GateNoun,
): Promise<{ content: string; metadata: Record<string, unknown> }> {
  const subject = firstLine(pending.message)
  const hist = (decision: HistoryEntry["decision"], detail?: string) =>
    appendHistory({
      id: pending.id,
      subject,
      repo: pending.repo,
      branch: pending.branch,
      decision,
      detail,
      at: new Date().toISOString(),
    })

  if (verdict?.decision === "reject") {
    const note = verdict.message?.trim()
    // Inline line comments picked on the review panel's diff
    // (validated by parseVerdict; invalid items were skipped):
    //   <file>:<start[-end]>: <text>
    const comments = verdict.comments ?? []
    const commentLines = comments.map((c) =>
      `${c.file}:${c.start === c.end ? c.start : `${c.start}-${c.end}`}: ${c.text}`,
    )
    await hist("reject", note || undefined)
    return {
      content:
        note || commentLines.length > 0
          ? (note
              ? `changes requested by user: ${note}`
              : "changes requested by user (see line comments)") +
            (commentLines.length > 0 ? "\n" + commentLines.join("\n") : "")
          : `user rejected the ${gate.noun}`,
      metadata: { id: pending.id, approved: false, comment: note ?? "", comments },
    }
  }
  if (aborted) {
    await hist("abort")
    const untouched = gate.untouched.charAt(0).toUpperCase() + gate.untouched.slice(1)
    return {
      content:
        `${gate.noun} request cancelled (the tool call was aborted). ${untouched}. ` +
        `Ask the user how to proceed.`,
      metadata: { id: pending.id, approved: false },
    }
  }
  const waitDesc =
    timeoutMs >= 60_000
      ? `${Math.max(1, Math.round(timeoutMs / 60_000))} minutes`
      : `${Math.round(timeoutMs / 1000)} seconds`
  await hist("timeout")
  return {
    content:
      `timed out after ${waitDesc} waiting for a decision — ${gate.untouched}. ` +
      `Ask the user directly: they can review with ${gate.reviewCmds} in a terminal, ` +
      `and you may propose again.`,
    metadata: { id: pending.id, approved: false },
  }
}

/** "behind\tahead" from `rev-list --left-right --count` → [behind, ahead]. */
function parseLeftRight(out: string): [number, number] {
  const [l = "0", r = "0"] = out.trim().split(/\s+/)
  return [parseInt(l, 10) || 0, parseInt(r, 10) || 0]
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
      })

      editor.add({
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
          const startDir = input.repo?.trim() || sessionDir
          let repo: string
          try {
            repo = (await git(startDir, ["rev-parse", "--show-toplevel"])).trim()
          } catch (err) {
            throw new Error(`not a git repository (or no git): ${startDir} — ${(err as Error).message}`)
          }

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
          //    Compare against the branch's upstream; without one, the
          //    remote-tracking ref; without that, it's a new remote branch
          //    (everything on the branch goes). Tracking refs are local
          //    (no fetch): as stale as `git status` would report.
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
            `ahead ${ahead}` + (behind > 0 ? `, behind ${behind}` : "") + (note !== "" ? ` (${note})` : "")

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
      })

      // TODO (next milestones):
      //
      // [ ] serial tools — proxy to serial-broker socket
      //     - serial_list()
      //     - serial_read({ port, since })
      //     - serial_write({ port, data })
      //     - serial_flash({ port, argv })
    })
  },
})
