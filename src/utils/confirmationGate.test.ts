import { describe, it, expect, vi } from "vitest";
import {
  CONFIRMED_TOOLS,
  ConfirmationGate,
  buildPreview,
  requiresConfirmation,
  type HumanPrompt,
} from "./confirmationGate.js";
import { READ_ONLY_TOOLS, SENDING_TOOLS } from "./toolMode.js";

const SEND = { to: ["a@example.com"], subject: "Hi", body: "Hello" };

function tokenFrom(text: string): string {
  const m = /confirmationToken: "([^"]+)"/.exec(text);
  if (!m) throw new Error(`no token in: ${text}`);
  return m[1];
}

function textOf(result: { content: Array<{ type: string; text?: string }> } | null): string {
  return result?.content.map((c) => c.text ?? "").join("") ?? "";
}

function gate(prompt: HumanPrompt = async () => "approved", now = () => 0) {
  const spy = vi.fn(prompt);
  return { gate: new ConfirmationGate(spy, now), prompt: spy };
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
  it("passes ungated tools without prompting", async () => {
    const { gate: g, prompt } = gate();
    expect(await g.check("create-draft", SEND)).toBeNull();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("refuses the first call with a preview and token, without prompting", async () => {
    const { gate: g, prompt } = gate();
    const first = await g.check("send-email", SEND);
    expect(first?.isError).toBe(true);
    expect(textOf(first)).toContain("NOT EXECUTED");
    expect(textOf(first)).toContain("a@example.com");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("runs after the token is returned and the person approves", async () => {
    const { gate: g, prompt } = gate();
    const token = tokenFrom(textOf(await g.check("send-email", SEND)));
    expect(await g.check("send-email", { ...SEND, confirmationToken: token })).toBeNull();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("refuses when the person cancels or the dialog times out", async () => {
    for (const outcome of ["cancelled", "timeout", "error"] as const) {
      const { gate: g } = gate(async () => outcome);
      const token = tokenFrom(textOf(await g.check("delete-message", { id: "7" })));
      const result = await g.check("delete-message", { id: "7", confirmationToken: token });
      expect(result?.isError).toBe(true);
      expect(textOf(result)).toContain("NOT EXECUTED");
    }
  });

  it("refuses a token when the arguments changed", async () => {
    const { gate: g, prompt } = gate();
    const token = tokenFrom(textOf(await g.check("send-email", SEND)));
    const result = await g.check("send-email", {
      ...SEND,
      to: ["attacker@example.com"],
      confirmationToken: token,
    });
    expect(textOf(result)).toContain("arguments changed");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("refuses a token issued for another tool", async () => {
    const { gate: g } = gate();
    const token = tokenFrom(textOf(await g.check("delete-message", { id: "7" })));
    const result = await g.check("move-message", { id: "7", confirmationToken: token });
    expect(result?.isError).toBe(true);
  });

  it("spends a token once, even when the person cancels", async () => {
    const { gate: g, prompt } = gate(async () => "cancelled");
    const token = tokenFrom(textOf(await g.check("send-email", SEND)));
    await g.check("send-email", { ...SEND, confirmationToken: token });
    const again = await g.check("send-email", { ...SEND, confirmationToken: token });
    expect(textOf(again)).toContain("already used");
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("refuses an invented or expired token", async () => {
    let t = 0;
    const { gate: g, prompt } = gate(
      async () => "approved",
      () => t
    );
    expect((await g.check("send-email", { ...SEND, confirmationToken: "made-up" }))?.isError).toBe(
      true
    );
    const token = tokenFrom(textOf(await g.check("send-email", SEND)));
    t = 11 * 60 * 1000;
    expect((await g.check("send-email", { ...SEND, confirmationToken: token }))?.isError).toBe(
      true
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it("matches arguments regardless of key order", async () => {
    const { gate: g } = gate();
    const token = tokenFrom(textOf(await g.check("send-email", SEND)));
    const reordered = { body: "Hello", subject: "Hi", to: ["a@example.com"] };
    expect(await g.check("send-email", { ...reordered, confirmationToken: token })).toBeNull();
  });

  it("shows one dialog at a time", async () => {
    let open = 0;
    let maxOpen = 0;
    const { gate: g } = gate(async () => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
      return "approved";
    });
    const a = tokenFrom(textOf(await g.check("delete-message", { id: "1" })));
    const b = tokenFrom(textOf(await g.check("delete-message", { id: "2" })));
    await Promise.all([
      g.check("delete-message", { id: "1", confirmationToken: a }),
      g.check("delete-message", { id: "2", confirmationToken: b }),
    ]);
    expect(maxOpen).toBe(1);
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
