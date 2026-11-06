/**
 * puli — commit-review queue panel for puli's commit gate.
 *
 * State contract (~/.local/state/puli, see opencode-puli):
 *
 *   pending/<id>.json  one file per proposed commit:
 *                      { id, repo, branch, message, stat, files: string[],
 *                        patch, createdAt }
 *                      written by the plugin's commit_request tool; the file
 *                      going away = the proposal is settled. `patch` is the
 *                      full staged diff frozen at proposal time (≤256 KiB;
 *                      older proposals have none) — the accordion below
 *                      renders it, so the panel is self-sufficient: exactly
 *                      what approval will commit, without opening anything
 *                      else. A push proposal (kind: "push", remote set,
 *                      empty files/patch) rides the same queue — the card
 *                      shows its push line instead of a diff; so does a
 *                      git-command proposal (kind: "git", message = the
 *                      exact command, from the git_request tool).
 *   verdict.json       { id, decision: "approve" | "reject", message?,
 *                        comments?: [{ file, start, end, text }] } —
 *                        transient; written by `puli approve | puli reject -m`
 *                        or this panel. A reject may carry `comments`:
 *                        inline line comments picked by clicking lines of
 *                        the card's inline diff (per repo-relative file,
 *                        an inclusive NEW-side line range). Counts only
 *                        when its id matches a pending proposal. The
 *                        plugin consumes it and deletes that proposal's
 *                        pending/<id>.json.
 *   history.jsonl      one JSON object per settled proposal (append-only):
 *                      { id, subject, repo, branch, decision: "approve" |
 *                      "reject" | "timeout" | "abort", detail?, at } —
 *                      detail = commit hash on approve, review comment on
 *                      reject. Missing file → empty history.
 *
 * NEVER decision.json: an external watcher on this machine deletes files with
 * that name in that directory within ~200 ms (known quirk; see state.ts).
 *
 * UI: one self-contained card per pending proposal (the waiting queue) with
 * the FULL commit message always visible, a FILES ACCORDION — one row per
 * changed file (name + +/− counts), clicking a row expands that file's diff
 * straight from `patch` (added green, removed red, hunks and context dim) —
 * and a collapsible history section below it (what was approved/rejected).
 * No list→detail navigation, no other panel needed.
 *
 * Rules this mod lives by:
 *  - It NEVER changes the user's view: no space.select / layout.* /
 *    mod.open runs at all — a fully passive UI. Actions are limited to
 *    writing verdict.json.
 *  - No setTimeout: the 1 s poll is cx.timer.every (one sh listing of the
 *    pending dir; files are re-read only when their checksum changes; the
 *    history file is re-parsed only when its bytes change).
 *  - Render is pure: no exec, no host calls with side effects. Diff
 *    rendering is bounded (per-file row cap, per-line length cap) so a
 *    huge patch cannot freeze the panel.
 *
 * Placement: mod.json "place": "right". The panel lives in its own
 * right-side column of the personal shown layout.
 */
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { closeOverlay, exec, home, props, readTextFile, settings, theme } from "herdr";

const DIR = home() + "/.local/state/puli";
const PENDING_DIR = DIR + "/pending";
const VERDICT = DIR + "/verdict.json";
const HISTORY = DIR + "/history.jsonl";

// One line per pending file: "<name>\t<md5>"; empty output when the dir is
// missing or empty (the glob stays literal and [ -f ] skips it).
const LIST_SH =
  'for f in "$1"/*.json; do [ -f "$f" ] || continue; ' +
  'printf "%s\\t%s\\n" "${f##*/}" "$(md5sum < "$f" | cut -d" " -f1)"; done';

// The verdict JSON rides in argv ($1), never through a shell parse, so any
// bytes the person types survive verbatim; tmp + rename keeps readers from
// ever seeing a half-written file (same contract as state.ts writeAtomic).
const WRITE_SH = 'printf %s "$1" > "$2.tmp-herdr" && mv -f "$2.tmp-herdr" "$2"';

const SAFE_NAME = /^[\w.-]+\.json$/; // plugin ids: uuid-ish; skip anything else

function parseJson(text) {
  if (text === null || text === undefined) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function baseName(p) {
  const parts = String(p ?? "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p ?? "");
}

function firstLine(s) {
  return (String(s ?? "").split("\n", 1)[0] ?? "").trim();
}

function age(iso) {
  const t = Date.parse(iso ?? "");
  if (!isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 90) return "1m ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 7200) return "1h ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

/** Verdict JSON in puli's own shape: 2-space indent + trailing newline.
 *  `comments` (reject only — approves drop them) are the card's picked
 *  line comments. */
function verdictText(id, decision, message, comments) {
  const v = { id, decision };
  const c = (message ?? "").trim();
  if (c) v.message = c;
  if (decision === "reject" && Array.isArray(comments) && comments.length > 0) {
    v.comments = comments.map((k) => ({ file: k.file, start: k.start, end: k.end, text: k.text }));
  }
  return JSON.stringify(v, null, 2) + "\n";
}

/** History lines → newest-first entries (≤ limit). Missing/invalid → fewer. */
function parseHistory(text, limit = 10) {
  if (text === null || text === undefined) return [];
  const out = [];
  for (const line of String(text).split("\n")) {
    if (line.trim() === "") continue;
    const v = parseJson(line);
    if (!v || typeof v.decision !== "string" || typeof v.at !== "string") continue;
    out.push({
      id: typeof v.id === "string" ? v.id : "",
      subject: typeof v.subject === "string" ? v.subject : "",
      repo: typeof v.repo === "string" ? v.repo : "",
      branch: typeof v.branch === "string" ? v.branch : "",
      decision: v.decision,
      detail: typeof v.detail === "string" ? v.detail : "",
      at: v.at,
    });
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return out.slice(0, limit);
}

/** The short, human-facing form of an id (its random6 tail), like the CLI. */
function shortId(id) {
  const parts = String(id ?? "").split("-");
  const tail = parts[parts.length - 1] ?? "";
  return tail.length >= 6 ? tail : String(id ?? "").slice(-6);
}

// ── patch parsing (the frozen `patch` field → per-file sections) ─────────
//
// A unified diff splits into sections at every `diff --git ` line. Each
// section keeps its filename (from `+++ b/...`, falling back to the
// diff --git line), +/− counts, and DISPLAY rows in Zed-editor style:
// only the AFTER state is listed — added lines, context lines and @@
// hunk headers; removed lines are NOT listed inline. Consecutive '- '
// lines form a removal group attached to the NEXT rendered row (or a
// standalone dim "tail" row at the end of the section); the row then
// carries a thin red marker, and hovering it reveals the group inline.
// index/mode/old-new header lines are skipped. Everything is bounded so
// a huge patch cannot freeze the panel: lines are left-trimmed to
// PATCH_LINE_CAP chars, a file renders at most DIFF_ROW_CAP rows (with
// a "use puli diff" note), a card lists at most FILE_ROW_CAP file rows.

const PATCH_LINE_CAP = 400; // chars kept per diff line (long lines: keep the tail)
const DIFF_ROW_CAP = 800;   // rendered rows per expanded file
const FILE_ROW_CAP = 200;   // file rows per card

/** Header lines inside a section that carry no review value. */
function isSkippedHeader(line) {
  return line.startsWith("index ") ||
    line.startsWith("old mode ") || line.startsWith("new mode ") ||
    line.startsWith("new file mode ") || line.startsWith("deleted file mode ") ||
    line.startsWith("similarity index ") || line.startsWith("dissimilarity index ") ||
    line.startsWith("rename from ") || line.startsWith("rename to ") ||
    line.startsWith("copy from ") || line.startsWith("copy to ") ||
    line.startsWith("--- ") || line.startsWith("+++ ") ||
    line.startsWith("Binary files ") || line.startsWith("GIT binary patch") ||
    line.startsWith("diff --git ");
}

/** Strip git's quoting ("b/path with spaces") → path. */
function unquote(p) {
  const s = String(p ?? "");
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

/** `+++ b/foo` / `+++ b/dev/null` style → foo; null when not a b-path. */
function bPath(line, prefix) {
  const s = String(line ?? "");
  if (!s.startsWith(prefix)) return null;
  const rest = unquote(s.slice(prefix.length));
  return rest === "/dev/null" ? null : rest;
}

/** One bounded display line: left-trimmed to PATCH_LINE_CAP chars. */
function capLine(raw) {
  return raw.length > PATCH_LINE_CAP
    ? "…" + raw.slice(raw.length - (PATCH_LINE_CAP - 1))
    : raw;
}

/**
 * Parse a frozen patch into per-file sections:
 *   { name, status: "" | "new" | "deleted" | "binary" | "meta",
 *     add, del, truncated, rows: [row] }
 * Row shapes (the AFTER state; removed lines live in `removed` groups).
 *   `line` is the NEW-side line number of an after-row (context and add
 *   rows each consume one, counting from the @@ header's +c value); rows
 *   with no new-side number (hunk, note, tail, "\ No newline") carry
 *   null — only rows with a number are selectable for line comments.
 *   { t: "hunk", s, line: null, removed?: string[] }  @@ header (also
 *                                         inherits a trailing removal
 *                                         group of the previous hunk)
 *   { t: "add", s, line: number | null, removed?: string[] }  '+ line'
 *   { t: "ctx", s, line: number | null, removed?: string[] }  context
 *   { t: "tail", s: "", line: null, removed: string[] }  standalone
 *                                         end-of-section row for a group
 *                                         with no survivor
 * Empty/missing/non-string patch → []. Malformed input degrades to
 * whatever sections could be recovered — never throws (render is pure).
 */
function parsePatch(patchText) {
  const files = [];
  if (typeof patchText !== "string" || patchText.trim() === "") return files;
  let cur = null;
  const flush = () => {
    if (cur && cur.name !== "") {
      if (cur.pending.length > 0) {
        // a removal group with no following line anywhere in the section
        // (deletion at end of file) rides a standalone dim row
        cur.rows.push({ t: "tail", s: "", line: null, removed: cur.pending });
        cur.pending = [];
      }
      files.push(cur);
    }
  };
  for (const raw of patchText.split("\n")) {
    if (raw === "") continue; // blank/trailing lines carry nothing
    if (raw.startsWith("diff --git ")) {
      flush();
      // fallback name straight from the header; refined by +++ below
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      cur = {
        name: m ? unquote(m[2]) : raw.slice(11),
        status: "",
        add: 0,
        del: 0,
        truncated: false,
        rows: [],
        pending: [], // removal group waiting for its next rendered row
        line: null,  // next NEW-side line number (set by each @@ header)
      };
      continue;
    }
    if (cur === null) continue; // junk before the first section
    if (isSkippedHeader(raw)) {
      if (raw.startsWith("new file mode ")) cur.status = "new";
      else if (raw.startsWith("deleted file mode ")) cur.status = "deleted";
      else if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
        cur.status = "binary";
      } else if (raw.startsWith("+++ ")) {
        // primary name source: the +++ b/<path> line (more precise than
        // the diff --git header for exotic/quoted paths)
        const n = bPath(raw, "+++ b/");
        if (n !== null) cur.name = n;
      }
      continue;
    }
    if (cur.status === "binary") continue; // binary payload: not for humans
    if (raw.startsWith("... (patch truncated")) {
      cur.truncated = true;
      cur.rows.push({ t: "note", s: raw, line: null });
      continue;
    }
    if (raw.startsWith("@@")) {
      // a removal group at the end of the previous hunk attaches to this
      // header row (the hunk-header fallback)
      const take = cur.pending;
      cur.pending = [];
      // ...and the new-side counter restarts at the header's +<start>
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
      if (h) cur.line = parseInt(h[1], 10);
      cur.rows.push(take.length ? { t: "hunk", s: capLine(raw), line: null, removed: take }
        : { t: "hunk", s: capLine(raw), line: null });
      continue;
    }
    if (raw.startsWith("-")) { // removed: NOT rendered inline (hover shows it)
      cur.pending.push(capLine(raw));
      cur.del += 1;
      continue;
    }
    if (raw.startsWith("+")) {
      cur.add += 1;
      const take = cur.pending;
      cur.pending = [];
      const line = cur.line; // this after-row's NEW-side number, if any
      if (line !== null) cur.line = line + 1;
      cur.rows.push(take.length ? { t: "add", s: capLine(raw), line, removed: take }
        : { t: "add", s: capLine(raw), line });
      continue;
    }
    if (raw.startsWith(" ") || raw.startsWith("\\")) {
      if (raw.startsWith("\\") && cur.pending.length > 0) {
        cur.pending.push(capLine(raw)); // "\ No newline…" of a removed line
        continue;
      }
      const take = cur.pending;
      cur.pending = [];
      if (raw.startsWith("\\")) {
        // "\ No newline…" of a surviving line: not a line itself
        cur.rows.push(take.length ? { t: "ctx", s: capLine(raw), line: null, removed: take }
          : { t: "ctx", s: capLine(raw), line: null });
        continue;
      }
      const line = cur.line;
      if (line !== null) cur.line = line + 1;
      cur.rows.push(take.length ? { t: "ctx", s: capLine(raw), line, removed: take }
        : { t: "ctx", s: capLine(raw), line });
      continue;
    }
    // anything else inside a section: treat as context
    const line = cur.line;
    if (line !== null) cur.line = line + 1;
    cur.rows.push({ t: "ctx", s: capLine(" " + raw), line });
  }
  flush();
  // A section whose only content rows are none (rename/mode-only) → meta.
  for (const f of files) {
    if (f.status === "" && f.rows.length === 0) f.status = "meta";
    delete f.pending;
    delete f.line;
  }
  return files;
}

/**
 * Greedy word wrap of the card subject into at most 2 lines, with an
 * ellipsis when it does not fit. gpui has no native line clamp, so the
 * line budget is an estimate from the panel width (see subjectChars).
 */
function wrap2(s, maxChars) {
  const words = String(s ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let overflow = false;
  for (const w of words) {
    const cur = lines.length ? lines[lines.length - 1] : null;
    if (cur !== null && cur.length + 1 + w.length <= maxChars) {
      lines[lines.length - 1] = cur + " " + w;
      continue;
    }
    if (lines.length === 2) {
      overflow = true; // a third line would be needed
      break;
    }
    if (w.length > maxChars) {
      lines.push(w.slice(0, Math.max(1, maxChars - 1)) + "…");
      overflow = true;
      break;
    }
    lines.push(w);
  }
  if (overflow && lines.length) {
    let last = lines[lines.length - 1];
    if (last.length > maxChars) last = last.slice(0, maxChars - 1);
    lines[lines.length - 1] = last + "…";
  }
  return lines.length ? lines : [""];
}

/** Word-wrap text into visual lines of ≤ maxChars, keeping paragraph
 *  breaks; over-long words hard-split. Well lines are laid out at fixed
 *  heights, so they must be pre-wrapped (auto-wrap inside a fixed-height
 *  div overprints). */
function wrapText(s, maxChars) {
  const out = [];
  for (const para of String(s ?? "").replace(/\n$/, "").split("\n")) {
    if (para.trim() === "") {
      out.push("");
      continue;
    }
    let cur = "";
    for (let word of para.split(" ")) {
      while (word.length > maxChars) { // pathological token: hard-split
        const room = maxChars - (cur === "" ? 0 : cur.length + 1);
        if (room > 0) {
          out.push(cur === "" ? word.slice(0, room) : cur + " " + word.slice(0, room));
          word = word.slice(room);
        } else out.push(cur);
        cur = "";
      }
      if (cur === "") cur = word;
      else if (cur.length + 1 + word.length <= maxChars) cur += " " + word;
      else {
        out.push(cur);
        cur = word;
      }
    }
    out.push(cur);
  }
  return out;
}

const mono = () => settings().font_family ?? "JetBrains Mono";

/** Blend two "#rrggbb" colors: mix(a, b, 0.2) = 20% a over b. Falls back
 *  to `a` for anything unparseable — tints must never break rendering. */
function mix(a, b, k) {
  const pa = /^#([0-9a-f]{6})$/i.exec(String(a ?? ""));
  const pb = /^#([0-9a-f]{6})$/i.exec(String(b ?? ""));
  if (!pa || !pb) return a;
  const ca = parseInt(pa[1], 16);
  const cb = parseInt(pb[1], 16);
  const r = Math.round(((ca >> 16) & 255) * k + ((cb >> 16) & 255) * (1 - k));
  const g = Math.round(((ca >> 8) & 255) * k + ((cb >> 8) & 255) * (1 - k));
  const bch = Math.round((ca & 255) * k + (cb & 255) * (1 - k));
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + bch).toString(16).slice(1);
}

export default class Puli extends View {
  init(_props, cx) {
    // Stale-copy cleanup: a previous attempt left a kept overlay window behind
    // (windows.json "puli-review", props {host: true}) that no CLI command
    // removes. The copy that finds itself inside that overlay closes itself —
    // "a kept window closed this way stays closed" (herdr.d.ts). Docked/pane
    // copies get no overlay prop and never hit this.
    const mine = props();
    if (mine && mine.host === true && typeof mine.overlay === "string") {
      closeOverlay(mine.overlay);
    }

    this.byFile = new Map(); // filename -> {..proposal, sum} | {error, sum}
    this.rejectingId = null; // proposal id whose comment input is open
    this.openFiles = new Map(); // proposal id -> Set of open file names (accordion)
    this.hoveredMark = null; // marker id (id-fileIdx-rowIdx) whose removals show
    // Line-comment state (in-memory only; nothing is written until the
    // verdict). Selection keys are "<proposal id>\u0000<file name>" →
    // Set of row indexes into that file section's rows.
    this.selection = new Map(); // key -> Set(rowIdx) of selected diff rows
    this.selAnchor = new Map(); // key -> rowIdx last clicked (shift-range start)
    this.comments = new Map(); // proposal id -> [{file, start, end, text}]
    this.activeCardId = null; // card lines were last picked on (Esc target)
    this.activeSelKey = null; // key whose comment input shows
    this.sentId = null;      // id this panel wrote a verdict for (awaiting pickup)
    this.seenVerdictKey = null; // verdict content last seen in verdict.json
    this.seenVerdictAt = 0;  // when that content first appeared
    this.sentDecision = null;
    this.busyId = null;      // proposal id with a verdict write in flight
    this.err = null;
    this.errId = null;       // proposal id the error belongs to
    this.histOpen = true;    // history section expanded by default
    this.history = [];       // newest-first settled entries
    this.lastHistoryText = null; // raw bytes; re-parse only on change
    this.ageBucket = null;
    this.width = null;       // panel width, for the 2-line subject estimate

    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "comment — Enter sends · Esc cancels" });
    this.input.on("submit", (_e, cx) => {
      const item = this.rejectingId === null
        ? null
        : this.items().find((i) => i.id === this.rejectingId) ?? null;
      if (item) cx.spawn((c) => this.decide(item, "reject", this.input.value(), c));
    });
    this.lineInput = InputState.new({ placeholder: "line comment — Enter adds" });
    this.lineInput.on("submit", (_e, cx) => this.addLineComment(cx));

    cx.timer.every(1000, (cx) => this.poll(cx));
    this.poll(cx);
  }

  // ── data ────────────────────────────────────────────────────────────────

  readJson(path) {
    return readTextFile(path).then(parseJson, () => null);
  }

  /** Pending proposals, oldest first; unreadable files flagged separately. */
  items() {
    return Array.from(this.byFile.values())
      .filter((r) => !r.error)
      .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  }

  errorFiles() {
    return Array.from(this.byFile.values()).filter((r) => r.error);
  }

  /** The verdict on record for an id: "sent" (ours), "approve"/"reject"
   *  (someone else's, e.g. the CLI), or null. */
  statusOf(item, verdict) {
    if (this.sentId === item.id) return "sent";
    if (verdict && verdict.id === item.id) return "answered";
    return null;
  }

  async poll(cx) {
    // 1) list the pending dir (name + checksum per file)
    let lines = [];
    try {
      const r = await exec("sh", ["-c", LIST_SH, "puli", PENDING_DIR]);
      if (r.code === 0) lines = r.stdout.split("\n");
    } catch {
      return; // transient; the next tick retries
    }
    const seen = new Map();
    for (const line of lines) {
      const tab = line.indexOf("\t");
      if (tab <= 0) continue;
      const name = line.slice(0, tab);
      if (SAFE_NAME.test(name)) seen.set(name, line.slice(tab + 1));
    }

    let changed = false;
    for (const name of Array.from(this.byFile.keys())) {
      if (!seen.has(name)) {
        this.byFile.delete(name);
        changed = true;
      }
    }
    for (const [name, sum] of seen) {
      const cur = this.byFile.get(name);
      if (cur && cur.sum === sum) continue; // unchanged
      const p = parseJson(await readTextFile(PENDING_DIR + "/" + name).catch(() => null));
      this.byFile.set(
        name,
        p && typeof p.id === "string" && typeof p.repo === "string"
          ? {
              id: p.id,
              repo: p.repo,
              branch: p.branch,
              kind: p.kind === "push" || p.kind === "git" ? p.kind : "",
              remote: typeof p.remote === "string" ? p.remote : "",
              message: String(p.message ?? ""),
              stat: String(p.stat ?? ""),
              files: Array.isArray(p.files) ? p.files.map((f) => String(f)) : [],
              patch: typeof p.patch === "string" ? p.patch : "", // old proposals: none
              createdAt: p.createdAt,
              file: name,
              sum,
              error: false,
            }
          : { file: name, sum, error: true });
      changed = true;
    }

    // 2) the transient verdict file
    let verdict = null;
    try {
      verdict = await this.readJson(VERDICT);
    } catch {
      verdict = null;
    }
    if (!Object.is(verdict, this.lastVerdict)) {
      this.lastVerdict = verdict;
      changed = true;
    }

    // 2b) a verdict no live waiter will ever consume:
    //   - its proposal is gone (orphan), or
    //   - it has sat unconsumed >10 s (a live waiter polls every 500 ms, so
    //     a real consume takes under a second; only a dead/absent waiter
    //     leaves a verdict standing — approve on such a card must not stick)
    if (verdict && typeof verdict.id === "string") {
      const ids = new Set(this.items().map((i) => i.id));
      const key = JSON.stringify(verdict);
      if (!ids.has(verdict.id) || (this.seenVerdictKey === key && Date.now() - this.seenVerdictAt > 10_000)) {
        if (this.seenVerdictKey !== key) { this.seenVerdictKey = key; this.seenVerdictAt = Date.now(); }
        const targets = ids.has(verdict.id) ? [PENDING_DIR + "/" + verdict.id + ".json"] : [];
        targets.push(VERDICT);
        try { await exec("sh", ["-c", 'rm -f "$@"', "puli", ...targets]); } catch { /* best effort */ }
        if (this.sentId === verdict.id) this.sentId = null;
        this.lastVerdict = null;
        verdict = null;
        changed = true;
      } else if (this.seenVerdictKey !== key) {
        this.seenVerdictKey = key;
        this.seenVerdictAt = Date.now();
      }
    }

    // 3) history: re-read every cycle, re-parse only when the bytes changed
    let hText = null;
    try {
      hText = await readTextFile(HISTORY);
    } catch {
      hText = null; // missing file → empty section
    }
    if (hText !== this.lastHistoryText) {
      this.lastHistoryText = hText;
      this.history = parseHistory(hText);
      changed = true;
    }

    // 4) per-card state repair: a settled proposal's file disappears
    const live = (id) => this.items().some((i) => i.id === id);
    // 4a) expired proposals: their waiter is gone (timed out or died), so
    // no one will consume a verdict for them — remove the card and any
    // verdict aimed at it, or an approved request sticks in the queue.
    for (const p of this.items()) {
      if (typeof p.expiresAt === "string" && !Number.isNaN(Date.parse(p.expiresAt))) {
        if (Date.parse(p.expiresAt) < Date.now()) {
          const targets = [PENDING_DIR + "/" + p.id + ".json"];
          let verdict = null;
          try { verdict = await this.readJson(VERDICT); } catch { verdict = null; }
          if (verdict && verdict.id === p.id) targets.push(VERDICT);
          try {
            await exec("sh", ["-c", 'rm -f "$1" ${2:+\"$2\"}', "puli", ...targets]);
          } catch { /* best effort */ }
          if (this.sentId === p.id) this.sentId = null;
          if (this.lastVerdict && this.lastVerdict.id === p.id) this.lastVerdict = null;
          changed = true;
        }
      }
    }
    if (this.rejectingId !== null && !live(this.rejectingId)) {
      this.rejectingId = null;
      this.input.set_value("");
      changed = true;
    }
    for (const id of Array.from(this.openFiles.keys())) {
      if (!live(id)) { // settled → its accordion state goes with it
        this.openFiles.delete(id);
        changed = true;
      }
    }
    // …and its line-comment state (selection keys carry the id before \u0000)
    for (const key of Array.from(this.selection.keys())) {
      if (!live(key.slice(0, key.indexOf("\u0000")))) {
        this.selection.delete(key);
        this.selAnchor.delete(key);
        changed = true;
      }
    }
    for (const id of Array.from(this.comments.keys())) {
      if (!live(id)) { // settled → drafted comments go with the card
        this.comments.delete(id);
        changed = true;
      }
    }
    if (this.activeCardId !== null && !live(this.activeCardId)) {
      this.activeCardId = null;
      changed = true;
    }
    if (this.activeSelKey !== null && !this.selection.has(this.activeSelKey)) {
      this.activeSelKey = null;
      this.lineInput.set_value("");
      changed = true;
    }
    // first sight of each proposal → its first file starts expanded
    for (const p of this.items()) {
      if (Array.isArray(p.files) && p.files.length > 0) {
        changed = this.ensureDefaultOpen(p.id, p.files[0], changed);
      }
    }
    if (this.errId !== null && !live(this.errId)) {
      this.errId = null;
      this.err = null;
      changed = true;
    }
    // our sent verdict was consumed when its proposal's file is gone
    if (this.sentId !== null && !live(this.sentId)) {
      this.sentId = null;
      this.sentDecision = null;
      changed = true;
    }

    // Re-render at most once a minute otherwise (the age labels — queue
    // and history both).
    const times = [];
    for (const i of this.items()) times.push(Date.parse(i.createdAt ?? ""));
    for (const h of this.history) times.push(Date.parse(h.at ?? ""));
    const bucket = times.length
      ? times.reduce((m, t) => (isFinite(t) ? Math.max(m, Math.floor((Date.now() - t) / 60000)) : m), -1)
      : null;
    if (changed || bucket !== this.ageBucket) {
      this.ageBucket = bucket;
      cx.notify();
    }
  }

  /** Write verdict.json byte-exactly and atomically; verify by reading back. */
  async writeVerdict(text, id) {
    // Never clobber a concurrent answer: if the CLI already wrote a verdict
    // for this proposal, leave it alone (the poll will show "answered").
    const current = await this.readJson(VERDICT);
    if (current && current.id === id) return true;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await exec("sh", ["-c", WRITE_SH, "puli", text, VERDICT]);
      } catch (e) {
        this.err = "verdict write failed: " + String((e && (e.stderr || e.message)) || e).trim().slice(0, 200);
        this.errId = id;
        continue;
      }
      let back = null;
      try {
        back = await readTextFile(VERDICT);
      } catch {
        back = null;
      }
      if (back === text) return true; // byte-exact after writing
    }
    return false;
  }

  async decide(item, decision, comment, cx) {
    if (!item || this.busyId !== null || this.sentId === item.id) return;
    // verdict.json is a single slot: while our last verdict is still waiting
    // to be consumed, answering another proposal would overwrite it.
    if (this.sentId !== null) {
      this.err = "a sent verdict is still waiting for puli…";
      this.errId = item.id;
      cx.notify();
      return;
    }
    this.busyId = item.id;
    this.err = null;
    this.errId = null;
    try {
      // a reject carries the card's drafted line comments; an approve
      // never does (comments on an approved card are simply dropped)
      const comments = decision === "reject" ? (this.comments.get(item.id) ?? []) : undefined;
      const ok = await this.writeVerdict(verdictText(item.id, decision, comment, comments), item.id);
      if (ok) {
        this.sentId = item.id;
        this.sentDecision = decision;
        this.rejectingId = null;
        this.input.set_value("");
        this.err = null;
      }
    } finally {
      this.busyId = null;
      cx.notify();
    }
  }

  // ── the files accordion (all local state; no view changes) ─────────────

  /** Parsed per-file sections of an item's frozen patch — parsed once,
   *  lazily, and cached on the item (a new item object arrives whenever
   *  the pending file's checksum changes). */
  diffFiles(item) {
    if (!item.diffFiles) item.diffFiles = parsePatch(item.patch);
    return item.diffFiles;
  }

  /** Click on a file row: expand/collapse that file's inline diff. */
  toggleFile(id, name, cx) {
    let open = this.openFiles.get(id);
    if (!open) {
      open = new Set();
      this.openFiles.set(id, open);
    }
    if (open.has(name)) open.delete(name);
    else open.add(name);
    cx.notify();
  }

  /** First sight of a proposal: open its first file so a diff is always
   *  visible immediately (nothing hidden behind a click on arrival). */
  ensureDefaultOpen(id, firstName, changed) {
    if (this.openFiles.has(id) || !firstName) return changed;
    this.openFiles.set(id, new Set([firstName]));
    return true;
  }

  // ── line selection & comments (in-memory; only the verdict is written) ──

  /** Click on a diff row: toggle it, or (shift) select the range from the
   *  last plain click to this row. Only rows with a line number take
   *  part — hunk/note/tail rows are never selectable. */
  rowClick(item, file, rIdx, shift, cx) {
    const key = item.id + "\u0000" + file.name;
    let sel = this.selection.get(key) ?? new Set();
    const anchor = this.selAnchor.get(key);
    if (shift && anchor !== undefined) {
      const lo = Math.min(anchor, rIdx);
      const hi = Math.max(anchor, rIdx);
      for (let i = lo; i <= hi; i++) {
        if (file.rows[i] && file.rows[i].line !== null) sel.add(i);
      }
    } else {
      if (sel.has(rIdx)) sel.delete(rIdx);
      else sel.add(rIdx);
      this.selAnchor.set(key, rIdx); // plain click moves the range anchor
    }
    if (sel.size === 0) this.selection.delete(key);
    else this.selection.set(key, sel);
    this.activeCardId = item.id;
    this.activeSelKey = this.selection.has(key) ? key : null;
    cx.notify();
  }

  /** Esc: drop every picked line of one card. Returns true if it had any. */
  clearCardSelection(id) {
    const prefix = id + "\u0000";
    let had = false;
    for (const key of Array.from(this.selection.keys())) {
      if (key.startsWith(prefix)) {
        this.selection.delete(key);
        this.selAnchor.delete(key);
        had = true;
      }
    }
    if (this.activeSelKey !== null && this.activeSelKey.startsWith(prefix)) {
      this.activeSelKey = null;
      this.lineInput.set_value("");
    }
    return had;
  }

  /** The NEW-side line numbers of a key's selected rows, ascending; []
   *  when nothing (valid) is selected. */
  selLines(item, name) {
    const file = this.diffFiles(item).find((f) => f.name === name);
    const sel = this.selection.get(item.id + "\u0000" + name);
    if (!file || !sel) return [];
    const lines = [];
    for (const i of sel) {
      const r = file.rows[i];
      if (r && r.line !== null) lines.push(r.line);
    }
    return lines.sort((a, b) => a - b);
  }

  /** Enter in the line-comment input (or its button): append the comment
   *  to the card's list and clear that file's selection. */
  addLineComment(cx) {
    const key = this.activeSelKey;
    if (key === null) return;
    const text = this.lineInput.value().trim();
    if (text === "") return;
    const tab = key.indexOf("\u0000");
    const id = key.slice(0, tab);
    const item = this.items().find((i) => i.id === id);
    if (!item) return;
    const lines = this.selLines(item, key.slice(tab + 1));
    if (lines.length === 0) return;
    const list = this.comments.get(id) ?? [];
    list.push({ file: key.slice(tab + 1), start: lines[0], end: lines[lines.length - 1], text });
    this.comments.set(id, list);
    this.selection.delete(key);
    this.selAnchor.delete(key);
    this.activeSelKey = null;
    this.lineInput.set_value("");
    cx.notify();
  }

  /** One row of a file's AFTER-state diff, Zed-editor style. Fixed
   *  height — rows in scroll boxes must be sized explicitly or they
   *  collapse to nothing (the well() pattern). A row that inherited a
   *  removal group starts with a thin red marker; hovering the marker
   *  (this.hoveredMark) reveals the group as a ghost block right below. */
  diffRow(t, item, file, fIdx, row, rIdx) {
    const markId = item.id + "-" + fIdx + "-" + rIdx;
    const isAdd = row.t === "add";
    const isHunk = row.t === "hunk";
    const isNote = row.t === "note";
    const hasMark = Array.isArray(row.removed) && row.removed.length > 0;
    const ghost = hasMark && this.hoveredMark === markId;
    const selected = this.selection.get(item.id + "\u0000" + file.name)?.has(rIdx) === true;
    // selection tint sits ON TOP of the add tint (accent over either)
    let bg = isAdd ? mix(t.done, t.background, 0.16) : null;
    if (selected) bg = mix(t.accent, bg ?? t.background, 0.2);
    const rows = [];
    // the row itself: [line gutter | marker hit-area | text]; the gutter
    // shows the NEW-side line number (blank on hunk/note/tail rows),
    // always dim; the marker (Zed-style gutter chip) sits at the START
    // of the next surviving line. Rows with a new-side line number are
    // clickable: pick lines to comment on.
    rows.push(
      h_flex().id("dl-" + markId).h(18).flex_none().items_stretch()
        .when(bg !== null, (e) => e.bg(bg))
        .when(row.line !== null, (e) => e.cursor_pointer()
          .on_click((ev, cx) => this.rowClick(item, file, rIdx,
            Boolean(ev && ev.modifiers && ev.modifiers.shift), cx)))
        .child(
          div().w(30).flex_none().pr(3).text_right()
            .font_family(mono()).text_size(10).text_color(t.dim)
            .child(row.line === null ? "" : String(row.line)))
        .child(
          hasMark
            ? h_flex().id("mk-" + markId).w(9).h(18).flex_none().items_center()
                .cursor_pointer()
                .on_hover((hovered, cx) => {
                  if (hovered) this.hoveredMark = markId;
                  else if (this.hoveredMark === markId) this.hoveredMark = null;
                  cx.notify();
                })
                .child(div().w(3).h(12).flex_none().rounded(1).bg(t.blocked))
            : div().w(9).h(18).flex_none())
        .child(div().flex_1().min_w(0).pl(3).font_family(mono()).text_size(11)
          .whitespace_nowrap()
          .when(isHunk || isNote, (e) => e.font_semibold())
          .text_color(
            isNote || isHunk ? t.muted :
            isAdd ? t.done :
            t.dim) // context
          .child(row.s === "" ? "\u00a0" : row.s)));
    // the revealed removal group: inline ghost block, red tint, indented
    if (ghost) {
      for (let g = 0; g < row.removed.length; g++) {
        const gl = row.removed[g];
        rows.push(
          div().id("gh-" + markId + "-" + g).h(18).flex_none().font_family(mono())
            .text_size(11).whitespace_nowrap()
            .bg(mix(t.blocked, t.background, 0.13))
            .pl(24).text_color(t.blocked)
            .child(gl === "" ? "\u00a0" : gl));
      }
    }
    return rows;
  }

  /** The expanded view of one file: a bounded, scrollable mono well
   *  showing the AFTER state (added lines tinted green, context dim, @@
   *  headers as dim separators; removals as red gutter markers with
   *  hover-reveal). Nothing here runs anything — the patch is already
   *  on disk in pending/<id>.json. DIFF_ROW_CAP rows max (then a
   *  "+N more lines" note). The well scrolls sideways too: the rows
   *  wrapper is min-width-sized to the longest rendered line (the
   *  Changes mod's overflow_x pattern), so rows render at full length
   *  instead of truncating at the panel width. */
  diffWell(t, item, file, idx) {
    const id = item.id + "-" + idx;
    const rows = [];
    const texts = []; // every rendered line string, for the min width
    const addText = (s) => texts.push(s);
    if (file.status === "binary") {
      const s = "binary file — no text diff";
      addText(s);
      rows.push(div().id("dl-" + id + "-bin").h(18).flex_none().font_family(mono())
        .text_size(11).text_color(t.muted).child(s));
    } else if (file.status === "meta") {
      const s = "no text changes (rename / mode change only)";
      addText(s);
      rows.push(div().id("dl-" + id + "-meta").h(18).flex_none().font_family(mono())
        .text_size(11).text_color(t.muted).child(s));
    } else if (file.rows.length === 0) {
      const s = "(empty diff)";
      addText(s);
      rows.push(div().id("dl-" + id + "-empty").h(18).flex_none().font_family(mono())
        .text_size(11).text_color(t.muted).child(s));
    } else {
      const shown = file.rows.slice(0, DIFF_ROW_CAP);
      shown.forEach((row, i) => {
        addText(row.s);
        if (Array.isArray(row.removed)) for (const gl of row.removed) addText(gl);
        rows.push(...this.diffRow(t, item, file, idx, row, i));
      });
      if (file.rows.length > DIFF_ROW_CAP) {
        const s = "+" + (file.rows.length - DIFF_ROW_CAP) + " more lines — use puli diff " + shortId(item.id);
        addText(s);
        rows.push(div().id("dl-" + id + "-more").h(18).flex_none().font_family(mono())
          .text_size(11).font_semibold().text_color(t.muted).child(s));
      }
    }
    // ghost rows only exist while hovered; size the well from the base rows
    const boxH = Math.min(300, Math.max(14 + 18, rows.length * 18 + 18));
    // longest line at the mono advance (11px ≈ 6.5px/char, 7 leaves
    // margin) + gutter + marker + text padding + a little right room
    let maxChars = 0;
    for (const s of texts) if (s.length > maxChars) maxChars = s.length;
    const minW = 30 + 9 + 3 + Math.ceil(maxChars * 7) + 8;
    return v_flex().id("dw-" + id).flex_none().pl(14).pt(1)
      .child(div().id("dwb-" + id).h(boxH).overflow_scrollbar()
        .py(8).rounded(6).bg(t.background).border_1().border_color(t.border)
        .child(div().id("dwr-" + id).w_full().min_w(minW).children(rows)));
  }

  /** Under a file's well, when that file has picked lines: the selection
   *  summary ("main.py 14-17"), and — for the file lines were last
   *  picked in — the comment input. Enter (or the button) appends the
   *  comment to the card's list and clears the selection; Esc clears it. */
  lineCommentBox(t, item, file, fIdx) {
    const lines = this.selLines(item, file.name);
    if (lines.length === 0) return null;
    const start = lines[0];
    const end = lines[lines.length - 1];
    const id = item.id + "-" + fIdx;
    const active = this.activeSelKey === item.id + "\u0000" + file.name;
    return v_flex().id("lcbox-" + id).flex_none().pl(14).pt(2).gap(4)
      .child(h_flex().id("lcsum-" + id).h(16).flex_none().items_center().gap(6)
        .child(div().flex_none().font_family(mono()).text_size(10.5).text_color(t.accent)
          .child(file.name + " " + (start === end ? String(start) : start + "-" + end)))
        .child(div().flex_1())
        .child(div().flex_none().text_size(10).text_color(t.dim)
          .child(lines.length + (lines.length === 1 ? " line" : " lines") + " · Esc clears")))
      .when(active, (e) => e.child(
        h_flex().id("lcrow-" + id).flex_none().items_center().gap(8)
          .child(div().id("lcin-" + id).flex_1().min_w(0).h(30).px(10).flex().items_center()
            .rounded(8).border_1().border_color(t.accent).bg(t.background).cursor_text()
            .child(Input.new(this.lineInput).h_full().text_size(12).text_color(t.foreground)))
          .child(this.button("lcadd-" + id, "Comment", t.accent, t.accent_foreground, t.accent,
            (_e, cx) => this.addLineComment(cx)))));
  }

  /** One file row of the accordion: caret, mono filename, status hint,
   *  +/− counts. Click expands that file's diff right below it. */
  fileRow(t, item, file, idx, isOpen) {
    const id = item.id + "-" + idx;
    return h_flex().id("fr-" + id).h(22).flex_none().px(6).gap(6).items_center()
      .rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggleFile(item.id, file.name, cx))
      .child(div().flex_none().w(10).text_size(10).text_color(t.dim)
        .child(isOpen ? "▾" : "▸"))
      .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(11)
        .text_color(isOpen ? t.foreground : t.muted)
        .tooltip(file.name)
        .child(file.name))
      .when(file.status === "new", (e) => e.child(
        div().flex_none().text_size(10).font_semibold().text_color(t.done).child("new")))
      .when(file.status === "deleted", (e) => e.child(
        div().flex_none().text_size(10).font_semibold().text_color(t.blocked).child("deleted")))
      .when(file.add > 0, (e) => e.child(
        div().flex_none().font_family(mono()).text_size(10.5).text_color(t.done)
          .child("+" + file.add)))
      .when(file.del > 0, (e) => e.child(
        div().flex_none().font_family(mono()).text_size(10.5).text_color(t.blocked)
          .child("-" + file.del)));
  }

  /** The card's file accordion, straight from the frozen patch: a mini
   *  header (label + total +/−), one row per changed file, the expanded
   *  inline diff under any open row. No patch (old proposals, write
   *  failures) → a "no patch captured" note instead. A push proposal
   *  has no diff by design — just its push line; a git-command proposal
   *  (kind: "git") likewise shows its command line (message = command). */
  filesSection(t, item) {
    if (item.kind === "push" || item.kind === "git") {
      return v_flex().flex_none().pt(2)
        .child(div().font_family(mono()).text_size(11).text_color(t.dim)
          .child(item.kind === "push"
            ? "push: " + String(item.branch ?? "") + " → " + (item.remote || "origin")
            : String(item.message ?? "")));
    }
    const files = this.diffFiles(item);
    if (files.length === 0) {
      return v_flex().flex_none().pt(2)
        .child(div().text_size(11).text_color(t.dim)
          .child("no patch captured — use puli diff " + shortId(item.id)));
    }
    let totA = 0;
    let totD = 0;
    for (const f of files) {
      totA += f.add;
      totD += f.del;
    }
    const open = this.openFiles.get(item.id) ?? new Set();
    const rows = [];
    const shown = files.slice(0, FILE_ROW_CAP);
    shown.forEach((f, i) => {
      const isOpen = open.has(f.name);
      rows.push(this.fileRow(t, item, f, i, isOpen));
      if (isOpen) {
        rows.push(this.diffWell(t, item, f, i));
        const box = this.lineCommentBox(t, item, f, i);
        if (box) rows.push(box);
      }
    });
    if (files.length > FILE_ROW_CAP) {
      rows.push(div().flex_none().px(6).text_size(10.5).text_color(t.muted)
        .child("+" + (files.length - FILE_ROW_CAP) + " more files — use puli diff " + shortId(item.id)));
    }
    return v_flex().flex_none().pt(2).gap(1)
      .child(h_flex().flex_none().px(6).items_center().gap(6)
        .child(div().text_size(10.5).text_color(t.dim).child("files"))
        .child(div().flex_1())
        .when(totA > 0, (e) => e.child(
          div().font_family(mono()).text_size(10.5).text_color(t.done).child("+" + totA)))
        .when(totD > 0, (e) => e.child(
          div().font_family(mono()).text_size(10.5).text_color(t.blocked).child("-" + totD))))
      .children(rows);
  }

  // ── ui ──────────────────────────────────────────────────────────────────

  button(id, label, bg, fg, borderC, action) {
    return h_flex().id(id).h(30).px(12).items_center().rounded(8).flex_none()
      .border_1().border_color(borderC).bg(bg).text_color(fg)
      .text_size(12).font_semibold().cursor_pointer()
      .hover((s) => s.opacity(0.85))
      .on_click(action)
      .child(label);
  }

  /** Card root: shared chrome + Esc handling. */
  root(children) {
    return v_flex().id("puli").size_full().min_h(0).rounded(10).overflow_hidden()
      .text_size(13)
      .track_focus(this.handle)
      .on_size_change((s, cx) => {
        if (s.width !== this.width) {
          this.width = s.width; // for the 2-line subject wrap estimate
          cx.notify();
        }
      })
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        let handled = false;
        if (this.rejectingId !== null) {
          this.rejectingId = null;
          this.err = null;
          this.input.set_value("");
          handled = true;
        }
        // the card lines were last picked on = the focused card
        if (this.activeCardId !== null && this.clearCardSelection(this.activeCardId)) {
          handled = true;
        }
        if (handled) {
          this.handle.focus();
          cx.stop_propagation();
          cx.notify();
        }
      })
      .children(children);
  }

  header(t, rightText) {
    return h_flex().id("puli-header").h(42).flex_none().px(14).gap(8).items_center()
      .border_b(1).border_color(t.border)
      .child(div().text_size(13).font_semibold().child("Commits"))
      .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border)
        .text_size(10).text_color(t.muted).child("commit review"))
      .child(div().flex_1())
      .when(rightText, (e) => e.child(div().text_size(11).text_color(t.dim).child(rightText)));
  }

  /** A labeled monospace well; scrollable, wrapped at the well's width.
   *  px/pt adapt it to the card's inner padding (panel-wide defaults).
   *  In this shell an overflow_y_scrollbar box does not grow to fit its
   *  children — size it explicitly from the visual line count (the shipped
   *  Changes mod does the same), capped at maxH; and since each line is a
   *  fixed-height row (the Files mod's pattern), the text is pre-wrapped
   *  to `chars` columns so nothing overprints or clips. */
  well(t, id, text, color, opts = {}) {
    const lh = opts.lineH ?? 17; // 12px mono needs a ~17px line box
    const lines = wrapText(text, opts.chars ?? 40);
    const boxH = Math.min(opts.maxH ?? 160, Math.max(lh + 20, lines.length * lh + 20));
    return v_flex().flex_none().px(opts.px ?? 14).pt(opts.pt ?? 8)
      .child(h_flex().h(18).flex_none().items_center().gap(6)
        .child(div().text_size(10.5).text_color(t.dim).child(opts.label ?? ""))
        .when(Boolean(opts.tail), (e) => e.child(
          div().flex_1().text_size(10.5).text_right().text_color(t.dim).child(opts.tail))))
      .child(div().id(id).mt(4).h(boxH).overflow_y_scrollbar()
        .p(10).rounded(8).bg(opts.bg ?? t.raised).border_1().border_color(t.border)
        .children(lines.map((s, i) =>
          div().id(id + "-" + i).h(lh).flex_none().font_family(mono()).text_size(12)
            .text_color(color).child(s === "" ? "\u00a0" : s))));
  }

  /** Estimated mono characters per well line at the current panel width.
   *  Measured 7.11px advance for 12px mono here; 7.5 leaves a safety
   *  margin so a pre-wrapped line never exceeds the real width (a
   *  fixed-height line div that auto-wraps would clip its second row). */
  wellChars() {
    const w = this.width ?? 360;
    const inner = w - 12 /* list padding */ - 20 /* card padding */ - 20 /* well padding */;
    return Math.max(12, Math.floor(inner / 7.5));
  }

  /** Estimated characters per subject line at the current panel width. */
  subjectChars() {
    const w = this.width ?? 360; // panel default before the first measure
    const usable = w - 12 /* list padding */ - 20 /* card padding */ - 10 /* scrollbar */ - 4;
    return Math.max(16, Math.floor(usable / 7.4)); // ~13px semibold UI font
  }

  // ── one card per pending proposal ───────────────────────────────────────

  card(t, item, verdict) {
    const st = this.statusOf(item, verdict);
    const busy = this.busyId === item.id;
    const subject = firstLine(item.message) || "(no message)";
    const id = item.id;
    return v_flex().id("card-" + id).flex_none().p(10).gap(6).rounded(8)
      .bg(t.raised).border_1().border_color(t.border)
      // subject: bold, wraps, cut with an ellipsis only past 2 lines
      .children(wrap2(subject, this.subjectChars()).map((s, i) =>
        div().id("subj-" + id + "-" + i).text_size(13).font_semibold()
          .text_color(st ? t.dim : t.foreground).child(s === "" ? "\u00a0" : s)))
      // the FULL message, always visible (for a push: its push line; for
      // a git command: the exact command)
      .child(this.well(t, "msg-" + id,
        String(item.message ?? "") === "" ? "(no message)" : String(item.message),
        st ? t.muted : t.foreground,
        { label: item.kind === "push" ? "push" : item.kind === "git" ? "git command" : "commit message", maxH: 320, chars: this.wellChars(), px: 0, pt: 0, bg: t.background }))
      // meta line: repo · branch · files · age
      .child(h_flex().id("meta-" + id).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted)
          .tooltip(String(item.repo ?? ""))
          .child(
            (baseName(item.repo) || String(item.repo ?? "")) +
            (String(item.branch ?? "") !== "" ? " · " + String(item.branch) : "") +
            (item.kind === "push"
              ? " · push"
              : item.kind === "git"
              ? " · git"
              : " · " + item.files.length + (item.files.length === 1 ? " file" : " files"))))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(age(item.createdAt))))
      // sent / answered states
      .when(st === "sent", (e) => e.child(h_flex().flex_none().items_center().gap(8)
        .child(div().text_size(12).font_semibold()
          .text_color(this.sentDecision === "reject" ? t.blocked : t.done)
          .child(this.sentDecision === "reject" ? "✓ Rejected" : "✓ Approved"))
        .child(div().text_size(10.5).text_color(t.dim)
          .loop("opacity", { from: 0.55, to: 1, period: 1400 })
          .child("sent — waiting for puli…"))))
      .when(st === "answered", (e) => e.child(
        div().flex_none().text_size(11).text_color(t.dim)
          .child("answered from the CLI (" +
            (verdict && (verdict.decision === "approve" || verdict.decision === "reject")
              ? verdict.decision : "?") +
            ") — waiting for puli…")))
      // error, if it belongs to this card
      .when(Boolean(this.err) && this.errId === id, (e) => e.child(
        div().flex_none().text_size(11).text_color(t.blocked).child(this.err)))
      // comment input, revealed by that card's Reject
      .when(this.rejectingId === id, (e) => e.child(
        h_flex().id("comment-row-" + id).flex_none().items_center().gap(8)
          .child(div().id("comment-" + id).flex_1().min_w(0).h(30).px(10).flex().items_center()
            .rounded(8).border_1().border_color(t.accent).bg(t.background).cursor_text()
            .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
          .child(this.button("send-" + id, "Send reject", t.blocked, t.foreground, t.blocked,
            (_e, cx) => cx.spawn((c) => this.decide(item, "reject", this.input.value(), c))))))
      // the files accordion: every changed file, expandable to its inline
      // diff from the frozen patch (this replaces the old diffstat toggle)
      .child(this.filesSection(t, item))
      // drafted line comments — sent with a Reject, × deletes one
      .when((this.comments.get(id) ?? []).length > 0, (e) => {
        const list = this.comments.get(id);
        return e.child(v_flex().id("lclist-" + id).flex_none().pt(2).gap(1)
          .child(div().flex_none().px(6).text_size(10.5).text_color(t.dim).child("line comments"))
          .children(list.map((c, i) =>
            h_flex().id("lcitem-" + id + "-" + i).flex_none().px(6).h(18).items_center().gap(6)
              .child(div().flex_none().font_family(mono()).text_size(10.5).text_color(t.accent)
                .child(c.file + ":" + (c.start === c.end ? String(c.start) : c.start + "-" + c.end)))
              .child(div().flex_1().min_w(0).truncate().text_size(11)
                .text_color(st ? t.muted : t.foreground).tooltip(c.text).child(c.text))
              .child(div().id("lcdel-" + id + "-" + i).flex_none().w(14).h(18)
                .flex().items_center().text_size(12).text_color(t.dim).cursor_pointer()
                .hover((s) => s.text_color(t.blocked)).child("×")
                .on_click((_e, cx) => { list.splice(i, 1); cx.notify(); })))))
      })
      // per-card actions
      .child(h_flex().flex_none().items_center().gap(8)
        .child(this.button("approve-" + id, busy ? "…" : "Approve",
          st ? t.raised : t.solid, st ? t.dim : t.solid_foreground, st ? t.border : t.solid,
          (_e, cx) => cx.spawn((c) => this.decide(item, "approve", undefined, c))))
        .child(this.button("reject-" + id, "Reject", t.raised, t.foreground, t.input,
          (_e, cx) => {
            this.rejectingId = id;
            this.err = null;
            this.input.focus();
            cx.notify();
          })));
  }

  // ── history: what was approved / rejected / reaped ──────────────────────

  historyRow(t, h, i) {
    const color =
      h.decision === "approve" ? t.done :
      h.decision === "reject" ? t.blocked : t.dim;
    return v_flex().id("hist-" + i).flex_none().px(8).py(4).gap(1)
      .when(i > 0, (e) => e.border_t(1).border_color(t.border))
      .child(h_flex().gap(6).items_center()
        .child(div().id("hist-decision-" + i).flex_none().text_size(10.5).font_semibold()
          .text_color(color).child(String(h.decision)))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted)
          .child(String(h.subject ?? "") === "" ? "(no subject)" : String(h.subject)))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(age(h.at))))
      .when(String(h.detail ?? "") !== "", (e) => e.child(
        div().pl(2).truncate().font_family(mono()).text_size(10.5).text_color(t.dim)
          .child(String(h.detail))));
  }

  historySection(t) {
    return v_flex().id("puli-history").flex_none().mt(4).rounded(8)
      .border_1().border_color(t.border).overflow_hidden()
      .child(h_flex().id("puli-history-head").h(28).flex_none().px(8).gap(6).items_center()
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          this.histOpen = !this.histOpen;
          cx.notify();
        })
        .child(div().text_size(10.5).text_color(t.dim).child(this.histOpen ? "▾" : "▸"))
        .child(div().text_size(11).font_semibold().text_color(t.muted).child("history"))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.dim)
          .child(this.history.length ? String(this.history.length) : "")))
      .when(this.histOpen, (e) => e.children(this.history.length
        ? this.history.map((h, i) => this.historyRow(t, h, i))
        : [h_flex().id("hist-empty").h(24).flex_none().px(8).items_center()
            .text_size(11).text_color(t.dim).child("nothing settled yet")]));
  }

  render(cx) {
    const t = theme();
    const items = this.items();
    const errors = this.errorFiles();
    const verdict = this.lastVerdict;

    // The waiting queue on top, settled history below — that contrast is
    // the point, so history shows even when nothing is pending.
    return this.root([
      this.header(t,
        items.length ? items.length + (items.length === 1 ? " proposal" : " proposals") : "queue empty"),
      v_flex().id("puli-queue").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(6)
        .children(items.map((it) => this.card(t, it, verdict)))
        .children(errors.map((er) =>
          h_flex().id("bad-" + er.file).h(28).flex_none().px(8).items_center()
            .child(div().text_size(11).truncate().text_color(t.dim)
              .child("(unreadable: " + er.file + ")"))))
        .when(!items.length && !errors.length, (e) => e.child(
          div().id("puli-idle").flex_none().p(8).text_size(12.5).text_color(t.dim)
            .child("No pending commits")))
        .child(this.historySection(t)),
    ]).bg(t.background).border_1().border_color(t.border);
  }
}


