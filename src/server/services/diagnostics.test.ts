import { describe, expect, it } from "bun:test";
import { redactSensitiveText, redactValue } from "./diagnostics-service";

describe("DiagnosticsService & Redaction Logic", () => {
  it("redacts sensitive Windows user file paths", () => {
    const input =
      "Error opening file at C:\\Users\\alexl\\AppData\\Local\\Nocturne\\secret.json";
    const redacted = redactSensitiveText(input);
    expect(redacted).toBe(
      "Error opening file at C:\\Users\\[REDACTED]\\AppData\\Local\\Nocturne\\secret.json",
    );
  });

  it("redacts sensitive POSIX user file paths", () => {
    const inputPosixHome = "Failed reading /home/alexl/config.json";
    expect(redactSensitiveText(inputPosixHome)).toBe(
      "Failed reading /home/[REDACTED]/config.json",
    );

    const inputMacUsers = "Failed reading /Users/alexl/config.json";
    expect(redactSensitiveText(inputMacUsers)).toBe(
      "Failed reading /Users/[REDACTED]/config.json",
    );
  });

  it("redacts bearer tokens and key-value query secrets", () => {
    const inputBearer =
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret";
    expect(redactSensitiveText(inputBearer)).toBe(
      "Authorization: Bearer [REDACTED]",
    );

    const inputParam = "http://example.com/api?token=supersecret123&user=john";
    expect(redactSensitiveText(inputParam)).toBe(
      "http://example.com/api?token=[REDACTED]&user=john",
    );
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

import { DiagnosticsService } from "./diagnostics-service";

function fakeManager(refresh: () => Promise<unknown>, connected = false) {
  return {
    refreshHostStatus: refresh,
    getHostStatus: () => ({ services: { volume: { available: false } } }),
    getConnectionStatus: () => ({
      connected: true,
      deviceCount: 1,
      devices: [{ deviceInfo: { device: "Car Thing", version: "1.0" } }],
    }),
    isHostBridgeConnected: () => connected,
  } as unknown as ConstructorParameters<typeof DiagnosticsService>[0];
}

it("returns cached health within the deadline and shares an in-flight probe", async () => {
  let calls = 0;
  let finish!: () => void;
  const service = new DiagnosticsService(
    fakeManager(() => {
      calls++;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    }),
    10,
  );
  const reports = await Promise.all([
    service.getDiagnostics(),
    service.getRedactedExport(),
  ]);
  expect(calls).toBe(1);
  for (const report of reports) {
    expect(report.health).toMatchObject({
      nativeHost: "unavailable",
      sidecar: "ready",
      bluetoothRoute: "connected",
      featureProbe: "timeout",
    });
  }
  await service.getDiagnostics();
  expect(calls).toBe(1);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await service.getDiagnostics();
  expect(calls).toBe(2);
  finish();
});

it("reports probe failure independently of route and native connectivity", async () => {
  const service = new DiagnosticsService(
    fakeManager(async () => {
      throw new Error("secret");
    }, true),
  );
  const report = await service.getDiagnostics();
  expect(report.health).toMatchObject({
    nativeHost: "connected",
    bluetoothRoute: "connected",
    featureProbe: "error",
  });
  expect(JSON.stringify(report)).not.toContain("secret");
});

import {
  supportReport,
  serializeDiagnosticsExport,
  MAX_DIAGNOSTICS_EXPORT_BYTES,
} from "./diagnostics-service";

it("bounds large collections and ignores arbitrarily deep, secret-bearing host metadata", () => {
  let nested: unknown = {
    token: "deep-secret",
    code: "987654",
    params: { command: "macro-secret" },
  };
  for (let i = 0; i < 20_000; i++) nested = { nested };
  const input = {
    version: "2.1.4",
    hostBridgeConnected: true,
    carThingDeviceCount: 100_000,
    carThingDevices: Array.from({ length: 100_000 }, () => ({
      deviceType: "private-host-name",
      firmwareVersion: "1.2.3",
    })),
    hostStatus: {
      services: { volume: { available: true, nested }, arbitrary: nested },
      nested,
    },
    health: {
      nativeHost: "connected",
      featureProbe: "complete",
      features: { volume: true, arbitrary: nested },
    },
    recentLogs: ["raw-log-secret", "Recent ERROR entries: 2"],
  };
  const report = supportReport(input);
  expect(report.truncated).toBe(true);
  expect(report.devicesTruncated).toBe(true);
  expect(report.carThingDevices).toHaveLength(32);
  expect(report.carThingDeviceCount).toBe(100_000);
  expect(report.hostStatus?.services.volume.available).toBe(true);
  const json = serializeDiagnosticsExport(input);
  expect(Buffer.byteLength(json)).toBeLessThan(MAX_DIAGNOSTICS_EXPORT_BYTES);
  for (const secret of [
    "deep-secret",
    "987654",
    "macro-secret",
    "private-host-name",
    "raw-log-secret",
    "arbitrary",
  ])
    expect(json).not.toContain(secret);
});

it("drops oversized and secret-bearing optional strings while retaining health", () => {
  const json = serializeDiagnosticsExport({
    version: "2.1.4",
    sidecarReadiness: true,
    carThingDevices: [
      {
        firmwareVersion: "x".repeat(10_000_000),
        deviceType: "Bearer opaque-secret",
      },
      { firmwareVersion: "1.2.3-opaque-secret" },
      { firmwareVersion: { pin: "987654" } },
    ],
    hostStatus: {
      services: {
        media: {
          available: true,
          source: "opaque-secret",
          params: { command: "opaque-secret" },
        },
      },
    },
    recentLogs: ["pairingCode=987654", "Bearer opaque-secret"],
    health: {
      nativeHost: "unavailable",
      featureProbe: "timeout",
      features: { media: true },
    },
  });
  expect(Buffer.byteLength(json)).toBeLessThan(MAX_DIAGNOSTICS_EXPORT_BYTES);
  for (const secret of ["opaque-secret", "987654", "params"])
    expect(json).not.toContain(secret);
  const report = JSON.parse(json);
  expect(report.truncated).toBe(true);
  expect(report.health.featureProbe).toBe("timeout");
  expect(report.carThingDevices[1].firmwareVersion).toBe("1.2.3");
});

it("bounds generic redaction depth, collection sizes, strings, and cycles", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const json = JSON.stringify(
    redactValue({
      cycle,
      items: Array.from({ length: 10_000 }, () => ({
        message: "x".repeat(10_000),
        password: "secret",
      })),
    }),
  );
  expect(json).toContain("[TRUNCATED]");
  expect(json).not.toContain("secret");
  expect(json.length).toBeLessThan(32_000);
});
