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
});
