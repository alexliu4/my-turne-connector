import { Elysia } from "elysia";
import { DiagnosticsService } from "../services/diagnostics-service";
import { createLogger } from "../utils/logger";
import { isLocalhostRequest } from "../utils/request-security";

const log = createLogger("DiagnosticsRoutes");

export function createDiagnosticsRoutes(
  diagnosticsService: DiagnosticsService,
  platform: NodeJS.Platform = process.platform,
  listeningOrigin?: string,
) {
  return new Elysia({ prefix: "/api/diagnostics" })
    .onBeforeHandle(({ request, set, server }) => {
      if (!isLocalhostRequest(request, platform, server?.url.origin ?? listeningOrigin)) {
        log.warn(`Rejecting non-localhost diagnostics request from ${request.headers.get("host") || "unknown"}`);
        set.status = 403;
        return { error: "Diagnostics API is localhost-only" };
      }
    })
    .get("/status", async ({ set }) => {
      set.headers["cache-control"] = "no-store";
      const report = await diagnosticsService.getDiagnostics();
      return { status: "ok", diagnostics: report };
    })
    .get("/export", async ({ set }) => {
      try {
        const redacted = await diagnosticsService.getRedactedExport();
        const jsonString = JSON.stringify(redacted, null, 2);
        if (Buffer.byteLength(jsonString) > 256 * 1024) throw new Error("Diagnostics export exceeds limit");
        set.headers["cache-control"] = "no-store";

        set.headers["content-type"] = "application/json";
        set.headers["content-disposition"] = `attachment; filename="nocturne-connector-diagnostics-${Date.now()}.json"`;
        return jsonString;
      } catch (err: any) {
        log.error(`Failed to generate redacted diagnostics export: ${err?.message || err}`);
        set.status = 500;
        return { error: "Failed to generate diagnostics export" };
      }
    });
}
