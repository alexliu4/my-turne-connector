# Windows Per-Application Audio Volume Mixer (Sprint 11)

## RPC Contract Documentation

### 1. `audio.sessions.list` (or `media.get_audio_sessions`)

Enumerates active Core Audio sessions on the specified render device (or default device if omitted).

#### Request Params
- `deviceId` (string, optional): Opaque device GUID ID string returned by `audio.outputs.list`.

#### Response Payload (`AudioSessionsResponse`)
```json
{
  "status": "ok",
  "sessions": [
    {
      "id": "1234:Spotify",
      "appName": "Spotify",
      "processId": 1234,
      "volumePercent": 80,
      "muted": false
    },
    {
      "id": "5678:Discord",
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

Sets the master volume scalar for a specific audio session by session ID.

#### Request Params
- `sessionId` (string, required): Session ID returned by `audio.sessions.list` (e.g. `"1234:Spotify"`).
- `volumePercent` / `level` (number, required): Integer percentage from 0 to 100.

#### Response Payload (`SetAudioSessionVolumeResponse`)
```json
{
  "status": "ok",
  "confirmedVolumePercent": 80
}
```

---

### 3. `audio.sessions.set_mute` (or `media.set_audio_session_mute`)

Sets the mute status for a specific audio session by session ID.

#### Request Params
- `sessionId` (string, required): Session ID returned by `audio.sessions.list`.
- `muted` (boolean, required): `true` to mute, `false` to unmute.

#### Response Payload (`SetAudioSessionMuteResponse`)
```json
{
  "status": "ok",
  "confirmedMuted": true
}
```

#### Status Values
- `"ok"`: Successfully queried or modified audio session.
- `"invalid_session"`: Session ID is empty, missing, or inactive/disappeared.
- `"invalid_volume"`: Volume percentage is out of range (not 0-100).
- `"unsupported"`: Core Audio session enumeration unavailable or host bridge error.

---

## Native Windows Implementation Details

- **Session Enumeration:** Obtains `IAudioSessionManager2` from render `IMMDevice` and calls `GetSessionEnumerator()` to retrieve `IAudioSessionEnumerator`.
- **Session Metadata:** Uses `IAudioSessionControl2` to query process ID (`GetProcessId`), display name (`GetDisplayName`), or session identifier (`GetSessionIdentifier`).
- **Volume & Mute Controls:** Casts `IAudioSessionControl` to `ISimpleAudioVolume` to call `GetMasterVolume`, `SetMasterVolume`, `GetMute`, and `SetMute`.

---

## Manual Verification Procedure (Real Windows PC)

1. **Prerequisites:** Windows 10/11 PC with active audio playing apps (e.g., Spotify desktop, Discord, browser with playing video/audio).
2. **Session Discovery:**
   - Invoke `audio.sessions.list` over RPC.
   - Confirm active apps appear with accurate process IDs, app names, current volume percentages, and mute states.
3. **Per-App Volume Control:**
   - Send `audio.sessions.set_volume` with `sessionId` set to Spotify's session ID and `volumePercent` set to 50.
   - Confirm in Windows Volume Mixer that Spotify's app volume changes to 50% without affecting system master volume or other apps.
4. **Per-App Mute Control:**
   - Send `audio.sessions.set_mute` with `sessionId` set to Discord's session ID and `muted: true`.
   - Verify Discord is muted in Windows Volume Mixer and sound output stops for Discord.
5. **Closed / Missing Application Handling:**
   - Close an application (e.g., Discord).
   - Send `audio.sessions.set_volume` targeting the old session ID.
   - Confirm response returns `{ "status": "invalid_session" }` without crashing or corrupting audio state.
