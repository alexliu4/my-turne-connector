import { NocturneManager, HostStatus } from "../nocturne-manager";
import { getConnectorVersion } from "../utils/version";
import { getRecentLogs } from "../utils/logger";

export interface DiagnosticsReport {
  timestamp: string;
  version: string;
  platform: string;
  connectorPlatform: string | null;
  sidecarReadiness: boolean;
  hostBridgeConnected: boolean | null;
  carThingConnected: boolean;
  carThingDeviceCount: number;
  carThingDevices: Array<{
    deviceIndex: number;
    deviceType: string;
    firmwareVersion: string;
  }>;
  hostStatus: HostStatus | null;
  recentLogs: string[];
  health?: {
    nativeHost: "connected" | "unavailable" | "unsupported";
    sidecar: "ready";
    bluetoothRoute: "connected" | "disconnected";
    featureProbe: "complete" | "timeout" | "error";
    features: Record<string, boolean>;
  };
  build?: { arch: string; runtime: string; version: string };
  devicesTruncated?: boolean;
}

export class DiagnosticsService {
  private refresh: Promise<"complete" | "error"> | null = null;

  constructor(
    private readonly manager: NocturneManager,
    private readonly probeTimeoutMs = 3_000,
  ) {}

  private async probe(): Promise<"complete" | "timeout" | "error"> {
    // Keep ownership until the actual refresh settles, even after a deadline.
    if (!this.refresh) {
      this.refresh = Promise.resolve().then(() => this.manager.refreshHostStatus())
        .then(() => "complete" as const, () => "error" as const)
        .finally(() => { this.refresh = null; });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.refresh,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), this.probeTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async getDiagnostics(): Promise<DiagnosticsReport> {
    const featureProbe = await this.probe();
    const hostStatus = this.manager.getHostStatus();
    const connStatus = this.manager.getConnectionStatus();

    const carThingDevices = connStatus.devices.slice(0, 32).map((d, index) => ({
      deviceIndex: index + 1,
      deviceType: d.deviceInfo?.device ?? "Nocturne Car Thing",
      firmwareVersion: d.deviceInfo?.version ?? "unknown",
    }));

    const rawLogs = getRecentLogs();
    // Arbitrary log text can contain embedded, escaped, or malformed JSON and
    // unlabeled secrets. Export only fixed severity counts, never log payloads.
    const redactedLogs = ["WARN", "ERROR"].map((level) => {
      const prefix = new RegExp(`^\\[\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z\\] \\[${level}\\] \\[`);
      const count = rawLogs.filter((line) => prefix.test(line)).length;
      return `Recent ${level} entries: ${count}`;
    });

    const hostConnected = this.manager.isHostBridgeConnected();
    const report: DiagnosticsReport = {
      health: {
        nativeHost: hostConnected === null ? "unsupported" : hostConnected ? "connected" : "unavailable",
        sidecar: "ready",
        bluetoothRoute: connStatus.connected ? "connected" : "disconnected",
        featureProbe,
        features: Object.fromEntries(Object.entries(hostStatus?.services ?? {}).map(([name, state]) => [name, state.available === true])),
      },
      build: { arch: process.arch, runtime: `Bun ${Bun.version}`, version: getConnectorVersion() },
      devicesTruncated: connStatus.devices.length > 32,
      timestamp: new Date().toISOString(),
      version: getConnectorVersion(),
      platform: process.platform,
      connectorPlatform: process.platform === "win32" ? "windows" : null,
      sidecarReadiness: true, // Bun sidecar process is online and serving requests
      hostBridgeConnected: this.manager.isHostBridgeConnected(),
      carThingConnected: connStatus.connected,
      carThingDeviceCount: connStatus.deviceCount,
      carThingDevices,
      hostStatus,
      recentLogs: redactedLogs,
    };

    return redactValue(report) as DiagnosticsReport;
  }

  async getRedactedExport(): Promise<Record<string, unknown>> {
    const report = await this.getDiagnostics();
    return redactValue(report) as Record<string, unknown>;
  }
}

export function redactSensitiveText(text: string): string {
  if (!text) return text;
  let redacted = text;

  // Redact Windows user paths e.g., C:\Users\Username\... or C:/Users/Username/...
  redacted = redacted.replace(/([a-zA-Z]:[/\\]Users[/\\])[^/\\\s"']+/gi, "$1[REDACTED]");

  // Redact POSIX user paths e.g., /home/username/... or /Users/username/...
  redacted = redacted.replace(/(\/(?:home|Users)\/)[^/\s"']+/g, "$1[REDACTED]");

  // Redact Bearer and Basic auth headers
  redacted = redacted.replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "$1[REDACTED]");
  redacted = redacted.replace(/(Basic\s+)[A-Za-z0-9+/]+=*/gi, "$1[REDACTED]");

  // Redact query parameter assignments e.g. token=123, secret=abc, code=xyz, password=def
  redacted = redacted.replace(
    /(?<=\b(?:token|secret|password|credential|auth|code|api_key|access_token|refresh_token)=)[^\s&"']+/gi,
    "[REDACTED]",
  );

  // Redact user credentials in URLs e.g. http://user:pass@host
  redacted = redacted.replace(/(https?:\/\/)([^:\s\/]+):([^@\s\/]+)@/gi, "$1[REDACTED]:[REDACTED]@");

  return redacted;
}

export function redactValue(val: unknown): unknown {
  if (typeof val === "string") {
    return redactSensitiveText(val.slice(0, 512));
  }

  if (Array.isArray(val)) {
    return val.map((item) => redactValue(item));
  }

  if (val !== null && typeof val === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      const lowerKey = k.toLowerCase();
      if (
        lowerKey.includes("token") ||
        lowerKey.includes("secret") ||
        lowerKey.includes("password") ||
        lowerKey.includes("credential") ||
        lowerKey.includes("auth") ||
        lowerKey.includes("session") ||
        lowerKey.includes("cookie") ||
        lowerKey.includes("key") ||
        lowerKey.includes("serial") ||
        lowerKey.includes("email") ||
        lowerKey.includes("user_id") ||
        lowerKey.includes("userid")
      ) {
        result[k] = "[REDACTED]";
      } else {
        result[k] = redactValue(v);
      }
    }
    return result;
  }

  return val;
}
