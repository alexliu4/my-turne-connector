import { Elysia } from "elysia";
import {
  DiagnosticsService,
  supportReport,
  serializeDiagnosticsExport,
} from "../services/diagnostics-service";
import { createLogger } from "../utils/logger";
import { isLocalhostRequest } from "../utils/request-security";

const log = createLogger("DiagnosticsRoutes");

export function createDiagnosticsRoutes(
  diagnosticsService: Pick<
    DiagnosticsService,
    "getDiagnostics" | "getRedactedExport"
  >,
  platform: NodeJS.Platform = process.platform,
  listeningOrigin?: string,
) {
  return new Elysia({ prefix: "/api/diagnostics" })
    .onBeforeHandle(({ request, set, server }) => {
      if (
        !isLocalhostRequest(
          request,
          platform,
          server?.url.origin ?? listeningOrigin,
        )
      ) {
        log.warn(
          `Rejecting non-localhost diagnostics request from ${request.headers.get("host") || "unknown"}`,
        );
        set.status = 403;
        return { error: "Diagnostics API is localhost-only" };
      }
    })
    .get("/status", async ({ set }) => {
      set.headers["cache-control"] = "no-store";
      const report = await diagnosticsService.getDiagnostics();
      return { status: "ok", diagnostics: supportReport(report) };
    })
    .get("/export", async ({ set }) => {
      try {
        const redacted = await diagnosticsService.getRedactedExport();
        const jsonString = serializeDiagnosticsExport(redacted);
        set.headers["cache-control"] = "no-store";

        set.headers["content-type"] = "application/json";
        set.headers["content-disposition"] =
          `attachment; filename="nocturne-connector-diagnostics-${Date.now()}.json"`;
        return jsonString;
      } catch (err: unknown) {
        log.error(
          "Failed to generate redacted diagnostics export",
          err instanceof Error ? err.name : "unknown error",
        );
        set.status = 500;
        return { error: "Failed to generate diagnostics export" };
      }
    });
}
