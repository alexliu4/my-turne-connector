import { describe, expect, it, spyOn } from "bun:test";
import type { Socket } from "node:net";
import { DiscordService } from "./discord-service";
import { HostBridge, type HostBridgeCallOptions, type HostBridgeClient } from "../platform/host-bridge";

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


it.each(["toggleMute", "toggleDeafen"] as const)("does not dispatch expired %s after the shared connection eventually resolves", async (toggle) => {
  const bridge = new HostBridge("delayed-test-pipe", "secret");
  let connect!: (socket: Socket) => void;
  const connection = new Promise<Socket>((resolve) => { connect = resolve; });
  const writes: Buffer[] = [];
  const socket = {
    destroyed: false,
    write(data: Buffer, callback: () => void) { writes.push(data); callback(); },
    destroy() {},
  } as unknown as Socket;
  const internals = bridge as unknown as {
    ensureConnected(): Promise<Socket>;
    socket: Socket | null;
  };
  internals.ensureConnected = () => connection;
  let expire!: () => void;
  const originalSetTimeout = globalThis.setTimeout;
  const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    if (delay === 2_000) expire = callback;
    return originalSetTimeout(callback, 60_000);
  }) as typeof setTimeout);
  try {
    const result = new DiscordService(bridge)[toggle]();
    expire();
    expect(await result).toMatchObject({ status: "unknown", state_known: false, muted: null, deafened: null });
    internals.socket = socket;
    connect(socket);
    await connection;
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toHaveLength(0);
    // Cancellation belongs to the request, so the shared connection stays usable.
    timerSpy.mockRestore();
    const nextCall = bridge.call("discord.get_status");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    bridge.close();
    await expect(nextCall).rejects.toThrow("closed");
  } finally {
    timerSpy.mockRestore();
    bridge.close();
  }
});


it.each(["toggleMute", "toggleDeafen"] as const)("reports an uncertain %s outcome without discarding verified availability", async (toggle) => {
  const bridge = new FakeHostBridge();
  bridge.responses["discord.get_status"] = { status: "ok", running: true };
  const service = new DiscordService(bridge);
  await service.getStatus();
  // A transport error cannot establish whether the host already executed the command.
  const result = await service[toggle]();
  expect(result).toMatchObject({
    status: "unknown", available: true, running: true,
    state_known: false, muted: null, deafened: null,
  });
  expect(result.message).toContain("may have executed");
  expect(service.isAvailable).toBeTrue();
});
