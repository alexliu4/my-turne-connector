import { describe, expect, it } from "bun:test";
import { createDiagnosticsRoutes } from "./diagnostics";
import type { DiagnosticsReport, DiagnosticsService } from "../services/diagnostics-service";

class MockDiagnosticsService implements Partial<DiagnosticsService> {
  async getDiagnostics(): Promise<DiagnosticsReport> {
    return {
      timestamp: "2026-10-12T00:00:00.000Z",
      version: "2.1.0",
      platform: "win32",
      connectorPlatform: "windows",
      sidecarReadiness: true,
      hostBridgeConnected: true,
      carThingConnected: true,
      carThingDevices: [{ id: "device-1", deviceInfo: null }],
      hostStatus: null,
      recentLogs: ["[INFO] System ready"],
    };
  }

  async getRedactedExport(): Promise<Record<string, unknown>> {
    const report = await this.getDiagnostics();
    return {
      ...report,
      path: "C:\\Users\\[REDACTED]\\config.json",
      token: "[REDACTED]",
    };
  }
}

describe("Diagnostics Routes", () => {
  it("returns diagnostics status json", async () => {
    const service = new MockDiagnosticsService() as DiagnosticsService;
    const app = createDiagnosticsRoutes(service);

    const res = await app.handle(new Request("http://localhost/api/diagnostics/status"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.diagnostics.version).toBe("2.1.0");
    expect(json.diagnostics.carThingConnected).toBe(true);
  });

  it("exports redacted diagnostics as downloadable json file attachment", async () => {
    const service = new MockDiagnosticsService() as DiagnosticsService;
    const app = createDiagnosticsRoutes(service);

    const res = await app.handle(new Request("http://localhost/api/diagnostics/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-disposition")).toContain("attachment; filename=\"nocturne-connector-diagnostics-");

    const json = await res.json();
    expect(json.version).toBe("2.1.0");
    expect(json.token).toBe("[REDACTED]");
    expect(json.path).toContain("[REDACTED]");
  });
});
