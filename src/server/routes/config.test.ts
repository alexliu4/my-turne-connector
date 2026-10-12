import { describe, expect, it, beforeEach } from "bun:test";
import { createConfigRoutes } from "./config";
import type {
  AppLaunchConfig,
  AppLaunchPreferenceStore,
} from "../services/app-launch-config";
import type {
  MacroConfig,
  MacroPreferenceStore,
} from "../services/macro-config";

class MemoryAppStore implements AppLaunchPreferenceStore {
  constructor(public config: AppLaunchConfig) {}
  load(): AppLaunchConfig {
    return JSON.parse(JSON.stringify(this.config));
  }
  save(config: AppLaunchConfig): void {
    this.config = JSON.parse(JSON.stringify(config));
  }
}

class MemoryMacroStore implements MacroPreferenceStore {
  constructor(public config: MacroConfig) {}
  load(): MacroConfig {
    return JSON.parse(JSON.stringify(this.config));
  }
  save(config: MacroConfig): void {
    this.config = JSON.parse(JSON.stringify(config));
  }
}

describe("Config REST Routes", () => {
  let appStore: MemoryAppStore;
  let macroStore: MemoryMacroStore;
  let app: ReturnType<typeof createConfigRoutes>;

  beforeEach(() => {
    appStore = new MemoryAppStore({
      apps: {
        vscode: {
          id: "vscode",
          name: "VS Code",
          target: "vscode://",
          enabled: true,
        },
      },
    });
    macroStore = new MemoryMacroStore({
      macros: {
        open_vscode: {
          id: "open_vscode",
          name: "Launch VS Code",
          action: { type: "app", appId: "vscode" },
          enabled: true,
        },
      },
    });
    app = createConfigRoutes(appStore, macroStore);
  });

  it("lists apps and macros for localhost requests", async () => {
    const resApps = await app.handle(
      new Request("http://localhost/api/config/apps"),
    );
    expect(resApps.status).toBe(200);
    const jsonApps = await resApps.json();
    expect(jsonApps.status).toBe("ok");
    expect(jsonApps.apps).toHaveLength(1);
    expect(jsonApps.apps[0].id).toBe("vscode");

    const resMacros = await app.handle(
      new Request("http://127.0.0.1/api/config/macros"),
    );
    expect(resMacros.status).toBe(200);
    const jsonMacros = await resMacros.json();
    expect(jsonMacros.status).toBe("ok");
    expect(jsonMacros.macros).toHaveLength(1);
    expect(jsonMacros.macros[0].id).toBe("open_vscode");
  });

  it("rejects non-localhost requests with 403", async () => {
    const res = await app.handle(
      new Request("http://192.168.1.100/api/config/apps", {
        headers: { host: "192.168.1.100" },
      }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("Configuration API is localhost-only");
  });

  it("adds and updates an application definition", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/config/apps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "notepad",
          name: "Notepad",
          target: "notepad.exe",
          enabled: true,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.app.id).toBe("notepad");

    const stored = appStore.load();
    expect(stored.apps.notepad).toBeDefined();
    expect(stored.apps.notepad.target).toBe("notepad.exe");
  });

  it("deletes an application definition", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/config/apps/vscode", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.deletedId).toBe("vscode");

    const stored = appStore.load();
    expect(stored.apps.vscode).toBeUndefined();
  });

  it("rejects malformed macro definitions", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/config/macros", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "invalid_macro",
          name: "Invalid Macro",
          action: { type: "unknown_type" },
        }),
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid macro definition format or missing fields");
  });
});
