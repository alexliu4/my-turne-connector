import { describe, expect, it } from "bun:test";
import { createDiagnosticsRoutes } from "./diagnostics";
import { DiagnosticsService, redactSensitiveText, redactValue } from "../services/diagnostics-service";
import type { DiagnosticsReport } from "../services/diagnostics-service";

class MockDiagnosticsService implements Partial<DiagnosticsService> {
  constructor(
    private readonly hostConnected: boolean | null = true,
    private readonly deviceConnected: boolean = true,
  ) {}

  async getDiagnostics(): Promise<DiagnosticsReport> {
    return {
      timestamp: "2026-10-12T00:00:00.000Z",
      version: "2.1.0",
      platform: "win32",
      connectorPlatform: "windows",
      sidecarReadiness: true,
      hostBridgeConnected: this.hostConnected,
      carThingConnected: this.deviceConnected,
      carThingDeviceCount: this.deviceConnected ? 1 : 0,
      carThingDevices: this.deviceConnected ? [{ deviceIndex: 1, deviceType: "Nocturne Car Thing", firmwareVersion: "1.0.0" }] : [],
      hostStatus: null,
      recentLogs: [redactSensitiveText("[INFO] Loaded C:\\Users\\alexl\\config.json with token=secret123")],
    };
  }

  async getRedactedExport(): Promise<Record<string, unknown>> {
    const report = await this.getDiagnostics();
    return redactValue(report) as Record<string, unknown>;
  }
}

describe("Diagnostics Routes & DiagnosticsService", () => {
  it("returns diagnostics status json for Windows localhost requests", async () => {
    const service = new MockDiagnosticsService(true, false) as unknown as DiagnosticsService;
    const app = createDiagnosticsRoutes(service, "win32", "http://localhost");

    const res = await app.handle(new Request("http://localhost/api/diagnostics/status", { headers: { origin: "http://localhost" } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.diagnostics.version).toBe("2.1.0");
    expect(json.diagnostics.hostBridgeConnected).toBe(true);
    expect(json.diagnostics.carThingConnected).toBe(false);
  });

  it("independently reports device connected while native host is unavailable", async () => {
    const service = new MockDiagnosticsService(false, true) as unknown as DiagnosticsService;
    const app = createDiagnosticsRoutes(service, "win32", "http://localhost");

    const res = await app.handle(new Request("http://localhost/api/diagnostics/status", { headers: { origin: "http://localhost" } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.diagnostics.hostBridgeConnected).toBe(false);
    expect(json.diagnostics.carThingConnected).toBe(true);
  });

  it("exports redacted diagnostics as downloadable json file attachment", async () => {
    const service = new MockDiagnosticsService() as unknown as DiagnosticsService;
    const app = createDiagnosticsRoutes(service, "win32", "http://localhost");

    const res = await app.handle(new Request("http://localhost/api/diagnostics/export", { headers: { origin: "http://localhost" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-disposition")).toContain("attachment; filename=\"nocturne-connector-diagnostics-");

    const json = await res.json();
    expect(json.version).toBe("2.1.0");
    expect(json.recentLogs[0]).toContain("C:\\Users\\[REDACTED]\\config.json");
    expect(json.recentLogs[0]).toContain("token=[REDACTED]");
  });

  it("rejects non-Windows or cross-site requests to diagnostics API", async () => {
    const linuxService = new MockDiagnosticsService() as unknown as DiagnosticsService;
    const linuxApp = createDiagnosticsRoutes(linuxService, "linux");

    const resLinux = await linuxApp.handle(new Request("http://localhost/api/diagnostics/status", { headers: { origin: "http://localhost" } }));
    expect(resLinux.status).toBe(403);

    const winService = new MockDiagnosticsService() as unknown as DiagnosticsService;
    const winApp = createDiagnosticsRoutes(winService, "win32", "http://localhost");

    const resCrossSite = await winApp.handle(
      new Request("http://localhost/api/diagnostics/status", {
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );
    expect(resCrossSite.status).toBe(403);
  });
});

it("omits JSON secrets from complete status and export HTTP responses", async () => {
  const { createLogger } = await import("../utils/logger");
  const secrets = {
    access_token: "sensitive-example-value",
    refresh_token: "refresh-example-value",
    password: "password-example-value",
    secret: "secret-example-value",
    api_key: "apikey-example-value",
    authorization: "authorization-example-value",
  };
  const log = createLogger("DiagnosticsTest");
  log.warn(`Failed response ${JSON.stringify(secrets)}`);
  log.error(`Escaped response ${JSON.stringify(JSON.stringify(secrets))}`);
  log.warn('Malformed response {"access_token":"sensitive-example-value');
  const manager = {
    refreshHostStatus: async () => null,
    getConnectionStatus: () => ({ connected: false, deviceCount: 0, devices: [] }),
    isHostBridgeConnected: () => false,
  } as unknown as ConstructorParameters<typeof DiagnosticsService>[0];
  const app = createDiagnosticsRoutes(new DiagnosticsService(manager), "win32", "http://localhost");
  for (const path of ["status", "export"]) {
    const res = await app.handle(new Request(`http://localhost/api/diagnostics/${path}`, {
      headers: { origin: "http://localhost" },
    }));
    expect(res.status).toBe(200);
    const serialized = await res.text();
    for (const secret of Object.values(secrets)) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("Recent WARN entries:");
  }
});
