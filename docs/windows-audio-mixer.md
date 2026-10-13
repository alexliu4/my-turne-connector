# Windows Per-Application Audio Volume Mixer (Sprint 11)

## RPC Contract Documentation

### 1. `audio.sessions.list` (or `media.get_audio_sessions`)

Enumerates active Core Audio sessions on the specified render device (or across all active render endpoints if `deviceId` is omitted).

#### Request Params
- `deviceId` (string, optional): Opaque device GUID ID string returned by `audio.outputs.list`.

#### Response Payload (`AudioSessionsResponse`)
```json
{
  "status": "ok",
  "sessions": [
    {
      "id": "a1b2c3d4e5f60718",
      "endpointId": "{0.0.0.00000000}.{device-guid-1}",
      "appName": "Spotify",
      "processId": 1234,
      "volumePercent": 80,
      "muted": false
    },
    {
      "id": "b2c3d4e5f6071829",
      "endpointId": "{0.0.0.00000000}.{device-guid-1}",
      "appName": "Discord",
      "processId": 5678,
      "volumePercent": 60,
      "muted": true
    }
  ]
}
```

---

### 2. `audio.sessions.set_volume` (or `media.set_audio_session_volume`)

Sets the master volume scalar for a specific audio session by exact session ID.

#### Request Params
- `sessionId` (string, required): Opaque 64-bit session ID returned by `audio.sessions.list` (e.g. `"a1b2c3d4e5f60718"`).
- `volumePercent` / `level` (number, required): Integer percentage from 0 to 100.
- `deviceId` (string, optional): Target device GUID string associated with the session.

#### Response Payload (`SetAudioSessionVolumeResponse`)
```json
{
  "status": "ok",
  "confirmedVolumePercent": 80
}
```

When rapid dial turns send multiple volume requests while a native call is in-flight, intermediate superseded requests resolve immediately with:
```json
{
  "status": "superseded"
}
```

---

### 3. `audio.sessions.set_mute` (or `media.set_audio_session_mute`)

Sets the mute status for a specific audio session by exact session ID.

#### Request Params
- `sessionId` (string, required): Opaque session ID returned by `audio.sessions.list`.
- `muted` (boolean, required): `true` to mute, `false` to unmute.
- `deviceId` (string, optional): Target device GUID string associated with the session.

#### Response Payload (`SetAudioSessionMuteResponse`)
```json
{
  "status": "ok",
  "confirmedMuted": true
}
```

#### Status Values
- `"ok"`: Successfully queried, modified, and verified audio session volume/mute state.
- `"superseded"`: Intermediate volume update superseded by a newer dial update during rapid dial movement.
- `"invalid_session"`: Session ID is empty, missing, or inactive/disappeared.
- `"invalid_volume"`: Volume percentage is out of range (not 0-100) or non-finite.
- `"failed"`: Native mutation or read-back confirmation failed.
- `"unsupported"`: Core Audio session enumeration unavailable or host bridge error.

---

## Session Identity and Lifetime

- **Opaque Session IDs:** Session IDs are 16-character hexadecimal hashes (`{:016x}`) computed deterministically from the endpoint ID and Windows Core Audio `IAudioSessionControl2::GetSessionInstanceIdentifier()`.
- **Exact Session Matching:** Prefix, process ID, or fallback matching is strictly prohibited. Every mutation targets exactly one session instance.
- **Endpoint Resolution:** Native volume and mute functions resolve target sessions across active render endpoints even when `deviceId` is omitted.
- **Lifetime & Invalidation:** Session IDs are session-scoped and endpoint-specific. When an application exits, restarts, or closes its audio stream, its old session ID is invalidated and will return `status: "invalid_session"`.

---

## Rapid Dial Movement & Coalescing Strategy

- When rapid volume adjustments target the same session (e.g., dial turns on the Car Thing), `SystemMediaService` maintains a strictly bounded queue per session ID:
  - At most **one native request in-flight**.
  - At most **one pending target and resolver**.
- When a new dial request arrives while a target is already pending, the old pending promise resolves immediately with `status: "superseded"` without executing native calls, and the new target replaces it.
- Once the in-flight request finishes, the latest pending target is dispatched to the native host.
- Explicit `set_mute` operations bypass the volume queue and execute independently.

---

## Native Windows Implementation Details

- **Session Enumeration:** Obtains `IAudioSessionManager2` from render `IMMDevice` and calls `GetSessionEnumerator()` to retrieve `IAudioSessionEnumerator`.
- **Session Metadata:** Uses `IAudioSessionControl2` to query process ID (`GetProcessId`), display name (`GetDisplayName`), executable name (`GetSessionIdentifier`), and unique session instance ID (`GetSessionInstanceIdentifier`).
- **Volume & Mute Controls:** Casts `IAudioSessionControl` to `ISimpleAudioVolume` to call `SetMasterVolume` / `GetMasterVolume` and `SetMute` / `GetMute` for explicit read-back confirmation.

---

## Manual Verification Procedure (Real Windows PC)

1. **Prerequisites:** Windows 10/11 PC with active audio playing apps (e.g., Spotify desktop, Discord, browser with playing video/audio).
2. **Session Discovery:**
   - Invoke `audio.sessions.list` over RPC.
   - Confirm active apps appear with unique 16-character opaque IDs, associated `endpointId`, process IDs, app names, current volume percentages, and mute states.
3. **Per-App Volume Control & Read-Back Verification:**
   - Send `audio.sessions.set_volume` with `sessionId` set to Spotify's opaque ID and `volumePercent` set to 50.
   - Confirm response returns `{ "status": "ok", "confirmedVolumePercent": 50 }`.
   - Confirm in Windows Volume Mixer that Spotify's app volume changes to 50% without affecting system master volume or other apps.
4. **Rapid Dial Adjustment Test:**
   - Rapidly send multiple volume updates (e.g. 10%, 20%, 30%, 40%, 50%) for a single session ID.
   - Confirm the first in-flight request returns `status: "ok"`, intermediate requests return `status: "superseded"`, and the final target request returns `status: "ok"`, keeping total native calls bounded to 2.
5. **Closed / Missing Application Handling:**
   - Close an application (e.g., Discord).
   - Send `audio.sessions.set_volume` targeting the old session ID.
   - Confirm response returns `{ "status": "invalid_session" }` without modifying other apps or system volume.
