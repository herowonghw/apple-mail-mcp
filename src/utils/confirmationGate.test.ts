import { describe, it, expect, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CONFIRMED_TOOLS,
  ConfirmationGate,
  buildPreview,
  requiresConfirmation,
  type DraftOps,
  type DraftRef,
  type HumanPrompt,
} from "./confirmationGate.js";
import type { DraftCheck } from "./draftTracker.js";
import { READ_ONLY_TOOLS, SENDING_TOOLS } from "./toolMode.js";

const SEND = { to: ["a@example.com"], subject: "Hi", body: "Hello" };
const OK: CallToolResult = { content: [{ type: "text", text: "done" }] };

function tokenFrom(text: string): string {
  const m = /confirmationToken: "([^"]+)"/.exec(text);
  if (!m) throw new Error(`no token in: ${text}`);
  return m[1];
}

function textOf(result: CallToolResult): string {
  return result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
}

function setup(prompt: HumanPrompt = async () => "approved", now = () => 0, drafts?: DraftOps) {
  const promptSpy = vi.fn(prompt);
  const gate = new ConfirmationGate(promptSpy, undefined, now);
  const exec = vi.fn(async (_args: Record<string, unknown>) => OK);
  const run = (tool: string, args: Record<string, unknown>) =>
    gate.run(tool, args, exec, drafts ? { drafts } : {});
  return { run, exec, prompt: promptSpy };
}

const DRAFT: DraftRef = {
  snapshot: {
    id: "55",
    subject: "Hi",
    sender: "Me <me@example.com>",
    to: ["a@example.com"],
    cc: [],
    bcc: [],
    contentHash: "h",
  },
  createdAt: new Date(0),
  route: { from: "Google · me@example.com", to: ["a@example.com"], cc: [], bcc: [] },
};

function fakeDrafts(check: DraftCheck): DraftOps & {
  prepare: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  reveal: ReturnType<typeof vi.fn>;
} {
  return {
    prepare: vi.fn(async () => DRAFT),
    check: vi.fn(async () => check),
    reveal: vi.fn(async () => {}),
    remove: vi.fn(async () => true),
  };
}

describe("requiresConfirmation", () => {
  it("covers every sending tool and the deletes, not drafts or reads", () => {
    for (const tool of SENDING_TOOLS) expect(CONFIRMED_TOOLS.has(tool)).toBe(true);
    for (const tool of ["delete-message", "batch-delete-messages", "move-message"]) {
      expect(CONFIRMED_TOOLS.has(tool)).toBe(true);
    }
    for (const tool of ["create-draft", "update-saved-draft", ...READ_ONLY_TOOLS]) {
      expect(CONFIRMED_TOOLS.has(tool)).toBe(false);
    }
  });

  it("lets reply/forward through when they only save a draft", () => {
    expect(requiresConfirmation("reply-to-message", { id: "1", send: false })).toBe(false);
    expect(requiresConfirmation("forward-message", { id: "1", send: false })).toBe(false);
    expect(requiresConfirmation("reply-to-message", { id: "1", send: true })).toBe(true);
  });
});

describe("ConfirmationGate", () => {
  it("runs ungated tools straight away, without the token", async () => {
    const { run, exec, prompt } = setup();
    expect(await run("create-draft", { ...SEND, confirmationToken: "x" })).toBe(OK);
    expect(exec).toHaveBeenCalledWith(SEND);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("refuses the first call with a preview and token, without prompting", async () => {
    const { run, exec, prompt } = setup();
    const first = await run("send-email", SEND);
    expect(first.isError).toBe(true);
    expect(textOf(first)).toContain("NOT EXECUTED");
    expect(textOf(first)).toContain("a@example.com");
    expect(exec).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("runs after the token is returned and the person approves", async () => {
    const { run, exec, prompt } = setup();
    const token = tokenFrom(textOf(await run("send-email", SEND)));
    expect(await run("send-email", { ...SEND, confirmationToken: token })).toBe(OK);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(SEND);
  });

  it("refuses when the person cancels or the dialog times out", async () => {
    for (const outcome of ["cancelled", "timeout", "error"] as const) {
      const { run, exec } = setup(async () => outcome);
      const token = tokenFrom(textOf(await run("delete-message", { id: "7" })));
      const result = await run("delete-message", { id: "7", confirmationToken: token });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("NOT EXECUTED");
      expect(exec).not.toHaveBeenCalled();
    }
  });

  it("refuses a token when the arguments changed", async () => {
    const { run, exec, prompt } = setup();
    const token = tokenFrom(textOf(await run("send-email", SEND)));
    const result = await run("send-email", {
      ...SEND,
      to: ["attacker@example.com"],
      confirmationToken: token,
    });
    expect(textOf(result)).toContain("arguments changed");
    expect(prompt).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses a token issued for another tool", async () => {
    const { run, exec } = setup();
    const token = tokenFrom(textOf(await run("delete-message", { id: "7" })));
    const result = await run("move-message", { id: "7", confirmationToken: token });
    expect(result.isError).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("spends a token once, even when the person cancels", async () => {
    const { run, prompt } = setup(async () => "cancelled");
    const token = tokenFrom(textOf(await run("send-email", SEND)));
    await run("send-email", { ...SEND, confirmationToken: token });
    const again = await run("send-email", { ...SEND, confirmationToken: token });
    expect(textOf(again)).toContain("already used");
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("refuses an invented or expired token", async () => {
    let t = 0;
    const { run, prompt } = setup(
      async () => "approved",
      () => t
    );
    expect((await run("send-email", { ...SEND, confirmationToken: "made-up" })).isError).toBe(true);
    const token = tokenFrom(textOf(await run("send-email", SEND)));
    t = 11 * 60 * 1000;
    expect((await run("send-email", { ...SEND, confirmationToken: token })).isError).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("matches arguments regardless of key order", async () => {
    const { run } = setup();
    const token = tokenFrom(textOf(await run("send-email", SEND)));
    const reordered = { body: "Hello", subject: "Hi", to: ["a@example.com"] };
    expect(await run("send-email", { ...reordered, confirmationToken: token })).toBe(OK);
  });

  it("shows one dialog at a time", async () => {
    let open = 0;
    let maxOpen = 0;
    const { run } = setup(async () => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
      return "approved";
    });
    const a = tokenFrom(textOf(await run("delete-message", { id: "1" })));
    const b = tokenFrom(textOf(await run("delete-message", { id: "2" })));
    await Promise.all([
      run("delete-message", { id: "1", confirmationToken: a }),
      run("delete-message", { id: "2", confirmationToken: b }),
    ]);
    expect(maxOpen).toBe(1);
  });
});

describe("ConfirmationGate with a Mail draft", () => {
  it("saves a draft on the first call and shows its sender prominently", async () => {
    const drafts = fakeDrafts({ state: "unchanged", snapshot: DRAFT.snapshot });
    const { run, exec } = setup(undefined, undefined, drafts);
    const first = await run("send-email", SEND);
    expect(drafts.prepare).toHaveBeenCalledWith("send-email", SEND);
    expect(textOf(first)).toContain("★ 发件邮箱：Google · me@example.com");
    expect(textOf(first)).toContain("draft of exactly this message was saved");
    expect(exec).not.toHaveBeenCalled();
  });

  it("sends once and removes the draft when it is unchanged", async () => {
    const drafts = fakeDrafts({ state: "unchanged", snapshot: DRAFT.snapshot });
    const { run, exec } = setup(undefined, undefined, drafts);
    const token = tokenFrom(textOf(await run("send-email", SEND)));
    const result = await run("send-email", { ...SEND, confirmationToken: token });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(drafts.remove).toHaveBeenCalledTimes(1);
    expect(textOf(result)).toContain("draft was removed");
  });

  it("does not send again when the person already sent the draft from Mail", async () => {
    const drafts = fakeDrafts({ state: "missing", foundInSent: true });
    const { run, exec } = setup(undefined, undefined, drafts);
    const token = tokenFrom(textOf(await run("send-email", SEND)));
    const result = await run("send-email", { ...SEND, confirmationToken: token });
    expect(exec).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("already sent it from Mail");
  });

  it("does not send when the person edited the draft", async () => {
    const drafts = fakeDrafts({ state: "changed", snapshot: DRAFT.snapshot });
    const { run, exec } = setup(undefined, undefined, drafts);
    const token = tokenFrom(textOf(await run("send-email", SEND)));
    const result = await run("send-email", { ...SEND, confirmationToken: token });
    expect(exec).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("edited the draft");
  });

  it("does not send when the draft cannot be checked", async () => {
    const drafts = fakeDrafts({ state: "unchanged", snapshot: DRAFT.snapshot });
    drafts.check = vi.fn(async () => {
      throw new Error("Mail not responding");
    });
    const { run, exec } = setup(undefined, undefined, drafts);
    const token = tokenFrom(textOf(await run("send-email", SEND)));
    const result = await run("send-email", { ...SEND, confirmationToken: token });
    expect(exec).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("could not be checked");
  });

  it("keeps the draft when the person cancels", async () => {
    const drafts = fakeDrafts({ state: "unchanged", snapshot: DRAFT.snapshot });
    const { run, exec } = setup(async () => "cancelled", undefined, drafts);
    const token = tokenFrom(textOf(await run("send-email", SEND)));
    const result = await run("send-email", { ...SEND, confirmationToken: token });
    expect(exec).not.toHaveBeenCalled();
    expect(drafts.remove).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("draft stays");
  });

  it("opens the draft in Mail from the window", async () => {
    const drafts = fakeDrafts({ state: "unchanged", snapshot: DRAFT.snapshot });
    const { run } = setup(
      async (_title, details, actions) => {
        expect(details.draftAvailable).toBe(true);
        actions?.openDraft?.();
        return "cancelled";
      },
      undefined,
      drafts
    );
    const token = tokenFrom(textOf(await run("send-email", SEND)));
    await run("send-email", { ...SEND, confirmationToken: token });
    expect(drafts.reveal).toHaveBeenCalledTimes(1);
  });

  it("falls back to no draft when saving it fails", async () => {
    const drafts = fakeDrafts({ state: "unchanged", snapshot: DRAFT.snapshot });
    drafts.prepare = vi.fn(async () => {
      throw new Error("boom");
    });
    const { run, exec } = setup(undefined, undefined, drafts);
    const token = tokenFrom(textOf(await run("send-email", SEND)));
    await run("send-email", { ...SEND, confirmationToken: token });
    expect(drafts.check).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe("buildPreview", () => {
  it("replaces inline attachment content with its size and cuts long bodies", () => {
    const preview = buildPreview("send-email", {
      body: "x".repeat(1000),
      attachments: [{ filename: "a.pdf", contentBase64: "A".repeat(4096) }],
    });
    expect(preview).toContain("a.pdf");
    expect(preview).toContain("<base64, ~3 KiB>");
    expect(preview).not.toContain("A".repeat(100));
    expect(preview).toContain("(1000 chars)");
  });
});
