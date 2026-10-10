import { describe, expect, it } from "bun:test";
import { MacroService } from "./macro-service";
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

describe("MacroService", () => {
  it("queries getStatus and reports macro capability", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["macros.get_status"] = {
      status: "ok",
      available: true,
    };

    const service = new MacroService(bridge, "win32");
    expect(service.isAvailable).toBeFalse();

    const status = await service.getStatus();
    expect(status).toEqual({
      status: "ok",
      available: true,
    });
    expect(service.isAvailable).toBeTrue();
  });

  it("executes valid macro action", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["macros.execute"] = {
      status: "ok",
      action: "app",
      app: "vscode",
      launched: true,
    };

    const service = new MacroService(bridge, "win32");
    const result = await service.executeMacro({ action: "app", app: "vscode" });

    expect(result).toMatchObject({
      status: "ok",
      action: "app",
      app: "vscode",
      launched: true,
    });
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0]).toEqual({
      method: "macros.execute",
      params: { action: "app", app: "vscode" },
    });
  });

  it("handles invalid macro action safely", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["macros.execute"] = {
      status: "invalid_action",
      error: "Unknown or unconfigured macro action type 'invalid'",
    };

    const service = new MacroService(bridge, "win32");
    const result = await service.executeMacro({ action: "invalid" });

    expect(result.status).toBe("invalid_action");
    expect(result.error).toContain("Unknown or unconfigured");
  });

  it("handles bridge errors gracefully", async () => {
    const bridge = new FakeHostBridge();
    const service = new MacroService(bridge, "win32");

    const status = await service.getStatus();
    expect(status.status).toBe("unsupported");
    expect(status.available).toBeFalse();

    const execRes = await service.executeMacro({ action: "app", app: "vscode" });
    expect(execRes.status).toBe("error");
  });
});
