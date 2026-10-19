# Sprint 13 — Windows Session, Lock, Sleep, and Wake Awareness

Sprint 13 introduces focused, event-driven observation of Windows session, display-power, and system suspend/resume state in the Connector host, exposing a typed snapshot model to connected Car Things without modifying Bluetooth connectivity, route selection, or Spotify playback.

## 1. Bounded Session State Schema

The Windows session state is represented by a typed, bounded model:

```typescript
interface WindowsSessionState {
  session: "locked" | "unlocked" | "unknown";
  activeSession: "active" | "inactive" | "unknown";
  systemPower: "awake" | "suspending" | "resuming" | "unknown";
  displayPower: "on" | "off" | "dimmed" | "unknown";
  observedAt: number;
  sequence: number;
  observerId: string;
  sessionMonitoring: boolean;
  displayPowerMonitoring: boolean;
  systemPowerMonitoring: boolean;
}
```

### Field Meanings

- **`session`**: Windows desktop session lock state (`locked`, `unlocked`, or `unknown`).
- **`activeSession`**: Whether the session is active/connected (`active`, `inactive`, or `unknown`).
- **`systemPower`**: System suspend/resume power status (`awake`, `suspending`, `resuming`, or `unknown`).
- **`displayPower`**: Console display power state (`on`, `off`, `dimmed`, or `unknown`).
- **`observedAt`**: Timestamp in Unix epoch milliseconds when the state change occurred.
- **`sequence`**: Monotonically increasing within one observer instance. Increments only when effective state or monitoring availability changes.
- **`observerId`**: Random UUID generated once per native observer lifetime. A host restart creates a new ID and may reset sequence to zero. It contains no OS identity.
- **`sessionMonitoring`**, **`displayPowerMonitoring`**, **`systemPowerMonitoring`**: Whether WTS notifications, display-power notifications, and the power-message window respectively are available. All default to false; unavailable sources have unknown state fields. A registered source can still report unknown when its query fails.

## 2. Native Windows Signal Sources

The Rust native host (`windows/src-tauri/src/native/session.rs`) observes Win32 system events via a background message window thread:

- **Session Events**: `WTSRegisterSessionNotification` with `NOTIFY_FOR_THIS_SESSION`. Listens for `WM_WTSSESSION_CHANGE` messages:
  - `WTS_SESSION_LOCK` -> `session: "locked"`
  - `WTS_SESSION_UNLOCK` -> `session: "unlocked"`
  - `WTS_CONSOLE_CONNECT`, `WTS_REMOTE_CONNECT`, `WTS_SESSION_LOGON` -> `activeSession: "active"`
  - `WTS_CONSOLE_DISCONNECT`, `WTS_REMOTE_DISCONNECT`, `WTS_SESSION_LOGOFF` -> `activeSession: "inactive"`
- **Lock decoding**: `SessionFlags` is decoded by exact value: `0` is locked, `1` is unlocked, `0xFFFFFFFF` and every other value are unknown. Only `WTSINFOEXW.Level == 1` is read; truncated responses are unknown. See [Microsoft WTS session values](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w).
- **Initial & Snapshot Queries**: `WTSQuerySessionInformationW` querying `WTSConnectState` and `WTSSessionInfoEx` (`WTSINFOEXW`).
- **System Power Events**: `WM_POWERBROADCAST`:
  - `PBT_APMSUSPEND` -> `systemPower: "suspending"`
  - `PBT_APMRESUMESUSPEND` / `PBT_APMRESUMEAUTOMATIC` -> `systemPower: "resuming"`, triggers revalidation, then settles to `systemPower: "awake"`.
- **Display Power Events**: `RegisterPowerSettingNotification` registered for `GUID_CONSOLE_DISPLAY_STATE` (`6FE69556-9F77-4D61-91A3-8701028D510E`) receiving `WM_POWERBROADCAST` with `PBT_POWERSETTINGCHANGE`:
  - `0` -> `displayPower: "off"`
  - `1` -> `displayPower: "on"`
  - `2` -> `displayPower: "dimmed"`

## 3. Event and RPC Contracts

### Native Host Bridge Contracts
- **RPC**: `windows.session.get_status` returns the current authoritative native `WindowsSessionState` snapshot.
- **Event**: `windows.session.changed` emitted over named pipe whenever effective state sequence increments.

### Car Thing Facing Contracts
- **RPC**: `windows.session.get_status` returns `{ status: "ok", sessionState: WindowsSessionState }` (or `{ status: "unsupported" }` on non-Windows).
- **Event**: `windows.session.changed` broadcast to connected Car Things and local WebSocket clients.
- **App Ready Payload**: `app.ready` includes `windowsSession: WindowsSessionState` on Windows platforms.

## 4. Unknown-State Behavior & Fallback Guarantees

- WTS and display registration results are checked independently and logged on failure. A failed WTS registration clears session and active-session state; a failed display registration clears display state. Window creation or message-loop failure clears all monitoring availability and state. None of these failures abort other native services.
- Failed WTS revalidation clears both session fields, including on resume. Resume invalidates cached display power until the next display notification; no current-display query is invented.
- A failed native snapshot RPC clears Bun's exposed state and monitoring availability. Ordering metadata is retained separately so delayed events cannot restore stale authority; the same current snapshot can restore availability after reconnect. A failed older RPC does not erase a newer event.
- `awake`, `unlocked`, or `active` are never invented when a query fails.
- On startup, resume, or sidecar reconnection, state is explicitly revalidated rather than assuming stale cached values remain accurate.

## 5. Reconnection, Sequence Ordering, and Freshness

- The Rust native host maintains the authoritative in-memory snapshot.
- Duplicate or noisy OS notifications produce no sequence increments and no duplicate events.
- Ordering uses `(observerId, sequence)`. Only an authoritative status RPC from the live native pipe can establish a different observer ID. An event with an unfamiliar ID triggers a single-flight status refresh rather than changing authority itself. The 16 most recently retired IDs are kept in insertion order and their events and snapshots are rejected, regardless of sequence or wall clock. The oldest ID is evicted on the next retirement, bounding history to 16 strings (each at most 64 characters), plus the current instance. An event from an evicted instance is treated as unfamiliar: its payload is never adopted; it can only trigger a live status RPC. Only that authoritative response may establish an ID outside the retained history. Delayed events cannot restore an old instance even after eviction.
- Within an instance, lower sequences and conflicting equal sequences are ignored. Exact duplicates produce no sidecar event. Consumers comparing sequences must scope them to `observerId`; sequence alone is not globally monotonic.
- Missing observer IDs are treated as a legacy instance (`""`) for compatibility. New hosts always supply the UUID. Missing monitoring fields default to false.
- On Bun sidecar restart or Car Thing reconnect, the latest authoritative snapshot is retrieved directly via RPC (`windows.session.get_status`).

## 6. Independence from Bluetooth Connectivity & Media Controls

**Windows session lock or display off does NOT mean Windows disconnected.**

The following remain strictly independent:
- Session lock/unlock state
- Display power state
- System suspend/resume state
- Native host availability
- Bluetooth / RFCOMM routes and pairing
- Route selection and Windows-to-Mac fallback logic

Bluetooth is NOT disconnected when Windows locks or turns off its screen. Media playback, volume controls, Spotify commands, and fallback logic operate without alteration. During physical system sleep, RFCOMM disconnects naturally and recovers automatically upon system resume.

## 7. Privacy Boundaries

The session observer collects only low-level OS power and session lock events.

**Explicitly Excluded**:
- Usernames or User Security Identifiers (SIDs)
- Desktop titles or window titles
- Application names or process IDs
- Typed text or keystrokes
- Clipboard contents or screen metadata

## 8. Physical Acceptance Test Matrix

The following matrix distinguishes behavior verified by automated unit/integration tests from tests requiring a physical Windows PC:

| Test Scenario | Verification Method | Status / Expected Outcome |
| :--- | :--- | :--- |
| Initial state unknown on query failure | Automated Test | Verified |
| Lock (`Win + L`) -> Unlock | Automated Test / Manual PC | Native observer emits `locked` then `unlocked` |
| Fast User Switching / Session Switch | Automated Test / Manual PC | Session reports `inactive` then `active` on return |
| Display Timeout (display off, system awake) | Automated Test / Manual PC | `displayPower: "off"`, `session: "unlocked"` |
| System Sleep & Wake | Automated Test / Manual PC | `systemPower`: `awake` -> `suspending` -> `resuming` -> `awake` |
| Duplicate / Noisy Event Coalescing | Automated Test | Duplicate events produce no event emissions |
| Rapid Conflicting Notifications | Automated Test | Settles stably to latest state |
| Car Thing Reconnect after Resume | Automated Test / Manual PC | Reconnecting Car Thing receives current snapshot |
| Sidecar Restart while Windows Locked | Automated Test / Manual PC | Sidecar retrieves latest `locked` snapshot |
| Windows -> Mac Fallback Unchanged | Automated Test | Unaffected by Windows session events |
| Non-Windows Platform Safety | Automated Test | Returns `status: "unsupported"` on macOS/Linux |

## 9. Outstanding G0 Dependencies

G0 physical hardware reliability acceptance is independent of Sprint 13. While Sprint 13 provides accurate OS status and events over the native bridge, physical Bluetooth recovery and hardware display behavior require manual testing on physical Car Thing and Windows hardware.

## 10. Re-review Validation and Physical Steps

Automated regression coverage includes exact lock values and unsupported levels, a locked reconnect query, independent registration failures, failed resume queries, distinct native observer IDs, lower-sequence native restarts, delayed retired-instance events, duplicate snapshots, sidecar restart/reconnection, and an older failed RPC racing a newer event. The session reducer tests also run on non-Windows Cargo hosts; Windows CI compiles and tests the actual Win32 observer.

Physical Windows validation remains required (automated tests do not claim hardware acceptance):

1. Install the Windows CI installer. With an RFCOMM Car Thing route active, use Win+L, reconnect the Car Thing while still locked, and inspect `windows.session.get_status`: expect `session: "locked"` and a stable observer ID. Unlock and expect a higher sequence with `unlocked`.
2. Restart only the Bun sidecar while locked. Expect the same native observer ID and current locked snapshot. Then restart the full native host while Bun remains connected in a development harness; expect a new ID with a potentially lower sequence accepted after the status RPC. Inject a queued event with the old ID and verify it is ignored.
3. Test display timeout and sleep/resume. Resume must not reuse the old display value before a fresh notification. If WTS query failure is injected during resume, both session fields must become unknown.
4. In a debug build, force WTS registration failure and display registration failure separately. Verify the matching monitoring flag is false, affected state is unknown, and a diagnostic is logged. Force observer window/message-loop failure and confirm all monitoring becomes unavailable. Restore monitoring by restarting the host.
5. During each failure and lock transition, exercise Spotify, volume, media controls, Bluetooth pairing/reconnect, and Windows-to-Mac fallback. Session observation must not alter route ownership or fallback decisions. No device backlight behavior is implemented in this sprint.
