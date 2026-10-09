import { createLogger } from "../utils/logger";
import type { HostBridgeClient } from "../platform/host-bridge";

const log = createLogger("DiscordService");

export interface DiscordStatus {
  status: string;
  available: boolean;
  running: boolean;
  muted: boolean;
  deafened: boolean;
}

export class DiscordService {
  constructor(private readonly hostBridge: HostBridgeClient) {}

  async getStatus(): Promise<DiscordStatus> {
    try {
      const response = await this.hostBridge.call<unknown>("discord.get_status", {});
      const rec = asRecord(response);
      if (!rec || rec.status !== "ok") {
        return {
          status: (rec?.status as string) ?? "unsupported",
          available: false,
          running: false,
          muted: false,
          deafened: false,
        };
      }
      return {
        status: "ok",
        available: rec.available === true || rec.running === true,
        running: rec.running === true || rec.available === true,
        muted: rec.muted === true,
        deafened: rec.deafened === true,
      };
    } catch (error) {
      log.warn(`discord.get_status call failed: ${errorMessage(error)}`);
      return {
        status: "unsupported",
        available: false,
        running: false,
        muted: false,
        deafened: false,
      };
    }
  }

  async toggleMute(): Promise<DiscordStatus> {
    try {
      const response = await this.hostBridge.call<unknown>("discord.toggle_mute", {});
      const rec = asRecord(response);
      if (!rec || rec.status !== "ok") {
        return {
          status: (rec?.status as string) ?? "unsupported",
          available: rec?.running === true,
          running: rec?.running === true,
          muted: false,
          deafened: false,
        };
      }
      return {
        status: "ok",
        available: true,
        running: true,
        muted: rec.muted === true,
        deafened: rec.deafened === true,
      };
    } catch (error) {
      log.warn(`discord.toggle_mute call failed: ${errorMessage(error)}`);
      return {
        status: "unsupported",
        available: false,
        running: false,
        muted: false,
        deafened: false,
      };
    }
  }

  async toggleDeafen(): Promise<DiscordStatus> {
    try {
      const response = await this.hostBridge.call<unknown>("discord.toggle_deafen", {});
      const rec = asRecord(response);
      if (!rec || rec.status !== "ok") {
        return {
          status: (rec?.status as string) ?? "unsupported",
          available: rec?.running === true,
          running: rec?.running === true,
          muted: false,
          deafened: false,
        };
      }
      return {
        status: "ok",
        available: true,
        running: true,
        muted: rec.muted === true,
        deafened: rec.deafened === true,
      };
    } catch (error) {
      log.warn(`discord.toggle_deafen call failed: ${errorMessage(error)}`);
      return {
        status: "unsupported",
        available: false,
        running: false,
        muted: false,
        deafened: false,
      };
    }
  }

  async setMute(muted: boolean): Promise<DiscordStatus> {
    try {
      const response = await this.hostBridge.call<unknown>("discord.set_mute", { muted });
      const rec = asRecord(response);
      if (!rec || rec.status !== "ok") {
        return {
          status: (rec?.status as string) ?? "unsupported",
          available: rec?.running === true,
          running: rec?.running === true,
          muted: false,
          deafened: false,
        };
      }
      return {
        status: "ok",
        available: true,
        running: true,
        muted: rec.muted === true,
        deafened: rec.deafened === true,
      };
    } catch (error) {
      log.warn(`discord.set_mute call failed: ${errorMessage(error)}`);
      return {
        status: "unsupported",
        available: false,
        running: false,
        muted: false,
        deafened: false,
      };
    }
  }

  async setDeafen(deafened: boolean): Promise<DiscordStatus> {
    try {
      const response = await this.hostBridge.call<unknown>("discord.set_deafen", { deafened });
      const rec = asRecord(response);
      if (!rec || rec.status !== "ok") {
        return {
          status: (rec?.status as string) ?? "unsupported",
          available: rec?.running === true,
          running: rec?.running === true,
          muted: false,
          deafened: false,
        };
      }
      return {
        status: "ok",
        available: true,
        running: true,
        muted: rec.muted === true,
        deafened: rec.deafened === true,
      };
    } catch (error) {
      log.warn(`discord.set_deafen call failed: ${errorMessage(error)}`);
      return {
        status: "unsupported",
        available: false,
        running: false,
        muted: false,
        deafened: false,
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
