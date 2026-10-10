import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { MACROS_CONFIG_PATH } from "../config";
import { createLogger } from "../utils/logger";

const log = createLogger("MacroConfigStore");

export type MacroActionType = "app" | "media" | "url" | "shortcut";

export interface AppMacroAction {
  type: "app";
  appId: string;
}

export interface MediaMacroAction {
  type: "media";
  control: "play" | "pause" | "next" | "previous" | "toggle" | "volume_up" | "volume_down";
}

export interface UrlMacroAction {
  type: "url";
  url: string;
}

export interface ShortcutMacroAction {
  type: "shortcut";
  shortcut: string;
}

export type MacroActionConfig =
  | AppMacroAction
  | MediaMacroAction
  | UrlMacroAction
  | ShortcutMacroAction;

export interface MacroDefinition {
  id: string;
  name: string;
  action: MacroActionConfig;
  enabled?: boolean;
}

export interface MacroConfig {
  macros: Record<string, MacroDefinition>;
}

export const DEFAULT_MACROS_CONFIG: MacroConfig = {
  macros: {
    open_vscode: {
      id: "open_vscode",
      name: "Launch VS Code",
      action: { type: "app", appId: "vscode" },
      enabled: true,
    },
    toggle_media: {
      id: "toggle_media",
      name: "Play/Pause Media",
      action: { type: "media", control: "toggle" },
      enabled: true,
    },
    open_home: {
      id: "open_home",
      name: "Open Nocturne Site",
      action: { type: "url", url: "https://usenocturne.com/" },
      enabled: true,
    },
    next_track: {
      id: "next_track",
      name: "Next Track Shortcut",
      action: { type: "shortcut", shortcut: "media_next" },
      enabled: true,
    },
  },
};

export interface MacroPreferenceStore {
  load(): MacroConfig;
  save(config: MacroConfig): void;
}

export class FileSystemMacroPreferenceStore implements MacroPreferenceStore {
  constructor(private readonly path = MACROS_CONFIG_PATH) {}

  load(): MacroConfig {
    try {
      if (!existsSync(this.path)) {
        return DEFAULT_MACROS_CONFIG;
      }
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.macros || typeof parsed.macros !== "object") {
        return DEFAULT_MACROS_CONFIG;
      }
      return parsed as MacroConfig;
    } catch (error) {
      log.warn(`Unable to read macros configuration: ${errorMessage(error)}`);
      return DEFAULT_MACROS_CONFIG;
    }
  }

  save(config: MacroConfig): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true });
    const temporary = `${this.path}.tmp.${process.pid}.${Date.now()}`;
    try {
      writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch (cleanupError) {
        log.debug(`Unable to remove temporary macros configuration: ${errorMessage(cleanupError)}`);
      }
      throw error;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
