/**
 * Shows the confirmation window and waits for a person.
 *
 * The window is native/ConfirmDialog.swift, compiled once with swiftc into the
 * server's Application Support directory (keyed by a hash of the source). When
 * it cannot be built or started, a plain AppleScript dialog asking for the same
 * 6-character code is used instead, so the gate never falls open.
 */
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { detailsText, type OperationDetails } from "@/utils/operationDetails.js";

export type PromptOutcome = "approved" | "cancelled" | "timeout" | "error";

export interface PromptActions {
  /** Called when the person asks to see the draft in Mail; the window stays open. */
  openDraft?: () => void;
}

/** Shows the dialog and resolves once the person has answered. */
export type HumanPrompt = (
  title: string,
  details: OperationDetails,
  actions?: PromptActions
) => Promise<PromptOutcome>;

const TIMEOUT_SECONDS = 180;
const CODE_PATTERN = /^[A-Za-z0-9]{6}$/;

/** build/index.js and src/utils/*.ts sit at different depths below the repo root. */
function swiftSourcePath(): string | undefined {
  for (const rel of ["../native/ConfirmDialog.swift", "../../native/ConfirmDialog.swift"]) {
    const path = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(path)) return path;
  }
  return undefined;
}

let building: Promise<string | undefined> | undefined;

/** Path of the compiled window, building it on first use. Undefined when that fails. */
export function nativeDialogBinary(): Promise<string | undefined> {
  building ??= new Promise((resolve) => {
    const source = swiftSourcePath();
    if (!source || process.platform !== "darwin") return resolve(undefined);
    const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 12);
    const dir = join(homedir(), "Library", "Application Support", "apple-mail-mcp", "bin");
    const binary = join(dir, `confirm-dialog-${hash}`);
    if (existsSync(binary)) return resolve(binary);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return resolve(undefined);
    }
    const partial = `${binary}.${process.pid}.tmp`;
    execFile("swiftc", ["-O", "-o", partial, source], { timeout: 180_000 }, (error) => {
      if (error) return resolve(undefined);
      try {
        renameSync(partial, binary);
        // Older builds, and leftovers from servers that exited mid-compile.
        for (const name of readdirSync(dir)) {
          if (name.startsWith("confirm-dialog-") && join(dir, name) !== binary) {
            rmSync(join(dir, name), { force: true });
          }
        }
        resolve(binary);
      } catch {
        resolve(existsSync(binary) ? binary : undefined);
      }
    });
  });
  return building;
}

function runNative(
  binary: string,
  title: string,
  details: OperationDetails,
  actions: PromptActions
) {
  return new Promise<PromptOutcome>((resolve) => {
    const env = { ...process.env };
    delete env.CONFIRM_DIALOG_SNAPSHOT;
    const child = spawn(binary, [], { env, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    let word = "";
    const timer = setTimeout(() => child.kill(), (TIMEOUT_SECONDS + 20) * 1000);
    // The window prints OPEN_DRAFT while it stays open, and its answer last.
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      let newline: number;
      while ((newline = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, newline).trim();
        out = out.slice(newline + 1);
        if (line === "OPEN_DRAFT") actions.openDraft?.();
        else if (line) word = line;
      }
    });
    child.on("error", () => resolve("error"));
    child.on("close", () => {
      clearTimeout(timer);
      if (out.trim()) word = out.trim();
      resolve(
        word === "APPROVED"
          ? "approved"
          : word === "CANCELLED"
            ? "cancelled"
            : word === "TIMEOUT"
              ? "timeout"
              : "error"
      );
    });
    const shown: Partial<OperationDetails> = { ...details };
    delete shown.tempFiles;
    child.stdin.end(JSON.stringify({ title, ...shown, timeoutSeconds: TIMEOUT_SECONDS }));
  });
}

const FALLBACK_SCRIPT = [
  "on run argv",
  'set r to display dialog (item 2 of argv) with title (item 1 of argv) default answer "" ' +
    'buttons {"取消", "确定"} default button "确定" cancel button "取消" ' +
    `with icon caution giving up after ${TIMEOUT_SECONDS}`,
  'if gave up of r then return "GAVEUP"',
  'return "ANSWER:" & text returned of r',
  "end run",
];

function runFallback(title: string, text: string): Promise<PromptOutcome | "retry"> {
  const args = FALLBACK_SCRIPT.flatMap((line) => ["-e", line]);
  return new Promise((resolve) => {
    execFile(
      "osascript",
      [...args, title, text],
      { timeout: (TIMEOUT_SECONDS + 20) * 1000 },
      (error, stdout, stderr) => {
        if (error) {
          // -128 is "User canceled".
          resolve(String(stderr).includes("-128") ? "cancelled" : "error");
          return;
        }
        const out = String(stdout).trim();
        if (out === "GAVEUP") return resolve("timeout");
        const answer = out.startsWith("ANSWER:") ? out.slice("ANSWER:".length).trim() : "";
        resolve(CODE_PATTERN.test(answer) ? "approved" : "retry");
      }
    );
  });
}

/** Plain AppleScript dialog: up to three tries to type 6 letters or digits. */
async function fallbackPrompt(title: string, details: OperationDetails): Promise<PromptOutcome> {
  const draft = details.draftAvailable
    ? "\n\n草稿已存在 Mail 草稿箱，可以先去 Mail 里查看；在 Mail 里自己发送的话，这里不会重复发送。"
    : "";
  let body = `${detailsText(details)}${draft}\n\n请输入任意 6 位字母或数字后点“确定”；点“取消”则不执行。`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const outcome = await runFallback(title, body);
    if (outcome !== "retry") return outcome;
    body = `⚠️ 需要输入 6 位字母或数字。\n\n${body}`;
  }
  return "cancelled";
}

/** The real prompt: the native window, or the AppleScript dialog when it is unavailable. */
export const macDialogPrompt: HumanPrompt = async (title, details, actions = {}) => {
  const binary = await nativeDialogBinary();
  if (binary) {
    const outcome = await runNative(binary, title, details, actions);
    if (outcome !== "error") return outcome;
  }
  return fallbackPrompt(title, details);
};
