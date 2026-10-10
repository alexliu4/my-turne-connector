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

    pub fn launch(&self, app_id: &str) -> Result<Value, String> {
        let app_lower = app_id.trim().to_lowercase();
        let launched_app = match app_lower.as_str() {
            "vscode" | "code" => self.launch_target(&["vscode://", "code://", "code"]),
            "discord" => self.launch_target(&["discord://", "discord"]),
            "browser" | "default_browser" => self.launch_target(&["https://"]),
            "steam" => self.launch_target(&["steam://", "steam"]),
            "spotify" => self.launch_target(&["spotify://", "spotify"]),
            "terminal" | "wt" | "cmd" => self.launch_target(&["wt.exe", "cmd.exe"]),
            "calc" | "calculator" => self.launch_target(&["calc.exe"]),
            _ => {
                return Ok(serde_json::json!({
                    "status": "invalid_app",
                    "error": format!("Application '{app_id}' is not in the configured allowlist"),
                    "launched": false
                }));
            }
        };

        if launched_app {
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
                "apps": ["vscode", "discord", "browser", "steam", "spotify", "terminal", "calc"]
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

                self.launch(app_id)
            }
            _ => Err(format!("Unsupported app_launch method: {method}")),
        }
    }
}
