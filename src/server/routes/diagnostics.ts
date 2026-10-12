import { Elysia } from "elysia";
import { DiagnosticsService } from "../services/diagnostics-service";
import { createLogger } from "../utils/logger";
import { isLocalhostRequest } from "../utils/request-security";

const log = createLogger("DiagnosticsRoutes");

export function createDiagnosticsRoutes(
  diagnosticsService: DiagnosticsService,
  platform: NodeJS.Platform = process.platform,
) {
  return new Elysia({ prefix: "/api/diagnostics" })
    .onBeforeHandle(({ request, set }) => {
      if (!isLocalhostRequest(request, platform)) {
        log.warn(`Rejecting non-localhost diagnostics request from ${request.headers.get("host") || "unknown"}`);
        set.status = 403;
        return { error: "Diagnostics API is localhost-only" };
      }
    })
    .get("/status", async () => {
      const report = await diagnosticsService.getDiagnostics();
      return { status: "ok", diagnostics: report };
    })
    .get("/export", async ({ set }) => {
      try {
        const redacted = await diagnosticsService.getRedactedExport();
        const jsonString = JSON.stringify(redacted, null, 2);

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
