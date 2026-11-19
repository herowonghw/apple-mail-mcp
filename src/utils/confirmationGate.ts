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
} from "@/utils/operationDetails.js";

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

interface Pending {
  tool: string;
  fingerprint: string;
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
   * Returns null when the call may proceed, or the result to send back instead.
   * `args` still carries the token; the caller strips it before running the tool.
   */
  async check(
    tool: string,
    args: Record<string, unknown>,
    lookup: MessageLookup = this.lookup
  ): Promise<CallToolResult | null> {
    if (!requiresConfirmation(tool, args)) return null;
    this.expire();
    const rest = stripToken(args);
    const print = fingerprint(tool, rest);
    const token = args[CONFIRMATION_TOKEN_PARAM];

    if (typeof token !== "string" || token === "") {
      const issued = randomBytes(9).toString("base64url");
      const details = await describeOperation(tool, rest, lookup, { withImage: false });
      cleanupDetails(details);
      this.pending.set(issued, { tool, fingerprint: print, expiresAt: this.now() + TOKEN_TTL_MS });
      return refusal(
        `NOT EXECUTED — confirmation required.\n\n${detailsText(details)}\n\n` +
          `Arguments:\n${buildPreview(tool, rest)}\n\n` +
          `Show this to the user and ask whether to proceed. Only if the user explicitly ` +
          `approves, call ${tool} again with exactly the same arguments plus ` +
          `${CONFIRMATION_TOKEN_PARAM}: "${issued}" (valid 10 minutes, single use). The user will ` +
          `then have to type a 6-character code into a macOS window. If the user declines, do ` +
          `not call again.`
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

    // One dialog at a time, so a person never answers a prompt meant for another call.
    const show = async () => {
      const details = await describeOperation(tool, rest, lookup, { withImage: true });
      try {
        return await this.prompt(`Apple Mail MCP 操作确认：${tool}`, details);
      } finally {
        cleanupDetails(details);
      }
    };
    const outcome = await (this.queue = this.queue.then(show, show));
    if (outcome === "approved") return null;
    const why =
      outcome === "timeout"
        ? "the confirmation window timed out"
        : outcome === "error"
          ? "the confirmation window could not be shown"
          : "the user cancelled in the confirmation window";
    return refusal(
      `NOT EXECUTED — ${why}. Nothing was sent or changed. Do not retry unless the user asks.`
    );
  }

  private expire(): void {
    const t = this.now();
    for (const [token, entry] of this.pending) {
      if (entry.expiresAt <= t) this.pending.delete(token);
    }
  }
}
