// Only a confirmed HTTP listen error is part of the native startup protocol.
export function sidecarBindFailure(error: unknown): string | null {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "EADDRINUSE"
  ) {
    return "NOCTURNE_STARTUP_ERROR=HTTP_ADDRESS_IN_USE\n";
  }
  return null;
}
