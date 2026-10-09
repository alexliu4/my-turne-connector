import { describe, expect, it } from "bun:test";
import { DiscordService } from "./discord-service";
import type { HostBridgeCallOptions, HostBridgeClient } from "../platform/host-bridge";

class FakeHostBridge implements HostBridgeClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  responses: Record<string, unknown> = {};

  call<TResult = unknown>(
    method: string,
    params?: unknown,
    _options?: HostBridgeCallOptions,
  ): Promise<TResult> {
    this.calls.push({ method, params });
    if (method in this.responses) {
      return Promise.resolve(this.responses[method] as TResult);
    }
    return Promise.reject(new Error(`Unhandled fake call: ${method}`));
  }

  onEvent<T = unknown>(_topic: string, _listener: (data: T) => void): () => void {
    return () => {};
  }

  close(): void {}
}

describe("DiscordService", () => {
  it("queries getStatus and reports running state without fabricating boolean mute state", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["discord.get_status"] = {
      status: "ok",
      available: true,
      running: true,
      state_known: false,
      muted: null,
      deafened: null,
    };

    const service = new DiscordService(bridge);
    expect(service.isAvailable).toBeFalse();

    const res = await service.getStatus();

    expect(res).toEqual({
      status: "ok",
      available: true,
      running: true,
      state_known: false,
      muted: null,
      deafened: null,
    });
    expect(service.isAvailable).toBeTrue();
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0].method).toBe("discord.get_status");
  });

  it("handles unavailable Discord when process is not running", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["discord.get_status"] = {
      status: "ok",
      available: false,
      running: false,
      state_known: false,
      muted: null,
      deafened: null,
    };

    const service = new DiscordService(bridge);
    const res = await service.getStatus();

    expect(res).toEqual({
      status: "ok",
      available: false,
      running: false,
      state_known: false,
      muted: null,
      deafened: null,
    });
    expect(service.isAvailable).toBeFalse();
  });

  it("handles bridge errors gracefully without throwing", async () => {
    const bridge = new FakeHostBridge();
    const service = new DiscordService(bridge);

    const res = await service.getStatus();

    expect(res).toEqual({
      status: "unsupported",
      available: false,
      running: false,
      state_known: false,
      muted: null,
      deafened: null,
    });
    expect(service.isAvailable).toBeFalse();
  });

  it("handles toggleMute and toggleDeafen when Discord is running", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["discord.toggle_mute"] = {
      status: "ok",
      running: true,
      available: true,
      action: "toggled_mute",
      state_known: false,
      muted: null,
      deafened: null,
    };
    bridge.responses["discord.toggle_deafen"] = {
      status: "ok",
      running: true,
      available: true,
      action: "toggled_deafen",
      state_known: false,
      muted: null,
      deafened: null,
    };

    const service = new DiscordService(bridge);
    const muteRes = await service.toggleMute();
    expect(muteRes).toEqual({
      status: "ok",
      available: true,
      running: true,
      action: "toggled_mute",
      state_known: false,
      muted: null,
      deafened: null,
    });
    expect(service.isAvailable).toBeTrue();

    const deafenRes = await service.toggleDeafen();
    expect(deafenRes).toEqual({
      status: "ok",
      available: true,
      running: true,
      action: "toggled_deafen",
      state_known: false,
      muted: null,
      deafened: null,
    });
  });

  it("rejects unverified setMute and setDeafen with unsupported", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["discord.set_mute"] = {
      status: "unsupported",
      message: "Idempotent set_mute/set_deafen requires verified Discord state; use toggle_mute or toggle_deafen instead",
      running: true,
      available: true,
      state_known: false,
      muted: null,
      deafened: null,
    };

    const service = new DiscordService(bridge);
    const muteRes = await service.setMute(true);
    expect(muteRes.status).toBe("unsupported");
    expect(muteRes.muted).toBeNull();
  });
});
