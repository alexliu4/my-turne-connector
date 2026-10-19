use crate::bridge::BridgeServer;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsSessionState {
    pub session: String,        // "locked" | "unlocked" | "unknown"
    pub active_session: String, // "active" | "inactive" | "unknown"
    pub system_power: String,   // "awake" | "suspending" | "resuming" | "unknown"
    pub display_power: String,  // "on" | "off" | "dimmed" | "unknown"
    pub observed_at: u64,
    pub sequence: u64,
    pub observer_id: String,
    pub session_monitoring: bool,
    pub display_power_monitoring: bool,
    pub system_power_monitoring: bool,
}

impl Default for WindowsSessionState {
    fn default() -> Self {
        Self {
            session: "unknown".to_string(),
            active_session: "unknown".to_string(),
            system_power: "unknown".to_string(),
            display_power: "unknown".to_string(),
            observed_at: now_ms(),
            sequence: 0,
            observer_id: uuid::Uuid::new_v4().to_string(),
            session_monitoring: false,
            display_power_monitoring: false,
            system_power_monitoring: false,
        }
    }
}

pub struct SessionStateTracker {
    state: Mutex<WindowsSessionState>,
}

impl SessionStateTracker {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(WindowsSessionState::default()),
        }
    }

    pub fn get_status(&self) -> WindowsSessionState {
        self.state.lock().unwrap().clone()
    }

    pub fn set_monitoring(
        &self,
        session: bool,
        display: bool,
        system: bool,
    ) -> Option<WindowsSessionState> {
        let mut state = self.state.lock().unwrap();
        let previous = state.clone();
        state.session_monitoring = session;
        state.display_power_monitoring = display;
        state.system_power_monitoring = system;
        if !session {
            state.session = "unknown".into();
            state.active_session = "unknown".into();
        }
        if !display {
            state.display_power = "unknown".into();
        }
        if !system {
            state.system_power = "unknown".into();
        }
        if *state == previous {
            return None;
        }
        state.sequence += 1;
        state.observed_at = now_ms();
        Some(state.clone())
    }

    pub fn revalidate(
        &self,
        query: Option<(String, String)>,
        resumed: bool,
    ) -> Option<WindowsSessionState> {
        let mut status = self.state.lock().unwrap();
        let (session, active) = if status.session_monitoring {
            query.unwrap_or_else(|| ("unknown".into(), "unknown".into()))
        } else {
            ("unknown".into(), "unknown".into())
        };
        let system = if status.system_power_monitoring {
            if resumed || status.system_power == "unknown" {
                "awake".to_string()
            } else {
                status.system_power.clone()
            }
        } else {
            "unknown".to_string()
        };
        let clear_display = resumed || !status.display_power_monitoring;
        Self::update_locked(
            &mut status,
            Some(&session),
            Some(&active),
            Some(&system),
            if clear_display { Some("unknown") } else { None },
        )
    }

    pub fn update(
        &self,
        session: Option<&str>,
        active_session: Option<&str>,
        system_power: Option<&str>,
        display_power: Option<&str>,
    ) -> Option<WindowsSessionState> {
        Self::update_locked(
            &mut self.state.lock().unwrap(),
            session,
            active_session,
            system_power,
            display_power,
        )
    }

    fn update_locked(
        guard: &mut WindowsSessionState,
        session: Option<&str>,
        active_session: Option<&str>,
        system_power: Option<&str>,
        display_power: Option<&str>,
    ) -> Option<WindowsSessionState> {
        let new_session = session
            .map(|s| s.to_string())
            .unwrap_or_else(|| guard.session.clone());
        let new_active = active_session
            .map(|s| s.to_string())
            .unwrap_or_else(|| guard.active_session.clone());
        let new_system = system_power
            .map(|s| s.to_string())
            .unwrap_or_else(|| guard.system_power.clone());
        let new_display = display_power
            .map(|s| s.to_string())
            .unwrap_or_else(|| guard.display_power.clone());

        if new_session == guard.session
            && new_active == guard.active_session
            && new_system == guard.system_power
            && new_display == guard.display_power
        {
            return None;
        }

        guard.session = new_session;
        guard.active_session = new_active;
        guard.system_power = new_system;
        guard.display_power = new_display;
        guard.sequence += 1;
        guard.observed_at = now_ms();

        Some(guard.clone())
    }
}

pub struct WindowsSessionObserver {
    tracker: Arc<SessionStateTracker>,
    bridge: Mutex<Option<BridgeServer>>,
}

impl WindowsSessionObserver {
    pub fn new() -> Self {
        Self {
            tracker: Arc::new(SessionStateTracker::new()),
            bridge: Mutex::new(None),
        }
    }

    pub fn get_status(&self) -> WindowsSessionState {
        self.revalidate_state();
        self.tracker.get_status()
    }

    pub fn tracker(&self) -> Arc<SessionStateTracker> {
        self.tracker.clone()
    }

    pub async fn start(&self, bridge: BridgeServer) {
        if let Ok(mut guard) = self.bridge.lock() {
            *guard = Some(bridge.clone());
        }

        #[cfg(windows)]
        {
            let tracker = self.tracker.clone();
            let bridge_clone = bridge.clone();
            std::thread::spawn(move || {
                run_win32_observer(tracker, bridge_clone);
            });
        }
    }

    pub async fn dispatch(&self, method: &str, _params: Value) -> Result<Value, String> {
        match method {
            "windows.session.get_status" | "session.get_status" | "windows_session.get_status" => {
                let status = self.get_status();
                serde_json::to_value(&status)
                    .map_err(|err| format!("Failed to serialize session status: {err}"))
            }
            _ => Err(format!("Unsupported session method: {method}")),
        }
    }

    pub fn revalidate_state(&self) {
        #[cfg(windows)]
        {
            if let Some(new_state) = self.tracker.revalidate(query_wts_session_status(), false) {
                if let Ok(guard) = self.bridge.lock() {
                    if let Some(ref bridge) = *guard {
                        emit_state(bridge, Some(new_state));
                    }
                }
            }
        }
    }
}

impl Default for WindowsSessionObserver {
    fn default() -> Self {
        Self::new()
    }
}

// SessionFlags is an exact LONG value, not a bit mask. UNKNOWN is -1.
fn decode_wts_lock_state(level: u32, value: i32) -> &'static str {
    match (level, value) {
        (1, 0) => "locked",
        (1, 1) => "unlocked",
        _ => "unknown",
    }
}

fn emit_state(bridge: &BridgeServer, state: Option<WindowsSessionState>) {
    if let Some(state) = state {
        if let Ok(value) = serde_json::to_value(state) {
            bridge.emit("windows.session.changed", value);
        }
    }
}

#[cfg(windows)]
fn query_wts_session_status() -> Option<(String, String)> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::RemoteDesktop::{
        ProcessIdToSessionId, WTSConnectState, WTSSessionInfoEx, WTS_CONNECTSTATE_CLASS,
        WTS_CURRENT_SERVER_HANDLE,
    };
    use windows::Win32::System::Threading::GetCurrentProcessId;

    unsafe {
        let mut session_id = 0u32;
        if ProcessIdToSessionId(GetCurrentProcessId(), &mut session_id).is_err() {
            return None;
        }

        // Query Connect State
        let mut buffer: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut bytes_returned = 0u32;

        let connect_state = if windows::Win32::System::RemoteDesktop::WTSQuerySessionInformationW(
            Some(HANDLE(WTS_CURRENT_SERVER_HANDLE.0)),
            session_id,
            WTSConnectState,
            &mut buffer as *mut _ as *mut _,
            &mut bytes_returned,
        )
        .is_ok()
            && !buffer.is_null()
            && bytes_returned as usize >= std::mem::size_of::<WTS_CONNECTSTATE_CLASS>()
        {
            let state_ptr = buffer as *const WTS_CONNECTSTATE_CLASS;
            let state = *state_ptr;
            windows::Win32::System::RemoteDesktop::WTSFreeMemory(buffer);
            match state {
                windows::Win32::System::RemoteDesktop::WTSActive => "active".to_string(),
                windows::Win32::System::RemoteDesktop::WTSDisconnected => "inactive".to_string(),
                _ => "inactive".to_string(),
            }
        } else {
            if !buffer.is_null() {
                windows::Win32::System::RemoteDesktop::WTSFreeMemory(buffer);
            }
            "unknown".to_string()
        };

        // Query Session Lock Status
        buffer = std::ptr::null_mut();
        bytes_returned = 0;
        let lock_state = if windows::Win32::System::RemoteDesktop::WTSQuerySessionInformationW(
            Some(HANDLE(WTS_CURRENT_SERVER_HANDLE.0)),
            session_id,
            WTSSessionInfoEx,
            &mut buffer as *mut _ as *mut _,
            &mut bytes_returned,
        )
        .is_ok()
            && !buffer.is_null()
            && bytes_returned as usize
                >= std::mem::size_of::<windows::Win32::System::RemoteDesktop::WTSINFOEXW>()
        {
            let info_ptr = buffer as *const windows::Win32::System::RemoteDesktop::WTSINFOEXW;
            let info = &*info_ptr;
            let lock_state = if info.Level == 1 {
                decode_wts_lock_state(info.Level, info.Data.WTSInfoExLevel1.SessionFlags)
            } else {
                "unknown"
            };
            windows::Win32::System::RemoteDesktop::WTSFreeMemory(buffer);
            lock_state.to_string()
        } else {
            if !buffer.is_null() {
                windows::Win32::System::RemoteDesktop::WTSFreeMemory(buffer);
            }
            "unknown".to_string()
        };

        if lock_state == "unknown" && connect_state == "unknown" {
            None
        } else {
            Some((lock_state, connect_state))
        }
    }
}

#[cfg(windows)]
fn run_win32_observer(tracker: Arc<SessionStateTracker>, bridge: BridgeServer) {
    use windows::core::GUID;
    use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Power::{
        RegisterPowerSettingNotification, UnregisterPowerSettingNotification,
        POWERBROADCAST_SETTING,
    };
    use windows::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
        RegisterClassW, MSG, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WNDCLASSW,
        WS_OVERLAPPEDWINDOW,
    };

    const WTS_CONSOLE_CONNECT: u32 = 0x1;
    const WTS_CONSOLE_DISCONNECT: u32 = 0x2;
    const WTS_REMOTE_CONNECT: u32 = 0x3;
    const WTS_REMOTE_DISCONNECT: u32 = 0x4;
    const WTS_SESSION_LOGON: u32 = 0x5;
    const WTS_SESSION_LOGOFF: u32 = 0x6;
    const WTS_SESSION_LOCK: u32 = 0x7;
    const WTS_SESSION_UNLOCK: u32 = 0x8;

    const PBT_APMSUSPEND: u32 = 0x0004;
    const PBT_APMRESUMESUSPEND: u32 = 0x0007;
    const PBT_APMRESUMEAUTOMATIC: u32 = 0x0018;
    const PBT_POWERSETTINGCHANGE: u32 = 0x8013;

    const DEVICE_NOTIFY_WINDOW_HANDLE: u32 = 0x00000000;

    const GUID_CONSOLE_DISPLAY_STATE: GUID =
        GUID::from_u128(0x6fe69556_9f77_4d61_91a3_8701028d510e);

    struct StateCtx {
        tracker: Arc<SessionStateTracker>,
        bridge: BridgeServer,
    }

    extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        unsafe {
            let ctx_ptr = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                hwnd,
                windows::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
            ) as *const StateCtx;

            if ctx_ptr.is_null() {
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }

            let ctx = &*ctx_ptr;

            match msg {
                WM_WTSSESSION_CHANGE => {
                    let code = wparam.0 as u32;
                    let (sess, act) = match code {
                        WTS_SESSION_LOCK => (Some("locked"), None),
                        WTS_SESSION_UNLOCK => (Some("unlocked"), None),
                        WTS_CONSOLE_CONNECT | WTS_REMOTE_CONNECT | WTS_SESSION_LOGON => {
                            (None, Some("active"))
                        }
                        WTS_CONSOLE_DISCONNECT | WTS_REMOTE_DISCONNECT | WTS_SESSION_LOGOFF => {
                            (None, Some("inactive"))
                        }
                        _ => (None, None),
                    };

                    if sess.is_some() || act.is_some() {
                        if let Some(new_state) = ctx.tracker.update(sess, act, None, None) {
                            if let Ok(val) = serde_json::to_value(&new_state) {
                                ctx.bridge.emit("windows.session.changed", val);
                            }
                        }
                    }
                }
                WM_POWERBROADCAST => {
                    let code = wparam.0 as u32;
                    if code == PBT_APMSUSPEND {
                        if let Some(new_state) =
                            ctx.tracker
                                .update(None, None, Some("suspending"), Some("unknown"))
                        {
                            if let Ok(val) = serde_json::to_value(&new_state) {
                                ctx.bridge.emit("windows.session.changed", val);
                            }
                        }
                    } else if code == PBT_APMRESUMESUSPEND || code == PBT_APMRESUMEAUTOMATIC {
                        if let Some(new_state) =
                            ctx.tracker.update(None, None, Some("resuming"), None)
                        {
                            if let Ok(val) = serde_json::to_value(&new_state) {
                                ctx.bridge.emit("windows.session.changed", val);
                            }
                        }

                        emit_state(
                            &ctx.bridge,
                            ctx.tracker.revalidate(query_wts_session_status(), true),
                        );
                    } else if code == PBT_POWERSETTINGCHANGE && lparam.0 != 0 {
                        let setting = &*(lparam.0 as *const POWERBROADCAST_SETTING);
                        if setting.PowerSetting == GUID_CONSOLE_DISPLAY_STATE
                            && setting.DataLength >= 4
                        {
                            let raw_val =
                                std::ptr::read_unaligned(setting.Data.as_ptr() as *const u32);
                            let disp = match raw_val {
                                0 => "off",
                                1 => "on",
                                2 => "dimmed",
                                _ => "unknown",
                            };
                            if let Some(new_state) =
                                ctx.tracker.update(None, None, None, Some(disp))
                            {
                                if let Ok(val) = serde_json::to_value(&new_state) {
                                    ctx.bridge.emit("windows.session.changed", val);
                                }
                            }
                        }
                    }
                }
                _ => {}
            }

            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
    }

    unsafe {
        let class_name = windows::core::w!("NocturneSessionObserverClass");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            lpszClassName: class_name,
            ..Default::default()
        };

        if RegisterClassW(&wc) == 0 {
            eprintln!(
                "Windows session monitoring unavailable: window class registration failed: {}",
                windows::core::Error::from_win32()
            );
            emit_state(&bridge, tracker.set_monitoring(false, false, false));
            return;
        }

        let hwnd = match CreateWindowExW(
            Default::default(),
            class_name,
            windows::core::w!("NocturneSessionObserver"),
            WS_OVERLAPPEDWINDOW,
            0,
            0,
            0,
            0,
            None,
            None,
            None,
            None,
        ) {
            Ok(h) => h,
            Err(err) => {
                eprintln!("Windows session monitoring unavailable: observer window creation failed: {err}");
                emit_state(&bridge, tracker.set_monitoring(false, false, false));
                return;
            }
        };

        let ctx = Box::new(StateCtx {
            tracker: tracker.clone(),
            bridge: bridge.clone(),
        });
        let ctx_ptr = Box::into_raw(ctx);

        windows::Win32::UI::WindowsAndMessaging::SetWindowLongPtrW(
            hwnd,
            windows::Win32::UI::WindowsAndMessaging::GWLP_USERDATA,
            ctx_ptr as isize,
        );

        let session_registration = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
        if let Err(ref err) = session_registration {
            eprintln!("Windows session monitoring unavailable: WTS registration failed: {err}");
        }
        let pwr_handle = RegisterPowerSettingNotification(
            HANDLE(hwnd.0),
            &GUID_CONSOLE_DISPLAY_STATE,
            windows::Win32::UI::WindowsAndMessaging::REGISTER_NOTIFICATION_FLAGS(
                DEVICE_NOTIFY_WINDOW_HANDLE,
            ),
        );

        if let Err(ref err) = pwr_handle {
            eprintln!("Windows display-power monitoring unavailable: registration failed: {err}");
        }
        emit_state(
            &bridge,
            tracker.set_monitoring(session_registration.is_ok(), pwr_handle.is_ok(), true),
        );
        emit_state(
            &bridge,
            tracker.revalidate(query_wts_session_status(), false),
        );

        let mut msg = MSG::default();
        loop {
            let result = GetMessageW(&mut msg, None, 0, 0).0;
            if result <= 0 {
                if result < 0 {
                    eprintln!(
                        "Windows session monitoring stopped: {}",
                        windows::core::Error::from_win32()
                    );
                }
                break;
            }
            DispatchMessageW(&msg);
        }
        emit_state(&bridge, tracker.set_monitoring(false, false, false));

        if let Ok(h) = pwr_handle {
            let _ = UnregisterPowerSettingNotification(h);
        }
        if session_registration.is_ok() {
            let _ = WTSUnRegisterSessionNotification(hwnd);
        }
        let _ = DestroyWindow(hwnd);
        let _ = Box::from_raw(ctx_ptr);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wts_lock_values_are_exact_and_require_level_one() {
        assert_eq!(decode_wts_lock_state(1, 0), "locked");
        assert_eq!(decode_wts_lock_state(1, 1), "unlocked");
        for value in [-1, 2, 3, i32::MIN, i32::MAX] {
            assert_eq!(decode_wts_lock_state(1, value), "unknown");
        }
        assert_eq!(decode_wts_lock_state(0, 0), "unknown");
        assert_eq!(decode_wts_lock_state(2, 1), "unknown");
    }

    #[test]
    fn reconnect_query_while_locked_returns_locked() {
        let tracker = SessionStateTracker::new();
        tracker.set_monitoring(true, true, true);
        tracker.revalidate(
            Some((decode_wts_lock_state(1, 0).into(), "active".into())),
            false,
        );
        assert_eq!(tracker.get_status().session, "locked");
    }

    #[test]
    fn observers_have_distinct_stable_ids() {
        let first = SessionStateTracker::new();
        let second = SessionStateTracker::new();
        assert_ne!(
            first.get_status().observer_id,
            second.get_status().observer_id
        );
        let id = first.get_status().observer_id;
        first.update(Some("locked"), None, None, None);
        assert_eq!(first.get_status().observer_id, id);
    }

    #[test]
    fn registration_failures_are_independent_and_clear_stale_state() {
        let tracker = SessionStateTracker::new();
        tracker.set_monitoring(true, true, true);
        tracker.update(Some("locked"), Some("active"), Some("awake"), Some("on"));
        let state = tracker.set_monitoring(false, true, true).unwrap();
        assert!(!state.session_monitoring);
        assert_eq!(state.session, "unknown");
        assert_eq!(state.active_session, "unknown");
        assert_eq!(state.display_power, "on");
        tracker.revalidate(Some(("unlocked".into(), "active".into())), false);
        assert_eq!(tracker.get_status().session, "unknown");
        let state = tracker.set_monitoring(true, false, true).unwrap();
        assert!(!state.display_power_monitoring);
        assert_eq!(state.display_power, "unknown");
        assert!(state.system_power_monitoring);
        let state = tracker.set_monitoring(false, false, false).unwrap();
        assert_eq!(state.system_power, "unknown");
    }

    #[test]
    fn failed_resume_query_clears_session_and_display() {
        let tracker = SessionStateTracker::new();
        tracker.set_monitoring(true, true, true);
        tracker.update(
            Some("locked"),
            Some("active"),
            Some("suspending"),
            Some("off"),
        );
        let state = tracker.revalidate(None, true).unwrap();
        assert_eq!(state.session, "unknown");
        assert_eq!(state.active_session, "unknown");
        assert_eq!(state.display_power, "unknown");
        assert_eq!(state.system_power, "awake");
    }

    #[test]
    fn initial_state_is_unknown() {
        let tracker = SessionStateTracker::new();
        let status = tracker.get_status();
        assert_eq!(status.session, "unknown");
        assert_eq!(status.active_session, "unknown");
        assert_eq!(status.system_power, "unknown");
        assert_eq!(status.display_power, "unknown");
        assert_eq!(status.sequence, 0);
    }

    #[test]
    fn lock_and_unlock_updates_sequence() {
        let tracker = SessionStateTracker::new();
        let s1 = tracker
            .update(Some("locked"), Some("active"), Some("awake"), Some("on"))
            .unwrap();
        assert_eq!(s1.session, "locked");
        assert_eq!(s1.sequence, 1);

        let s2 = tracker.update(Some("unlocked"), None, None, None).unwrap();
        assert_eq!(s2.session, "unlocked");
        assert_eq!(s2.sequence, 2);
    }

    #[test]
    fn active_session_switch_and_return() {
        let tracker = SessionStateTracker::new();
        let _ = tracker.update(Some("unlocked"), Some("active"), Some("awake"), Some("on"));

        let s1 = tracker.update(None, Some("inactive"), None, None).unwrap();
        assert_eq!(s1.active_session, "inactive");
        assert_eq!(s1.sequence, 2);

        let s2 = tracker.update(None, Some("active"), None, None).unwrap();
        assert_eq!(s2.active_session, "active");
        assert_eq!(s2.sequence, 3);
    }

    #[test]
    fn display_power_changes_independently_of_session() {
        let tracker = SessionStateTracker::new();
        let _ = tracker.update(Some("unlocked"), Some("active"), Some("awake"), Some("on"));

        let s1 = tracker.update(None, None, None, Some("off")).unwrap();
        assert_eq!(s1.display_power, "off");
        assert_eq!(s1.session, "unlocked");

        let s2 = tracker.update(None, None, None, Some("on")).unwrap();
        assert_eq!(s2.display_power, "on");
        assert_eq!(s2.session, "unlocked");
    }

    #[test]
    fn suspend_resume_sequence_flow() {
        let tracker = SessionStateTracker::new();
        let _ = tracker.update(Some("unlocked"), Some("active"), Some("awake"), Some("on"));

        let s1 = tracker
            .update(None, None, Some("suspending"), None)
            .unwrap();
        assert_eq!(s1.system_power, "suspending");

        let s2 = tracker.update(None, None, Some("resuming"), None).unwrap();
        assert_eq!(s2.system_power, "resuming");

        let s3 = tracker
            .update(Some("unlocked"), Some("active"), Some("awake"), Some("on"))
            .unwrap();
        assert_eq!(s3.system_power, "awake");
    }

    #[test]
    fn duplicate_notifications_produce_no_event() {
        let tracker = SessionStateTracker::new();
        let s1 = tracker.update(Some("unlocked"), Some("active"), Some("awake"), Some("on"));
        assert!(s1.is_some());

        let s2 = tracker.update(Some("unlocked"), Some("active"), Some("awake"), Some("on"));
        assert!(s2.is_none());
    }

    #[test]
    fn rapid_conflicting_notifications_settle_to_latest() {
        let tracker = SessionStateTracker::new();
        let _ = tracker.update(Some("locked"), None, None, None);
        let _ = tracker.update(Some("unlocked"), None, None, None);
        let final_state = tracker.get_status();
        assert_eq!(final_state.session, "unlocked");
        assert_eq!(final_state.sequence, 2);
    }

    #[test]
    fn listener_or_query_failure_produces_unknown_state() {
        let tracker = SessionStateTracker::new();
        let _ = tracker.update(Some("locked"), Some("active"), Some("awake"), Some("on"));

        let s1 = tracker
            .update(Some("unknown"), Some("unknown"), None, None)
            .unwrap();
        assert_eq!(s1.session, "unknown");
        assert_eq!(s1.active_session, "unknown");
    }
}
