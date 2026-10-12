# Windows Audio Output Discovery & Switching (Sprint 9)

## RPC Contract Documentation

### 1. `audio.outputs.list` (or `media.get_audio_outputs`)

Enumerates active audio playback/render devices on the Windows host and identifies default role assignments.

#### Request Params
None (`{}`).

#### Response Payload (`GetAudioOutputsResponse`)
```json
{
  "status": "ok",
  "selectedDeviceId": "{0.0.0.00000000}.{device-guid-1}",
  "devices": [
    {
      "id": "{0.0.0.00000000}.{device-guid-1}",
      "name": "Speakers (Realtek High Definition Audio)",
      "state": "active",
      "isDefault": true,
      "defaultRoles": {
        "console": true,
        "multimedia": true,
        "communications": false
      }
    },
    {
      "id": "{0.0.0.00000000}.{device-guid-2}",
      "name": "Headphones (Wireless Stereo)",
      "state": "active",
      "isDefault": false,
      "defaultRoles": {
        "console": false,
        "multimedia": false,
        "communications": true
      }
    }
  ]
}
```

---

### 2. `audio.outputs.select` (or `media.set_audio_output`)

Sets the default audio output endpoint on Windows for specified roles.

#### Request Params
- `deviceId` (string, required): Opaque device GUID ID string returned by `audio.outputs.list`.
- `roles` (array of strings, optional): Roles to apply. Supported values: `["console"]`, `["multimedia"]`, `["communications"]`.
- `role` (string, optional): Alternative single role string (`"console"`, `"multimedia"`, `"communications"`, or `"all"`).
- **Default Policy:** If neither `roles` nor `role` is specified, defaults to `["console", "multimedia"]`. Communications output remains unchanged unless explicitly requested.

#### Response Payload (`SelectAudioOutputResponse`)
```json
{
  "status": "ok",
  "deviceId": "{0.0.0.00000000}.{device-guid-2}",
  "confirmed": true
}
```

#### Error / Status Values
- `"ok"`: Successfully changed and verified default status for all requested roles.
- `"invalid_device"`: Device ID is empty or invalid.
- `"invalid_role"`: Requested role list or string is invalid or empty.
- `"device_missing"`: Requested device ID is not currently active/enumerated.
- `"access_denied"`: Windows returned HRESULT `0x80070005` (Access Denied).
- `"failed"`: Native call failed or read-back verification failed for one or more requested roles.
- `"unsupported"`: Native COM interface (`IPolicyConfig`) is unavailable or host bridge failed.

---

## Native Windows Implementation Details

- **Device Enumeration:** Uses COM interface `IMMDeviceEnumerator::EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)` and property store `PKEY_Device_FriendlyName` (`a45c254e-df1c-4efd-8020-67d146a850e0`, PID 14).
- **Default Switching:** Uses COM interface `IPolicyConfig` (IID `f8679f50-850a-41cf-9c72-430f290290c8`, CLSID `870af99c-171d-4f9e-af0d-e63df40c2bc9`) method `SetDefaultEndpoint`.
- **Read-Back Verification:** Re-queries `IMMDeviceEnumerator::GetDefaultAudioEndpoint(eRender, role)` for every requested role to guarantee the requested change was actually applied by Windows.
- **Timeouts:** Service calls specify explicit 3000ms timeouts suitable for interactive controls.

---

## Manual Verification Procedure (Real Windows PC)

1. **Prerequisites:** A Windows 10/11 PC with at least two active render devices (e.g. Speakers, Bluetooth Headphones, USB DAC).
2. **Device Discovery:**
   - Call `audio.outputs.list` over RPC / Nocturne WebSocket.
   - Verify that all connected output devices appear with correct friendly names and default role flags.
3. **Device Switching:**
   - Call `audio.outputs.select` with `deviceId` set to the secondary output device.
   - Confirm that Windows system audio output changes to the selected device immediately.
   - Play audio (e.g. YouTube or Spotify) and confirm sound outputs through the selected device.
4. **Communications Role Isolation:**
   - Change output using default parameters (`roles` omitted).
   - Check Windows Control Panel / Sound settings and confirm Default Device changed while Default Communication Device remained on its previous device.
5. **Device Disappearance:**
   - Disconnect a USB DAC or turn off Bluetooth headphones.
   - Send `audio.outputs.select` with the disconnected device ID.
   - Confirm response is `{ "status": "device_missing" }` without crashing or stale positive confirmation.
6. **Existing Features Verification:**
   - Test master volume up/down, mute toggle, and now-playing media session updates to confirm no regressions.
