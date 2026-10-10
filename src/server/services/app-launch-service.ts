import { createLogger } from "../utils/logger";
import type { HostBridgeClient } from "../platform/host-bridge";

const log = createLogger("AppLaunchService");
const APP_LAUNCH_RPC_TIMEOUT_MS = 2_000;

export interface AppLaunchStatus {
  status: string;
  available: boolean;
  apps?: string[];
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
 * To ensure remote execution safety, launch operations validate against an allowlist of configured host applications.
 */
export class AppLaunchService {
  private isHostVerified = false;

  constructor(
    private readonly hostBridge: HostBridgeClient,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  get isAvailable(): boolean {
    return this.isHostVerified;
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
        available: true,
        apps: Array.isArray(rec.apps) ? rec.apps.map(String) : [],
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

  async launchApp(app: string): Promise<AppLaunchResult> {
    try {
      const response = await this.callHostWithTimeout("app_launch.launch", { app });
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
        app: typeof rec.app === "string" ? rec.app : app,
        launched: rec.launched === true,
        error: typeof rec.error === "string" ? rec.error : undefined,
      };
    } catch (error) {
      log.warn(`app_launch.launch call failed: ${errorMessage(error)}`);
      return {
        status: "error",
        app,
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
