import { describe, expect, it } from "bun:test";
import { AppLaunchService } from "./app-launch-service";
import type { AppLaunchConfig, AppLaunchPreferenceStore } from "./app-launch-config";
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

class MemoryAppLaunchPreferenceStore implements AppLaunchPreferenceStore {
  constructor(
    private config: AppLaunchConfig = {
      apps: {
        vscode: {
          id: "vscode",
          name: "VS Code",
          target: "vscode://",
          fallbacks: ["code"],
          enabled: true,
        },
      },
    },
  ) {}

  load(): AppLaunchConfig {
    return this.config;
  }

  save(config: AppLaunchConfig): void {
    this.config = config;
  }
}

describe("AppLaunchService", () => {
  it("queries getStatus and reports appLaunch capability when configured apps exist", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["app_launch.get_status"] = {
      status: "ok",
      available: true,
    };

    const store = new MemoryAppLaunchPreferenceStore();
    const service = new AppLaunchService(bridge, "win32", store);
    expect(service.isAvailable).toBeFalse();

    const status = await service.getStatus();
    expect(status.status).toBe("ok");
    expect(status.available).toBeTrue();
    expect(status.apps).toHaveLength(1);
    expect(status.apps?.[0].id).toBe("vscode");
    expect(service.isAvailable).toBeTrue();
  });

  it("launches allowed application with configured target and fallbacks", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["app_launch.launch"] = {
      status: "ok",
      app: "vscode",
      launched: true,
    };

    const store = new MemoryAppLaunchPreferenceStore();
    const service = new AppLaunchService(bridge, "win32", store);
    const result = await service.launchApp("vscode");

    expect(result).toEqual({
      status: "ok",
      app: "vscode",
      launched: true,
      error: undefined,
    });
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0]).toEqual({
      method: "app_launch.launch",
      params: {
        app: "vscode",
        target: "vscode://",
        fallbacks: ["code"],
      },
    });
  });

  it("rejects unconfigured application IDs without calling host bridge", async () => {
    const bridge = new FakeHostBridge();
    const store = new MemoryAppLaunchPreferenceStore();
    const service = new AppLaunchService(bridge, "win32", store);

    const result = await service.launchApp("malicious_script");

    expect(result.status).toBe("invalid_app");
    expect(result.launched).toBeFalse();
    expect(result.error).toContain("is not configured or enabled");
    expect(bridge.calls).toHaveLength(0);
  });

  it("reports appLaunch capability false if no apps are enabled in config", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["app_launch.get_status"] = {
      status: "ok",
      available: true,
    };

    const store = new MemoryAppLaunchPreferenceStore({
      apps: {
        vscode: {
          id: "vscode",
          name: "VS Code",
          target: "vscode://",
          enabled: false,
        },
      },
    });

    const service = new AppLaunchService(bridge, "win32", store);
    const status = await service.getStatus();

    expect(status.available).toBeFalse();
    expect(service.isAvailable).toBeFalse();
  });
});
