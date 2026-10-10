import { describe, expect, it } from "bun:test";
import { MacroService } from "./macro-service";
import type { MacroConfig, MacroPreferenceStore } from "./macro-config";
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

class MemoryMacroPreferenceStore implements MacroPreferenceStore {
  constructor(
    private config: MacroConfig = {
      macros: {
        toggle_media: {
          id: "toggle_media",
          name: "Play/Pause Media",
          action: { type: "media", control: "toggle" },
          enabled: true,
        },
        open_vscode: {
          id: "open_vscode",
          name: "Launch VS Code",
          action: { type: "app", appId: "vscode" },
          enabled: true,
        },
      },
    },
  ) {}

  load(): MacroConfig {
    return this.config;
  }

  save(config: MacroConfig): void {
    this.config = config;
  }
}

describe("MacroService", () => {
  it("queries getStatus and reports macro capability when configured macros exist", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["macros.get_status"] = {
      status: "ok",
      available: true,
    };

    const store = new MemoryMacroPreferenceStore();
    const service = new MacroService(bridge, "win32", store);
    expect(service.isAvailable).toBeFalse();

    const status = await service.getStatus();
    expect(status.status).toBe("ok");
    expect(status.available).toBeTrue();
    expect(status.macros).toHaveLength(2);
    expect(service.isAvailable).toBeTrue();
  });

  it("executes configured macro ID successfully", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["macros.execute"] = {
      status: "ok",
      action: "media",
      control: "toggle",
    };

    const store = new MemoryMacroPreferenceStore();
    const service = new MacroService(bridge, "win32", store);
    const result = await service.executeMacro({ id: "toggle_media" });

    expect(result).toMatchObject({
      status: "ok",
      action: "media",
    });
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0]).toEqual({
      method: "macros.execute",
      params: {
        id: "toggle_media",
        type: "media",
        control: "toggle",
      },
    });
  });

  it("rejects unconfigured macro IDs or missing macro ID without calling host bridge", async () => {
    const bridge = new FakeHostBridge();
    const store = new MemoryMacroPreferenceStore();
    const service = new MacroService(bridge, "win32", store);

    const resultMissing = await service.executeMacro({ action: "url", url: "https://evil.com" });
    expect(resultMissing.status).toBe("invalid_action");
    expect(resultMissing.error).toContain("must specify a valid configured macro ID");
    expect(bridge.calls).toHaveLength(0);

    const resultUnconfigured = await service.executeMacro({ id: "non_existent_macro" });
    expect(resultUnconfigured.status).toBe("invalid_action");
    expect(resultUnconfigured.error).toContain("is not configured or enabled");
    expect(bridge.calls).toHaveLength(0);
  });

  it("reports macro capability false if no macros are enabled in config", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["macros.get_status"] = {
      status: "ok",
      available: true,
    };

    const store = new MemoryMacroPreferenceStore({
      macros: {
        toggle_media: {
          id: "toggle_media",
          name: "Play/Pause Media",
          action: { type: "media", control: "toggle" },
          enabled: false,
        },
      },
    });

    const service = new MacroService(bridge, "win32", store);
    const status = await service.getStatus();

    expect(status.available).toBeFalse();
    expect(service.isAvailable).toBeFalse();
  });
});
