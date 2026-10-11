import { createLogger } from "../utils/logger";
import type { HostBridgeClient } from "../platform/host-bridge";
import {
  type AppDefinition,
  type AppLaunchPreferenceStore,
  FileSystemAppLaunchPreferenceStore,
} from "./app-launch-config";

const log = createLogger("AppLaunchService");
const APP_LAUNCH_RPC_TIMEOUT_MS = 2_000;

export interface AppLaunchStatus {
  status: string;
  available: boolean;
  apps?: AppDefinition[];
  message?: string;
}

export interface AppLaunchResult {
  status: string;
  app?: string;
  launched: boolean;
  error?: string;
}

/**
 * AppLaunchService handles application launching requests through the Windows native host bridge.
 * To ensure remote execution safety, launch operations validate strictly against locally configured application definitions.
 */
export class AppLaunchService {
  private isHostVerified = false;

  constructor(
    private readonly hostBridge: HostBridgeClient,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly preferenceStore: AppLaunchPreferenceStore = new FileSystemAppLaunchPreferenceStore(),
  ) {}

  get isAvailable(): boolean {
    const config = this.preferenceStore.load();
    const hasConfiguredApps = Object.values(config.apps).some((app) => app.enabled !== false);
    return this.isHostVerified && hasConfiguredApps;
  }

  async start(): Promise<void> {
    if (this.platform !== "win32") return;
    try {
      await this.getStatus();
    } catch (error) {
      log.warn(`Background app launch probe failed: ${errorMessage(error)}`);
    }
  }

  async getStatus(): Promise<AppLaunchStatus> {
    try {
      const response = await this.callHostWithTimeout("app_launch.get_status", {});
      const rec = asRecord(response);
      const available = rec?.status === "ok" && rec?.available === true;
      this.isHostVerified = available;

      const config = this.preferenceStore.load();
      const configuredApps = Object.values(config.apps).filter((app) => app.enabled !== false);

      if (!rec || rec.status !== "ok") {
        return {
          status: typeof rec?.status === "string" ? rec.status : "unsupported",
          available: false,
          apps: [],
          message: typeof rec?.message === "string" ? rec.message : undefined,
        };
      }

      return {
        status: "ok",
        available: available && configuredApps.length > 0,
        apps: configuredApps,
      };
    } catch (error) {
      log.warn(`app_launch.get_status call failed: ${errorMessage(error)}`);
      this.isHostVerified = false;
      return {
        status: "unsupported",
        available: false,
        apps: [],
        message: errorMessage(error),
      };
    }
  }

  async launchApp(appId: string): Promise<AppLaunchResult> {
    const config = this.preferenceStore.load();
    const appDef = config.apps[appId];

    if (!appDef || appDef.enabled === false) {
      log.warn(`Rejecting unconfigured or disabled app launch request: ${appId}`);
      return {
        status: "invalid_app",
        app: appId,
        launched: false,
        error: `Application '${appId}' is not configured or enabled`,
      };
    }

    try {
      const response = await this.callHostWithTimeout("app_launch.launch", {
        app: appDef.id,
        target: appDef.target,
        fallbacks: appDef.fallbacks ?? [],
      });
      const rec = asRecord(response);

      if (!rec) {
        return {
          status: "unsupported",
          launched: false,
          error: "No response from host",
        };
      }

      return {
        status: typeof rec.status === "string" ? rec.status : "unsupported",
        app: typeof rec.app === "string" ? rec.app : appDef.id,
        launched: rec.launched === true,
        error: typeof rec.error === "string" ? rec.error : undefined,
      };
    } catch (error) {
      log.warn(`app_launch.launch call failed for ${appId}: ${errorMessage(error)}`);
      return {
        status: "error",
        app: appId,
        launched: false,
        error: errorMessage(error),
      };
    }
  }

  private callHostWithTimeout(method: string, params: unknown): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`AppLaunch RPC ${method} timed out after ${APP_LAUNCH_RPC_TIMEOUT_MS}ms`));
      }, APP_LAUNCH_RPC_TIMEOUT_MS);
    });

    return Promise.race([
      this.hostBridge.call(method, params, { timeoutMs: APP_LAUNCH_RPC_TIMEOUT_MS, signal: controller.signal }),
      timeoutPromise,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
