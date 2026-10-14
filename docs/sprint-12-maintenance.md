# Sprint 12 maintenance contract

The existing Windows-only, same-origin localhost REST surface is extended; no
Car Thing RPC, transport, capability, or Pi behavior changes are required.

- `GET /api/diagnostics/status` returns the existing `{status: "ok", diagnostics}`.
  New `health` fields distinguish sidecar readiness, native pipe connectivity,
  Bluetooth route state, and feature probe completion. Probe states are `complete`,
  `timeout`, or `error`; cached feature availability is reported separately.
- `GET /api/diagnostics/export` downloads a redacted JSON attachment. It uses the
  same bounded report, never reads arbitrary files, environment variables, session
  files, macro definitions, native logs, or raw log payloads. Versions, architecture,
  Bun runtime, bounded counts, and health states are included.
- Both requests share one feature refresh, with a three-second deadline. Timeout
  returns cached status and an explicit timeout state. No background diagnostic
  polling or native recovery action is introduced.
- Native pipe connectivity is an observation, not proof that each feature works.
  A responding HTTP sidecar is ready; a dead sidecar cannot serve its own health.
  Native host lifecycle logs supply evidence for that case.

Windows logs retain five files per writer (current plus four archives), each at
most 5 MiB. Connector lines are limited to 8 KiB including newline; native lines
have the same limit. `connector.log` and `host.log` together use at most 50 MiB
of payload, excluding filesystem allocation. Recent warnings/errors retain at
most 50 bounded lines in memory. Known credential assignments, auth headers,
and user paths are redacted before console, file, or memory storage. Support
exports intentionally contain severity counts instead of free-form log text.

## Validation and review

G0 physical integration, Windows CI, and installer acceptance remain required.
Local tests on macOS cannot establish Windows Bluetooth or Smart App Control
behavior. No automatic updater is part of this sprint. No device-repo follow-up
is required. See `windows-recovery.md` for reproducible manual acceptance steps.

Oversized log files left by older versions are discarded on the first new log
write so the documented retention ceiling also applies after upgrading.

Local evidence (macOS): `just test` passed (321 Bun tests, plus image service
and U-Boot helper checks); `bun run lint` and `bun run build` passed;
`cargo check --locked` and `cargo test --release --locked` passed (10 host tests).
Windows-specific APIs are gated out on macOS; Windows CI and the installer build
are separate required checks. Log retention and export bounds are verified in
unit tests; physical fallback/recovery and reinstall remain untested.
