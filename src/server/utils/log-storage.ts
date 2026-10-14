import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_ARCHIVES = 4;
export const LOG_LINE_MAX_BYTES = 8 * 1024;

function size(path: string): number {
  try { return statSync(path).size; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export function boundedLogLine(line: string, maxBytes = LOG_LINE_MAX_BYTES): Buffer {
  // Escape control characters so a payload cannot forge severity or lifecycle lines.
  const safe = line.replace(/[\r\n\x00-\x08\x0b-\x1f\x7f]/g, " ");
  const bytes = Buffer.from(safe);
  let end = Math.min(bytes.length, maxBytes - 1);
  // Keep UTF-8 intact so decoding into the recent-log buffer cannot expand a
  // partial character into replacement bytes beyond the documented limit.
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return Buffer.concat([bytes.subarray(0, end), Buffer.from("\n")]);
}

export function appendRotatingLog(path: string, line: string, maxBytes = LOG_FILE_MAX_BYTES): void {
  mkdirSync(dirname(path), { recursive: true });
  // Discard oversized legacy files so upgrading cannot retain unbounded logs.
  for (const candidate of [path, ...Array.from({ length: LOG_ARCHIVES }, (_, i) => `${path}.${i + 1}`)]) {
    if (size(candidate) > maxBytes) unlinkSync(candidate);
  }
  const bytes = boundedLogLine(line, Math.min(LOG_LINE_MAX_BYTES, maxBytes));
  if (size(path) + bytes.length > maxBytes) {
    const oldest = `${path}.${LOG_ARCHIVES}`;
    if (size(oldest)) unlinkSync(oldest);
    for (let index = LOG_ARCHIVES - 1; index >= 1; index--) {
      if (size(`${path}.${index}`)) renameSync(`${path}.${index}`, `${path}.${index + 1}`);
    }
    if (size(path)) renameSync(path, `${path}.1`);
  }
  appendFileSync(path, bytes, { mode: 0o600 });
}

export function redactLogText(text: string, osErrorCode?: unknown): string {
  const suffix =
    typeof osErrorCode === "number" &&
    Number.isInteger(osErrorCode) &&
    osErrorCode >= -2147483648 &&
    osErrorCode <= 4294967295
      ? ` OS error errno=${osErrorCode}`
      : "";
  // Unstructured error responses can contain malformed/escaped JSON; suppress
  // the entire payload when a credential assignment is detected.
  if (
    /(?:token|secret|password|credential|authorization|cookie|api[_-]?key|pin|code)[\s\\"']*[:=]/i.test(
      text,
    ) ||
    /\b(?:Bearer|Basic)\s+\S+/i.test(text) ||
    /https?:\/\/[^\s/]+:[^\s/]+@/i.test(text)
  )
    return "[REDACTED sensitive log payload]" + suffix;
  return (
    text
      .replace(/([a-z]:[/\\]Users[/\\])[^/\\\s"']+/gi, "$1[REDACTED]")
      .replace(/(\/(?:Users|home)\/)[^/\s"']+/g, "$1[REDACTED]") + suffix
  );
}
