/**
 * What the confirmation dialog shows for a gated tool call: a red headline
 * naming the operation, the question, the message it acts on (recipients,
 * subject, attachments), a short body summary and at most one image.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

export interface DialogField {
  label: string;
  value: string;
}

export interface OperationDetails {
  /** Red headline, e.g. "即将发送邮件". */
  action: string;
  question: string;
  fields: DialogField[];
  summary?: string;
  imagePath?: string;
  imageCaption?: string;
  /** Temporary files to remove once the dialog is closed. */
  tempFiles?: string[];
}

/** What the server could read about an existing message. */
export interface MessageInfo {
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  date?: string;
  body?: string;
  image?: { name: string; path: string };
  /** Why the message could not be read, when it could not. */
  error?: string;
}

export interface LookupOptions {
  account?: string;
  mailbox?: string;
  withBody?: boolean;
  withImage?: boolean;
}

/** Reads an existing message for display. Never throws; failures go in `error`. */
export type MessageLookup = (id: string, options: LookupOptions) => Promise<MessageInfo>;

export const noLookup: MessageLookup = async () => ({ error: "not available" });

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".heic",
  ".webp",
  ".bmp",
  ".tiff",
]);

export function isImageName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(name).toLowerCase());
}

/** The first and last `edge` characters with the middle left out. */
export function summarize(text: string | undefined, edge = 30): string | undefined {
  if (!text) return undefined;
  // U+FFFC marks where Mail had an inline image; zero-width characters are invisible noise.
  const clean = text.replace(/[\uFFFC\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ");
  const chars = Array.from(clean.trim());
  if (chars.length === 0) return undefined;
  if (chars.length <= edge * 2 + 6) return chars.join("");
  return `${chars.slice(0, edge).join("")} …… ${chars.slice(-edge).join("")}`;
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value) return [value];
  return [];
}

function push(fields: DialogField[], label: string, value: unknown): void {
  const items = list(value);
  if (items.length > 0) fields.push({ label, value: items.join(", ") });
}

interface OutgoingAttachments {
  field?: DialogField;
  image?: { name: string; path: string; temp?: string };
}

/** Count and names of outgoing attachments; the first image becomes the preview. */
function outgoingAttachments(value: unknown): OutgoingAttachments {
  if (!Array.isArray(value) || value.length === 0) return {};
  const names: string[] = [];
  let image: OutgoingAttachments["image"];
  for (const item of value) {
    if (typeof item === "string") {
      names.push(basename(item));
      if (!image && isImageName(item)) image = { name: basename(item), path: item };
    } else if (item && typeof item === "object") {
      const { filename, contentBase64 } = item as { filename?: string; contentBase64?: string };
      const name = filename ?? "(unnamed)";
      names.push(name);
      if (!image && filename && isImageName(filename) && typeof contentBase64 === "string") {
        try {
          const dir = mkdtempSync(join(tmpdir(), "amm-confirm-"));
          const path = join(dir, `preview${extname(filename)}`);
          writeFileSync(path, Buffer.from(contentBase64, "base64"), { mode: 0o600 });
          image = { name, path, temp: dir };
        } catch {
          // No preview is fine; the name is still listed.
        }
      }
    }
  }
  return { field: { label: "附件", value: `${names.length} 个：${names.join(", ")}` }, image };
}

function messageFields(fields: DialogField[], info: MessageInfo, prefix = ""): void {
  if (info.error) {
    fields.push({ label: `${prefix}邮件`, value: `（无法读取：${info.error}）` });
    return;
  }
  push(fields, `${prefix}主题`, info.subject || "（无主题）");
  push(fields, `${prefix}发件人`, info.from);
  push(fields, `${prefix}收件人`, info.to);
  push(fields, `${prefix}抄送`, info.cc);
  push(fields, `${prefix}日期`, info.date);
}

function where(args: Record<string, unknown>, mailboxKey: string, accountKey: string): string {
  const mailbox = typeof args[mailboxKey] === "string" ? (args[mailboxKey] as string) : "";
  const account = typeof args[accountKey] === "string" ? (args[accountKey] as string) : "";
  return [account, mailbox].filter(Boolean).join(" / ");
}

/** Builds the dialog content for one gated call. */
export async function describeOperation(
  tool: string,
  args: Record<string, unknown>,
  lookup: MessageLookup,
  options: { withImage: boolean }
): Promise<OperationDetails> {
  const fields: DialogField[] = [];
  const tempFiles: string[] = [];
  const done = (d: Omit<OperationDetails, "fields" | "tempFiles">): OperationDetails => ({
    ...d,
    fields,
    ...(tempFiles.length > 0 ? { tempFiles } : {}),
  });
  const withOutgoing = (value: unknown) => {
    const out = outgoingAttachments(value);
    if (out.field) fields.push(out.field);
    if (out.image?.temp) tempFiles.push(out.image.temp);
    return out.image && options.withImage
      ? { imagePath: out.image.path, imageCaption: `图片附件预览：${out.image.name}` }
      : {};
  };
  const readOne = async (id: string, account?: unknown, mailbox?: unknown, body = true) => {
    const info = await lookup(id, {
      account: typeof account === "string" ? account : undefined,
      mailbox: typeof mailbox === "string" ? mailbox : undefined,
      withBody: body,
      withImage: options.withImage,
    });
    if (info.image) tempFiles.push(info.image.path);
    return info;
  };
  const imageOf = (info: MessageInfo) =>
    info.image
      ? { imagePath: info.image.path, imageCaption: `邮件图片预览：${info.image.name}` }
      : {};

  switch (tool) {
    case "send-email": {
      push(fields, "发件账号", args.account ?? "默认账号");
      push(fields, "收件人", args.to);
      push(fields, "抄送", args.cc);
      push(fields, "密送", args.bcc);
      push(fields, "主题", args.subject);
      const image = withOutgoing(args.attachments);
      return done({
        action: "即将发送邮件",
        question: "确定要发送下面这封邮件吗？发出后无法撤回。",
        summary: summarize(args.body as string),
        ...image,
      });
    }
    case "send-serial-email": {
      const recipients = Array.isArray(args.recipients)
        ? (args.recipients as Array<{ email?: string }>).map((r) => r.email ?? "")
        : [];
      push(fields, "发件账号", args.account ?? "默认账号");
      fields.push({
        label: "收件人",
        value: `${recipients.length} 人，每人单独一封：${recipients.slice(0, 8).join(", ")}${
          recipients.length > 8 ? " …" : ""
        }`,
      });
      push(fields, "主题模板", args.subject);
      return done({
        action: `即将群发 ${recipients.length} 封邮件`,
        question: `确定要给 ${recipients.length} 位收件人逐个发送下面的邮件吗？发出后无法撤回。`,
        summary: summarize(args.body as string),
      });
    }
    case "reply-to-message": {
      const all = args.replyAll === true;
      const info = await readOne(String(args.id), args.account, args.mailbox, false);
      messageFields(fields, info, "原邮件");
      fields.push({
        label: "回复对象",
        value: all ? "原发件人及所有收件人（回复全部）" : "原发件人",
      });
      const image = withOutgoing(args.attachments);
      return done({
        action: all ? "即将回复全部" : "即将回复邮件",
        question: all
          ? "确定要对下面这封邮件“回复全部”吗？所有原收件人都会收到，发出后无法撤回。"
          : "确定要回复下面这封邮件吗？发出后无法撤回。",
        summary: summarize(args.body as string),
        ...image,
      });
    }
    case "forward-message": {
      push(fields, "转发给", args.to);
      const info = await readOne(String(args.id), args.account, args.mailbox, !args.body);
      messageFields(fields, info, "原邮件");
      const image = withOutgoing(args.attachments);
      return done({
        action: "即将转发邮件",
        question: "确定要把下面这封邮件转发出去吗？发出后无法撤回。",
        summary: summarize((args.body as string) || info.body),
        ...(image.imagePath ? image : imageOf(info)),
      });
    }
    case "delete-message":
    case "move-message": {
      const info = await readOne(String(args.id), undefined, undefined);
      messageFields(fields, info);
      const moving = tool === "move-message";
      if (moving) fields.push({ label: "移动到", value: where(args, "mailbox", "account") });
      return done({
        action: moving ? "即将移动邮件" : "即将删除邮件",
        question: moving
          ? "确定要把下面这封邮件移动到其他邮箱吗？"
          : "确定要删除下面这封邮件吗？邮件会移到废纸篓。",
        summary: summarize(info.body),
        ...imageOf(info),
      });
    }
    case "batch-delete-messages":
    case "batch-move-messages": {
      const ids = list(args.ids);
      const shown = ids.slice(0, 5);
      const infos: MessageInfo[] = [];
      for (const id of shown) {
        infos.push(await readOne(id, args.sourceAccount, args.sourceMailbox, false));
      }
      shown.forEach((id, i) => {
        const info = infos[i];
        fields.push({
          label: `第 ${i + 1} 封`,
          value: info.error
            ? `${id}（无法读取：${info.error}）`
            : `${info.subject || "（无主题）"} — ${info.from ?? ""}`,
        });
      });
      if (ids.length > shown.length) {
        fields.push({ label: "其余", value: `还有 ${ids.length - shown.length} 封未列出` });
      }
      const from = where(args, "sourceMailbox", "sourceAccount");
      if (from) fields.push({ label: "所在邮箱", value: from });
      const moving = tool === "batch-move-messages";
      if (moving) fields.push({ label: "移动到", value: where(args, "mailbox", "account") });
      return done({
        action: moving ? `即将批量移动 ${ids.length} 封邮件` : `即将批量删除 ${ids.length} 封邮件`,
        question: moving
          ? `确定要移动这 ${ids.length} 封邮件吗？`
          : `确定要删除这 ${ids.length} 封邮件吗？邮件会移到废纸篓。`,
      });
    }
    case "delete-mailbox":
      push(fields, "邮箱文件夹", args.name);
      push(fields, "账号", args.account);
      return done({
        action: "即将删除邮箱文件夹",
        question: "确定要删除这个邮箱文件夹吗？里面的邮件会一起删除。",
      });
    case "delete-smart-mailbox":
      push(fields, "智能邮箱", args.name);
      return done({ action: "即将删除智能邮箱", question: "确定要删除这个智能邮箱吗？" });
    case "delete-rule":
      push(fields, "规则", args.name);
      return done({ action: "即将删除邮件规则", question: "确定要删除这条规则吗？" });
    case "enable-rule":
      push(fields, "规则", args.name);
      return done({
        action: "即将启用邮件规则",
        question: "确定要启用这条规则吗？规则可能会自动转发或回复邮件。",
      });
    case "create-rule":
      push(fields, "规则", args.name);
      fields.push({ label: "条件", value: JSON.stringify(args.conditions ?? []) });
      fields.push({ label: "动作", value: JSON.stringify(args.actions ?? []) });
      return done({
        action: "即将创建邮件规则",
        question: "确定要创建这条规则吗？规则可能会自动转发、回复或删除邮件。",
      });
    case "delete-template":
      push(fields, "模板", args.id);
      return done({ action: "即将删除邮件模板", question: "确定要删除这个模板吗？" });
    case "set-account-settings": {
      push(fields, "账号", args.account);
      for (const [key, value] of Object.entries(args)) {
        if (key !== "account" && value !== undefined) push(fields, key, String(value));
      }
      return done({
        action: "即将修改账号设置",
        question: "确定要修改这个邮件账号的设置吗？停用账号会停止收发邮件。",
      });
    }
    default:
      for (const [key, value] of Object.entries(args)) {
        if (value !== undefined) push(fields, key, JSON.stringify(value));
      }
      return done({ action: `即将执行 ${tool}`, question: "确定要执行这个操作吗？" });
  }
}

/** The details as plain text, for the model's preview and the fallback dialog. */
export function detailsText(details: OperationDetails): string {
  const lines = [`【${details.action}】`, details.question, ""];
  for (const f of details.fields) lines.push(`${f.label}：${f.value}`);
  if (details.summary) lines.push("", `内容摘要：${details.summary}`);
  return lines.join("\n");
}

export function cleanupDetails(details: OperationDetails): void {
  for (const path of details.tempFiles ?? []) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
}
