import { createLogger } from "../utils/logger";
import type { HostBridgeClient } from "../platform/host-bridge";
import {
  type MacroDefinition,
  type MacroPreferenceStore,
  FileSystemMacroPreferenceStore,
} from "./macro-config";
import {
  type AppLaunchPreferenceStore,
  FileSystemAppLaunchPreferenceStore,
} from "./app-launch-config";

const log = createLogger("MacroService");
const MACRO_RPC_TIMEOUT_MS = 2_000;

export interface MacroStatus {
  status: string;
  available: boolean;
  macros?: MacroDefinition[];
  message?: string;
}

export interface MacroResult {
  status: string;
  action?: string;
  error?: string;
  [key: string]: unknown;
}

/**
 * MacroService handles execution of constrained macro actions through the native host bridge.
 * Execution is restricted strictly to explicitly configured macro IDs stored in user configuration.
 */
export class MacroService {
  private isHostVerified = false;

  constructor(
    private readonly hostBridge: HostBridgeClient,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly preferenceStore: MacroPreferenceStore = new FileSystemMacroPreferenceStore(),
    private readonly appLaunchPreferenceStore: AppLaunchPreferenceStore = new FileSystemAppLaunchPreferenceStore(),
  ) {}

  get isAvailable(): boolean {
    const config = this.preferenceStore.load();
    const hasConfiguredMacros = Object.values(config.macros).some((m) => m.enabled !== false);
    return this.isHostVerified && hasConfiguredMacros;
  }

  async start(): Promise<void> {
    if (this.platform !== "win32") return;
    try {
      await this.getStatus();
    } catch (error) {
      log.warn(`Background macro probe failed: ${errorMessage(error)}`);
    }
  }

  async getStatus(): Promise<MacroStatus> {
    try {
      const response = await this.callHostWithTimeout("macros.get_status", {});
      const rec = asRecord(response);
      const available = rec?.status === "ok" && rec?.available === true;
      this.isHostVerified = available;

      const config = this.preferenceStore.load();
      const configuredMacros = Object.values(config.macros).filter((m) => m.enabled !== false);

      if (!rec || rec.status !== "ok") {
        return {
          status: typeof rec?.status === "string" ? rec.status : "unsupported",
          available: false,
          macros: [],
          message: typeof rec?.message === "string" ? rec.message : undefined,
        };
      }

      return {
        status: "ok",
        available: available && configuredMacros.length > 0,
        macros: configuredMacros,
      };
    } catch (error) {
      log.warn(`macros.get_status call failed: ${errorMessage(error)}`);
      this.isHostVerified = false;
      return {
        status: "unsupported",
        available: false,
        macros: [],
        message: errorMessage(error),
      };
    }
  }

  async executeMacro(params: unknown): Promise<MacroResult> {
    const recParams = asRecord(params);
    const macroId =
      typeof recParams?.id === "string" && recParams.id
        ? recParams.id
        : typeof recParams?.macro_id === "string" && recParams.macro_id
        ? recParams.macro_id
        : typeof recParams?.macroId === "string" && recParams.macroId
        ? recParams.macroId
        : null;

    if (!macroId) {
      log.warn("Rejecting macro request: Missing macro ID");
      return {
        status: "invalid_action",
        error: "Macro request must specify a valid configured macro ID",
      };
    }

    const config = this.preferenceStore.load();
    const macroDef = config.macros[macroId];

    if (!macroDef || macroDef.enabled === false) {
      log.warn(`Rejecting unconfigured or disabled macro execution request: ${macroId}`);
      return {
        status: "invalid_action",
        error: `Macro '${macroId}' is not configured or enabled`,
      };
    }

    let payload: Record<string, unknown>;

    if (macroDef.action.type === "app") {
      const appConfig = this.appLaunchPreferenceStore.load();
      const appDef = appConfig.apps[macroDef.action.appId];

      if (!appDef || appDef.enabled === false) {
        log.warn(`Rejecting app macro ${macroId}: target app ${macroDef.action.appId} is unconfigured or disabled`);
        return {
          status: "invalid_action",
          error: `App '${macroDef.action.appId}' configured in macro '${macroId}' is not configured or enabled`,
        };
      }

      payload = {
        id: macroDef.id,
        type: "app",
        app: appDef.id,
        appId: appDef.id,
        target: appDef.target,
        fallbacks: appDef.fallbacks ?? [],
      };
    } else {
      payload = {
        id: macroDef.id,
        ...macroDef.action,
      };
    }

    try {
      const response = await this.callHostWithTimeout("macros.execute", payload);
      const rec = asRecord(response);

      if (!rec) {
        return {
          status: "unsupported",
          error: "No response from host",
        };
      }

      return {
        status: typeof rec.status === "string" ? rec.status : "unsupported",
        action: typeof rec.action === "string" ? rec.action : macroDef.action.type,
        error: typeof rec.error === "string" ? rec.error : undefined,
        ...rec,
      };
    } catch (error) {
      log.warn(`macros.execute call failed for ${macroId}: ${errorMessage(error)}`);
      return {
        status: "error",
        error: errorMessage(error),
      };
    }
  }

  private callHostWithTimeout(method: string, params: unknown): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Macro RPC ${method} timed out after ${MACRO_RPC_TIMEOUT_MS}ms`));
      }, MACRO_RPC_TIMEOUT_MS);
    });

    return Promise.race([
      this.hostBridge.call(method, params, { timeoutMs: MACRO_RPC_TIMEOUT_MS, signal: controller.signal }),
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
