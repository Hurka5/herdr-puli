/** Git plumbing shared by the commit and push gate tools. */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { shortId } from "./state.ts"

const exec = promisify(execFile)

/** Run git in `cwd`, args as an array; throws with git's stderr in the message. */
export async function git(cwd: string, args: string[]): Promise<string> {
  return gitRun(cwd, args).then((r) => r.stdout)
}

/** Like git(), but stdout+stderr combined — push writes its ref summary to stderr. */
export async function gitAll(cwd: string, args: string[]): Promise<string> {
  return gitRun(cwd, args).then((r) => (r.stdout + r.stderr).trim())
}

export async function gitRun(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec("git", ["-C", cwd, ...args], {
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    throw new Error(`git ${args.join(" ")} failed: ${(e.stderr ?? e.message ?? "").trim()}`)
  }
}

/** Cap for the patch captured into a proposal (keeps pending files small). */
const PATCH_CAP = 256 * 1024

/**
 * The staged diff frozen at proposal time — the panel renders exactly
 * this, and approving commits exactly this. Capped at 256 KiB: past the
 * cap the tail is dropped and a trailer points at `puli diff` (which
 * re-runs git live instead of using the frozen copy).
 */
export async function capturePatch(repo: string, id: string): Promise<string> {
  const diff = await git(repo, ["diff", "--cached", "--no-color", "--no-ext-diff"])
  if (diff.length <= PATCH_CAP) return diff
  return diff.slice(0, PATCH_CAP) + `\n... (patch truncated — run \`puli diff ${shortId(id)}\` for the full diff)\n`
}

/** Repo root containing `startDir` (git walks up from the directory itself). */
export async function resolveRepoRoot(startDir: string): Promise<string> {
  try {
    return (await git(startDir, ["rev-parse", "--show-toplevel"])).trim()
  } catch (err) {
    throw new Error(`not a git repository (or no git): ${startDir} — ${(err as Error).message}`)
  }
}

/**
 * The current branch. On a repo with zero commits (unborn HEAD)
 * rev-parse fails; symbolic-ref still names the unborn branch.
 */
export async function currentBranch(repo: string): Promise<string> {
  try {
    return (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
  } catch {
    return (await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim()
  }
}
