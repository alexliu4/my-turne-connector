use serde_json::Value;

#[derive(Default)]
pub struct WindowsAppLaunchState;

impl WindowsAppLaunchState {
    pub fn new() -> Self {
        Self
    }

    pub fn is_app_launch_available(&self) -> bool {
        #[cfg(windows)]
        {
            true
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    pub fn launch(&self, app_id: &str, target: Option<&str>, fallbacks: &[&str]) -> Result<Value, String> {
        let mut targets_to_try: Vec<&str> = Vec::new();
        if let Some(t) = target {
            if !t.trim().is_empty() {
                targets_to_try.push(t.trim());
            }
        }
        for fb in fallbacks {
            if !fb.trim().is_empty() && !targets_to_try.contains(&fb.trim()) {
                targets_to_try.push(fb.trim());
            }
        }

        if targets_to_try.is_empty() {
            let app_lower = app_id.trim().to_lowercase();
            match app_lower.as_str() {
                "vscode" | "code" => targets_to_try.extend_from_slice(&["vscode://", "code://", "code"]),
                "discord" => targets_to_try.extend_from_slice(&["discord://", "discord"]),
                "browser" | "default_browser" => targets_to_try.extend_from_slice(&["https://usenocturne.com/"]),
                "steam" => targets_to_try.extend_from_slice(&["steam://", "steam"]),
                "spotify" => targets_to_try.extend_from_slice(&["spotify://", "spotify"]),
                "terminal" | "wt" | "cmd" => targets_to_try.extend_from_slice(&["wt.exe", "cmd.exe"]),
                "calc" | "calculator" => targets_to_try.extend_from_slice(&["calc.exe"]),
                _ => {
                    return Ok(serde_json::json!({
                        "status": "invalid_app",
                        "error": format!("Application '{app_id}' has no valid launch targets configured"),
                        "launched": false
                    }));
                }
            }
        }

        let launched = self.launch_target(&targets_to_try);

        if launched {
            Ok(serde_json::json!({
                "status": "ok",
                "app": app_id,
                "launched": true
            }))
        } else {
            Ok(serde_json::json!({
                "status": "error",
                "error": format!("Failed to launch application '{app_id}'"),
                "launched": false
            }))
        }
    }

    pub fn launch_target(&self, targets: &[&str]) -> bool {
        #[cfg(windows)]
        {
            use windows::core::PCWSTR;
            use windows::Win32::UI::Shell::ShellExecuteW;
            use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

            let open_op: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();

            for target in targets {
                if target.trim().is_empty() {
                    continue;
                }
                let wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
                unsafe {
                    let res = ShellExecuteW(
                        None,
                        PCWSTR(open_op.as_ptr()),
                        PCWSTR(wide.as_ptr()),
                        PCWSTR::null(),
                        PCWSTR::null(),
                        SW_SHOWNORMAL,
                    );
                    if (res.0 as usize) > 32 {
                        return true;
                    }
                }
            }
            false
        }
        #[cfg(not(windows))]
        {
            let _ = targets;
            false
        }
    }

    pub async fn dispatch(&self, method: &str, params: Value) -> Result<Value, String> {
        let available = self.is_app_launch_available();

        match method {
            "app_launch.get_status"
            | "appLaunch.get_status"
            | "app.get_status"
            | "app_launch.get_state" => Ok(serde_json::json!({
                "status": "ok",
                "available": available,
            })),
            "app_launch.launch" | "appLaunch.launch" | "app.launch" => {
                if !available {
                    return Ok(serde_json::json!({
                        "status": "unsupported",
                        "available": false,
                        "launched": false
                    }));
                }
                let app_id = params
                    .get("app")
                    .or_else(|| params.get("id"))
                    .or_else(|| params.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("");

                if app_id.is_empty() {
                    return Ok(serde_json::json!({
                        "status": "invalid_app",
                        "error": "Missing application identifier",
                        "launched": false
                    }));
                }

                let target = params.get("target").and_then(Value::as_str);
                let fallbacks: Vec<&str> = params
                    .get("fallbacks")
                    .and_then(Value::as_array)
                    .map(|arr| arr.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();

                self.launch(app_id, target, &fallbacks)
            }
            _ => Err(format!("Unsupported app_launch method: {method}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_or_unconfigured_launch_targets() {
        let state = WindowsAppLaunchState::new();
        let res = state.launch("unknown_app", None, &[]).unwrap();
        assert_eq!(res.get("status").unwrap(), "invalid_app");
        assert_eq!(res.get("launched").unwrap(), false);
    }
}
