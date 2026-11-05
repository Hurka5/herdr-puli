/**
 * Verdict waiting + settling, shared by the commit and push gates:
 * the poll loop that blocks for the human's answer, the decision
 * timeout knobs, and the not-approved settle paths (reject / abort /
 * timeout), which append their own history entries.
 */
import {
  appendHistory,
  clearVerdict,
  firstLine,
  parseVerdict,
  readVerdict,
  type HistoryEntry,
  type Proposal,
  type Verdict,
} from "./state.ts"

const POLL_MS = 500
const DECISION_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

/**
 * How long a proposal waits for the human. Precedence: the tool call's
 * `timeoutMs` input (clamped to ≥10 s), then $PULI_DECISION_TIMEOUT_MS,
 * then the 30-minute default.
 */
export function decisionTimeoutMs(inputMs?: number): number {
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

/**
 * Poll the shared verdict slot until the answer for OUR id lands, the
 * deadline passes, or the tool call is aborted. Only a verdict whose id
 * matches is consumed (and cleared); anything else — another waiter's
 * answer, a malformed id — is left in place and ignored.
 */
export async function awaitVerdict(id: string, deadline: number, signal: AbortSignal): Promise<Verdict | null> {
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
export type GateNoun = {
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
export async function settleNotApproved(
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
