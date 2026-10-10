import { createLogger } from "../utils/logger";
import type { HostBridgeClient } from "../platform/host-bridge";

const log = createLogger("MacroService");
const MACRO_RPC_TIMEOUT_MS = 2_000;

export interface MacroStatus {
  status: string;
  available: boolean;
  message?: string;
}

export interface MacroResult {
  status: string;
  action?: string;
  error?: string;
  [key: string]: unknown;
}

/**
 * MacroService handles execution of constrained macro actions through the native host bridge.
 * Supported action types include configured app launches, media controls, validated HTTP/HTTPS URLs, and key shortcuts.
 */
export class MacroService {
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
      log.warn(`Background macro probe failed: ${errorMessage(error)}`);
    }
  }

  async getStatus(): Promise<MacroStatus> {
    try {
      const response = await this.callHostWithTimeout("macros.get_status", {});
      const rec = asRecord(response);
      const available = rec?.status === "ok" && rec?.available === true;
      this.isHostVerified = available;

      if (!rec || rec.status !== "ok") {
        return {
          status: typeof rec?.status === "string" ? rec.status : "unsupported",
          available: false,
          message: typeof rec?.message === "string" ? rec.message : undefined,
        };
      }

      return {
        status: "ok",
        available: true,
      };
    } catch (error) {
      log.warn(`macros.get_status call failed: ${errorMessage(error)}`);
      this.isHostVerified = false;
      return {
        status: "unsupported",
        available: false,
        message: errorMessage(error),
      };
    }
  }

  async executeMacro(params: unknown): Promise<MacroResult> {
    try {
      const response = await this.callHostWithTimeout("macros.execute", params);
      const rec = asRecord(response);

      if (!rec) {
        return {
          status: "unsupported",
          error: "No response from host",
        };
      }

      return {
        status: typeof rec.status === "string" ? rec.status : "unsupported",
        action: typeof rec.action === "string" ? rec.action : undefined,
        error: typeof rec.error === "string" ? rec.error : undefined,
        ...rec,
      };
    } catch (error) {
      log.warn(`macros.execute call failed: ${errorMessage(error)}`);
      return {
        status: "error",
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
        reject(new Error(`Macro RPC ${method} timed out after ${MACRO_RPC_TIMEOUT_MS}ms`));
      }, MACRO_RPC_TIMEOUT_MS);
    });

    return Promise.race([
      this.hostBridge.call(method, params, { timeoutMs: MACRO_RPC_TIMEOUT_MS, signal: controller.signal }),
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
