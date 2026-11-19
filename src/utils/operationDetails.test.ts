import { describe, it, expect } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupDetails,
  describeOperation,
  detailsText,
  noLookup,
  summarize,
  type MessageLookup,
} from "./operationDetails.js";

const field = (d: { fields: { label: string; value: string }[] }, label: string) =>
  d.fields.find((f) => f.label === label)?.value;

describe("summarize", () => {
  it("keeps short text whole and collapses whitespace", () => {
    expect(summarize("Hello\n\n  world")).toBe("Hello world");
  });

  it("keeps the first and last 30 characters of long text", () => {
    const text = "开".repeat(30) + "中".repeat(100) + "尾".repeat(30);
    expect(summarize(text)).toBe(`${"开".repeat(30)} …… ${"尾".repeat(30)}`);
  });

  it("drops Mail's inline-image placeholder", () => {
    expect(summarize("see below\uFFFC")).toBe("see below");
  });

  it("returns undefined for empty text", () => {
    expect(summarize("   ")).toBeUndefined();
    expect(summarize(undefined)).toBeUndefined();
  });
});

describe("describeOperation", () => {
  it("shows recipients, subject, attachments and summary for send-email", async () => {
    const d = await describeOperation(
      "send-email",
      {
        to: ["a@example.com", "b@example.com"],
        cc: ["c@example.com"],
        subject: "Report",
        body: "Hi",
        attachments: ["/Users/me/report.pdf", "/Users/me/chart.png"],
      },
      noLookup,
      { withImage: true }
    );
    expect(d.action).toBe("即将发送邮件");
    expect(field(d, "收件人")).toBe("a@example.com, b@example.com");
    expect(field(d, "抄送")).toBe("c@example.com");
    expect(field(d, "主题")).toBe("Report");
    expect(field(d, "附件")).toBe("2 个：report.pdf, chart.png");
    expect(d.summary).toBe("Hi");
    expect(d.imagePath).toBe("/Users/me/chart.png");
  });

  it("writes an inline image attachment to a temp file and cleans it up", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const d = await describeOperation(
      "send-email",
      {
        to: ["a@example.com"],
        subject: "s",
        body: "b",
        attachments: [{ filename: "x.png", contentBase64: png }],
      },
      noLookup,
      { withImage: true }
    );
    expect(d.imagePath && existsSync(d.imagePath)).toBe(true);
    cleanupDetails(d);
    expect(existsSync(d.imagePath!)).toBe(false);
  });

  it("omits the image when not asked for one", async () => {
    const d = await describeOperation(
      "send-email",
      { to: ["a@example.com"], subject: "s", body: "b", attachments: ["/x/y.jpg"] },
      noLookup,
      { withImage: false }
    );
    expect(d.imagePath).toBeUndefined();
  });

  it("names the original message for reply-all", async () => {
    const lookup: MessageLookup = async (id) => ({
      subject: `Subject of ${id}`,
      from: "boss@example.com",
      to: "me@example.com",
    });
    const d = await describeOperation(
      "reply-to-message",
      { id: "42", body: "Thanks!", replyAll: true },
      lookup,
      { withImage: false }
    );
    expect(d.action).toBe("即将回复全部");
    expect(field(d, "原邮件主题")).toBe("Subject of 42");
    expect(field(d, "原邮件发件人")).toBe("boss@example.com");
    expect(d.summary).toBe("Thanks!");
  });

  it("shows the message being deleted, its body summary and image", async () => {
    const image = join(tmpdir(), `amm-test-${Date.now()}.png`);
    writeFileSync(image, "x");
    const lookup: MessageLookup = async () => ({
      subject: "Invoice",
      from: "shop@example.com",
      body: "Your invoice",
      image: { name: "logo.png", path: image },
    });
    const d = await describeOperation("delete-message", { id: "7" }, lookup, { withImage: true });
    expect(d.action).toBe("即将删除邮件");
    expect(field(d, "主题")).toBe("Invoice");
    expect(d.summary).toBe("Your invoice");
    expect(d.imagePath).toBe(image);
    cleanupDetails(d);
    expect(existsSync(image)).toBe(false);
  });

  it("still asks when the message cannot be read", async () => {
    const lookup: MessageLookup = async () => ({ error: "Mail.app not running" });
    const d = await describeOperation("delete-message", { id: "7" }, lookup, { withImage: false });
    expect(field(d, "邮件")).toContain("Mail.app not running");
  });

  it("lists the first five messages of a batch and counts the rest", async () => {
    const lookup: MessageLookup = async (id) => ({ subject: `S${id}`, from: "x@example.com" });
    const ids = Array.from({ length: 8 }, (_, i) => String(i));
    const d = await describeOperation("batch-delete-messages", { ids }, lookup, {
      withImage: false,
    });
    expect(d.action).toBe("即将批量删除 8 封邮件");
    expect(field(d, "第 1 封")).toBe("S0 — x@example.com");
    expect(field(d, "其余")).toBe("还有 3 封未列出");
  });

  it("renders as text for the model and the fallback dialog", async () => {
    const d = await describeOperation(
      "send-email",
      { to: ["a@example.com"], subject: "Hi", body: "Body" },
      noLookup,
      { withImage: false }
    );
    const text = detailsText(d);
    expect(text).toContain("【即将发送邮件】");
    expect(text).toContain("收件人：a@example.com");
    expect(text).toContain("内容摘要：Body");
  });
});
