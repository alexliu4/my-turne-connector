import { createLogger } from "../utils/logger";
import type { HostBridgeClient } from "../platform/host-bridge";

const log = createLogger("DiscordService");

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

export class DiscordService {
  private isRunning = false;

  constructor(private readonly hostBridge: HostBridgeClient) {}

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
      const response = await this.hostBridge.call<unknown>("discord.get_status", {});
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
      const response = await this.hostBridge.call<unknown>("discord.toggle_mute", {});
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

  async toggleDeafen(): Promise<DiscordStatus> {
    try {
      const response = await this.hostBridge.call<unknown>("discord.toggle_deafen", {});
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

  async setMute(muted: boolean): Promise<DiscordStatus> {
    try {
      const response = await this.hostBridge.call<unknown>("discord.set_mute", { muted });
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
      const response = await this.hostBridge.call<unknown>("discord.set_deafen", { deafened });
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
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
