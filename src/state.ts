/**
 * puli state — shared by the OpenCode plugin (src/index.ts) and the
 * `puli` CLI (bin/puli).
 *
 * QUEUE layout under ~/.local/state/puli:
 *
 *   pending/<id>.json  one file per proposed commit (the queue).
 *                      Written by the plugin's commit_request tool;
 *                      removed by the same waiter when the request
 *                      settles (approve / reject / timeout / abort).
 *                      Shape: { id, repo, branch, message, stat,
 *                               files: string[], patch, createdAt }
 *                      `patch` is the FULL staged diff frozen at
 *                      proposal time (`git diff --cached --no-color
 *                      --no-ext-diff`, capped at 256 KiB with a
 *                      truncation trailer) — the review panel renders
 *                      exactly what approval will commit.
 *                      A push proposal (kind: "push", remote set, empty
 *                      files/patch) rides the same queue; the panel
 *                      shows its push line instead of a diff. So does a
 *                      generic git-command proposal (kind: "git",
 *                      message = the command) from the git_request tool.
 *   verdict.json       transient human answer, written by the herdr
 *                      panel or the `puli` CLI:
 *                      { id, decision: "approve" | "reject", message?,
 *                        comments?: [{ file, start, end, text }], at? }
 *                      `comments` (reject only) are inline line comments
 *                      picked on the panel's inline diff: an inclusive
 *                      NEW-side line range per repo-relative file.
 *
 * A verdict only counts for the waiter whose pending id it matches;
 * that waiter consumes (deletes) it. Any other waiter must leave it
 * alone — it belongs to somebody else's proposal. Verdicts with a
 * malformed/unknown id are ignored, never deleted.
 *
 * All writes go through tmp + rename so a reader never sees a
 * half-written file.
 *
 * NOTE: the answer file is verdict.json, NOT decision.json — on this
 * machine an external watcher deletes any file named decision.json in
 * this directory within ~200ms of its creation, so that name is
 * unusable here (observed empirically; likely the weave adapter's
 * auto-approver consuming that path).
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export type Proposal = {
  id: string
  repo: string
  branch: string
  /** "push" / "git" mark push / raw-command proposals; absent = commit proposal. */
  kind?: "push" | "git"
  /** Push proposals only: the remote the branch would be pushed to. */
  remote?: string
  message: string
  stat: string
  /** Staged paths at proposal time (`git diff --cached --name-only`). */
  files: string[]
  /**
   * The staged diff frozen at proposal time (`git diff --cached
   * --no-color --no-ext-diff`), capped at 256 KiB. Old proposals (from
   * before this field) have none — readers must treat it as optional.
   */
  patch: string
  createdAt: string
  /** Waiter deadline; the panel expires the card after it passes. */
  expiresAt?: string
}

export type Verdict = {
  id: string
  decision: "approve" | "reject"
  message?: string
  /** Inline line comments (reject only, written by the review panel). */
  comments?: LineComment[]
  at?: string
}

/** One inline comment on a rejected diff: an inclusive new-side line range. */
export type LineComment = {
  /** Repo-relative path. */
  file: string
  start: number
  end: number
  text: string
}

export const stateDir = path.join(homedir(), ".local", "state", "puli")
export const pendingDir = path.join(stateDir, "pending")
export const verdictPath = path.join(stateDir, "verdict.json")
export const historyPath = path.join(stateDir, "history.jsonl")

/** Write via temp file + rename so a reader never sees a half-written file. */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(tmp, text, "utf8")
  await rename(tmp, file)
}

/** Missing / unreadable / invalid JSON all read as null. */
export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T
  } catch {
    return null
  }
}

/** Unique proposal id: puli-<epochms>-<random6>. */
export function newProposalId(): string {
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0")
  return `puli-${Date.now()}-${rand}`
}

/** The short, human-facing form of an id (its random6 tail). */
export function shortId(id: string): string {
  const tail = id.split("-").pop() ?? id
  return tail.length >= 6 ? tail : id.slice(-6)
}

export function proposalPath(id: string): string {
  return path.join(pendingDir, `${id}.json`)
}

export function writeProposal(p: Proposal): Promise<void> {
  return writeAtomic(proposalPath(p.id), JSON.stringify(p, null, 2) + "\n")
}

export async function removeProposal(id: string): Promise<void> {
  await rm(proposalPath(id), { force: true })
}

/** Every valid proposal in the queue, oldest first. Invalid files are skipped. */
export async function listProposals(): Promise<Proposal[]> {
  let entries: string[]
  try {
    entries = await readdir(pendingDir)
  } catch {
    return [] // no queue dir yet → empty queue
  }
  const proposals: Proposal[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue // skips our own *.tmp-* in-flight writes
    const p = await readJson<Proposal>(path.join(pendingDir, entry))
    if (p && typeof p.id === "string" && p.id !== "") proposals.push(p)
  }
  proposals.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id))
  return proposals
}

export function readVerdict(): Promise<unknown> {
  return readJson<unknown>(verdictPath)
}

/** A valid comment item, or null (callers skip invalid items). */
function parseComment(raw: unknown): LineComment | null {
  if (typeof raw !== "object" || raw === null) return null
  const c = raw as Record<string, unknown>
  if (typeof c.file !== "string" || c.file.trim() === "") return null
  if (typeof c.start !== "number" || !Number.isFinite(c.start)) return null
  if (typeof c.end !== "number" || !Number.isFinite(c.end)) return null
  if (typeof c.text !== "string" || c.text.trim() === "") return null
  return { file: c.file, start: c.start, end: c.end, text: c.text }
}

/**
 * Validate a parsed verdict file. Anything without a string id and an
 * "approve" | "reject" decision is malformed → null (callers must
 * ignore it, not delete it). `comments` items are validated one by one;
 * invalid items are skipped, an empty remainder drops the field.
 */
export function parseVerdict(raw: unknown): Verdict | null {
  if (typeof raw !== "object" || raw === null) return null
  const v = raw as Record<string, unknown>
  if (typeof v.id !== "string" || v.id === "") return null
  if (v.decision !== "approve" && v.decision !== "reject") return null
  const comments = Array.isArray(v.comments)
    ? (v.comments as unknown[])
        .map(parseComment)
        .filter((c): c is LineComment => c !== null)
    : []
  return {
    id: v.id,
    decision: v.decision,
    ...(typeof v.message === "string" && v.message.trim() !== "" ? { message: v.message } : {}),
    ...(comments.length > 0 ? { comments } : {}),
    ...(typeof v.at === "string" ? { at: v.at } : {}),
  }
}

/** Drop the verdict file (only the waiter that matched it may call this). */
export async function clearVerdict(): Promise<void> {
  await rm(verdictPath, { force: true })
}

export function firstLine(s: string): string {
  return (s.split("\n", 1)[0] ?? "").trim()
}

export type HistoryEntry = {
  id: string
  subject: string
  repo: string
  branch: string
  decision: "approve" | "reject" | "timeout" | "abort"
  /** Commit hash on approve; review comment on reject. */
  detail?: string
  at: string
}

/** Append one outcome line to history.jsonl (best-effort; never throws). */
export async function appendHistory(e: HistoryEntry): Promise<void> {
  try {
    await mkdir(stateDir, { recursive: true })
    const { appendFile } = await import("node:fs/promises")
    await appendFile(historyPath, JSON.stringify(e) + "\n", "utf8")
  } catch {
    /* history is advisory — never let it break a settle path */
  }
}
