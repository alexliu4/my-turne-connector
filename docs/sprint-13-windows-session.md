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
}
```

### Field Meanings

- **`session`**: Windows desktop session lock state (`locked`, `unlocked`, or `unknown`).
- **`activeSession`**: Whether the session is active/connected (`active`, `inactive`, or `unknown`).
- **`systemPower`**: System suspend/resume power status (`awake`, `suspending`, `resuming`, or `unknown`).
- **`displayPower`**: Console display power state (`on`, `off`, `dimmed`, or `unknown`).
- **`observedAt`**: Timestamp in Unix epoch milliseconds when the state change occurred.
- **`sequence`**: Monotonically increasing sequence integer. Increments **only** when effective state changes.

## 2. Native Windows Signal Sources

The Rust native host (`windows/src-tauri/src/native/session.rs`) observes Win32 system events via a background message window thread:

- **Session Events**: `WTSRegisterSessionNotification` with `NOTIFY_FOR_THIS_SESSION`. Listens for `WM_WTSSESSION_CHANGE` messages:
  - `WTS_SESSION_LOCK` -> `session: "locked"`
  - `WTS_SESSION_UNLOCK` -> `session: "unlocked"`
  - `WTS_CONSOLE_CONNECT`, `WTS_REMOTE_CONNECT`, `WTS_SESSION_LOGON` -> `activeSession: "active"`
  - `WTS_CONSOLE_DISCONNECT`, `WTS_REMOTE_DISCONNECT`, `WTS_SESSION_LOGOFF` -> `activeSession: "inactive"`
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

- If OS queries, listener registrations, or session state determination fails, state fields evaluate explicitly to `"unknown"`.
- `awake`, `unlocked`, or `active` are never invented when a query fails.
- On startup, resume, or sidecar reconnection, state is explicitly revalidated rather than assuming stale cached values remain accurate.

## 5. Reconnection, Sequence Ordering, and Freshness

- The Rust native host maintains the authoritative in-memory snapshot.
- Duplicate or noisy OS notifications produce no sequence increments and no duplicate events.
- Sequence counter checks ensure delayed or out-of-order native events cannot overwrite newer snapshot state in the Bun sidecar or Car Thing.
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
