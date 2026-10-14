# Windows maintenance and recovery

State lives in `%LOCALAPPDATA%\Nocturne\Connector`. The `App` subdirectory
contains installed executables; session and preference files live outside it.
Uninstall preserves state. Do not delete this directory to fix a connection.
Never attach session files, app/macro configuration, or unreviewed raw logs to a
support report.

## Observe before restarting

1. Open Settings → Connection Diagnostics. Refresh once, then export the support
   bundle. The JSON contains bounded version/build information, independent native
   pipe and Car Thing route state, feature availability and probe completion, and
   recent warning/error counts. It contains no raw log text or macro parameters.
2. If the UI cannot open, use tray → **Open Diagnostic Logs**. Inspect `host.log`
   for native startup version, sidecar launch, HTTP readiness, exit and restart
   events. A host that crashes cannot record its own crash; compare the last event
   with Windows Event Viewer and OS security history. Child output is not copied
   into this log. No `HTTP ready` event indicates a pre-readiness failure.
3. `host.log` and `connector.log` each retain a current file plus four archives,
   five MiB per file (50 MiB combined maximum). Each line is at most eight KiB.
   Native writers share a lock. Connector log redaction suppresses known credential
   assignments and auth headers and masks user paths. Raw logs still contain local
   operational details, so review them before sharing; use the redacted export.
4. Feature probe `timeout` means the three-second diagnostic refresh deadline
   elapsed. Availability is cached and is not proof that an action will succeed.
   `error` means refresh itself failed. A disconnected native pipe and a
   disconnected Bluetooth route are separate observations.

## Restart, reinstall, or roll back

1. Save a support export if available. Record the installed version and the commit
   of your last known-good installer. Keep that installer locally; Actions
   artifacts expire (the build workflow currently retains them for 14 days).
2. Choose **Quit** in the tray. Closing the UI only destroys its WebView and leaves
   the tray/sidecar running. Quit terminates the sidecar and its Windows Job Object.
3. Relaunch from the Start menu. A sidecar exit clears readiness and native routes;
   the host restarts it with delays of 1, 2, 4, 8, 16, then 30 seconds. After an
   attempt runs for 60 seconds the retry delay resets. Bluetooth routes recover
   through the existing pairing/reconnect path; no re-pairing should be necessary.
4. If needed, download the x64 installer from a successful **Windows Build** run
   for the desired commit, or choose a known-good release installer. Verify the
   repository, workflow commit, architecture, and provenance before running it.
5. Install to the same default `App` directory. The installer forcibly stops host
   and sidecar process trees before replacing files and starts in background mode.
   Prefer quitting first; installation does not imply gracefully drained writes.
   If replacement reports locked files, quit any remaining processes and retry;
   do not run overlapping installers. Do not interrupt file replacement.
6. To roll back, quit and run the retained known-good installer in the same
   directory. State remains; keep a private backup before experimenting with older
   versions whose configuration compatibility has not been validated. Do not
   distribute that backup: it can contain credentials.
7. Open from the tray, check the reported version, and repeat pairing/route, media,
   Spotify, volume and configured-feature checks. This sprint adds no auto-updater.

Unsigned GitHub artifacts do not bypass Windows Smart App Control. If Windows
blocks the installer, host or sidecar, record the exact security message and the
artifact commit; use a trusted signed distribution when available. Disabling
security protections is not the default recovery procedure.

## Manual Windows acceptance (not run on macOS)

- Install a current successful Actions artifact on the real PC; record Smart App
  Control behavior and perform the roadmap's G0 Bluetooth-only integration checks.
- With the UI closed, end only the server sidecar in Task Manager. Confirm one
  replacement starts, readiness clears until HTTP is ready, and routes reconnect.
- Repeat with an immediate-exit test sidecar in a development build. Confirm retry
  backoff, bounded logs, and responsive Quit. Restore the real sidecar afterward.
- Rename a development sidecar executable, start the host normally, and confirm
  tray log access explains the pre-readiness failure. Restore and restart.
- End the native host process; confirm its Job Object stops the sidecar. Relaunch
  and confirm fallback/reconnect. Exercise Windows → Mac → Windows preference.
- Refresh diagnostics while the native pipe is unavailable; record separate route
  and probe states and verify the request returns within about three seconds.
- Inspect support JSON for absent tokens, pairing codes, user paths, app targets,
  macro definitions and log payloads. Confirm versions/runtime/health are present.
- Quit/reinstall the same version, then roll back to your recorded known-good
  artifact. Confirm account/preferences survive and all core controls work.
- Complete Windows CI and Windows Build; physical results, restart/reinstall and
  rollback remain **untested** until this checklist is executed on Windows.

Oversized log files left by older versions are discarded on the first new log
write so the documented retention ceiling also applies after upgrading.

### HTTP port changed after a collision

The Connector normally reuses its loopback HTTP port. If another process takes
that port, a confirmed HTTP bind collision makes the next sidecar choose a new
ephemeral localhost port. The host waits for current-process readiness before
updating its remembered port and navigating an existing local UI window to the
replacement URL. Other startup failures do not trigger this fallback. To verify,
stop the sidecar, occupy its old port on the test PC, and observe a successful
replacement and UI navigation. Physical acceptance of this sequence remains
pending; automated checks cover binding classification and native recovery.

A diagnostic featureProbe timeout keeps returning cached state without starting
another overlapping refresh. Existing feature RPC deadlines normally settle it.
If a defective refresh never settles, use the existing host restart procedure;
there is no new background recovery loop or unsafe aggregate cancellation.
