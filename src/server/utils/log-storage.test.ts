import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRotatingLog, boundedLogLine, redactLogText } from "./log-storage";

describe("bounded log storage", () => {
  it("caps each file including oversized entries and replaces oldest archives", () => {
    const dir = mkdtempSync(join(tmpdir(), "connector-logs-"));
    try {
      const path = join(dir, "connector.log");
      writeFileSync(path, "legacy".repeat(100));
      writeFileSync(`${path}.4`, "legacy".repeat(100));
      for (let index = 0; index < 20; index++) appendRotatingLog(path, `${index}:` + "é".repeat(100), 64);
      expect(readdirSync(dir).length).toBe(5);
      for (const file of readdirSync(dir)) expect(statSync(join(dir, file)).size).toBeLessThanOrEqual(64);
      expect(readFileSync(path, "utf8")).toStartWith("19:");
      expect(readFileSync(`${path}.4`, "utf8")).toStartWith("15:");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("escapes forged lines and limits bytes", () => {
    expect(boundedLogLine("message\n[ERROR] forged\r\x00").toString()).toBe("message [ERROR] forged  \n");
    expect(boundedLogLine("😀".repeat(10000)).length).toBeLessThanOrEqual(8192);
    expect(boundedLogLine("😀".repeat(10000)).toString()).not.toContain("�");
  });
  it("suppresses malformed and escaped credential payloads before storage", () => {
    for (const value of ['{"access_token":"private', '{\\"password\\":\\"private\\"}', 'pin=123456', 'code: 123456', 'Bearer private', 'https://name:private@example.com']) {
      expect(redactLogText(value)).not.toContain("private");
      expect(redactLogText(value)).not.toContain("123456");
    }
    expect(redactLogText("Opening C:\\Users\\Alex\\file")).toContain("[REDACTED]");
  });
});

import { spyOn } from "bun:test";
import { createLogger, getRecentLogs } from "./logger";

it("redacts console and in-memory log outputs and bounds recent history", () => {
  const output = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const logger = createLogger("LogPrivacyTest");
    logger.warn('Failed {"refresh_token":"private-example"}');
    expect(output.mock.calls[0]?.[0]).not.toContain("private-example");
    for (let i = 0; i < 60; i++) logger.warn(`entry ${i} ${"x".repeat(9000)}`);
    const recent = getRecentLogs();
    expect(recent.length).toBe(50);
    for (const line of recent) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(8191);
    expect(JSON.stringify(recent)).not.toContain("private-example");
  } finally { output.mockRestore(); }
});

it("keeps structured numeric OS error evidence without weakening payload redaction", () => {
  expect(redactLogText("OS failure code: 5", 5)).toBe(
    "[REDACTED sensitive log payload] OS error errno=5",
  );
  expect(redactLogText("pin=123456 password=private", -4091)).toBe(
    "[REDACTED sensitive log payload] OS error errno=-4091",
  );
  for (const code of ["123456", NaN, Infinity, {}, 1.1])
    expect(redactLogText("code: 123456", code)).toBe(
      "[REDACTED sensitive log payload]",
    );
  expect(
    boundedLogLine(redactLogText("x".repeat(10000), 5)).length,
  ).toBeLessThanOrEqual(8192);
});
