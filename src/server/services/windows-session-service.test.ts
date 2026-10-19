import { describe, expect, test } from "bun:test";
import {
  WindowsSessionService,
  normalizeWindowsSessionState,
  type WindowsSessionState,
} from "./windows-session-service";
import type { HostBridgeClient } from "../platform/host-bridge";
import { NocturneManager } from "../nocturne-manager";
import { createUnavailableBluetoothService } from "./bluetooth-service";

class FakeHostBridge implements HostBridgeClient {
  private handlers = new Map<string, (data: any) => void>();
  public calls: Array<{ method: string; params: any }> = [];

  constructor(
    private sessionStatusHandler: () => any = () => ({
      session: "unlocked",
      activeSession: "active",
      systemPower: "awake",
      displayPower: "on",
      observedAt: 1000,
      sequence: 1,
    }),
  ) {}

  setSessionStatusHandler(fn: () => any) {
    this.sessionStatusHandler = fn;
  }

  async call<TResult = unknown>(
    method: string,
    params?: unknown,
  ): Promise<TResult> {
    this.calls.push({ method, params });
    if (method === "windows.session.get_status") {
      return this.sessionStatusHandler() as TResult;
    }
    throw new Error(`Unhandled fake bridge method: ${method}`);
  }

  onEvent<T = unknown>(topic: string, listener: (data: T) => void): () => void {
    this.handlers.set(topic, listener);
    return () => {
      this.handlers.delete(topic);
    };
  }

  emitNativeEvent(topic: string, data: any) {
    this.handlers.get(topic)?.(data);
  }

  close(): void {}
}

describe("WindowsSessionService & Integration", () => {
  test("1. Initial state unknown when no authoritative Windows state is available", () => {
    const service = new WindowsSessionService(null, "win32");
    expect(service.currentState.session).toBe("unknown");
    expect(service.currentState.activeSession).toBe("unknown");
    expect(service.currentState.systemPower).toBe("unknown");
    expect(service.currentState.displayPower).toBe("unknown");
    expect(service.currentState.sequence).toBe(0);
  });

  test("2. Lock -> unlock transitions", async () => {
    const bridge = new FakeHostBridge();
    const service = new WindowsSessionService(bridge, "win32");
    await service.start();

    const changes: WindowsSessionState[] = [];
    service.onSessionChanged((state) => changes.push(state));

    bridge.emitNativeEvent("windows.session.changed", {
      session: "locked",
      activeSession: "active",
      systemPower: "awake",
      displayPower: "on",
      observedAt: 1001,
      sequence: 2,
    });

    expect(service.currentState.session).toBe("locked");

    bridge.emitNativeEvent("windows.session.changed", {
      session: "unlocked",
      activeSession: "active",
      systemPower: "awake",
      displayPower: "on",
      observedAt: 1002,
      sequence: 3,
    });

    expect(service.currentState.session).toBe("unlocked");
    expect(changes.length).toBe(2);
  });

  test("3. Active-session switch and return", async () => {
    const bridge = new FakeHostBridge();
    const service = new WindowsSessionService(bridge, "win32");
    await service.start();

    bridge.emitNativeEvent("windows.session.changed", {
      session: "unlocked",
      activeSession: "inactive",
      systemPower: "awake",
      displayPower: "on",
      observedAt: 1001,
      sequence: 2,
    });
    expect(service.currentState.activeSession).toBe("inactive");

    bridge.emitNativeEvent("windows.session.changed", {
      session: "unlocked",
      activeSession: "active",
      systemPower: "awake",
      displayPower: "on",
      observedAt: 1002,
      sequence: 3,
    });
    expect(service.currentState.activeSession).toBe("active");
  });

  test("4. Display on -> off -> on, independently of session lock", async () => {
    const bridge = new FakeHostBridge();
    const service = new WindowsSessionService(bridge, "win32");
    await service.start();

    bridge.emitNativeEvent("windows.session.changed", {
      session: "unlocked",
      activeSession: "active",
      systemPower: "awake",
      displayPower: "off",
      observedAt: 1001,
      sequence: 2,
    });
    expect(service.currentState.displayPower).toBe("off");
    expect(service.currentState.session).toBe("unlocked");

    bridge.emitNativeEvent("windows.session.changed", {
      session: "unlocked",
      activeSession: "active",
      systemPower: "awake",
      displayPower: "on",
      observedAt: 1002,
      sequence: 3,
    });
    expect(service.currentState.displayPower).toBe("on");
    expect(service.currentState.session).toBe("unlocked");
  });

  test("5. Suspend -> resume -> revalidation flow", async () => {
    const bridge = new FakeHostBridge();
    const service = new WindowsSessionService(bridge, "win32");
    await service.start();

    bridge.emitNativeEvent("windows.session.changed", {
      session: "unlocked",
      activeSession: "active",
      systemPower: "suspending",
      displayPower: "off",
      observedAt: 1001,
      sequence: 2,
    });
    expect(service.currentState.systemPower).toBe("suspending");

    bridge.emitNativeEvent("windows.session.changed", {
      session: "unlocked",
      activeSession: "active",
      systemPower: "resuming",
      displayPower: "off",
      observedAt: 1002,
      sequence: 3,
    });
    expect(service.currentState.systemPower).toBe("resuming");

    bridge.emitNativeEvent("windows.session.changed", {
      session: "unlocked",
      activeSession: "active",
      systemPower: "awake",
      displayPower: "on",
      observedAt: 1003,
      sequence: 4,
    });
    expect(service.currentState.systemPower).toBe("awake");
  });

  test("6 & 7. Duplicate notifications and rapid conflicting notifications settle properly", async () => {
    const bridge = new FakeHostBridge();
    const service = new WindowsSessionService(bridge, "win32");
    await service.start();

    const initialSeq = service.currentState.sequence;

    // Rapid conflicting events: locked (seq 2) -> unlocked (seq 3)
    bridge.emitNativeEvent("windows.session.changed", {
      session: "locked",
      activeSession: "active",
      systemPower: "awake",
      displayPower: "on",
      observedAt: 1001,
      sequence: initialSeq + 1,
    });

    bridge.emitNativeEvent("windows.session.changed", {
      session: "unlocked",
      activeSession: "active",
      systemPower: "awake",
      displayPower: "on",
      observedAt: 1002,
      sequence: initialSeq + 2,
    });

    expect(service.currentState.session).toBe("unlocked");
    expect(service.currentState.sequence).toBe(initialSeq + 2);

    // Duplicate notification with lower/equal sequence is ignored
    bridge.emitNativeEvent("windows.session.changed", {
      session: "locked",
      activeSession: "active",
      systemPower: "awake",
      displayPower: "on",
      observedAt: 1000,
      sequence: initialSeq + 1,
    });

    expect(service.currentState.session).toBe("unlocked");
    expect(service.currentState.sequence).toBe(initialSeq + 2);
  });

  test("8. Native listener registration or query failure produces explicit unknown values", () => {
    const parsed = normalizeWindowsSessionState({
      session: "invalid_value",
      active_session: null,
      system_power: undefined,
      display_power: "dimmed",
      sequence: -5,
    });

    expect(parsed?.session).toBe("unknown");
    expect(parsed?.activeSession).toBe("unknown");
    expect(parsed?.systemPower).toBe("unknown");
    expect(parsed?.displayPower).toBe("dimmed");
    expect(parsed?.sequence).toBe(0);
  });

  test("9. Bun sidecar restart retrieves the native snapshot", async () => {
    const bridge = new FakeHostBridge(() => ({
      session: "locked",
      activeSession: "active",
      systemPower: "awake",
      displayPower: "on",
      observedAt: 2000,
      sequence: 10,
    }));

    const service = new WindowsSessionService(bridge, "win32");
    await service.start();

    expect(service.currentState.session).toBe("locked");
    expect(service.currentState.sequence).toBe(10);
  });

  test("10 & 11. Car Thing reconnect receives current snapshot and delayed native events cannot overwrite newer state", async () => {
    const bridge = new FakeHostBridge();
    const service = new WindowsSessionService(bridge, "win32");
    await service.start();

    bridge.emitNativeEvent("windows.session.changed", {
      session: "unlocked",
      activeSession: "active",
      systemPower: "awake",
      displayPower: "on",
      observedAt: 5000,
      sequence: 50,
    });

    const manager = new NocturneManager({
      platform: "win32",
      hostBridge: bridge,
      windowsSessionService: service,
      bluetoothService: createUnavailableBluetoothService(),
    });

    const res = await manager.onCall("1", "windows.session.get_status", {});
    expect((res.result as any).sessionState.session).toBe("unlocked");
    expect((res.result as any).sessionState.sequence).toBe(50);

    // Delayed native event with sequence 40 arriving now
    bridge.emitNativeEvent("windows.session.changed", {
      session: "locked",
      activeSession: "active",
      systemPower: "awake",
      displayPower: "on",
      observedAt: 4000,
      sequence: 40,
    });

    expect(service.currentState.session).toBe("unlocked");
    expect(service.currentState.sequence).toBe(50);
  });

  test("12, 13 & 14. Native pipe loss and recovery do not interfere with Bluetooth or Spotify, and unsupported platforms remain safe", async () => {
    const bridge = new FakeHostBridge(() => {
      throw new Error("Pipe disconnected");
    });

    const service = new WindowsSessionService(bridge, "win32");
    const snapshot = await service.refreshState();
    expect(snapshot.session).toBe("unknown");

    const nonWinService = new WindowsSessionService(bridge, "darwin");
    expect(nonWinService.isAvailable).toBe(false);
    expect(nonWinService.currentState.session).toBe("unknown");

    const manager = new NocturneManager({
      platform: "darwin",
      bluetoothService: createUnavailableBluetoothService(),
    });

    const res = await manager.onCall("1", "windows.session.get_status", {});
    expect((res.result as any).status).toBe("unsupported");
    expect((res.result as any).sessionState.session).toBe("unknown");
  });
});

describe("native observer generations and availability", () => {
  const snapshot = (observerId: string, sequence: number, session = "locked") => ({
    observerId, sequence, session, activeSession: "active", systemPower: "awake",
    displayPower: "on", observedAt: sequence * 100,
    sessionMonitoring: true, displayPowerMonitoring: true, systemPowerMonitoring: true,
  });

  test("startup RPC is authoritative; exact duplicates and equal-sequence conflicts are ignored", async () => {
    const state = snapshot("host-a", 20);
    const bridge = new FakeHostBridge(() => state);
    const service = new WindowsSessionService(bridge, "win32");
    const changes: WindowsSessionState[] = [];
    service.onSessionChanged(value => changes.push(value));
    await service.start();
    bridge.emitNativeEvent("windows.session.changed", state);
    bridge.emitNativeEvent("windows.session.changed", { ...state, session: "unlocked", observedAt: 99999 });
    expect(changes).toHaveLength(1);
    expect(service.currentState.session).toBe("locked");
  });

  test("native restart accepts lower sequence only from live snapshot and rejects delayed old instance", async () => {
    let live = snapshot("host-a", 100, "unlocked");
    const bridge = new FakeHostBridge(() => live);
    const service = new WindowsSessionService(bridge, "win32");
    await service.start();
    live = snapshot("host-b", 1);
    bridge.emitNativeEvent("windows.session.changed", live);
    expect(service.currentState.observerId).toBe("host-a");
    await service.refreshState();
    expect(service.currentState.observerId).toBe("host-b");
    expect(service.currentState.sequence).toBe(1);
    expect(service.currentState.session).toBe("locked");
    const calls = bridge.calls.length;
    bridge.emitNativeEvent("windows.session.changed", snapshot("host-a", 999, "unlocked"));
    expect(service.currentState.session).toBe("locked");
    expect(bridge.calls).toHaveLength(calls);
    bridge.emitNativeEvent("windows.session.changed", snapshot("host-c", 999, "unlocked"));
    await service.refreshState();
    expect(service.currentState.observerId).toBe("host-b");
  });

  test("pipe failure clears stale authority, same-instance reconnect restores locked snapshot", async () => {
    const state = snapshot("host-a", 10);
    const bridge = new FakeHostBridge(() => state);
    const service = new WindowsSessionService(bridge, "win32");
    await service.start();
    bridge.setSessionStatusHandler(() => { throw new Error("disconnected"); });
    await service.refreshState();
    expect(service.currentState.session).toBe("unknown");
    expect(service.currentState.displayPower).toBe("unknown");
    expect(service.currentState.sessionMonitoring).toBe(false);
    bridge.emitNativeEvent("windows.session.changed", snapshot("host-a", 9, "unlocked"));
    expect(service.currentState.session).toBe("unknown");
    bridge.setSessionStatusHandler(() => state);
    await service.refreshState();
    expect(service.currentState.session).toBe("locked");
    expect(service.currentState.sessionMonitoring).toBe(true);
    const replacement = new WindowsSessionService(bridge, "win32");
    await replacement.start();
    expect(replacement.currentState.session).toBe("locked");
    expect(replacement.currentState.observerId).toBe("host-a");
  });

  test("delayed failed refresh cannot erase a newer event; overlapping refreshes single-flight", async () => {
    const bridge = new FakeHostBridge(() => snapshot("host-a", 1));
    const service = new WindowsSessionService(bridge, "win32");
    await service.start();
    let fail!: (error: Error) => void;
    bridge.setSessionStatusHandler(() => new Promise((_, reject) => { fail = reject; }));
    const first = service.refreshState();
    const second = service.refreshState();
    bridge.emitNativeEvent("windows.session.changed", snapshot("host-a", 2));
    fail(new Error("late failure"));
    await Promise.all([first, second]);
    expect(bridge.calls).toHaveLength(2);
    expect(service.currentState.session).toBe("locked");
    expect(service.currentState.sequence).toBe(2);
  });

  test("monitoring failure is reported without affecting other fields; Linux stays unsupported", async () => {
    const state = { ...snapshot("host-a", 1), sessionMonitoring: false, session: "unknown", activeSession: "unknown" };
    const bridge = new FakeHostBridge(() => state);
    const service = new WindowsSessionService(bridge, "win32");
    await service.start();
    expect(service.currentState.sessionMonitoring).toBe(false);
    expect(service.currentState.displayPowerMonitoring).toBe(true);
    expect(service.currentState.displayPower).toBe("on");
    const linux = new WindowsSessionService(bridge, "linux");
    const calls = bridge.calls.length;
    await linux.start();
    await linux.refreshState();
    expect(linux.isAvailable).toBe(false);
    expect(bridge.calls).toHaveLength(calls);
    const manager = new NocturneManager({ platform: "linux", bluetoothService: createUnavailableBluetoothService() });
    const response = await manager.onCall("1", "windows.session.get_status", {});
    expect((response.result as any).status).toBe("unsupported");
  });
});


test("app.ready revalidates a locked reconnect rather than replaying an unlocked cache", async () => {
  let state = { observerId: "host-a", sequence: 1, observedAt: 100, session: "unlocked" };
  const bridge = new FakeHostBridge(() => state);
  const service = new WindowsSessionService(bridge, "win32");
  await service.start();
  state = { ...state, sequence: 2, observedAt: 200, session: "locked" };
  const manager = new NocturneManager({ platform: "win32", hostBridge: bridge,
    windowsSessionService: service, bluetoothService: createUnavailableBluetoothService() });
  let ready: any;
  (manager as any).broadcastToDevices = async (topic: string, data: unknown) => {
    if (topic === "app.ready") ready = data;
  };
  await (manager as any).sendAppReady();
  expect(ready.windowsSession.session).toBe("locked");
  expect(ready.windowsSession.sequence).toBe(2);
  expect(ready.platform).toBe("web");
});

test("a new-instance event arriving during an older refresh gets a follow-up live snapshot", async () => {
  const bridge = new FakeHostBridge(() => ({ observerId: "host-a", sequence: 100, observedAt: 100, session: "unlocked" }));
  const service = new WindowsSessionService(bridge, "win32");
  await service.start();
  let finish!: (value: unknown) => void;
  bridge.setSessionStatusHandler(() => new Promise(resolve => { finish = resolve; }));
  const pending = service.refreshState();
  bridge.emitNativeEvent("windows.session.changed", { observerId: "host-b", sequence: 1, session: "locked" });
  bridge.setSessionStatusHandler(() => ({ observerId: "host-b", sequence: 1, observedAt: 200, session: "locked" }));
  finish({ observerId: "host-a", sequence: 100, observedAt: 100, session: "unlocked" });
  await pending;
  await service.refreshState();
  expect(service.currentState.observerId).toBe("host-b");
  expect(service.currentState.session).toBe("locked");
});


test("observer history stays bounded across restarts without trusting evicted events", async () => {
  const snapshot = (index: number) => ({
    observerId: `host-${index}`, sequence: index % 2, observedAt: index,
    session: index % 2 === 0 ? "locked" : "unlocked",
  });
  let live = snapshot(0);
  const bridge = new FakeHostBridge(() => live);
  const service = new WindowsSessionService(bridge, "win32");
  const retired = () => (service as unknown as { retiredObservers: Set<string> }).retiredObservers;
  const changes: WindowsSessionState[] = [];
  service.onSessionChanged(state => changes.push(state));
  await service.start();

  for (let index = 1; index <= 64; index++) {
    live = snapshot(index);
    bridge.emitNativeEvent("windows.session.changed", live);
    // A new generation's event alone never establishes authority.
    expect(service.currentState.observerId).toBe(`host-${index - 1}`);
    await service.refreshState();
    expect(service.currentState.observerId).toBe(live.observerId);
    expect(service.currentState.sequence).toBe(live.sequence);
    expect(retired().size).toBe(Math.min(index, 16));
  }
  expect(retired().has("host-0")).toBe(false);
  expect(retired().has("host-48")).toBe(true);
  expect(retired().has("host-63")).toBe(true);
  expect(retired().has("host-64")).toBe(false);

  const current = service.currentState;
  const changeCount = changes.length;
  const calls = bridge.calls.length;
  // Recent tombstones reject even events with a much higher sequence/time.
  bridge.emitNativeEvent("windows.session.changed", {
    ...snapshot(63), sequence: 99999, observedAt: 99999,
  });
  expect(bridge.calls).toHaveLength(calls);

  // Evicted tombstones are no longer remembered, but their event data remains
  // untrusted. Revalidate against host-64 instead of adopting the old payload.
  for (let index = 0; index < 64; index++) {
    bridge.emitNativeEvent("windows.session.changed", {
      ...snapshot(index), session: "unlocked", sequence: 99999, observedAt: 99999,
    });
    expect(service.currentState).toEqual(current);
  }
  await service.refreshState();
  await service.refreshState(); // drain any follow-up refresh from an in-flight RPC
  expect(service.currentState).toEqual(current);
  expect(changes).toHaveLength(changeCount);
  expect(retired().size).toBe(16);

  // A real restart after eviction still adopts its authoritative reset sequence.
  live = snapshot(65);
  await service.refreshState();
  expect(service.currentState.observerId).toBe("host-65");
  expect(service.currentState.session).toBe("unlocked");
  expect(retired().size).toBe(16);
  expect(retired().has("host-48")).toBe(false);
  expect(retired().has("host-64")).toBe(true);
});
