import { describe, expect, it, beforeEach } from "bun:test";
import { createConfigRoutes } from "./config";
import {
  type AppLaunchConfig,
  type AppLaunchPreferenceStore,
  validateAppDefinition,
} from "../services/app-launch-config";
import {
  type MacroConfig,
  type MacroPreferenceStore,
  validateMacroDefinition,
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

describe("Config REST Routes & Security", () => {
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
    // Pass platform "win32" for testing Windows local route behavior
    app = createConfigRoutes(appStore, macroStore, "win32", "http://localhost");
  });

  it("lists apps and macros for localhost requests", async () => {
    const resApps = await app.handle(
      new Request("http://localhost/api/config/apps", { headers: { origin: "http://localhost" } }),
    );
    expect(resApps.status).toBe(200);
    const jsonApps = await resApps.json();
    expect(jsonApps.status).toBe("ok");
    expect(jsonApps.apps).toHaveLength(1);
    expect(jsonApps.apps[0].id).toBe("vscode");

    const resMacros = await app.handle(
      new Request("http://localhost/api/config/macros", { headers: { origin: "http://localhost" } }),
    );
    expect(resMacros.status).toBe(200);
    const jsonMacros = await resMacros.json();
    expect(jsonMacros.status).toBe("ok");
    expect(jsonMacros.macros).toHaveLength(1);
    expect(jsonMacros.macros[0].id).toBe("open_vscode");
  });

  it("rejects requests on non-Windows platforms", async () => {
    const linuxApp = createConfigRoutes(appStore, macroStore, "linux");
    const res = await linuxApp.handle(
      new Request("http://localhost/api/config/apps", { headers: { origin: "http://localhost" } }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects DNS rebinding attacks via malicious Host headers", async () => {
    const res = await app.handle(
      new Request("http://127.0.0.1/api/config/apps", {
        headers: { host: "attacker-domain.com" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects cross-site CSRF requests with non-loopback Origin or Sec-Fetch-Site", async () => {
    const resCrossSite = await app.handle(
      new Request("http://localhost/api/config/apps", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({
          id: "malicious_app",
          name: "Malicious App",
          target: "calc.exe",
        }),
      }),
    );
    expect(resCrossSite.status).toBe(403);

    const resEvilOrigin = await app.handle(
      new Request("http://localhost/api/config/apps", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil-website.com",
        },
        body: JSON.stringify({
          id: "malicious_app",
          name: "Malicious App",
          target: "calc.exe",
        }),
      }),
    );
    expect(resEvilOrigin.status).toBe(403);
  });

  it("preserves custom existing config IDs without silently dropping them", () => {
    const appWithDots = validateAppDefinition("app.vscode", {
      id: "app.vscode",
      name: "VS Code Plugin",
      target: "vscode://",
    });
    expect(appWithDots).not.toBeNull();
    expect(appWithDots?.id).toBe("app.vscode");

    const appWithSpaces = validateAppDefinition("My Custom App", {
      id: "My Custom App",
      name: "Custom App",
      target: "custom.exe",
    });
    expect(appWithSpaces).not.toBeNull();
    expect(appWithSpaces?.id).toBe("My Custom App");

    const macroWithVersion = validateMacroDefinition("macro-v1.2", {
      id: "macro-v1.2",
      name: "Macro 1.2",
      action: { type: "media", control: "play" },
    });
    expect(macroWithVersion).not.toBeNull();
    expect(macroWithVersion?.id).toBe("macro-v1.2");
  });

  it("adds and updates an application definition", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/config/apps", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
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
        headers: { origin: "http://localhost" },
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
        headers: { "content-type": "application/json", origin: "http://localhost" },
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

it("protects both privileged route groups with permissive global CORS on the actual dynamic port", async () => {
  const { Elysia } = await import("elysia");
  const { cors } = await import("@elysiajs/cors");
  const { createDiagnosticsRoutes } = await import("./diagnostics");
  const { DiagnosticsService } = await import("../services/diagnostics-service");
  const manager = {
    refreshHostStatus: async () => null,
    getHostStatus: () => null,
    getConnectionStatus: () => ({ connected: false, deviceCount: 0, devices: [] }),
    isHostBridgeConnected: () => false,
  } as unknown as ConstructorParameters<typeof DiagnosticsService>[0];
  const appStore = new MemoryAppStore({ apps: {} });
  const macroStore = new MemoryMacroStore({ macros: {} });
  const app = new Elysia().use(cors())
    .use(createConfigRoutes(appStore, macroStore, "win32"))
    .use(createDiagnosticsRoutes(new DiagnosticsService(manager), "win32"))
    .listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const origin = app.server!.url.origin;
    for (const path of ["/api/config/apps", "/api/config/macros", "/api/diagnostics/status", "/api/diagnostics/export"]) {
      for (const [headers, status] of [
        [{ origin }, 200],
        [{ "sec-fetch-site": "same-origin" }, 200],
        [{ origin: "http://127.0.0.1:1" }, 403],
        [{}, 403],
      ] as const) {
        const response = await fetch(`${origin}${path}`, { headers });
        expect(response.status).toBe(status);
        await response.text();
      }
    }
    const rejected = await fetch(`${origin}/api/config/apps`, {
      method: "POST",
      headers: { origin: "http://127.0.0.1:1", "content-type": "application/json" },
      body: JSON.stringify({ id: "untrusted", name: "Untrusted", target: "calc.exe" }),
    });
    expect(rejected.status).toBe(403);
    expect(appStore.config.apps.untrusted).toBeUndefined();
    await rejected.text();
    const response = await fetch(`${origin}/api/config/apps`, {
      method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ id: "notepad", name: "Notepad", target: "notepad.exe" }),
    });
    expect(response.status).toBe(200);
    expect(appStore.config.apps.notepad).toBeDefined();
    await response.text();
  } finally {
    await app.stop();
  }
});
