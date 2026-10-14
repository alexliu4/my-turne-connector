import { appendRotatingLog, boundedLogLine, redactLogText } from "./log-storage";
import { join } from "path";
import { CONNECTOR_STATE_DIR } from "../config";

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;
const logFile =
  process.platform === "win32"
    ? join(CONNECTOR_STATE_DIR, "logs", "connector.log")
    : null;

const currentLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) || "info";

const recentLogs: string[] = [];
const MAX_RECENT_LOGS = 50;

function pushRecentLog(line: string): void {
  if (recentLogs.length >= MAX_RECENT_LOGS) {
    recentLogs.shift();
  }
  recentLogs.push(line);
}

export function getRecentLogs(): string[] {
  return [...recentLogs];
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function timestamp(): string {
  return new Date().toISOString();
}

let logWriteFailureReported = false;

function writeRotatingLog(line: string): void {
  if (!logFile) return;
  try {
    appendRotatingLog(logFile, line);
    logWriteFailureReported = false;
  } catch {
    if (!logWriteFailureReported) {
      logWriteFailureReported = true;
      console.error("Unable to write the Connector log file");
    }
  }
}

function formatLine(level: LogLevel, category: string, msg: string, args: unknown[], osErrorCode?: unknown): string {
  const suffix = args.length
    ? ` ${args.map((arg) => {
        try {
          return typeof arg === "string" ? arg : JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }).join(" ")}`
    : "";
  return boundedLogLine(`[${timestamp()}] [${level.toUpperCase()}] [${redactLogText(category)}] ${redactLogText(msg + suffix, osErrorCode)}`).toString("utf8").trimEnd();
}

export function createLogger(category: string) {
  return {
    // Callers supply a numeric errno from the OS, never a parsed log payload.
    errorOsCode(msg: string, code: unknown) {
      if (!shouldLog("error")) return;
      const line = formatLine("error", category, msg, [], code);
      console.error(line);
      writeRotatingLog(line);
      pushRecentLog(line);
    },
    debug(msg: string, ...args: unknown[]) {
      if (shouldLog("debug")) {
        const line = formatLine("debug", category, msg, args);
        console.debug(line);
        writeRotatingLog(line);
      }
    },
    info(msg: string, ...args: unknown[]) {
      if (shouldLog("info")) {
        const line = formatLine("info", category, msg, args);
        console.info(line);
        writeRotatingLog(line);
      }
    },
    warn(msg: string, ...args: unknown[]) {
      if (shouldLog("warn")) {
        const line = formatLine("warn", category, msg, args);
        console.warn(line);
        writeRotatingLog(line);
        pushRecentLog(line);
      }
    },
    error(msg: string, ...args: unknown[]) {
      if (shouldLog("error")) {
        const line = formatLine("error", category, msg, args);
        console.error(line);
        writeRotatingLog(line);
        pushRecentLog(line);
      }
    },
  };
}
