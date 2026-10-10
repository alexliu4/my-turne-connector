import { describe, expect, it } from "bun:test";
import { AppLaunchService } from "./app-launch-service";
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

describe("AppLaunchService", () => {
  it("queries getStatus and reports appLaunch capability", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["app_launch.get_status"] = {
      status: "ok",
      available: true,
      apps: ["vscode", "discord", "browser", "steam"],
    };

    const service = new AppLaunchService(bridge, "win32");
    expect(service.isAvailable).toBeFalse();

    const status = await service.getStatus();
    expect(status).toEqual({
      status: "ok",
      available: true,
      apps: ["vscode", "discord", "browser", "steam"],
    });
    expect(service.isAvailable).toBeTrue();
  });

  it("launches allowed application successfully", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["app_launch.launch"] = {
      status: "ok",
      app: "vscode",
      launched: true,
    };

    const service = new AppLaunchService(bridge, "win32");
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
      params: { app: "vscode" },
    });
  });

  it("handles non-allowlisted application rejection safely", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["app_launch.launch"] = {
      status: "invalid_app",
      app: "malicious_script.exe",
      launched: false,
      error: "Application 'malicious_script.exe' is not in the configured allowlist",
    };

    const service = new AppLaunchService(bridge, "win32");
    const result = await service.launchApp("malicious_script.exe");

    expect(result).toEqual({
      status: "invalid_app",
      app: "malicious_script.exe",
      launched: false,
      error: "Application 'malicious_script.exe' is not in the configured allowlist",
    });
  });

  it("handles bridge errors gracefully without throwing", async () => {
    const bridge = new FakeHostBridge();
    const service = new AppLaunchService(bridge, "win32");

    const status = await service.getStatus();
    expect(status.status).toBe("unsupported");
    expect(status.available).toBeFalse();
    expect(service.isAvailable).toBeFalse();

    const launchRes = await service.launchApp("vscode");
    expect(launchRes.status).toBe("error");
    expect(launchRes.launched).toBeFalse();
  });
});
