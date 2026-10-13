import { describe, expect, it } from "bun:test";
import {
  redactSensitiveText,
  redactValue,
} from "./diagnostics-service";

describe("DiagnosticsService & Redaction Logic", () => {
  it("redacts sensitive Windows user file paths", () => {
    const input = "Error opening file at C:\\Users\\alexl\\AppData\\Local\\Nocturne\\secret.json";
    const redacted = redactSensitiveText(input);
    expect(redacted).toBe("Error opening file at C:\\Users\\[REDACTED]\\AppData\\Local\\Nocturne\\secret.json");
  });

  it("redacts sensitive POSIX user file paths", () => {
    const inputPosixHome = "Failed reading /home/alexl/config.json";
    expect(redactSensitiveText(inputPosixHome)).toBe("Failed reading /home/[REDACTED]/config.json");

    const inputMacUsers = "Failed reading /Users/alexl/config.json";
    expect(redactSensitiveText(inputMacUsers)).toBe("Failed reading /Users/[REDACTED]/config.json");
  });

  it("redacts bearer tokens and key-value query secrets", () => {
    const inputBearer = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret";
    expect(redactSensitiveText(inputBearer)).toBe("Authorization: Bearer [REDACTED]");

    const inputParam = "http://example.com/api?token=supersecret123&user=john";
    expect(redactSensitiveText(inputParam)).toBe("http://example.com/api?token=[REDACTED]&user=john");
  });

  it("recursively redacts nested object properties with sensitive keys", () => {
    const data = {
      version: "2.1.0",
      user: {
        name: "Alex",
        authToken: "secret-token-value",
        nested: {
          api_key: "key-12345",
          path: "C:\\Users\\alexl\\file.txt",
        },
      },
    };

    const redacted = redactValue(data) as any;
    expect(redacted.version).toBe("2.1.0");
    expect(redacted.user.name).toBe("Alex");
    expect(redacted.user.authToken).toBe("[REDACTED]");
    expect(redacted.user.nested.api_key).toBe("[REDACTED]");
    expect(redacted.user.nested.path).toBe("C:\\Users\\[REDACTED]\\file.txt");
  });
});
