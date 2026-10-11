import { describe, expect, it } from "bun:test";
import { MacroService } from "./macro-service";
import type { MacroConfig, MacroPreferenceStore } from "./macro-config";
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
        open_custom: {
          id: "open_custom",
          name: "Launch Custom App",
          action: { type: "app", appId: "custom_editor" },
          enabled: true,
        },
        open_disabled_app: {
          id: "open_disabled_app",
          name: "Launch Disabled App",
          action: { type: "app", appId: "disabled_app" },
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

class MemoryAppLaunchPreferenceStore implements AppLaunchPreferenceStore {
  constructor(
    private config: AppLaunchConfig = {
      apps: {
        custom_editor: {
          id: "custom_editor",
          name: "Custom Editor",
          target: "custom-editor://",
          fallbacks: ["editor.exe"],
          enabled: true,
        },
        disabled_app: {
          id: "disabled_app",
          name: "Disabled App",
          target: "disabled.exe",
          enabled: false,
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

describe("MacroService", () => {
  it("queries getStatus and reports macro capability when configured macros exist", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["macros.get_status"] = {
      status: "ok",
      available: true,
    };

    const macroStore = new MemoryMacroPreferenceStore();
    const appStore = new MemoryAppLaunchPreferenceStore();
    const service = new MacroService(bridge, "win32", macroStore, appStore);
    expect(service.isAvailable).toBeFalse();

    const status = await service.getStatus();
    expect(status.status).toBe("ok");
    expect(status.available).toBeTrue();
    expect(status.macros).toHaveLength(3);
    expect(service.isAvailable).toBeTrue();
  });

  it("resolves target and fallbacks from app launch config when executing app macro", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["macros.execute"] = {
      status: "ok",
      action: "app",
      app: "custom_editor",
      launched: true,
    };

    const macroStore = new MemoryMacroPreferenceStore();
    const appStore = new MemoryAppLaunchPreferenceStore();
    const service = new MacroService(bridge, "win32", macroStore, appStore);
    const result = await service.executeMacro({ id: "open_custom" });

    expect(result).toMatchObject({
      status: "ok",
      action: "app",
      app: "custom_editor",
      launched: true,
    });
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0]).toEqual({
      method: "macros.execute",
      params: {
        id: "open_custom",
        type: "app",
        app: "custom_editor",
        appId: "custom_editor",
        target: "custom-editor://",
        fallbacks: ["editor.exe"],
      },
    });
  });

  it("rejects app macro when target app is disabled or unconfigured in app launch store", async () => {
    const bridge = new FakeHostBridge();
    const macroStore = new MemoryMacroPreferenceStore();
    const appStore = new MemoryAppLaunchPreferenceStore();
    const service = new MacroService(bridge, "win32", macroStore, appStore);

    const result = await service.executeMacro({ id: "open_disabled_app" });

    expect(result.status).toBe("invalid_action");
    expect(result.error).toContain("is not configured or enabled");
    expect(bridge.calls).toHaveLength(0);
  });

  it("rejects unconfigured macro IDs or missing macro ID without calling host bridge", async () => {
    const bridge = new FakeHostBridge();
    const macroStore = new MemoryMacroPreferenceStore();
    const appStore = new MemoryAppLaunchPreferenceStore();
    const service = new MacroService(bridge, "win32", macroStore, appStore);

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

    const macroStore = new MemoryMacroPreferenceStore({
      macros: {
        toggle_media: {
          id: "toggle_media",
          name: "Play/Pause Media",
          action: { type: "media", control: "toggle" },
          enabled: false,
        },
      },
    });

    const appStore = new MemoryAppLaunchPreferenceStore();
    const service = new MacroService(bridge, "win32", macroStore, appStore);
    const status = await service.getStatus();

    expect(status.available).toBeFalse();
    expect(service.isAvailable).toBeFalse();
  });
});
