import { test, expect } from "bun:test";
import {
  sidecarBindFailure,
  HTTP_ADDRESS_IN_USE_EXIT_CODE,
  STALE_RFCOMM_RECOVERY_EXIT_CODE,
} from "./sidecar-startup";

test("classifies only actual address-in-use errors from HTTP listen", () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
  });
  try {
    try {
      const replacement = Bun.serve({
        hostname: "127.0.0.1",
        port: server.port,
        fetch: () => new Response("ok"),
      });
      replacement.stop(true);
      throw new Error("Expected port collision");
    } catch (error) {
      expect(sidecarBindFailure(error)).toBe(
        "NOCTURNE_STARTUP_ERROR=HTTP_ADDRESS_IN_USE\n",
      );
    }
    for (const error of [
      { code: "EACCES" },
      new Error("EADDRINUSE"),
      { message: "address in use" },
      null,
    ])
      expect(sidecarBindFailure(error)).toBeNull();
  } finally {
    server.stop(true);
  }
});

test("HTTP bind collisions cannot reuse the intentional Bluetooth recovery exit code", () => {
  expect(STALE_RFCOMM_RECOVERY_EXIT_CODE).toBe(75);
  expect(HTTP_ADDRESS_IN_USE_EXIT_CODE).toBe(76);
  expect(HTTP_ADDRESS_IN_USE_EXIT_CODE).not.toBe(
    STALE_RFCOMM_RECOVERY_EXIT_CODE,
  );
});
