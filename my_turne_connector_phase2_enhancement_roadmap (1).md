# My-Turne Connector — Phase 2 Enhancement Roadmap

**Repository:** [`alexliu4/my-turne-connector`](https://github.com/alexliu4/my-turne-connector)  
**Related device repository:** [`alexliu4/my-turne`](https://github.com/alexliu4/my-turne)  
**Created:** 2026-10-11  
**Status:** Proposed / **not yet approved or implemented**  
**Relationship to original roadmap:** Continue *after* `jules_my_turne_native_windows_connector_sprints.md` (Sprints 0–8). Do not replace or rewrite that roadmap.

> **Purpose:** Build only the host-side additions that make the Windows Connector a more useful, reliable Car Thing desktop controller. Work sequentially, one tightly scoped PR per sprint, with a human code review and explicit acceptance gate between PRs. Features are ordered primarily by practical value, tempered by risk and dependencies.

---

## 1. What is already built — do not recreate it

The original Connector roadmap's feature PRs through **Sprint 8** are merged. Existing work includes Windows identity and Bluetooth/RFCOMM integration, volume and Windows system media, Connector capability metadata, Discord control, CPU/RAM/GPU telemetry, configured app launching/macros, structured Host Status, Windows CI, and a downloadable Windows x64 installer workflow.

**Important distinction:** Merged code and green CI do **not** establish that all functionality works on your actual Windows PC + physical Car Thing. Hardware verification remains a prerequisite.

Architecture to preserve:

```text
Windows available:
Car Thing UI -> local Nocturne daemon -> Bluetooth/RFCOMM RPC
             -> native Windows Connector -> Windows APIs

Windows unavailable:
Car Thing UI -> Nocturne daemon -> Mac Connector -> normal Nocturne/Spotify

Windows returns:
Device route selection automatically prefers a verified healthy Windows Connector.
```

Do **not** reintroduce a direct Car Thing-to-Windows LAN WebSocket, legacy Windows Companion, extra transport, Mac proxy, generic remote shell, or marketplace runtime. Keep `app.ready.platform = "web"` for upstream compatibility; identify Windows only using explicit Connector metadata.

**Repository responsibility:**

- `my-turne-connector`: Windows API access, trusted host actions, host capabilities, settings/configuration, diagnostics, OS-side data sources.
- `my-turne`: Car Thing screens, buttons/knob UX, device-side caching, RPC routing, Windows preference, Mac fallback, device power/backlight behavior.
- **Never change both repositories in one PR.** If UI support is missing, finish and test the Connector contract first, then record a separate device-repo issue/PR dependency. Do not silently implement the UI here.

---

## 2. Ordered backlog at a glance

| Order | Work package | Priority | Estimated scope | Requires new Car Thing UI? | Delivery decision |
|---|---|---|---|---|---|
| **G0** | **Real-device validation gate** | Mandatory | Medium testing effort | Uses existing UI | **Pass before Sprint 9** |
| **Sprint 9** | Windows audio output discovery + switching | **P0 / high value** | Medium–High | Yes, separate device PR | Build |
| **Sprint 10** | Local configuration editor + diagnostics | **P0 / high value** | Medium | No for first version | Build |
| **Sprint 11** | Per-application volume mixer | **P1 / high value** | High | Yes, separate device PR | Build after 9 |
| **Sprint 12** | Connector maintainability, logs + recovery tooling | **P1 / reliability** | Medium | No | Build |
| **Sprint 13** | Windows session/lock and power awareness | P2 | Medium | Yes, device backlight behavior | Build if desired |
| **Sprint 14** | Home Assistant scene/action integration | P2 / conditional | Medium–High | Yes | **Architecture decision first** |
| **Sprint 15** | Calendar and meeting context | P2 / conditional | High | Yes | **Data-source decision first** |
| **Sprint 16** | Media-source fidelity and artwork extensions | P3 / optional | Medium | Usually yes | Build only on observed gaps |
| **Sprint 17** | OBS / creator controls | P3 / optional | Medium | Yes | Skip unless used |

**Estimates are relative, not promises.** The sprint order is the recommended sequence; conditional sprints may be explicitly skipped after documenting a decision. Do not hold earlier PRs hostage to speculative later integrations.

**Deliberately device-side / not new Connector sprints:** clock, Pomodoro/focus timer, weather screen, screen rotation, themes, animations, screenshots or screen recording, button remapping UI, and GitHub status dashboard unless they need a trusted Windows-host data adapter. These belong on the `my-turne` backlog, especially after its existing device Sprints 8–12.

---

## 3. Universal Jules workflow — apply to *every* sprint

1. **Read current state:** `README.md`, this roadmap, original Connector roadmap, relevant service/native code, and the latest merged `main`. Verify pre-existing support first; don't duplicate upstream features.
2. **One sprint, one PR:** branch from current `main`; implement only the sprint's Connector-side scope. Make no edits to `alexliu4/my-turne` in that PR.
3. **Design contract before implementation:** document the RPC name, request/response shapes, capability indication, `unsupported` / `unavailable` / `error` behavior, and whether responses are live, cached, or event-driven. Reuse existing method and naming conventions where possible. Names in this document are suggestions, **not already implemented APIs**.
4. **Security by default:** allowlisted actions; no arbitrary command execution or request proxy; no secrets sent to Car Thing; avoid sensitive contents in logs; validate all inbound parameters; honor Windows/Mac route ownership.
5. **Bounded behavior:** no high-rate polls, endless retries, unbounded queues, or 30-second blocking UI RPCs. Use the existing native HostBridge and Bluetooth/RFCOMM path; keep failures isolated from Spotify, media, volume, and pairing.
6. **Validation:** run relevant Bun checks/tests, Windows Rust checks/tests, Windows CI, and installer build. Add focused tests for successful operation, invalid inputs, unavailable hardware, reconnect/stale state, and non-Windows behavior as appropriate.
7. **PR handoff:** list the changed files, exact RPC contract, manual Windows steps, outstanding hardware validation, and required follow-up `my-turne` device work. Include reproducible evidence; never claim physically tested when only CI ran.
8. **Stop:** ask for human review after **each PR**. Do **not** auto-merge, automatically start the next sprint, or create a batch of future PRs.

**Merge gate for each sprint:** acceptance criteria verified in code/tests; green CI and Windows installer build; no regressions to upstream Nocturne; reviewer approval. Physical hardware acceptance may remain an explicitly tracked blocker if unavailable—do not silently mark it passed.

### Standard copy/paste Jules kickoff prompt

Replace `N` and `<SPRINT TITLE>` before sending:

```text
Repository: alexliu4/my-turne-connector
Roadmap: my_turne_connector_phase2_enhancement_roadmap.md
Task: Implement ONLY Connector Sprint N — <SPRINT TITLE>.

Read the Phase 2 universal workflow, the complete Sprint N requirements,
the original native Windows Connector roadmap, and the current repository
implementation before editing. Reuse existing native Bluetooth/RFCOMM,
HostBridge, config, service, and test patterns. Do not modify my-turne.

Create one focused PR to main with the Sprint N acceptance criteria, tests,
RPC contract and examples, manual Windows verification steps, CI evidence,
and any separate device-repo follow-up clearly identified.

Do not start another sprint, merge the PR, introduce a new transport,
rebuild existing features, or implement unrelated optional items.
Stop after pushing the PR so I can get a code review.
```

---

## G0 — Mandatory physical integration checkpoint

**Goal:** Confirm the existing Connector actually runs and talks to the real Car Thing *without USB data*, before layering more host features onto it.

**Procedure:**

- [ ] Download the latest successful **Windows x64** build from GitHub Actions, install it, and start the tray/server on the target PC.
- [ ] Record whether **Windows Smart App Control** blocks the unsigned installer or its child executables. A green GitHub build does **not** bypass Smart App Control. Do not disable security protections as the default workaround.
- [ ] Pair and connect the actual Car Thing via Bluetooth/RFCOMM; confirm no USB data cable is needed in normal use.
- [ ] Verify ordinary Nocturne/Spotify behavior survives.
- [ ] Verify Windows volume, media artwork/controls, Host Status, Discord status/actions, system stats, app launching and macros where configured.
- [ ] Test the route sequence **Windows → Mac fallback → Windows preferred again**.
- [ ] Test app/Connector restart, Car Thing reboot, Bluetooth interruption, Windows sleep/wake, and Windows logout/login.
- [ ] Record exact observed results and failures in a concise test report; distinguish **untested**, **blocked**, **passed**, and **failed**.

**Stop condition:** If pairing/transport/installer cannot work on the real PC, resolve that with a targeted bugfix PR before starting Sprint 9. Do not assume a Bluetooth redesign is required without isolating the failure. No fictional verification.

**Jules assignment:** Only fix a specifically reproduced failure from this checkpoint; do not invent broad connectivity improvements.

---

## Sprint 9 — Windows Audio Output Discovery and Switching

**Priority:** Highest new functional feature.  
**Inspiration:** DeskThing output-source controls; Windows desktop audio workflows.  
**Depends on:** G0 and existing native Windows volume integration.  
**Goal:** Select between real Windows audio render endpoints (e.g., speakers, headphones) without leaving Car Thing.

### Connector-side scope

- Inspect the existing `windows/src-tauri/src/native/media.rs` endpoint-volume / `IMMDeviceEnumerator` support first; extend it instead of making a second audio subsystem.
- Enumerate **active render devices** with stable opaque IDs, friendly names, current/default indicators, and capability/availability metadata. Handle unplug/replug and Bluetooth headphones disappearing.
- Offer a **separately authorized** default-output switch by *enumerated ID* only. Explicitly confirm the supported native Windows mechanism and any policy/API limitations before implementing; do not pretend `IAudioEndpointVolume` itself changes the default endpoint.
- Decide and document how `eConsole`, `eMultimedia`, and `eCommunications` roles are handled. Avoid surprising partial switches.
- Reflect actual Windows state after a switch, and report specific failures (`device_missing`, `unsupported`, `access_denied`, etc.). Never claim success on request alone.
- Avoid changing Spotify session routing, Bluetooth pairing, device preferences, and the master-volume logic unexpectedly.

**Proposed protocol (final names must follow established repo style):**

```text
audio.outputs.list  -> {status, available, devices:[{id,name,isDefault,...}]}
audio.outputs.select({deviceId}) -> {status, selectedId?, confirmedDefault?}
```

**Acceptance:**

- [ ] List two or more available endpoints and identify the current default accurately.
- [ ] Switch to a different available device, verify the system default changed, and handle disappearing devices safely.
- [ ] Invalid/unlisted IDs and non-Windows requests fail without side effects.
- [ ] A native feature unavailable on a given Windows version reports `unsupported`, not a fabricated selection.
- [ ] Playback, volume, Bluetooth and Spotify regressions covered.
- [ ] Connector API is documented for a **separate** `my-turne` output-selector UI PR; no UI implemented here.

**Stop & review:** PR for Connector endpoint RPC + tests + Windows manual test instructions. **Do not proceed to Sprint 10 until reviewed.**

---

## Sprint 10 — Local Configuration Editor and Connection Diagnostics

**Priority:** High; improves usability of existing Sprint 7 features.  
**Depends on:** G0 and existing application/macro config stores.  
**Goal:** Stop requiring manual editing of JSON for routine app/macro configuration, while making connection troubleshooting easier.

### Connector-side scope

- Reuse the existing **local Windows Connector desktop/web settings surface**, if one exists. Confirm its auth/binding behavior. Do not create a second open network server.
- Provide a small **localhost-only** editor for configured apps and macros: list, enable/disable, add/edit/delete, validate, and show effective configuration. Reuse existing allowlist rules and preference stores; no generic command-shell editor.
- Apply edits atomically; show validation errors without corrupting existing config. Never silently reactivate explicitly disabled actions.
- Provide read-only diagnostics: native host connected, sidecar connected, Car Thing Bluetooth route, recent errors, feature readiness, Connector version, and build provenance if available.
- Include a **redacted** export suitable for bug reports. Avoid tokens, paths containing sensitive user information, private URLs and raw credentials.
- Do not let a remote Car Thing mutate trusted app/macro definitions in this sprint; this editor is local to Windows.

**Acceptance:**

- [ ] Add/modify/disable an allowed app or macro, persist it, restart Connector and verify the effective configuration.
- [ ] Malformed/invalid configuration is safely rejected; no arbitrary remote execution is enabled.
- [ ] Editor cannot be accessed from another machine by default; protect any write endpoints against cross-origin/CSRF issues as appropriate.
- [ ] Diagnostics distinguish Windows host health from Car Thing connection presence.
- [ ] Redacted support report omits secrets and logs contain no sensitive action payloads.
- [ ] Existing app-launch/macro RPC tests remain green.

**Stop & review:** One PR for a practical minimum editor and diagnostics—not a visual redesign or plugin manager.

---

## Sprint 11 — Per-Application Windows Volume Mixer

**Priority:** High; most useful alongside Sprint 9.  
**Depends on:** G0, Sprint 9 endpoint behavior, existing system volume API.  
**Goal:** Turn the knob into a targeted control for the volume of Spotify, Discord, browser, game, etc., while preserving master volume.

### Connector-side scope

- Inspect native Windows Core Audio session support and use established session interfaces (e.g., `IAudioSessionManager2` / `ISimpleAudioVolume`) where appropriate; verify thread/COM lifecycle and endpoint behavior.
- Return **active sessions**, associated app display names (where reliably available), per-session volume/mute, stable *session-scoped* opaque IDs, and the associated output endpoint. Avoid claiming an ID persists across process restarts.
- Allow volume/mute updates for **discovered session IDs only**. Validate numeric range, report inactive/disappeared sessions and access limitations, and do not mutate master volume accidentally.
- Throttle/coalesce rapid knob-driven changes and avoid excessive event traffic over Bluetooth.
- Clear missing sessions on refresh/reconnect; never show old readings as live data.
- Preserve the existing native master-volume RPC and route ownership; no service duplication.

**Suggested protocol:**

```text
audio.sessions.list({deviceId?}) -> {status, sessions:[{id,appName,volumePercent,muted,...}]}
audio.sessions.set_volume({sessionId,volumePercent}) -> {status,confirmedVolumePercent?}
audio.sessions.set_mute({sessionId,muted}) -> {status,confirmedMuted?}
```

**Acceptance:**

- [ ] Enumerates at least two active sessions on the real Windows system if present.
- [ ] Changing one session's volume does not change another session or the master volume.
- [ ] Closed, stale, and protected/unavailable sessions are handled safely.
- [ ] Fast repeated actions remain responsive and bounded; no regressions to normal volume/Now Playing.
- [ ] Clear API for a **separate** `my-turne` volume-mixer screen and knob-selection behavior.

**Stop & review:** Native session/mixer RPC PR and tests first; device mixer screen in another repository later.

---

## Sprint 12 — Maintenance, Logging, Diagnostics Export, and Recovery

**Priority:** Reliability; particularly useful once your Windows PC is running the Connector daily.  
**Depends on:** G0; optionally use Sprint 10 diagnostics surface.  
**Goal:** Make long-running installations observable and recoverable without an expensive rewrite.

### Connector-side scope

- Audit log storage, retention and rotation; cap total log size and avoid logging credentials, tokens, raw pairing secrets, or sensitive macro parameters.
- Add structured health/readiness information that distinguishes **native host**, **Bun sidecar**, **Bluetooth device route**, and **feature-probe status**.
- Add a bounded, user-triggered diagnostic bundle / redacted support export. Include clear versions and platform/build info; do not include secrets.
- Review current Windows test-install workflow, process shutdown/update-in-place behavior, and first-run failure reporting.
- Document safe re-install / rollback to a known-good Actions artifact or release. **Do not claim unsigned GitHub artifacts can bypass Smart App Control.**
- Consider automated updates only in a *separate future design decision* that includes trust/signature verification, rollback, and user confirmation. No silent unsigned auto-updater.

**Acceptance:**

- [ ] Log growth is bounded by documented limits.
- [ ] Native host crash/disconnect and sidecar failure become diagnosable and do not break core fallback behavior.
- [ ] Restart/reinstall/recovery procedures are repeatable on Windows.
- [ ] Diagnostic export is redacted and testable.
- [ ] Installer CI and core Nocturne checks remain green.

**Stop & review:** Reliability PR only, not a new auto-update architecture.

---

## Sprint 13 — Windows Session, Lock, Sleep, and Wake Awareness

**Priority:** Medium.  
**Depends on:** G0, established Car Thing reliability behavior.  
**Goal:** Allow Car Thing to respond intelligently to Windows session lock, display sleep, and resume without weakening the Mac fallback.

### Connector-side scope

- Observe supported Windows lock/unlock, active-session, system suspend/resume, and display-power signals **without polling aggressively**. Distinguish `unknown` from `unlocked` or `awake` when native state cannot be verified.
- Emit bounded event updates and expose current cached state by RPC for reconnection.
- Separate Windows host *session* state from Bluetooth *connection* state: locked != offline; asleep/disconnected may trigger route changes via device daemon.
- Never broadcast desktop content, active window titles, typed text, or private screen metadata by default.
- Device repo owns the actual backlight/screen-sleep behavior; **no device power writes from the Connector**.

**Acceptance:**

- [ ] Lock/unlock and sleep/wake transitions are represented reliably or explicitly unknown.
- [ ] Reconnect returns a correct snapshot rather than old session state.
- [ ] Duplicate/noisy OS notifications are coalesced.
- [ ] Spotify, pairing, and Windows-to-Mac fallback are not disrupted.

**Stop & review:** A status/events-only Connector PR; device screen-off/lock UI is a separate `my-turne` task.

---

## Sprint 14 — Home Assistant Scene and Action Integration (Conditional)

**Priority:** Medium, useful for desk lighting and routines.  
**Decision gate:** Since Home Assistant may run on an always-on Mac mini, determine whether this functionality should live in the Windows Connector at all. A host-independent data/service path may be better when Windows is asleep.

**First Jules deliverable:** Short architecture decision in the PR description. If it belongs outside this repo, **do not implement a Connector integration**—create a device/host-service backlog entry instead.

### Connector-side scope *only if Windows-host ownership is justified*

- Reuse an existing authenticated client if available; otherwise add the smallest maintained integration required.
- Allow only configured scenes, scripts or vetted entities. No arbitrary remote Home Assistant REST proxy, uncontrolled URL execution, or dynamic action injection from Car Thing.
- Store credentials securely on Windows; do not expose tokens to Car Thing or logs.
- Report actual action invocation results and unsupported/offline state; do not infer a light is on unless verified by HA state.

**Acceptance:**

- [ ] User-approved allowlisted scene action succeeds and an unconfigured one is blocked.
- [ ] HA offline, expired credentials, and Windows sleep fail safely.
- [ ] Secrets stay on trusted host and the integration cannot affect Nocturne connectivity.
- [ ] Explicit companion task for device scene buttons, if applicable.

**Stop & review:** Conditional integration only after architecture review.

---

## Sprint 15 — Calendar and Meeting Context (Conditional)

**Priority:** Medium, high usefulness but higher integration complexity.  
**Inspiration:** MacThing agenda, upcoming event alerts, and meeting-end countdown.  
**Decision gate:** Choose where calendar data should live and which source is authorized (e.g., local Outlook calendar, user-selected ICS, or a linked provider). Do not assume Windows provides a universal calendar API or access without permission.

### Connector-side scope *if a Windows-host adapter is justified*

- Read **only explicitly authorized** event metadata: start, end, all-day flag, title (if permitted), optional sanitized location/meeting type.
- Bound cached lookahead window; normalize time zones and daylight-saving transitions; support cancelled/moved/overlapping meetings.
- Protect private calendar URLs/credentials; minimize exposed content and allow users to hide titles.
- Deliver read-only agenda/status; no automatic meeting joining, device screen takeovers, or calendar writes.

**Acceptance:**

- [ ] Correct today's agenda and next-meeting end time using deterministic fixtures, including DST and all-day cases.
- [ ] Revoked access, missing source, malformed entries and network loss degrade to unavailable/empty appropriately.
- [ ] Private credentials and event bodies are never broadcast accidentally.
- [ ] A separate `my-turne` PR owns clock/agenda view, meeting timer, and alerts.

**Stop & review:** If data-source ownership is undecided, record the decision and **skip implementation**, rather than inventing a calendar backend.

---

## Sprint 16 — Richer Media Source and Artwork Fidelity (Optional)

**Priority:** Lower; only act on an observed deficiency.  
**Inspiration:** MacThing's browser artwork handling and media-aware UI.

### Connector-side scope

- First test existing Windows GSMTC artwork, source names, artwork dimensions, stale-session behavior, and handling of YouTube/video playback.
- If a concrete gap is reproduced, improve *only that data path*: e.g., better verified source metadata, safe artwork sizing, or meaningful stopped/no-session semantics.
- Do not scrape browser pages, inspect private tabs, inject scripts, or request broad browsing permissions merely for prettier album art. Avoid embedding high-resolution art repeatedly over RFCOMM.
- Prefer compression/caching and existing media event contracts.

**Acceptance:**

- [ ] Before/after sample demonstrates a real improvement.
- [ ] Existing Spotify and GSMTC routing, progress, session switching and transport latency remain sound.
- [ ] No private browser content or oversized payloads leak to Car Thing.

**Stop & review:** If existing quality is sufficient, mark **skipped—no code needed**.

---

## Sprint 17 — OBS / Creator Controls (Optional)

**Priority:** Low unless you regularly stream/record.  
**Inspiration:** DeskThing community OBS requests.

### Connector-side scope

- Reuse OBS's supported authenticated control API (if present). Scope permissions to configured scene switching, recording status, and explicit start/stop actions only.
- Avoid arbitrary request forwarding, exposing a remote OBS server on the LAN, or storing secrets in logs.
- Consider one read-only status prototype before enabling potentially destructive recording/scene actions.
- Keep every action tied to an allowlisted ID; confirm actual success/error state.

**Acceptance:**

- [ ] Works against a test OBS instance with explicit permission.
- [ ] Disconnected/locked/unauthorized OBS cannot affect core Nocturne operation.
- [ ] Device UI is deferred to a separate task.

**Stop & review:** Skip entirely unless there is a concrete use case.

---

## 4. Future ideas — not automatically approved Connector work

These came from MacThing/DeskThing comparisons but **should not produce PRs by default**:

| Idea | Default destination / decision |
|---|---|
| Pomodoro/focus timer, clock and timer knob controls | `my-turne` device UI; Connector unnecessary unless integrating Windows focus status |
| Weather and multi-day forecast | `my-turne` device + chosen data provider; do not tie weather to Windows availability |
| Album-art themes, screen rotation, larger clock, smoother transitions | `my-turne` UI |
| Car Thing screenshot / MP4 recording utility | `my-turne` device dev tooling; consider test-fixture screenshots first |
| Better Discord channel/participants | Investigate safe official API/permissions and `state_known` limitations before a proposal |
| GitHub CI/PR dashboard | Separate provider adapter if needed; do not couple to Windows media layer |
| Windows notification viewer | Privacy-first opt-in feasibility study; avoid arbitrary notification/body streaming |
| Work/Gaming/Relax profiles | Potential cross-repo follow-up *after* safe action mappings and mixer exist |
| Community app marketplace / arbitrary plugins | **Not recommended** for current personal project's security and maintenance budget |
| AI voice assistant / microphone capture | Defer; unrelated to core Connector and raises microphone/privacy/latency questions |

---

## 5. Human review template to use after each Jules PR

```text
Review PR #<number> in alexliu4/my-turne-connector against
my_turne_connector_phase2_enhancement_roadmap.md Sprint <N>.

Inspect current HEAD and actual diff, service/native contracts, compatibility
with original Nocturne and my-turne routing, tests and latest Windows CI/build.
Prioritize bugs and incorrect assumptions over micro-refactors.

Return:
1) Sprint acceptance pass/partial/fail with evidence,
2) actionable bugs ranked P0/P1/P2,
3) optional improvements only if meaningful,
4) physical test still outstanding,
5) a single precise Codex/Jules prompt to fix blockers (when needed),
6) a clear MERGE / CHANGES REQUESTED verdict.

Do not auto-merge or start the next sprint.
```

## 6. Sequence and completion ledger

Update **only this ledger** after an actual reviewed merge or an explicit skip decision; keep previous sprints intact.

| Milestone | Status | PR or evidence | Human sign-off |
|---|---|---|---|
| G0 — Physical integration | **Not verified** | — | — |
| Sprint 9 — Audio outputs | Proposed | — | — |
| Sprint 10 — Settings/diagnostics | Proposed | — | — |
| Sprint 11 — App volume mixer | Proposed | — | — |
| Sprint 12 — Maintenance | Proposed | — | — |
| Sprint 13 — Power/lock | Proposed | — | — |
| Sprint 14 — Home Assistant | Conditional | — | — |
| Sprint 15 — Calendar | Conditional | — | — |
| Sprint 16 — Artwork/media polish | Optional | — | — |
| Sprint 17 — OBS | Optional | — | — |

**Definition of Phase 2 success:** A reproducibly installed, physically verified Windows Connector with useful output switching, manageable macro/app settings, responsive per-app audio controls, and robust recovery—while retaining native Bluetooth/RFCOMM, clean Windows→Mac→Windows handoffs, and ordinary Spotify/Nocturne functionality. Conditional integrations are a bonus, not a completion dependency.
