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

      const validatedMacros: Record<string, MacroDefinition> = {};
      for (const [key, val] of Object.entries(parsed.macros)) {
        const macro = validateMacroDefinition(key, val);
        if (macro) {
          validatedMacros[macro.id] = macro;
        }
      }

      return { macros: validatedMacros };
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

function validateMacroDefinition(fallbackKey: string, val: unknown): MacroDefinition | null {
  if (!val || typeof val !== "object" || Array.isArray(val)) return null;
  const rec = val as Record<string, unknown>;
  const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : fallbackKey.trim();
  const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id;
  const action = validateMacroAction(rec.action);
  if (!id || !name || !action) return null;

  if (rec.enabled !== undefined && typeof rec.enabled !== "boolean") return null;
  const enabled = rec.enabled ?? true;

  return { id, name, action, enabled };
}

function validateMacroAction(val: unknown): MacroActionConfig | null {
  if (!val || typeof val !== "object" || Array.isArray(val)) return null;
  const rec = val as Record<string, unknown>;
  const type = typeof rec.type === "string" ? rec.type.trim() : null;
  if (!type) return null;

  if (type === "app") {
    const appId = typeof rec.appId === "string" && rec.appId.trim() ? rec.appId.trim() : null;
    return appId ? { type: "app", appId } : null;
  }

  if (type === "media") {
    const control = typeof rec.control === "string" ? rec.control.trim() : null;
    const validControls = ["play", "pause", "next", "previous", "toggle", "volume_up", "volume_down"];
    return control && validControls.includes(control)
      ? { type: "media", control: control as MediaMacroAction["control"] }
      : null;
  }

  if (type === "url") {
    const url = typeof rec.url === "string" && rec.url.trim() ? rec.url.trim() : null;
    return url && (url.startsWith("http://") || url.startsWith("https://"))
      ? { type: "url", url }
      : null;
  }

  if (type === "shortcut") {
    const shortcut = typeof rec.shortcut === "string" && rec.shortcut.trim() ? rec.shortcut.trim() : null;
    return shortcut ? { type: "shortcut", shortcut } : null;
  }

  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
