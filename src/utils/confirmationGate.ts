/**
 * Human confirmation gate for tools that send, delete or otherwise act on mail
 * in a way that cannot be taken back.
 *
 * "Confirm with the user before calling" in a tool description is advice to the
 * model; a prompt injection in an email body can ignore it. This gate is
 * enforced by the server in two steps:
 *
 * 1. A gated call without `confirmationToken` does nothing. It returns a preview
 *    and a single-use token bound to the exact arguments, and tells the model to
 *    show the preview to the user and ask for explicit approval.
 * 2. A call carrying a valid token opens a native macOS window showing the
 *    operation and the message it acts on. A person has to type any 6 letters or
 *    digits into it; only then does the tool run. Cancel, timeout,
 *    an expired token or changed arguments all mean nothing is done.
 *
 * Step 2 runs in this process, outside the model's reach: the model never sees
 * the dialog and cannot answer it through MCP.
 */
import { createHash, randomBytes } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SENDING_TOOLS } from "@/utils/toolMode.js";
import { macDialogPrompt, type HumanPrompt } from "@/utils/confirmDialog.js";
import {
  cleanupDetails,
  describeOperation,
  detailsText,
  noLookup,
  type MessageLookup,
  type Route,
} from "@/utils/operationDetails.js";
import type { DraftCheck, DraftSnapshot } from "@/utils/draftTracker.js";

export type { HumanPrompt, PromptOutcome } from "@/utils/confirmDialog.js";

export const CONFIRMATION_TOKEN_PARAM = "confirmationToken";

/** Tools that require the two-step confirmation. Drafts are deliberately not here. */
export const CONFIRMED_TOOLS = new Set([
  ...SENDING_TOOLS,
  "delete-message",
  "batch-delete-messages",
  "move-message",
  "batch-move-messages",
  "delete-mailbox",
  "delete-smart-mailbox",
  "create-rule",
  "delete-rule",
  "delete-template",
  "set-account-settings",
]);

/** True when this call has to pass the gate. reply/forward with send=false only save a draft. */
export function requiresConfirmation(tool: string, args: Record<string, unknown>): boolean {
  if (!CONFIRMED_TOOLS.has(tool)) return false;
  if ((tool === "reply-to-message" || tool === "forward-message") && args.send === false) {
    return false;
  }
  return true;
}

export const confirmationTokenSchema = z
  .string()
  .optional()
  .describe(
    "Leave empty on the first call. The server then returns a preview and a token instead of " +
      "acting. Show the preview to the user; only after the user explicitly approves, call again " +
      "with identical arguments plus this token. The user must then also type a 6-character " +
      "code into a macOS window before anything happens."
  );

export const CONFIRMATION_NOTE =
  "\nConfirmation: this tool never acts on the first call. It returns a preview and a " +
  "confirmationToken; ask the user to approve that preview, then repeat the call with the same " +
  "arguments and the token. The user must also enter a 6-character code in a macOS window.";

/** The Mail draft saved for a pending send. */
export interface DraftRef {
  snapshot: DraftSnapshot;
  createdAt: Date;
  route: Route;
}

/** Draft handling for sends; injected so the gate can be tested without Mail. */
export interface DraftOps {
  /** Saves the call as a Mail draft. Undefined when the tool has none or saving failed. */
  prepare(tool: string, args: Record<string, unknown>): Promise<DraftRef | undefined>;
  check(draft: DraftRef): Promise<DraftCheck>;
  reveal(draft: DraftRef): Promise<void>;
  remove(draft: DraftRef): Promise<boolean>;
}

export const noDrafts: DraftOps = {
  prepare: async () => undefined,
  check: async () => ({ state: "missing", foundInSent: false }),
  reveal: async () => {},
  remove: async () => true,
};

export type ToolRunner = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface Pending {
  tool: string;
  fingerprint: string;
  draft?: DraftRef;
  expiresAt: number;
}

const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_PREVIEW_CHARS = 1500;

/** Canonical JSON with sorted keys, so the same arguments always hash the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function stripToken(args: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...args };
  delete rest[CONFIRMATION_TOKEN_PARAM];
  return rest;
}

function fingerprint(tool: string, args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${tool}\n${canonical(args)}`)
    .digest("hex");
}

/** A readable, bounded summary of the arguments: long text cut, base64 replaced by its size. */
export function buildPreview(tool: string, args: Record<string, unknown>): string {
  const shown = JSON.stringify(
    args,
    (key, value: unknown) => {
      if (key === "contentBase64" && typeof value === "string") {
        return `<base64, ~${Math.round((value.length * 3) / 4 / 1024)} KiB>`;
      }
      if (typeof value === "string" && value.length > 400) {
        return `${value.slice(0, 400)}… (${value.length} chars)`;
      }
      if (Array.isArray(value) && value.length > 20) {
        return [...value.slice(0, 20), `… (+${value.length - 20} more)`];
      }
      return value;
    },
    2
  );
  const text = `Tool: ${tool}\n${shown}`;
  return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}\n…` : text;
}

function appendText(result: CallToolResult, text: string): CallToolResult {
  return { ...result, content: [...(result.content ?? []), { type: "text", text }] };
}

function refusal(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export class ConfirmationGate {
  private readonly pending = new Map<string, Pending>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prompt: HumanPrompt = macDialogPrompt,
    private readonly lookup: MessageLookup = noLookup,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Runs `exec` only after both confirmations. Ungated calls run straight away.
   * `args` may carry the token; `exec` never sees it.
   */
  async run(
    tool: string,
    args: Record<string, unknown>,
    exec: ToolRunner,
    deps: { lookup?: MessageLookup; drafts?: DraftOps } = {}
  ): Promise<CallToolResult> {
    const rest = stripToken(args);
    if (!requiresConfirmation(tool, args)) return exec(rest);
    const lookup = deps.lookup ?? this.lookup;
    const drafts = deps.drafts ?? noDrafts;
    this.expire();
    const print = fingerprint(tool, rest);
    const token = args[CONFIRMATION_TOKEN_PARAM];

    if (typeof token !== "string" || token === "") {
      const issued = randomBytes(9).toString("base64url");
      const draft = await drafts.prepare(tool, rest).catch(() => undefined);
      const details = await describeOperation(tool, rest, lookup, {
        withImage: false,
        route: draft?.route,
      });
      cleanupDetails(details);
      this.pending.set(issued, {
        tool,
        fingerprint: print,
        draft,
        expiresAt: this.now() + TOKEN_TTL_MS,
      });
      const draftNote = draft
        ? `A draft of exactly this message was saved in Mail's Drafts (nothing was sent). The ` +
          `user can open it from the confirmation window. If the user sends or deletes that ` +
          `draft in Mail, the confirmed call will not send again.\n\n`
        : "";
      return refusal(
        `NOT EXECUTED — confirmation required.\n\n${detailsText(details)}\n\n${draftNote}` +
          `Arguments:\n${buildPreview(tool, rest)}\n\n` +
          `Show this to the user — make the sender address and the recipients prominent — and ` +
          `ask whether to proceed. Only if the user explicitly approves, call ${tool} again with ` +
          `exactly the same arguments plus ${CONFIRMATION_TOKEN_PARAM}: "${issued}" (valid 10 ` +
          `minutes, single use). The user will then have to type a 6-character code into a macOS ` +
          `window. If the user declines, do not call again.`
      );
    }

    const entry = this.pending.get(token);
    // Single use: a token is spent whether or not this attempt succeeds.
    this.pending.delete(token);
    if (!entry || entry.tool !== tool || entry.fingerprint !== print) {
      return refusal(
        `NOT EXECUTED — ${CONFIRMATION_TOKEN_PARAM} is unknown, expired, already used, or the ` +
          `arguments changed since it was issued. Call ${tool} again without a token to get a ` +
          `new preview, and get the user's approval again.`
      );
    }
    const draft = entry.draft;

    // One dialog at a time, so a person never answers a prompt meant for another call.
    const show = async () => {
      const details = await describeOperation(tool, rest, lookup, {
        withImage: true,
        route: draft?.route,
      });
      try {
        return await this.prompt(`Apple Mail MCP 操作确认：${tool}`, details, {
          openDraft: draft ? () => void drafts.reveal(draft).catch(() => {}) : undefined,
        });
      } finally {
        cleanupDetails(details);
      }
    };
    const outcome = await (this.queue = this.queue.then(show, show));
    if (outcome !== "approved") {
      const why =
        outcome === "timeout"
          ? "the confirmation window timed out"
          : outcome === "error"
            ? "the confirmation window could not be shown"
            : "the user cancelled in the confirmation window";
      const kept = draft ? " The draft stays in Mail's Drafts." : "";
      return refusal(
        `NOT EXECUTED — ${why}. Nothing was sent or changed.${kept} Do not retry unless the ` +
          `user asks.`
      );
    }
    if (!draft) return exec(rest);

    // The person may have sent, deleted or edited the draft in Mail meanwhile.
    const state = await drafts
      .check(draft)
      .catch((error: unknown): DraftCheck | { state: "error"; error: string } => ({
        state: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
    if (state.state === "missing") {
      return refusal(
        `NOT SENT AGAIN — the draft is no longer in Mail's Drafts` +
          (state.foundInSent
            ? `, and a message with this subject is in Sent: the user already sent it from Mail.`
            : `: the user sent or deleted it in Mail.`) +
          ` To avoid a duplicate, nothing was sent. Do not retry.`
      );
    }
    if (state.state === "changed") {
      return refusal(
        `NOT SENT — the user edited the draft in Mail after approving it, so the approved ` +
          `content no longer matches. Nothing was sent; the edited draft is in Drafts. Tell the ` +
          `user to send it from Mail, or start over without a token.`
      );
    }
    if (state.state === "error") {
      return refusal(
        `NOT SENT — the draft could not be checked (${state.error}), so whether it was already ` +
          `sent from Mail is unknown. Nothing was sent. Do not retry; ask the user to check Mail.`
      );
    }
    const result = await exec(rest);
    if (result.isError) {
      return appendText(result, "The draft stays in Mail's Drafts.");
    }
    const removed = await drafts.remove({ ...draft, snapshot: state.snapshot }).catch(() => false);
    return appendText(
      result,
      removed
        ? "The matching draft was removed from Drafts."
        : "Sent, but the matching draft could not be removed from Drafts; delete it in Mail."
    );
  }

  private expire(): void {
    const t = this.now();
    for (const [token, entry] of this.pending) {
      if (entry.expiresAt <= t) this.pending.delete(token);
    }
  }
}
