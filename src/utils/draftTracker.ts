/**
 * Tracks the Mail.app draft that stands behind a gated send.
 *
 * Before a send/reply/forward is confirmed, the server saves it as a real draft
 * so the person can open it in Mail. At approval the draft is checked again:
 * gone means the person already sent (or deleted) it in Mail, changed means they
 * edited it — in both cases the server does not send, so nothing goes out twice.
 *
 * All scripts take their values through `argv`, never by string interpolation.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

/** What identifies a draft's content; compared before sending. */
export interface DraftSnapshot {
  id: string;
  subject: string;
  sender: string;
  to: string[];
  cc: string[];
  bcc: string[];
  contentHash: string;
}

export type DraftCheck =
  | { state: "unchanged"; snapshot: DraftSnapshot }
  | { state: "changed"; snapshot: DraftSnapshot }
  | { state: "missing"; foundInSent: boolean };

const RS = "\u001e";
const US = "\u001f";

function runMail(lines: string[], argv: string[], timeoutMs = 30_000): Promise<string> {
  const args = lines.flatMap((line) => ["-e", line]);
  return new Promise((resolve, reject) => {
    execFile("osascript", [...args, ...argv], { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error)
        reject(
          new Error(
            String(stderr || error.message)
              .trim()
              .slice(0, 200)
          )
        );
      else resolve(String(stdout).replace(/\n$/, ""));
    });
  });
}

/** AppleScript handler that serializes one message: id, subject, sender, to, cc, bcc, content. */
const SERIALIZE = [
  "on joinList(xs)",
  '  set AppleScript\'s text item delimiters to ","',
  "  set s to xs as text",
  '  set AppleScript\'s text item delimiters to ""',
  "  return s",
  "end joinList",
  "on describeMessage(m)",
  '  tell application "Mail"',
  "    set us to character id 31",
  '    set c to ""',
  "    try",
  "      set c to content of m",
  "    end try",
  "    return ((id of m) as text) & us & (subject of m) & us & (sender of m) & us & " +
    "my joinList(address of to recipients of m) & us & my joinList(address of cc recipients of m) " +
    "& us & my joinList(address of bcc recipients of m) & us & c",
  "  end tell",
  "end describeMessage",
];

function normalizeContent(content: string): string {
  // Mail rewrites line endings and trailing whitespace when it stores a draft.
  return content
    .replace(/[\uFFFC\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parse(record: string): DraftSnapshot | undefined {
  const parts = record.split(US);
  if (parts.length < 7) return undefined;
  const [id, subject, sender, to, cc, bcc, ...content] = parts;
  const split = (s: string) => (s ? s.split(",").map((x) => x.trim().toLowerCase()) : []).sort();
  return {
    id,
    subject,
    sender,
    to: split(to),
    cc: split(cc),
    bcc: split(bcc),
    contentHash: createHash("sha256")
      .update(normalizeContent(content.join(US)))
      .digest("hex"),
  };
}

/** Ids of every message in Mail's combined Drafts mailbox. */
export async function listDraftIds(): Promise<string[]> {
  const out = await runMail(
    [
      "on run argv",
      'tell application "Mail" to set ids to id of (messages of drafts mailbox whose deleted status is false)',
      'set AppleScript\'s text item delimiters to ","',
      "return ids as text",
      "end run",
    ],
    []
  );
  return out ? out.split(",").map((s) => s.trim()) : [];
}

/** One draft by id, or undefined when it is no longer in Drafts. */
export async function readDraft(id: string): Promise<DraftSnapshot | undefined> {
  const out = await runMail(
    [
      ...SERIALIZE,
      "on run argv",
      'tell application "Mail"',
      "  set ms to (messages of drafts mailbox whose id is ((item 1 of argv) as integer) and deleted status is false)",
      '  if (count of ms) is 0 then return ""',
      "  return my describeMessage(item 1 of ms)",
      "end tell",
      "end run",
    ],
    [id]
  );
  return out ? parse(out) : undefined;
}

/** Drafts with this exact subject (Mail can give a draft a new id when it syncs it). */
export async function draftsWithSubject(subject: string): Promise<DraftSnapshot[]> {
  const out = await runMail(
    [
      ...SERIALIZE,
      "on run argv",
      'tell application "Mail"',
      "  set ms to (messages of drafts mailbox whose subject is (item 1 of argv) and deleted status is false)",
      "  set out to {}",
      "  repeat with m in ms",
      "    set end of out to my describeMessage(m)",
      "  end repeat",
      "end tell",
      "set AppleScript's text item delimiters to character id 30",
      "return out as text",
      "end run",
    ],
    [subject]
  );
  return out
    .split(RS)
    .map(parse)
    .filter((d): d is DraftSnapshot => !!d);
}

/** True when Sent holds a message with this subject sent at or after `since`. */
export async function sentSince(subject: string, since: Date): Promise<boolean> {
  const out = await runMail(
    [
      "on run argv",
      "set cutoff to (current date) - ((item 2 of argv) as integer)",
      'tell application "Mail"',
      "  set n to count of (messages of sent mailbox whose subject is (item 1 of argv) " +
        "and date sent ≥ cutoff)",
      "end tell",
      "return n as text",
      "end run",
    ],
    [subject, String(Math.max(0, Math.ceil((Date.now() - since.getTime()) / 1000) + 5))]
  );
  return Number(out) > 0;
}

/**
 * Opens this exact draft for editing, through its message:// URL (Message-ID).
 * Mail's `open` command and viewer selection only show the Drafts list on
 * recent macOS; the URL opens the draft itself.
 */
export async function revealDraft(id: string): Promise<void> {
  const messageId = await runMail(
    [
      "on run argv",
      'tell application "Mail"',
      "  return message id of (first message of drafts mailbox whose id is ((item 1 of argv) as integer))",
      "end tell",
      "end run",
    ],
    [id]
  );
  const bare = messageId.trim().replace(/^<|>$/g, "");
  if (!bare) throw new Error("the draft has no Message-ID");
  await new Promise<void>((resolve, reject) => {
    // Same form Mail itself uses for links: only the angle brackets are encoded.
    execFile("open", [`message://%3C${bare}%3E`], (error) => (error ? reject(error) : resolve()));
  });
}

/** Deletes the draft; resolves false when it could not. */
export async function deleteDraft(id: string): Promise<boolean> {
  try {
    await runMail(
      [
        "on run argv",
        'tell application "Mail"',
        "  delete (first message of drafts mailbox whose id is ((item 1 of argv) as integer))",
        "end tell",
        "end run",
      ],
      [id]
    );
    return true;
  } catch {
    return false;
  }
}

export function sameContent(a: DraftSnapshot, b: DraftSnapshot): boolean {
  return (
    a.subject === b.subject &&
    a.contentHash === b.contentHash &&
    a.to.join() === b.to.join() &&
    a.cc.join() === b.cc.join() &&
    a.bcc.join() === b.bcc.join()
  );
}

/** Re-reads the draft before sending and says whether it is still the approved one. */
export async function checkDraft(saved: DraftSnapshot, createdAt: Date): Promise<DraftCheck> {
  let current = await readDraft(saved.id);
  if (!current) {
    // Mail may have re-stored the draft under a new id; find it by content.
    current = (await draftsWithSubject(saved.subject)).find((d) => sameContent(d, saved));
  }
  if (!current) {
    const foundInSent = await sentSince(saved.subject, createdAt).catch(() => false);
    return { state: "missing", foundInSent };
  }
  // Mail removes a sent draft from Drafts a moment after sending; Sent already has it.
  if (await sentSince(saved.subject, createdAt).catch(() => false)) {
    return { state: "missing", foundInSent: true };
  }
  return sameContent(current, saved)
    ? { state: "unchanged", snapshot: current }
    : { state: "changed", snapshot: current };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The draft a compose just saved. Exchange can store one save as two copies a
 * moment apart — sometimes one of them without the new text — so wait for
 * Drafts to settle, keep the copy that holds `bodyHint` (else the longest) and
 * delete the other new copies with the same subject. New drafts with another
 * subject are never touched. Undefined when no new draft appeared.
 */
export async function settleNewDraft(
  before: Set<string>,
  bodyHint = "",
  settleMs = 3000
): Promise<DraftSnapshot | undefined> {
  let fresh: string[] = [];
  for (let waited = 0; ; waited += 500) {
    fresh = (await listDraftIds()).filter((id) => !before.has(id));
    if (waited >= settleMs) break;
    await sleep(500);
  }
  const read = await Promise.all(fresh.map(async (id) => ({ id, d: await readDraftFull(id) })));
  const copies = read.filter((x): x is { id: string; d: FullDraft } => !!x.d);
  if (copies.length === 0) return undefined;
  const hint = normalizeContent(bodyHint).slice(0, 40);
  const byLength = [...copies].sort((x, y) => y.d.content.length - x.d.content.length);
  const keep =
    (hint && byLength.find((x) => normalizeContent(x.d.content).includes(hint))) || byLength[0];
  for (const other of copies) {
    if (other.id !== keep.id && other.d.snapshot.subject === keep.d.snapshot.subject) {
      await deleteDraft(other.id);
    }
  }
  return keep.d.snapshot;
}

interface FullDraft {
  snapshot: DraftSnapshot;
  content: string;
}

/** A draft with its raw content, for choosing between copies. */
async function readDraftFull(id: string): Promise<FullDraft | undefined> {
  const out = await runMail(
    [
      ...SERIALIZE,
      "on run argv",
      'tell application "Mail"',
      "  set ms to (messages of drafts mailbox whose id is ((item 1 of argv) as integer) and deleted status is false)",
      '  if (count of ms) is 0 then return ""',
      "  return my describeMessage(item 1 of ms)",
      "end tell",
      "end run",
    ],
    [id]
  ).catch(() => "");
  const snapshot = out ? parse(out) : undefined;
  if (!snapshot) return undefined;
  return { snapshot, content: out.split(US).slice(6).join(US) };
}

/** Closes open compose windows with this subject without saving; they would re-save the draft. */
export async function closeDraftWindows(subject: string): Promise<void> {
  await runMail(
    [
      "on run argv",
      'tell application "Mail"',
      "  repeat with om in (every outgoing message whose subject is (item 1 of argv))",
      "    close om saving no",
      "  end repeat",
      "end tell",
      "end run",
    ],
    [subject]
  );
}

async function deleteMatching(snapshot: DraftSnapshot): Promise<boolean> {
  let ok = true;
  if ((await readDraft(snapshot.id)) && !(await deleteDraft(snapshot.id))) ok = false;
  for (const copy of await draftsWithSubject(snapshot.subject)) {
    if (sameContent(copy, snapshot) && !(await deleteDraft(copy.id))) ok = false;
  }
  return ok;
}

/**
 * After a send: closes the draft's open compose window (which would save it again),
 * deletes every copy with the same content, and sweeps once more for a late re-save.
 * Resolves false if a copy could not be deleted.
 */
export async function deleteDraftCopies(
  snapshot: DraftSnapshot,
  sweepAfterMs = 2500
): Promise<boolean> {
  await closeDraftWindows(snapshot.subject).catch(() => {});
  const first = await deleteMatching(snapshot);
  await sleep(sweepAfterMs);
  await closeDraftWindows(snapshot.subject).catch(() => {});
  const second = await deleteMatching(snapshot);
  return first && second;
}

// ---------------------------------------------------------------------------
// Visible compose window for a new message (send-email).
// ---------------------------------------------------------------------------

export interface ComposeInput {
  subject: string;
  body: string;
  /** Exact sender address; empty for Mail's default. */
  sender: string;
  to: string[];
  cc: string[];
  bcc: string[];
  /** Absolute, already-validated file paths. */
  attachmentPaths: string[];
}

/** What the open compose window currently holds. */
export interface ComposeState {
  visible: boolean;
  subject: string;
  sender: string;
  to: string[];
  cc: string[];
  bcc: string[];
  contentHash: string;
}

const COMPOSE_SEP = "\u001f";

/**
 * Opens a visible Mail compose window for the message, saves it to Drafts and
 * leaves it open, so the person can review, edit or send it themselves.
 * Resolves to the compose window's outgoing-message id.
 */
export async function openCompose(input: ComposeInput): Promise<string> {
  const lines = (xs: string[]) => xs.filter(Boolean).join("\n");
  const out = await runMail(
    [
      "on run argv",
      "set subj to item 1 of argv",
      "set bod to item 2 of argv",
      "set snd to item 3 of argv",
      "set toList to paragraphs of (item 4 of argv)",
      "set ccList to paragraphs of (item 5 of argv)",
      "set bccList to paragraphs of (item 6 of argv)",
      "set fileList to paragraphs of (item 7 of argv)",
      'tell application "Mail"',
      "  set m to make new outgoing message with properties {subject:subj, content:bod, visible:true}",
      "  tell m",
      "    repeat with a in toList",
      '      if (contents of a) is not "" then make new to recipient at end of to recipients with properties {address:(contents of a)}',
      "    end repeat",
      "    repeat with a in ccList",
      '      if (contents of a) is not "" then make new cc recipient at end of cc recipients with properties {address:(contents of a)}',
      "    end repeat",
      "    repeat with a in bccList",
      '      if (contents of a) is not "" then make new bcc recipient at end of bcc recipients with properties {address:(contents of a)}',
      "    end repeat",
      '    if snd is not "" then set sender to snd',
      "    set expected to 0",
      "    repeat with f in fileList",
      '      if (contents of f) is not "" then',
      "        make new attachment with properties {file name:(POSIX file (contents of f))} at after the last paragraph",
      "        set expected to expected + 1",
      "      end if",
      "    end repeat",
      "  end tell",
      // Mail loads attachments asynchronously; saving before they land loses them.
      "  set attachDeadline to (current date) + 15",
      "  repeat while expected > 0",
      "    set attachCount to 0",
      "    try",
      "      set attachCount to count of attachments of content of m",
      "    end try",
      "    if attachCount >= expected or (current date) > attachDeadline then exit repeat",
      "    delay 0.25",
      "  end repeat",
      "  if expected > 0 then delay 1",
      // `set sender` silently falls back to the default for an unknown address.
      '  if snd is not "" and (sender of m) does not contain snd then',
      "    close m saving no",
      '    error "Mail would not send from " & snd',
      "  end if",
      "  save m",
      "  return (id of m) as text",
      "end tell",
      "end run",
    ],
    [
      input.subject,
      input.body,
      input.sender,
      lines(input.to),
      lines(input.cc),
      lines(input.bcc),
      lines(input.attachmentPaths),
    ],
    60_000
  );
  return out.trim();
}

/** The compose window's current state, or undefined when Mail no longer has it. */
export async function readCompose(outgoingId: string): Promise<ComposeState | undefined> {
  const out = await runMail(
    [
      "on joinList(xs)",
      '  set AppleScript\'s text item delimiters to ","',
      "  set s to xs as text",
      '  set AppleScript\'s text item delimiters to ""',
      "  return s",
      "end joinList",
      "on run argv",
      'tell application "Mail"',
      "  set ms to (every outgoing message whose id is ((item 1 of argv) as integer))",
      '  if (count of ms) is 0 then return ""',
      "  set m to item 1 of ms",
      "  set us to character id 31",
      '  set c to ""',
      "  try",
      "    set c to content of m",
      "  end try",
      "  return ((visible of m) as text) & us & (subject of m) & us & (sender of m) & us & " +
        "my joinList(address of to recipients of m) & us & my joinList(address of cc recipients of m) " +
        "& us & my joinList(address of bcc recipients of m) & us & c",
      "end tell",
      "end run",
    ],
    [outgoingId]
  ).catch(() => "");
  if (!out) return undefined;
  const [visible, subject, sender, to, cc, bcc, ...content] = out.split(COMPOSE_SEP);
  const split = (s: string) => (s ? s.split(",").map((x) => x.trim().toLowerCase()) : []).sort();
  return {
    visible: visible === "true",
    subject,
    sender,
    to: split(to),
    cc: split(cc),
    bcc: split(bcc),
    contentHash: createHash("sha256")
      .update(normalizeContent(content.join(COMPOSE_SEP)))
      .digest("hex"),
  };
}

/** True when the compose window still holds exactly the approved message. */
export function composeMatches(state: ComposeState, approved: ComposeState): boolean {
  return (
    state.subject === approved.subject &&
    state.contentHash === approved.contentHash &&
    state.to.join() === approved.to.join() &&
    state.cc.join() === approved.cc.join() &&
    state.bcc.join() === approved.bcc.join() &&
    state.sender === approved.sender
  );
}

/** Brings the compose window to the front; false when it is gone or closed. */
export async function focusCompose(outgoingId: string): Promise<boolean> {
  const out = await runMail(
    [
      "on run argv",
      'tell application "Mail"',
      "  set ms to (every outgoing message whose id is ((item 1 of argv) as integer))",
      '  if (count of ms) is 0 then return "gone"',
      "  set m to item 1 of ms",
      '  if not (visible of m) then return "gone"',
      "  activate",
      "  set subj to subject of m",
      "  repeat with w in (every window whose visible is true)",
      "    if name of w is subj then set index of w to 1",
      "  end repeat",
      '  return "front"',
      "end tell",
      "end run",
    ],
    [outgoingId]
  ).catch(() => "gone");
  return out.trim() === "front";
}

/** Sends the open compose window itself (Mail then removes its draft). */
export async function sendCompose(outgoingId: string): Promise<void> {
  const out = await runMail(
    [
      "on run argv",
      'tell application "Mail"',
      "  set m to first outgoing message whose id is ((item 1 of argv) as integer)",
      "  set ok to send m",
      "  return ok as text",
      "end tell",
      "end run",
    ],
    [outgoingId],
    60_000
  );
  if (out.trim() !== "true") throw new Error(`Mail did not send the message (${out.trim()})`);
}

/** Subject Mail's native composer gives a compose while it inserts text. */
const NATIVE_MARKER_PREFIX = "MCP Native ";

/**
 * After a failed native-editor compose: closes its marked compose windows without
 * saving and deletes the drafts it left — new since `before`, and either still
 * marked or a reply/forward without `bodyHint` (the text the failed attempt never
 * inserted). A draft holding the body, and any older draft, is kept.
 */
export async function cleanupNativeLeftovers(before: Set<string>, bodyHint: string): Promise<void> {
  await runMail(
    [
      "on run argv",
      'tell application "Mail"',
      "  repeat with om in (every outgoing message whose subject starts with (item 1 of argv))",
      "    try",
      "      close om saving no",
      "    end try",
      "  end repeat",
      "end tell",
      "end run",
    ],
    [NATIVE_MARKER_PREFIX]
  ).catch(() => "");
  const hint = normalizeContent(bodyHint).slice(0, 40);
  for (const id of (await listDraftIds()).filter((x) => !before.has(x))) {
    const draft = await readDraftFull(id);
    if (!draft) continue;
    const subject = draft.snapshot.subject;
    const marked = subject.startsWith(NATIVE_MARKER_PREFIX);
    const replyLike = /^(re|fw|fwd|回复|转发)\s*[:：]/i.test(subject);
    const hasBody = !!hint && normalizeContent(draft.content).includes(hint);
    if (marked || (replyLike && !hasBody)) await deleteDraft(id);
  }
}
