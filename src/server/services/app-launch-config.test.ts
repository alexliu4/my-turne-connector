import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  DEFAULT_APP_LAUNCH_CONFIG,
  FileSystemAppLaunchPreferenceStore,
} from "./app-launch-config";
import {
  DEFAULT_MACROS_CONFIG,
  FileSystemMacroPreferenceStore,
} from "./macro-config";

describe("AppLaunchConfig & MacroConfig stores", () => {
  it("defaults terminal entry to enabled: false", () => {
    expect(DEFAULT_APP_LAUNCH_CONFIG.apps.terminal.enabled).toBeFalse();
  });

  it("handles malformed JSON in AppLaunchPreferenceStore safely by returning defaults", () => {
    const tempDir = join(tmpdir(), `test-app-config-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const tempFilePath = join(tempDir, "app-launch-config.json");

    try {
      writeFileSync(tempFilePath, "{ invalid json corrupt ", "utf8");
      const store = new FileSystemAppLaunchPreferenceStore(tempFilePath);
      const config = store.load();

      expect(config).toEqual(DEFAULT_APP_LAUNCH_CONFIG);
      expect(config.apps.vscode.enabled).toBeTrue();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("filters out structurally malformed app entries and non-boolean enabled properties", () => {
    const tempDir = join(tmpdir(), `test-app-struct-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const tempFilePath = join(tempDir, "app-launch-config.json");

    try {
      const corruptData = JSON.stringify({
        apps: {
          null_entry: null,
          incomplete: { id: "incomplete" },
          invalid_enabled: { id: "invalid_enabled", name: "Invalid", target: "invalid://", enabled: "true" },
          omitted_enabled: { id: "omitted_enabled", name: "Omitted", target: "omitted://" },
          valid: { id: "valid", name: "Valid App", target: "valid://", enabled: true },
        },
      });
      writeFileSync(tempFilePath, corruptData, "utf8");
      const store = new FileSystemAppLaunchPreferenceStore(tempFilePath);
      const config = store.load();

      expect(Object.keys(config.apps).sort()).toEqual(["omitted_enabled", "valid"]);
      expect(config.apps.omitted_enabled.enabled).toBeTrue();
      expect(config.apps.valid.target).toBe("valid://");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles malformed JSON in MacroPreferenceStore safely by returning defaults", () => {
    const tempDir = join(tmpdir(), `test-macro-config-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const tempFilePath = join(tempDir, "macros-config.json");

    try {
      writeFileSync(tempFilePath, "{ invalid json corrupt ", "utf8");
      const store = new FileSystemMacroPreferenceStore(tempFilePath);
      const config = store.load();

      expect(config).toEqual(DEFAULT_MACROS_CONFIG);
      expect(config.macros.open_vscode.enabled).toBeTrue();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("filters out structurally malformed macro entries and non-boolean enabled properties", () => {
    const tempDir = join(tmpdir(), `test-macro-struct-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const tempFilePath = join(tempDir, "macros-config.json");

    try {
      const corruptData = JSON.stringify({
        macros: {
          null_entry: null,
          missing_action: { id: "missing", name: "Missing Action" },
          invalid_action_type: { id: "invalid", name: "Invalid", action: { type: "unknown" } },
          invalid_enabled: {
            id: "invalid_enabled",
            name: "Invalid Enabled",
            action: { type: "media", control: "toggle" },
            enabled: "true",
          },
          omitted_enabled: {
            id: "omitted_enabled",
            name: "Omitted Enabled",
            action: { type: "media", control: "play" },
          },
          valid: {
            id: "valid_macro",
            name: "Valid Macro",
            action: { type: "media", control: "toggle" },
            enabled: true,
          },
        },
      });
      writeFileSync(tempFilePath, corruptData, "utf8");
      const store = new FileSystemMacroPreferenceStore(tempFilePath);
      const config = store.load();

      expect(Object.keys(config.macros).sort()).toEqual(["omitted_enabled", "valid_macro"]);
      expect(config.macros.omitted_enabled.enabled).toBeTrue();
      expect(config.macros.valid_macro.action.type).toBe("media");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
