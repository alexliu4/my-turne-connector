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
    const hostHeader = request.headers.get("host")?.trim();
    if (hostHeader) {
      try {
        const hostUrl = new URL(`http://${hostHeader}`);
        const hostname = hostUrl.hostname.toLowerCase();
        if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") {
          log.warn(`Rejecting request with non-loopback Host header: ${hostHeader}`);
          return false;
        }
      } catch {
        log.warn(`Rejecting request with malformed Host header: ${hostHeader}`);
        return false;
      }
    }

    // 2. Requested URL Host check
    const requestUrl = new URL(request.url);
    const requestHostname = requestUrl.hostname.toLowerCase();
    if (
      requestHostname !== "localhost" &&
      requestHostname !== "127.0.0.1" &&
      requestHostname !== "::1"
    ) {
      log.warn(`Rejecting request with non-loopback URL hostname: ${requestHostname}`);
      return false;
    }

    // 3. Sec-Fetch-Site header check to reject cross-site requests
    const secFetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
    if (secFetchSite === "cross-site") {
      log.warn(`Rejecting cross-site request (Sec-Fetch-Site: ${secFetchSite})`);
      return false;
    }

    // 4. Strict Origin header check using exact URL hostname matching if present
    const origin = request.headers.get("origin")?.trim();
    if (origin) {
      try {
        const originUrl = new URL(origin);
        const isAllowedScheme =
          originUrl.protocol === "http:" ||
          originUrl.protocol === "app:" ||
          originUrl.protocol === "tauri:" ||
          originUrl.protocol === "https:";
        const originHostname = originUrl.hostname.toLowerCase();
        const isLoopbackOrigin =
          originHostname === "localhost" ||
          originHostname === "127.0.0.1" ||
          originHostname === "::1";

        if (!isAllowedScheme || !isLoopbackOrigin) {
          log.warn(`Rejecting request with untrusted Origin: ${origin}`);
          return false;
        }
      } catch {
        log.warn(`Rejecting request with malformed Origin header: ${origin}`);
        return false;
      }
    }

    // 5. Strict Referer header check using exact URL hostname matching if present
    const referer = request.headers.get("referer")?.trim();
    if (referer) {
      try {
        const refererUrl = new URL(referer);
        const isAllowedScheme =
          refererUrl.protocol === "http:" ||
          refererUrl.protocol === "app:" ||
          refererUrl.protocol === "tauri:" ||
          refererUrl.protocol === "https:";
        const refererHostname = refererUrl.hostname.toLowerCase();
        const isLoopbackReferer =
          refererHostname === "localhost" ||
          refererHostname === "127.0.0.1" ||
          refererHostname === "::1";

        if (!isAllowedScheme || !isLoopbackReferer) {
          log.warn(`Rejecting request with untrusted Referer: ${referer}`);
          return false;
        }
      } catch {
        log.warn(`Rejecting request with malformed Referer header: ${referer}`);
        return false;
      }
    }

    return true;
  } catch (error) {
    log.warn(`Error verifying localhost request: ${error}`);
    return false;
  }
}
