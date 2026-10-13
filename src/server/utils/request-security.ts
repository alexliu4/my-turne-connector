// The Windows WebView loads the sidecar's HTTP origin; it does not need a
// tauri://localhost or app://localhost exception.
export function isLocalhostRequest(
  request: Request,
  platform: NodeJS.Platform = process.platform,
  listeningOrigin?: string,
): boolean {
  if (platform !== "win32" || !listeningOrigin) return false;

  try {
    const local = new URL(listeningOrigin);
    // URL.hostname retains brackets for IPv6 literals.
    const hostname = local.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      !["localhost", "127.0.0.1", "::1"].includes(hostname) ||
      !["http:", "https:"].includes(local.protocol)
    ) return false;

    const target = new URL(request.url);
    if (target.origin !== local.origin) return false;

    const host = request.headers.get("host");
    if (host && host.toLowerCase() !== local.host.toLowerCase()) return false;

    const site = request.headers.get("sec-fetch-site")?.toLowerCase();
    if (site && site !== "same-origin") return false;

    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");
    if (origin) {
      const source = new URL(origin);
      if (source.origin !== local.origin || source.href !== `${source.origin}/`) return false;
    }
    if (referer && new URL(referer).origin !== local.origin) return false;

    // Same-origin browser GETs may omit Origin and Referer (e.g. a restrictive
    // referrer policy), but still carry Fetch Metadata. Headerless/native clients
    // have no authenticated management channel and are deliberately denied.
    return Boolean(origin || referer || site === "same-origin");
  } catch {
    return false;
  }
}
