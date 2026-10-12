import { createLogger } from "./logger";

const log = createLogger("RequestSecurity");

export function isLocalhostRequest(
  request: Request,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // Restrict configuration and diagnostics management APIs to Windows host local surface
  if (platform !== "win32") {
    return false;
  }

  try {
    // 1. Host header check to prevent DNS rebinding attacks
    const hostHeader = request.headers.get("host")?.trim().toLowerCase();
    if (hostHeader) {
      const hostName = hostHeader.split(":")[0]?.replace(/^\[|\]$/g, "") ?? "";
      if (hostName !== "localhost" && hostName !== "127.0.0.1" && hostName !== "::1") {
        log.warn(`Rejecting request with non-loopback Host header: ${hostHeader}`);
        return false;
      }
    }

    // 2. Requested URL Host check
    const url = new URL(request.url);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") {
      log.warn(`Rejecting request with non-loopback URL hostname: ${hostname}`);
      return false;
    }

    // 3. Sec-Fetch-Site header check to reject cross-site requests
    const secFetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
    if (secFetchSite === "cross-site") {
      log.warn(`Rejecting cross-site request (Sec-Fetch-Site: ${secFetchSite})`);
      return false;
    }

    // 4. Origin header check (for CSRF protection)
    const origin = request.headers.get("origin")?.trim().toLowerCase();
    if (origin) {
      const isLoopbackOrigin =
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1") ||
        origin.startsWith("http://[::1]") ||
        origin.startsWith("app://localhost") ||
        origin.startsWith("tauri://localhost");
      if (!isLoopbackOrigin) {
        log.warn(`Rejecting request with non-loopback Origin: ${origin}`);
        return false;
      }
    }

    // 5. Referer header check
    const referer = request.headers.get("referer")?.trim().toLowerCase();
    if (referer) {
      const isLoopbackReferer =
        referer.startsWith("http://localhost") ||
        referer.startsWith("http://127.0.0.1") ||
        referer.startsWith("http://[::1]") ||
        referer.startsWith("app://localhost") ||
        referer.startsWith("tauri://localhost");
      if (!isLoopbackReferer) {
        log.warn(`Rejecting request with non-loopback Referer: ${referer}`);
        return false;
      }
    }

    return true;
  } catch (error) {
    log.warn(`Error verifying localhost request: ${error}`);
    return false;
  }
}
