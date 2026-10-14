// Sidecar exit classifications. Keep Bluetooth recovery on its established code.
export const STALE_RFCOMM_RECOVERY_EXIT_CODE = 75;
export const HTTP_ADDRESS_IN_USE_EXIT_CODE = 76;

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
