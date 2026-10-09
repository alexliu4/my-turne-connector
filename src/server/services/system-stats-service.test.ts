import { describe, expect, it } from "bun:test";
import { SystemStatsService } from "./system-stats-service";
import { NocturneManager } from "../nocturne-manager";
import type { HostBridgeCallOptions, HostBridgeClient } from "../platform/host-bridge";

class FakeHostBridge implements HostBridgeClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  responses: Record<string, unknown> = {};

  call<TResult = unknown>(
    method: string,
    params?: unknown,
    _options?: HostBridgeCallOptions,
  ): Promise<TResult> {
    this.calls.push({ method, params });
    if (method in this.responses) {
      return Promise.resolve(this.responses[method] as TResult);
    }
    return Promise.reject(new Error(`Unhandled fake call: ${method}`));
  }

  onEvent<T = unknown>(_topic: string, _listener: (data: T) => void): () => void {
    return () => {};
  }

  close(): void {}
}

describe("SystemStatsService", () => {
  it("queries getStats and returns formatted telemetry", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["system_stats.get"] = {
      status: "ok",
      available: true,
      cpu_percent: 12.5,
      memory_percent: 48.2,
      memory_used_bytes: 8000000000,
      memory_total_bytes: 16000000000,
      gpu_percent: null,
    };

    const service = new SystemStatsService(bridge, "win32");
    expect(service.isAvailable).toBeTrue();

    const stats = await service.getStats();

    expect(stats).toEqual({
      status: "ok",
      available: true,
      cpu_percent: 12.5,
      memory_percent: 48.2,
      memory_used_bytes: 8000000000,
      memory_total_bytes: 16000000000,
      gpu_percent: null,
    });
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0].method).toBe("system_stats.get");
  });

  it("caches stats within TTL to limit sampling overhead", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["system_stats.get"] = {
      status: "ok",
      available: true,
      cpu_percent: 15.0,
      memory_percent: 50.0,
      memory_used_bytes: 8000000000,
      memory_total_bytes: 16000000000,
      gpu_percent: null,
    };

    const service = new SystemStatsService(bridge, "win32");

    const stats1 = await service.getStats();
    const stats2 = await service.getStats();

    expect(stats1).toEqual(stats2);
    expect(bridge.calls).toHaveLength(1); // Only called host bridge once due to caching!
  });

  it("handles host bridge failure gracefully without throwing", async () => {
    const bridge = new FakeHostBridge(); // No responses configured
    const service = new SystemStatsService(bridge, "win32");

    const stats = await service.getStats();

    expect(stats).toEqual({
      status: "unsupported",
      available: false,
      cpu_percent: null,
      memory_percent: null,
      memory_used_bytes: null,
      memory_total_bytes: null,
      gpu_percent: null,
      message: "Unhandled fake call: system_stats.get",
    });
  });

  it("reports systemStats capability and handles RPC dispatch in NocturneManager", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["system_stats.get"] = {
      status: "ok",
      available: true,
      cpu_percent: 20.0,
      memory_percent: 60.0,
      memory_used_bytes: 9600000000,
      memory_total_bytes: 16000000000,
      gpu_percent: null,
    };

    const manager = new NocturneManager({
      platform: "win32",
      hostBridge: bridge,
    });

    const capabilities = manager.getCapabilities();
    expect(capabilities.systemStats).toBeTrue();

    const rpcMethods = ["system_stats.get", "systemStats.get", "stats.get", "system.get_stats"];
    for (const method of rpcMethods) {
      const callRes = await manager.onCall("conn-1", method, {});
      expect(callRes.error).toBeUndefined();
      expect(callRes.result).toEqual({
        status: "ok",
        available: true,
        cpu_percent: 20.0,
        memory_percent: 60.0,
        memory_used_bytes: 9600000000,
        memory_total_bytes: 16000000000,
        gpu_percent: null,
      });
    }
  });

  it("returns unsupported stats when systemStatsService is absent on non-win32 platform", async () => {
    const manager = new NocturneManager({
      platform: "linux",
    });

    const capabilities = manager.getCapabilities();
    expect(capabilities.systemStats).toBeFalse();

    const callRes = await manager.onCall("conn-1", "system_stats.get", {});
    expect(callRes.result).toEqual({
      status: "unsupported",
      available: false,
      cpu_percent: null,
      memory_percent: null,
      memory_used_bytes: null,
      memory_total_bytes: null,
      gpu_percent: null,
    });
  });
});
