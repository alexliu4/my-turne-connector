import { describe, expect, it } from "bun:test";
import { SystemStatsService } from "./system-stats-service";
import { NocturneManager } from "../nocturne-manager";
import type { HostBridgeCallOptions, HostBridgeClient } from "../platform/host-bridge";

const fakeBluetoothService: any = {
  initialize: async () => {},
  rfcommServer: { setDataHandler: () => {} },
  rfcommOutbound: { setDataHandler: () => {} },
  onEvent: () => {},
};

class DelayHostBridge implements HostBridgeClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  responses: Record<string, unknown> = {};
  delayMs = 0;

  call<TResult = unknown>(
    method: string,
    params?: unknown,
    _options?: HostBridgeCallOptions,
  ): Promise<TResult> {
    this.calls.push({ method, params });
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (method in this.responses) {
          resolve(this.responses[method] as TResult);
        } else {
          reject(new Error(`Unhandled fake call: ${method}`));
        }
      }, this.delayMs);
    });
  }

  onEvent<T = unknown>(_topic: string, _listener: (data: T) => void): () => void {
    return () => {};
  }

  close(): void {}
}

describe("SystemStatsService", () => {
  it("starts with isAvailable = false until capability is verified by host response with telemetry", async () => {
    const bridge = new DelayHostBridge();
    bridge.responses["system_stats.get"] = {
      status: "ok",
      available: true,
      cpu_percent: null,
      memory_percent: 48.2,
      memory_used_bytes: 8000000000,
      memory_total_bytes: 16000000000,
      gpu_percent: null,
    };

    const service = new SystemStatsService(bridge, "win32");
    expect(service.isAvailable).toBeFalse();

    const stats = await service.getStats();

    expect(stats).toEqual({
      status: "ok",
      available: true,
      cpu_percent: null,
      memory_percent: 48.2,
      memory_used_bytes: 8000000000,
      memory_total_bytes: 16000000000,
      gpu_percent: null,
    });
    expect(service.isAvailable).toBeTrue();
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0].method).toBe("system_stats.get");
  });

  it("preserves partial success where cpu_percent is null but memory is valid", async () => {
    const bridge = new DelayHostBridge();
    bridge.responses["system_stats.get"] = {
      status: "ok",
      available: true,
      cpu_percent: null,
      memory_percent: 50.0,
      memory_used_bytes: 8000000000,
      memory_total_bytes: 16000000000,
      gpu_percent: null,
    };

    const service = new SystemStatsService(bridge, "win32");
    const stats = await service.getStats();

    expect(stats.status).toBe("ok");
    expect(stats.available).toBeTrue();
    expect(stats.cpu_percent).toBeNull();
    expect(stats.memory_percent).toBe(50.0);
    expect(service.isAvailable).toBeTrue();
  });

  it("treats all-null responses as available = false and keeps isAvailable = false", async () => {
    const bridge = new DelayHostBridge();
    bridge.responses["system_stats.get"] = {
      status: "ok",
      available: true,
      cpu_percent: null,
      memory_percent: null,
      memory_used_bytes: null,
      memory_total_bytes: null,
      gpu_percent: null,
    };

    const service = new SystemStatsService(bridge, "win32");
    const stats = await service.getStats();

    expect(stats.status).toBe("ok");
    expect(stats.available).toBeFalse();
    expect(service.isAvailable).toBeFalse();
  });

  it("handles status: ok with available: false by setting isAvailable = false", async () => {
    const bridge = new DelayHostBridge();
    bridge.responses["system_stats.get"] = {
      status: "ok",
      available: false,
      cpu_percent: 10.0,
      memory_percent: 40.0,
      memory_used_bytes: 4000000000,
      memory_total_bytes: 10000000000,
      gpu_percent: null,
    };

    const service = new SystemStatsService(bridge, "win32");
    const stats = await service.getStats();

    expect(stats.available).toBeFalse();
    expect(service.isAvailable).toBeFalse();
  });

  it("handles host bridge failure by resetting isAvailable to false and returning null metrics", async () => {
    const bridge = new DelayHostBridge(); // No responses configured
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
    expect(service.isAvailable).toBeFalse();
  });

  it("deduplicates concurrent in-flight requests", async () => {
    const bridge = new DelayHostBridge();
    bridge.delayMs = 20;
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

    // Launch 3 parallel requests
    const [stats1, stats2, stats3] = await Promise.all([
      service.getStats(),
      service.getStats(),
      service.getStats(),
    ]);

    expect(stats1).toEqual(stats2);
    expect(stats2).toEqual(stats3);
    expect(bridge.calls).toHaveLength(1); // Exact 1 host call made!
  });

  it("triggers a new host call after cache TTL (1 second) expires", async () => {
    const bridge = new DelayHostBridge();
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

    await service.getStats();
    expect(bridge.calls).toHaveLength(1);

    // Call again immediately -> served from cache
    await service.getStats();
    expect(bridge.calls).toHaveLength(1);

    // Manually expire cache fetchedAt timestamp
    const internal = service as any;
    if (internal.cache) {
      internal.cache.fetchedAt = Date.now() - 1001;
    }

    await service.getStats();
    expect(bridge.calls).toHaveLength(2);
  });

  it("reports systemStats capability in NocturneManager only after verification", async () => {
    const bridge = new DelayHostBridge();
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
      bluetoothService: fakeBluetoothService,
    });

    // Before probe/verification, systemStats is false
    expect(manager.getCapabilities().systemStats).toBeFalse();

    // Perform RPC call which verifies host support
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

    // Now verified!
    expect(manager.getCapabilities().systemStats).toBeTrue();
  });

  it("returns unsupported stats when systemStatsService is absent on non-win32 platform", async () => {
    const manager = new NocturneManager({
      platform: "linux",
      bluetoothService: fakeBluetoothService,
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
