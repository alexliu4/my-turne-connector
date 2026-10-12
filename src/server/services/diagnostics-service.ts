import { NocturneManager, HostStatus } from "../nocturne-manager";
import { getConnectorVersion } from "../utils/version";
import { getRecentLogs } from "../utils/logger";

export interface DiagnosticsReport {
  timestamp: string;
  version: string;
  platform: string;
  connectorPlatform: string | null;
  sidecarReadiness: boolean;
  hostBridgeConnected: boolean;
  carThingConnected: boolean;
  carThingDevices: Array<{ id: string; deviceInfo: any }>;
  hostStatus: HostStatus | null;
  recentLogs: string[];
}

export class DiagnosticsService {
  constructor(private readonly manager: NocturneManager) {}

  async getDiagnostics(): Promise<DiagnosticsReport> {
    const hostStatus = await this.manager.refreshHostStatus();
    const connStatus = this.manager.getConnectionStatus();
    const recentLogs = getRecentLogs();

    return {
      timestamp: new Date().toISOString(),
      version: getConnectorVersion(),
      platform: process.platform,
      connectorPlatform: process.platform === "win32" ? "windows" : null,
      sidecarReadiness: true,
      hostBridgeConnected: process.platform === "win32" ? hostStatus.connected : true,
      carThingConnected: connStatus.connected,
      carThingDevices: connStatus.devices,
      hostStatus,
      recentLogs,
    };
  }

  async getRedactedExport(): Promise<Record<string, unknown>> {
    const report = await this.getDiagnostics();
    return redactValue(report) as Record<string, unknown>;
  }
}

export function redactSensitiveText(text: string): string {
  if (!text) return text;
  let redacted = text;

  // Redact Windows user paths e.g., C:\Users\Username\... -> C:\Users\[REDACTED]\...
  redacted = redacted.replace(/([a-zA-Z]:\\Users\\)[^\\]+/gi, "$1[REDACTED]");

  // Redact POSIX user paths e.g., /home/username/... -> /home/[REDACTED]/... or /Users/username/... -> /Users/[REDACTED]/...
  redacted = redacted.replace(/(\/(?:home|Users)\/)[^/]+/g, "$1[REDACTED]");

  // Redact Bearer / auth tokens
  redacted = redacted.replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "$1[REDACTED]");
  redacted = redacted.replace(/(token|secret|password|key)=([^\s&"']+)/gi, "$1=[REDACTED]");

  return redacted;
}

export function redactValue(val: unknown): unknown {
  if (typeof val === "string") {
    return redactSensitiveText(val);
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
        lowerKey.includes("key")
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
