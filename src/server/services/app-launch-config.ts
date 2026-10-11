import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { APP_LAUNCH_CONFIG_PATH } from "../config";
import { createLogger } from "../utils/logger";

const log = createLogger("AppLaunchConfigStore");

export interface AppDefinition {
  id: string;
  name: string;
  target: string;
  fallbacks?: string[];
  enabled?: boolean;
}

export interface AppLaunchConfig {
  apps: Record<string, AppDefinition>;
}

export const DEFAULT_APP_LAUNCH_CONFIG: AppLaunchConfig = {
  apps: {
    vscode: {
      id: "vscode",
      name: "VS Code",
      target: "vscode://",
      fallbacks: ["code://", "code"],
      enabled: true,
    },
    discord: {
      id: "discord",
      name: "Discord",
      target: "discord://",
      fallbacks: ["discord"],
      enabled: true,
    },
    browser: {
      id: "browser",
      name: "Default Browser",
      target: "https://usenocturne.com/",
      enabled: true,
    },
    steam: {
      id: "steam",
      name: "Steam",
      target: "steam://",
      fallbacks: ["steam"],
      enabled: true,
    },
    spotify: {
      id: "spotify",
      name: "Spotify",
      target: "spotify://",
      fallbacks: ["spotify"],
      enabled: true,
    },
    terminal: {
      id: "terminal",
      name: "Terminal",
      target: "wt.exe",
      fallbacks: ["cmd.exe"],
      enabled: false,
    },
    calc: {
      id: "calc",
      name: "Calculator",
      target: "calc.exe",
      enabled: true,
    },
  },
};

export interface AppLaunchPreferenceStore {
  load(): AppLaunchConfig;
  save(config: AppLaunchConfig): void;
}

export class FileSystemAppLaunchPreferenceStore implements AppLaunchPreferenceStore {
  constructor(private readonly path = APP_LAUNCH_CONFIG_PATH) {}

  load(): AppLaunchConfig {
    try {
      if (!existsSync(this.path)) {
        return DEFAULT_APP_LAUNCH_CONFIG;
      }
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.apps || typeof parsed.apps !== "object") {
        return DEFAULT_APP_LAUNCH_CONFIG;
      }

      const validatedApps: Record<string, AppDefinition> = {};
      for (const [key, val] of Object.entries(parsed.apps)) {
        const app = validateAppDefinition(key, val);
        if (app) {
          validatedApps[app.id] = app;
        }
      }

      return { apps: validatedApps };
    } catch (error) {
      log.warn(`Unable to read app launch configuration: ${errorMessage(error)}`);
      return DEFAULT_APP_LAUNCH_CONFIG;
    }
  }

  save(config: AppLaunchConfig): void {
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
        log.debug(`Unable to remove temporary app launch configuration: ${errorMessage(cleanupError)}`);
      }
      throw error;
    }
  }
}

function validateAppDefinition(fallbackKey: string, val: unknown): AppDefinition | null {
  if (!val || typeof val !== "object" || Array.isArray(val)) return null;
  const rec = val as Record<string, unknown>;
  const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : fallbackKey.trim();
  const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id;
  const target = typeof rec.target === "string" && rec.target.trim() ? rec.target.trim() : null;
  if (!id || !name || !target) return null;

  const fallbacks = Array.isArray(rec.fallbacks)
    ? rec.fallbacks.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : undefined;
  const enabled = typeof rec.enabled === "boolean" ? rec.enabled : true;

  return { id, name, target, fallbacks, enabled };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
