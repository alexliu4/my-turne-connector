import { createLogger } from "../utils/logger";
import type { HostBridgeClient } from "../platform/host-bridge";

const log = createLogger("SystemStatsService");
const STATS_RPC_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 1_000;

export interface SystemStats {
  status: string;
  available: boolean;
  cpu_percent: number | null;
  memory_percent: number | null;
  memory_used_bytes: number | null;
  memory_total_bytes: number | null;
  gpu_percent: number | null;
  message?: string;
}

interface CachedSystemStats {
  stats: SystemStats;
  fetchedAt: number;
}

export class SystemStatsService {
  private cache: CachedSystemStats | null = null;
  private isHostAvailable = false;

  constructor(
    private readonly hostBridge: HostBridgeClient,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.isHostAvailable = this.platform === "win32";
  }

  get isAvailable(): boolean {
    return this.isHostAvailable;
  }

  async getStats(): Promise<SystemStats> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.stats;
    }

    try {
      const response = await this.callHostWithTimeout("system_stats.get", {});
      const rec = asRecord(response);

      if (!rec || rec.status !== "ok") {
        const fallback: SystemStats = {
          status: typeof rec?.status === "string" ? rec.status : "unsupported",
          available: rec?.available === true,
          cpu_percent: null,
          memory_percent: null,
          memory_used_bytes: null,
          memory_total_bytes: null,
          gpu_percent: null,
          message: typeof rec?.message === "string" ? rec.message : undefined,
        };
        return fallback;
      }

      this.isHostAvailable = true;
      const stats: SystemStats = {
        status: "ok",
        available: true,
        cpu_percent: typeof rec.cpu_percent === "number" ? rec.cpu_percent : null,
        memory_percent: typeof rec.memory_percent === "number" ? rec.memory_percent : null,
        memory_used_bytes: typeof rec.memory_used_bytes === "number" ? rec.memory_used_bytes : null,
        memory_total_bytes: typeof rec.memory_total_bytes === "number" ? rec.memory_total_bytes : null,
        gpu_percent: typeof rec.gpu_percent === "number" ? rec.gpu_percent : null,
      };

      this.cache = {
        stats,
        fetchedAt: now,
      };

      return stats;
    } catch (error) {
      log.warn(`system_stats.get call failed: ${errorMessage(error)}`);
      const fallback: SystemStats = {
        status: "unsupported",
        available: false,
        cpu_percent: null,
        memory_percent: null,
        memory_used_bytes: null,
        memory_total_bytes: null,
        gpu_percent: null,
        message: errorMessage(error),
      };
      return fallback;
    }
  }

  private callHostWithTimeout(method: string, params: unknown): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`SystemStats RPC ${method} timed out after ${STATS_RPC_TIMEOUT_MS}ms`));
      }, STATS_RPC_TIMEOUT_MS);
    });

    return Promise.race([
      this.hostBridge.call(method, params, { timeoutMs: STATS_RPC_TIMEOUT_MS, signal: controller.signal }),
      timeoutPromise,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
