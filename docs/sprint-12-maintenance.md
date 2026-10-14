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

## Focused reliability review after 9f8dcb3

The host retains its last HTTP port only as the replacement sidecar's requested
bind port. `sidecar::ready_port` requires the current process readiness flag,
and `show_window` checks it again on the main thread rather than trusting the
scheduler's earlier observation. No new supervisor architecture was introduced.
Subprocess tests cover failed process creation, delayed readiness, exit, and
successful restart; lease tests reject stale stdout before and after replacement
readiness. Restart backoff checks shutdown at most every 100 ms.

Both diagnostics routes use a fixed support-report schema. It includes health
states, six known feature availability flags, bounded counts, numeric version
cores, architecture/runtime, and at most 32 anonymized device summaries. The
maximum nesting depth is four object levels; there are no arbitrary maps or
metadata trees. Strings are validated within 128 characters before processing.
Only two fixed severity-count strings may appear as recentLogs. No raw log text,
host source/title metadata, credential fields, pairing prompts/codes, app
definitions, or executable macro parameters are copied. Version suffixes are
omitted because peer-provided suffixes can contain arbitrary text.

Oversized optional values are dropped, and `truncated` and `devicesTruncated`
indicate reduced detail without erasing health or failing the request. The JSON
attachment retains its 256 KiB ceiling, with optional fields dropped before a
future schema expansion could exceed it. The compatibility redaction helper also
bounds depth (five), collection fanout (32), strings (128), and traversal work
(256 values), including cycles. It is not the export schema.

PR #16 was inspected at 52375529728ea02f365acaf9b1ec2bdfc1764ba5. Its file tree
is identical to main at 2b4f640b01d28cef1c188dd4357da2d22c99bf4b, both tree
13d2de60c4724309493559945f699eb26388246b. It contains no unique file changes
to preserve and can be closed as redundant after review. It was left open.

Focused-review local evidence (macOS): all 325 server/client Bun tests and five
U-Boot helper tests pass; the data-growth shell tests, Bun check/lint/frontend
build, Cargo check, and Cargo release tests pass. Cargo reports 13 passing
tests and one ignored subprocess fixture, which the lifecycle test invokes
explicitly. Windows CI and the installer workflow validate the pushed revision
separately; physical recovery acceptance remains pending.
