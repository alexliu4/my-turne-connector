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
  it("queries getStatus and formats response", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["discord.get_status"] = {
      status: "ok",
      available: true,
      running: true,
      muted: false,
      deafened: true,
    };

    const service = new DiscordService(bridge);
    const res = await service.getStatus();

    expect(res).toEqual({
      status: "ok",
      available: true,
      running: true,
      muted: false,
      deafened: true,
    });
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0].method).toBe("discord.get_status");
  });

  it("handles bridge error gracefully in getStatus", async () => {
    const bridge = new FakeHostBridge();
    const service = new DiscordService(bridge);

    const res = await service.getStatus();

    expect(res).toEqual({
      status: "unsupported",
      available: false,
      running: false,
      muted: false,
      deafened: false,
    });
  });

  it("handles toggleMute and toggleDeafen", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["discord.toggle_mute"] = {
      status: "ok",
      running: true,
      muted: true,
      deafened: false,
    };
    bridge.responses["discord.toggle_deafen"] = {
      status: "ok",
      running: true,
      muted: true,
      deafened: true,
    };

    const service = new DiscordService(bridge);
    const muteRes = await service.toggleMute();
    expect(muteRes).toEqual({
      status: "ok",
      available: true,
      running: true,
      muted: true,
      deafened: false,
    });

    const deafenRes = await service.toggleDeafen();
    expect(deafenRes).toEqual({
      status: "ok",
      available: true,
      running: true,
      muted: true,
      deafened: true,
    });
  });

  it("handles setMute and setDeafen", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses["discord.set_mute"] = {
      status: "ok",
      running: true,
      muted: true,
      deafened: false,
    };
    bridge.responses["discord.set_deafen"] = {
      status: "ok",
      running: true,
      muted: true,
      deafened: false,
    };

    const service = new DiscordService(bridge);
    const muteRes = await service.setMute(true);
    expect(muteRes.muted).toBe(true);
    expect(bridge.calls[0].params).toEqual({ muted: true });

    const deafenRes = await service.setDeafen(false);
    expect(deafenRes.deafened).toBe(false);
    expect(bridge.calls[1].params).toEqual({ deafened: false });
  });
});
