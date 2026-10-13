import { describe, expect, it } from "bun:test";
import { isLocalhostRequest } from "./request-security";

const local = "http://127.0.0.1:52225";
function allowed(headers: HeadersInit, target = local, listening = local) {
  return isLocalhostRequest(new Request(`${target}/api/config/apps`, { headers }), "win32", listening);
}

describe("exact Windows management origins", () => {
  it("accepts the dynamically assigned same origin", () => {
    expect(allowed({ origin: local, host: "127.0.0.1:52225" })).toBe(true);
    expect(allowed({ referer: `${local}/settings` })).toBe(true);
    expect(allowed({ "sec-fetch-site": "same-origin" })).toBe(true);
  });

  it("rejects other ports, schemes, loopback aliases and Tauri origins", () => {
    for (const origin of ["http://127.0.0.1:52226", "https://127.0.0.1:52225", "http://localhost:52225", "tauri://localhost", "app://localhost", "https://tauri.localhost", "null"]) {
      expect(allowed({ origin })).toBe(false);
      expect(allowed({ referer: `${origin}/settings` })).toBe(false);
    }
    expect(allowed({ origin: local, host: "127.0.0.1:52226" })).toBe(false);
    expect(allowed({ origin: local }, "http://127.0.0.1:52226")).toBe(false);
  });

  it("rejects deceptive hostnames and malformed origins", () => {
    for (const hostname of ["localhost.evil.test", "127.0.0.1.evil.test", "localhost-attacker.test"]) {
      expect(allowed({ origin: `http://${hostname}:52225` })).toBe(false);
      expect(allowed({ origin: local, host: `${hostname}:52225` })).toBe(false);
      expect(allowed({ origin: `http://${hostname}:52225` }, `http://${hostname}:52225`, `http://${hostname}:52225`)).toBe(false);
    }
    for (const origin of [`${local}/path`, `http://user@127.0.0.1:52225`, "invalid"]) {
      expect(allowed({ origin })).toBe(false);
    }
  });

  it("normalizes IPv6 loopback literals without equating different origins", () => {
    const ipv6 = "http://[::1]:52225";
    expect(allowed({ origin: "http://[0:0:0:0:0:0:0:1]:52225", host: "[::1]:52225" }, ipv6, ipv6)).toBe(true);
    expect(allowed({ origin: "http://[::1]:52226" }, ipv6, ipv6)).toBe(false);
    expect(allowed({ origin: ipv6 })).toBe(false);
  });

  it("fails closed without browser metadata or a known listening origin", () => {
    expect(allowed({})).toBe(false);
    expect(allowed({ "sec-fetch-site": "none" })).toBe(false);
    expect(allowed({ origin: local, "sec-fetch-site": "same-site" })).toBe(false);
    expect(allowed({ origin: local, referer: "http://127.0.0.1:52226/" })).toBe(false);
    expect(isLocalhostRequest(new Request(local, { headers: { origin: local } }), "win32")).toBe(false);
    expect(isLocalhostRequest(new Request(local, { headers: { origin: local } }), "linux", local)).toBe(false);
  });
});
