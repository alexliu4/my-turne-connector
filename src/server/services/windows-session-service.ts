import type { HostBridgeClient } from "../platform/host-bridge";
import { createLogger } from "../utils/logger";

const log = createLogger("WindowsSessionService");

export interface WindowsSessionState {
  session: "locked" | "unlocked" | "unknown";
  activeSession: "active" | "inactive" | "unknown";
  systemPower: "awake" | "suspending" | "resuming" | "unknown";
  displayPower: "on" | "off" | "dimmed" | "unknown";
  observedAt: number;
  sequence: number;
}

export function defaultWindowsSessionState(): WindowsSessionState {
  return {
    session: "unknown",
    activeSession: "unknown",
    systemPower: "unknown",
    displayPower: "unknown",
    observedAt: Date.now(),
    sequence: 0,
  };
}

export class WindowsSessionService {
  private current: WindowsSessionState = defaultWindowsSessionState();
  private unbindEvent: (() => void) | null = null;
  private readonly listeners = new Set<(state: WindowsSessionState) => void>();

  constructor(
    private readonly hostBridge: HostBridgeClient | null,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  get isAvailable(): boolean {
    return this.platform === "win32" && this.hostBridge !== null;
  }

  get currentState(): WindowsSessionState {
    return { ...this.current };
  }

  async start(): Promise<void> {
    if (!this.isAvailable || !this.hostBridge) return;

    this.unbindEvent?.();
    this.unbindEvent = this.hostBridge.onEvent<unknown>(
      "windows.session.changed",
      (data) => this.handleNativeEvent(data),
    );

    await this.refreshState();
  }

  async refreshState(): Promise<WindowsSessionState> {
    if (!this.isAvailable || !this.hostBridge) {
      return this.currentState;
    }

    try {
      const raw = await this.hostBridge.call<unknown>(
        "windows.session.get_status",
        {},
        { timeoutMs: 2_000 },
      );
      this.updateState(raw);
    } catch (err) {
      log.warn(`Failed to fetch native Windows session status: ${err}`);
    }

    return this.currentState;
  }

  onSessionChanged(listener: (state: WindowsSessionState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private handleNativeEvent(data: unknown): void {
    this.updateState(data);
  }

  private updateState(raw: unknown): void {
    const parsed = normalizeWindowsSessionState(raw);
    if (!parsed) return;

    if (
      parsed.sequence < this.current.sequence ||
      (parsed.sequence === this.current.sequence &&
        parsed.sequence > 0 &&
        parsed.observedAt < this.current.observedAt)
    ) {
      return;
    }

    this.current = parsed;
    for (const listener of this.listeners) {
      try {
        listener(this.currentState);
      } catch (err) {
        log.error(`Session change listener failed: ${err}`);
      }
    }
  }

  stop(): void {
    this.unbindEvent?.();
    this.unbindEvent = null;
    this.listeners.clear();
  }
}

export function normalizeWindowsSessionState(
  data: unknown,
): WindowsSessionState | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;

  const session = parseEnum<WindowsSessionState["session"]>(
    record.session,
    ["locked", "unlocked", "unknown"],
    "unknown",
  );

  const activeSession = parseEnum<WindowsSessionState["activeSession"]>(
    record.activeSession ?? record.active_session,
    ["active", "inactive", "unknown"],
    "unknown",
  );

  const systemPower = parseEnum<WindowsSessionState["systemPower"]>(
    record.systemPower ?? record.system_power,
    ["awake", "suspending", "resuming", "unknown"],
    "unknown",
  );

  const displayPower = parseEnum<WindowsSessionState["displayPower"]>(
    record.displayPower ?? record.display_power,
    ["on", "off", "dimmed", "unknown"],
    "unknown",
  );

  const observedAtRaw = record.observedAt ?? record.observed_at;
  const observedAt =
    typeof observedAtRaw === "number" && Number.isFinite(observedAtRaw) && observedAtRaw >= 0
      ? observedAtRaw
      : Date.now();

  const sequenceRaw = record.sequence;
  const sequence =
    typeof sequenceRaw === "number" && Number.isInteger(sequenceRaw) && sequenceRaw >= 0
      ? sequenceRaw
      : 0;

  return {
    session,
    activeSession,
    systemPower,
    displayPower,
    observedAt,
    sequence,
  };
}

function parseEnum<T extends string>(
  val: unknown,
  allowed: T[],
  fallback: T,
): T {
  if (typeof val === "string" && (allowed as string[]).includes(val)) {
    return val as T;
  }
  return fallback;
}
