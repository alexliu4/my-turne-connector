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
  observerId: string;
  sessionMonitoring: boolean;
  displayPowerMonitoring: boolean;
  systemPowerMonitoring: boolean;
}

export function defaultWindowsSessionState(): WindowsSessionState {
  return {
    session: "unknown",
    activeSession: "unknown",
    systemPower: "unknown",
    displayPower: "unknown",
    observedAt: Date.now(),
    sequence: 0,
    observerId: "",
    sessionMonitoring: false,
    displayPowerMonitoring: false,
    systemPowerMonitoring: false,
  };
}

export class WindowsSessionService {
  private current: WindowsSessionState = defaultWindowsSessionState();
  private refreshPromise: Promise<WindowsSessionState> | null = null;
  private accepted: WindowsSessionState | null = null;
  private readonly retiredObservers = new Set<string>();
  private revision = 0;
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

    if (this.refreshPromise) return this.refreshPromise;
    const revision = this.revision;
    this.refreshPromise = (async () => {
      try {
        const raw = await this.hostBridge!.call<unknown>(
          "windows.session.get_status", {}, { timeoutMs: 2_000 },
        );
        if (!normalizeWindowsSessionState(raw)) throw new Error("Invalid session snapshot");
        this.updateState(raw, true);
      } catch (err) {
        log.warn(`Failed to fetch native Windows session status: ${err}`);
        // A failed older request must not erase a newer event.
        if (this.revision === revision) {
          this.publish({ ...defaultWindowsSessionState(),
            observerId: this.current.observerId, sequence: this.current.sequence });
        }
      }
      return this.currentState;
    })().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  onSessionChanged(listener: (state: WindowsSessionState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private handleNativeEvent(data: unknown): void {
    const parsed = normalizeWindowsSessionState(data);
    if (!parsed || this.retiredObservers.has(parsed.observerId)) return;
    if (!this.accepted || parsed.observerId !== this.accepted.observerId) {
      // Only a response from the live pipe can establish a native instance.
      void this.refreshState().then(() => {
        // An older RPC may already have been in flight when this instance appeared.
        if (this.accepted?.observerId !== parsed.observerId &&
            !this.retiredObservers.has(parsed.observerId)) void this.refreshState();
      });
      return;
    }
    this.updateState(parsed);
  }

  private updateState(raw: unknown, authoritative = false): void {
    const parsed = normalizeWindowsSessionState(raw);
    if (!parsed || this.retiredObservers.has(parsed.observerId)) return;
    const previous = this.accepted;
    if (previous && parsed.observerId !== previous.observerId) {
      if (!authoritative) return;
      this.retiredObservers.add(previous.observerId);
    } else if (previous) {
      if (parsed.sequence < previous.sequence) return;
      if (parsed.sequence === previous.sequence &&
          JSON.stringify(parsed) !== JSON.stringify(previous)) return;
    }
    this.accepted = parsed;
    this.publish(parsed);
  }

  private publish(state: WindowsSessionState): void {
    if (JSON.stringify(state) === JSON.stringify(this.current)) return;
    this.current = state;
    this.revision++;
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
    observerId: typeof record.observerId === "string" && record.observerId.length <= 64
      ? record.observerId : "",
    sessionMonitoring: record.sessionMonitoring === true,
    displayPowerMonitoring: record.displayPowerMonitoring === true,
    systemPowerMonitoring: record.systemPowerMonitoring === true,
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
