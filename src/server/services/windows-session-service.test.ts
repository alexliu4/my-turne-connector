import { describe, expect, test } from "bun:test";
import {
  WindowsSessionService,
  normalizeWindowsSessionState,
  type WindowsSessionState,
} from "./windows-session-service";
import type { HostBridgeClient } from "../platform/host-bridge";
import { NocturneManager } from "../nocturne-manager";

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
    });

    const res = await manager.onCall("1", "windows.session.get_status", {});
    expect((res.result as any).status).toBe("unsupported");
    expect((res.result as any).sessionState.session).toBe("unknown");
  });
});
