import { createLogger } from "../utils/logger";
import type { HostBridgeClient } from "../platform/host-bridge";

const log = createLogger("DiscordService");
const DISCORD_RPC_TIMEOUT_MS = 2_000;

export interface DiscordStatus {
  status: string;
  available: boolean;
  running: boolean;
  state_known: boolean;
  muted: boolean | null;
  deafened: boolean | null;
  action?: string;
  message?: string;
}

/**
 * DiscordService handles communications with the Windows native host bridge for Discord integration.
 *
 * Capability Refresh Behavior:
 * - `connector.capabilities` reports `discord: isAvailable`, which reads the cached `isRunning` state.
 * - Calling `discord.get_status` or running `refreshStatus()` probes the native host and refreshes `isRunning`.
 * - No high-frequency polling loop is created. Probes occur on startup and explicit UI/RPC status queries.
 */
export class DiscordService {
  private isRunning = false;

  constructor(private readonly hostBridge: HostBridgeClient) {}

  /**
   * Indicates whether Discord is currently verified running on the host system.
   * This cached value is reported in `connector.capabilities`.
   */
  get isAvailable(): boolean {
    return this.isRunning;
  }

  async start(): Promise<void> {
    await this.refreshStatus();
  }

  async refreshStatus(): Promise<boolean> {
    const status = await this.getStatus();
    return status.running;
  }

  async getStatus(): Promise<DiscordStatus> {
    try {
      const response = await this.callHostWithTimeout("discord.get_status", {});
      const rec = asRecord(response);
      const running = rec?.running === true || rec?.available === true;
      this.isRunning = running;

      if (!rec || rec.status !== "ok") {
        return {
          status: (rec?.status as string) ?? "unsupported",
          available: running,
          running,
          state_known: false,
          muted: null,
          deafened: null,
          message: typeof rec?.message === "string" ? rec.message : undefined,
        };
      }

      return {
        status: "ok",
        available: running,
        running,
        state_known: false,
        muted: null,
        deafened: null,
      };
    } catch (error) {
      log.warn(`discord.get_status call failed: ${errorMessage(error)}`);
      this.isRunning = false;
      return {
        status: "unsupported",
        available: false,
        running: false,
        state_known: false,
        muted: null,
        deafened: null,
      };
    }
  }

  async toggleMute(): Promise<DiscordStatus> {
    try {
      const response = await this.callHostWithTimeout("discord.toggle_mute", {});
      const rec = asRecord(response);
      const running = rec?.running === true || rec?.available === true;
      this.isRunning = running;

      if (!rec || rec.status !== "ok") {
        return {
          status: (rec?.status as string) ?? "unsupported",
          available: running,
          running,
          state_known: false,
          muted: null,
          deafened: null,
          message: typeof rec?.message === "string" ? rec.message : undefined,
        };
      }

      return {
        status: "ok",
        available: true,
        running: true,
        state_known: false,
        muted: null,
        deafened: null,
        action: typeof rec.action === "string" ? rec.action : "toggled_mute",
      };
    } catch (error) {
      log.warn(`discord.toggle_mute call failed: ${errorMessage(error)}`);
      return {
        status: "unknown",
        available: this.isRunning,
        running: this.isRunning,
        state_known: false,
        muted: null,
        deafened: null,
        message: "Command outcome unknown; it may have executed. Check Discord before retrying.",
      };
    }
  }

  async toggleDeafen(): Promise<DiscordStatus> {
    try {
      const response = await this.callHostWithTimeout("discord.toggle_deafen", {});
      const rec = asRecord(response);
      const running = rec?.running === true || rec?.available === true;
      this.isRunning = running;

      if (!rec || rec.status !== "ok") {
        return {
          status: (rec?.status as string) ?? "unsupported",
          available: running,
          running,
          state_known: false,
          muted: null,
          deafened: null,
          message: typeof rec?.message === "string" ? rec.message : undefined,
        };
      }

      return {
        status: "ok",
        available: true,
        running: true,
        state_known: false,
        muted: null,
        deafened: null,
        action: typeof rec.action === "string" ? rec.action : "toggled_deafen",
      };
    } catch (error) {
      log.warn(`discord.toggle_deafen call failed: ${errorMessage(error)}`);
      return {
        status: "unknown",
        available: this.isRunning,
        running: this.isRunning,
        state_known: false,
        muted: null,
        deafened: null,
        message: "Command outcome unknown; it may have executed. Check Discord before retrying.",
      };
    }
  }

  async setMute(muted: boolean): Promise<DiscordStatus> {
    try {
      const response = await this.callHostWithTimeout("discord.set_mute", { muted });
      const rec = asRecord(response);
      const running = rec?.running === true || rec?.available === true;
      this.isRunning = running;

      return {
        status: (rec?.status as string) ?? "unsupported",
        available: running,
        running,
        state_known: false,
        muted: null,
        deafened: null,
        message:
          typeof rec?.message === "string"
            ? rec.message
            : "Idempotent set_mute requires verified Discord state; use toggle_mute instead",
      };
    } catch (error) {
      log.warn(`discord.set_mute call failed: ${errorMessage(error)}`);
      this.isRunning = false;
      return {
        status: "unsupported",
        available: false,
        running: false,
        state_known: false,
        muted: null,
        deafened: null,
        message: "Idempotent set_mute requires verified Discord state; use toggle_mute instead",
      };
    }
  }

  async setDeafen(deafened: boolean): Promise<DiscordStatus> {
    try {
      const response = await this.callHostWithTimeout("discord.set_deafen", { deafened });
      const rec = asRecord(response);
      const running = rec?.running === true || rec?.available === true;
      this.isRunning = running;

      return {
        status: (rec?.status as string) ?? "unsupported",
        available: running,
        running,
        state_known: false,
        muted: null,
        deafened: null,
        message:
          typeof rec?.message === "string"
            ? rec.message
            : "Idempotent set_deafen requires verified Discord state; use toggle_deafen instead",
      };
    } catch (error) {
      log.warn(`discord.set_deafen call failed: ${errorMessage(error)}`);
      this.isRunning = false;
      return {
        status: "unsupported",
        available: false,
        running: false,
        state_known: false,
        muted: null,
        deafened: null,
        message: "Idempotent set_deafen requires verified Discord state; use toggle_deafen instead",
      };
    }
  }

  private callHostWithTimeout(method: string, params: unknown): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Discord RPC ${method} timed out after ${DISCORD_RPC_TIMEOUT_MS}ms`));
      }, DISCORD_RPC_TIMEOUT_MS);
    });

    return Promise.race([
      this.hostBridge.call(method, params, { timeoutMs: DISCORD_RPC_TIMEOUT_MS, signal: controller.signal }),
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
