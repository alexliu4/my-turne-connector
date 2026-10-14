import { NocturneManager } from "../nocturne-manager";
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
  hostStatus: {
    connected: boolean;
    deviceConnected: boolean;
    services: Record<DiagnosticFeature, { available: boolean }>;
  } | null;
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
  truncated?: boolean;
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
      this.refresh = Promise.resolve()
        .then(() => this.manager.refreshHostStatus())
        .then(
          () => "complete" as const,
          () => "error" as const,
        )
        .finally(() => {
          this.refresh = null;
        });
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

    const carThingDevices = connStatus.devices
      .slice(0, MAX_DEVICES)
      .map((d, index) => ({
        deviceIndex: index + 1,
        deviceType: d.deviceInfo?.device ?? "Nocturne Car Thing",
        firmwareVersion: d.deviceInfo?.version ?? "unknown",
      }));

    const rawLogs = getRecentLogs();
    // Arbitrary log text can contain embedded, escaped, or malformed JSON and
    // unlabeled secrets. Export only fixed severity counts, never log payloads.
    const redactedLogs = ["WARN", "ERROR"].map((level) => {
      const prefix = new RegExp(
        `^\\[\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z\\] \\[${level}\\] \\[`,
      );
      const count = rawLogs.filter((line) => prefix.test(line)).length;
      return `Recent ${level} entries: ${count}`;
    });

    const hostConnected = this.manager.isHostBridgeConnected();
    return supportReport({
      timestamp: new Date().toISOString(),
      version: getConnectorVersion(),
      platform: process.platform,
      connectorPlatform: process.platform === "win32" ? "windows" : null,
      sidecarReadiness: true,
      hostBridgeConnected: hostConnected,
      carThingConnected: connStatus.connected,
      carThingDeviceCount: connStatus.deviceCount,
      carThingDevices,
      devicesTruncated: connStatus.devices.length > MAX_DEVICES,
      hostStatus,
      recentLogs: redactedLogs,
      health: {
        nativeHost:
          hostConnected === null
            ? "unsupported"
            : hostConnected
              ? "connected"
              : "unavailable",
        sidecar: "ready",
        bluetoothRoute: connStatus.connected ? "connected" : "disconnected",
        featureProbe,
        features: Object.fromEntries(
          FEATURES.map((name) => [
            name,
            hostStatus?.services?.[name]?.available === true,
          ]),
        ),
      },
      build: {
        arch: process.arch,
        runtime: `Bun ${Bun.version}`,
        version: getConnectorVersion(),
      },
    });
  }

  async getRedactedExport(): Promise<DiagnosticsReport> {
    return this.getDiagnostics();
  }
}

export const MAX_DIAGNOSTICS_EXPORT_BYTES = 256 * 1024;
const MAX_DEVICES = 32;
const MAX_STRING = 128;
const FEATURES = [
  "volume",
  "media",
  "discord",
  "systemStats",
  "appLaunch",
  "macros",
] as const;
type DiagnosticFeature = (typeof FEATURES)[number];
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

// Fixed support schema: no traversal of arbitrary host metadata, log payloads,
// pairing prompts, app definitions, or executable macro parameters.
export function supportReport(input: unknown): DiagnosticsReport {
  const raw = object(input);
  let truncated = raw.truncated === true;
  const bounded = (
    value: unknown,
    pattern: RegExp,
    fallback: string,
  ): string => {
    if (typeof value !== "string") {
      if (value != null) truncated = true;
      return fallback;
    }
    if (value.length > MAX_STRING || !pattern.test(value)) {
      truncated = true;
      return fallback;
    }
    return value;
  };
  const version = (value: unknown) => {
    const safe = bounded(
      value,
      /^\d{1,4}(?:\.\d{1,4}){1,3}(?:[-+][A-Za-z0-9.-]{1,48})?$/,
      "unknown",
    );
    const core = safe.split(/[-+]/, 1)[0];
    if (core !== safe) truncated = true;
    return core;
  };
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? Math.min(value, 1_000_000_000)
      : 0;
  const flags = (value: unknown) => {
    const source = object(value);
    return Object.fromEntries(
      FEATURES.map((name) => [name, source[name] === true]),
    ) as Record<DiagnosticFeature, boolean>;
  };
  const devices = Array.isArray(raw.carThingDevices) ? raw.carThingDevices : [];
  if (devices.length > MAX_DEVICES) truncated = true;
  const carThingDevices = devices.slice(0, MAX_DEVICES).map((value, index) => {
    const device = object(value);
    return {
      deviceIndex: index + 1,
      deviceType: "Nocturne Car Thing",
      firmwareVersion: version(device.firmwareVersion),
    };
  });
  const host = raw.hostStatus == null ? null : object(raw.hostStatus);
  const services = object(host?.services);
  const health = object(raw.health);
  const build = object(raw.build);
  const logs = Array.isArray(raw.recentLogs) ? raw.recentLogs : [];
  const recentLogs: string[] = [];
  for (const line of logs.slice(0, 2)) {
    if (
      typeof line === "string" &&
      line.length <= MAX_STRING &&
      /^Recent (WARN|ERROR) entries: \d{1,9}$/.test(line)
    )
      recentLogs.push(line);
    else truncated = true;
  }
  if (logs.length > 2) truncated = true;
  const report: DiagnosticsReport = {
    timestamp: bounded(
      raw.timestamp,
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/,
      "unknown",
    ),
    version: version(raw.version),
    platform: bounded(
      raw.platform,
      /^(win32|linux|darwin|freebsd|openbsd|aix|sunos|android)$/,
      "unknown",
    ),
    connectorPlatform: raw.connectorPlatform === "windows" ? "windows" : null,
    sidecarReadiness: raw.sidecarReadiness === true,
    hostBridgeConnected:
      typeof raw.hostBridgeConnected === "boolean"
        ? raw.hostBridgeConnected
        : null,
    carThingConnected: raw.carThingConnected === true,
    carThingDeviceCount: count(raw.carThingDeviceCount),
    carThingDevices,
    hostStatus: host
      ? {
          connected: host.connected === true,
          deviceConnected: host.deviceConnected === true,
          services: Object.fromEntries(
            FEATURES.map((name) => [
              name,
              { available: object(services[name]).available === true },
            ]),
          ) as Record<DiagnosticFeature, { available: boolean }>,
        }
      : null,
    recentLogs,
    devicesTruncated:
      raw.devicesTruncated === true || devices.length > MAX_DEVICES,
  };
  if (raw.health != null)
    report.health = {
      nativeHost:
        health.nativeHost === "connected"
          ? "connected"
          : health.nativeHost === "unsupported"
            ? "unsupported"
            : "unavailable",
      sidecar: "ready",
      bluetoothRoute:
        health.bluetoothRoute === "connected" ? "connected" : "disconnected",
      featureProbe:
        health.featureProbe === "complete"
          ? "complete"
          : health.featureProbe === "timeout"
            ? "timeout"
            : "error",
      features: flags(health.features),
    };
  if (raw.build != null)
    report.build = {
      arch: bounded(
        build.arch,
        /^(x64|arm64|arm|ia32|riscv64|ppc64|s390x)$/,
        "unknown",
      ),
      runtime:
        typeof build.runtime === "string" &&
        build.runtime.length <= MAX_STRING &&
        build.runtime.startsWith("Bun ")
          ? `Bun ${version(build.runtime.slice(4))}`
          : "unknown",
      version: version(build.version),
    };
  report.truncated = truncated || report.devicesTruncated;
  return report;
}

export function serializeDiagnosticsExport(input: unknown): string {
  const report = supportReport(input);
  let json = JSON.stringify(report, null, 2);
  if (Buffer.byteLength(json) > MAX_DIAGNOSTICS_EXPORT_BYTES) {
    // Keep essential health even if the optional schema grows in the future.
    report.carThingDevices = [];
    report.hostStatus = null;
    report.recentLogs = [];
    report.build = undefined;
    report.truncated = true;
    report.devicesTruncated = true;
    json = JSON.stringify(report, null, 2);
  }
  return json;
}

export function redactSensitiveText(text: string): string {
  if (!text) return text;
  let redacted = text;

  // Redact Windows user paths e.g., C:\Users\Username\... or C:/Users/Username/...
  redacted = redacted.replace(
    /([a-zA-Z]:[/\\]Users[/\\])[^/\\\s"']+/gi,
    "$1[REDACTED]",
  );

  // Redact POSIX user paths e.g., /home/username/... or /Users/username/...
  redacted = redacted.replace(/(\/(?:home|Users)\/)[^/\s"']+/g, "$1[REDACTED]");

  // Redact Bearer and Basic auth headers
  redacted = redacted.replace(
    /(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
    "$1[REDACTED]",
  );
  redacted = redacted.replace(/(Basic\s+)[A-Za-z0-9+/]+=*/gi, "$1[REDACTED]");

  // Redact query parameter assignments e.g. token=123, secret=abc, code=xyz, password=def
  redacted = redacted.replace(
    /(?<=\b(?:token|secret|password|credential|auth|code|api_key|access_token|refresh_token)=)[^\s&"']+/gi,
    "[REDACTED]",
  );

  // Redact user credentials in URLs e.g. http://user:pass@host
  redacted = redacted.replace(
    /(https?:\/\/)([^:\s\/]+):([^@\s\/]+)@/gi,
    "$1[REDACTED]:[REDACTED]@",
  );

  return redacted;
}

// Compatibility helper for in-memory redaction tests. Exports use the fixed
// schema above rather than this generic traversal. Bound depth, fanout and work.
export function redactValue(val: unknown): unknown {
  let remaining = 256;
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 5) return "[TRUNCATED]";
    if (typeof value === "string")
      return redactSensitiveText(value.slice(0, MAX_STRING));
    if (value !== null && typeof value === "object") {
      if (seen.has(value)) return "[TRUNCATED]";
      seen.add(value);
      if (Array.isArray(value))
        return value.slice(0, 32).map((item) => visit(item, depth + 1));
      const result: Record<string, unknown> = Object.create(null);
      let count = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (++count > 32 || remaining <= 0) {
          result.truncated = true;
          break;
        }
        const name = key.slice(0, MAX_STRING);
        if (
          /(token|secret|password|credential|auth|session|cookie|key|serial|email|user_?id|code|pin|params|arguments|command|logs)/i.test(
            key,
          )
        )
          result[name] = "[REDACTED]";
        else result[name] = visit(object(value)[key], depth + 1);
      }
      return result;
    }
    return value;
  };
  return visit(val, 0);
}
