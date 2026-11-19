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

/** Shows the draft in Mail's viewer (opening it for editing if it cannot be selected). */
export async function revealDraft(id: string): Promise<void> {
  await runMail(
    [
      "on run argv",
      'tell application "Mail"',
      "  set m to first message of drafts mailbox whose id is ((item 1 of argv) as integer)",
      "  activate",
      "  try",
      "    if (count of message viewers) is 0 then make new message viewer",
      "    set mv to message viewer 1",
      "    set selected mailboxes of mv to {drafts mailbox}",
      "    set selected messages of mv to {m}",
      "  on error",
      "    open m",
      "  end try",
      "end tell",
      "end run",
    ],
    [id]
  );
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
 * The draft a compose just saved. Exchange accounts can store two copies of one
 * save a moment apart, so wait for Drafts to settle, keep one copy and delete
 * the others. Undefined when no new draft, or unrelated new drafts, appeared.
 */
export async function settleNewDraft(
  before: Set<string>,
  settleMs = 3000
): Promise<DraftSnapshot | undefined> {
  let fresh: string[] = [];
  for (let waited = 0; ; waited += 500) {
    fresh = (await listDraftIds()).filter((id) => !before.has(id));
    if (waited >= settleMs) break;
    await sleep(500);
  }
  const snapshots = (await Promise.all(fresh.map(readDraft))).filter(
    (d): d is DraftSnapshot => !!d
  );
  if (snapshots.length === 0) return undefined;
  const [keep, ...rest] = snapshots.sort((a, b) => Number(b.id) - Number(a.id));
  if (!rest.every((d) => sameContent(d, keep))) return undefined;
  for (const extra of rest) await deleteDraft(extra.id);
  return keep;
}

/** Deletes the draft and any other copy with the same content; false if one could not be. */
export async function deleteDraftCopies(snapshot: DraftSnapshot): Promise<boolean> {
  let ok = true;
  if ((await readDraft(snapshot.id)) && !(await deleteDraft(snapshot.id))) ok = false;
  for (const copy of await draftsWithSubject(snapshot.subject)) {
    if (sameContent(copy, snapshot) && !(await deleteDraft(copy.id))) ok = false;
  }
  return ok;
}
