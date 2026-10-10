use crate::bridge::BridgeServer;
use super::app_launch::WindowsAppLaunchState;
use super::media::WindowsMediaState;
use serde_json::Value;

#[derive(Default)]
pub struct WindowsMacroState;

impl WindowsMacroState {
    pub fn new() -> Self {
        Self
    }

    pub fn is_macros_available(&self) -> bool {
        #[cfg(windows)]
        {
            true
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    pub async fn execute(
        &self,
        bridge: &BridgeServer,
        app_launch: &WindowsAppLaunchState,
        media: &WindowsMediaState,
        params: &Value,
    ) -> Result<Value, String> {
        let action_type = params
            .get("action")
            .or_else(|| params.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");

        match action_type {
            "app" | "launch_app" => {
                let app_id = params
                    .get("app")
                    .or_else(|| params.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("");

                if app_id.is_empty() {
                    return Ok(serde_json::json!({
                        "status": "invalid_action",
                        "error": "Macro action 'app' requires an app identifier"
                    }));
                }
                app_launch.launch(app_id)
            }
            "media" => {
                let control = params
                    .get("control")
                    .or_else(|| params.get("command"))
                    .and_then(Value::as_str)
                    .unwrap_or("");

                let method = match control {
                    "play" => "media.control.play",
                    "pause" => "media.control.pause",
                    "next" => "media.control.next",
                    "previous" | "prev" => "media.control.previous",
                    "toggle" => "media.control.toggle",
                    "volumeUp" | "volume_up" => "media.control.volumeUp",
                    "volumeDown" | "volume_down" => "media.control.volumeDown",
                    _ => {
                        return Ok(serde_json::json!({
                            "status": "invalid_action",
                            "error": format!("Unsupported media macro control '{control}'")
                        }));
                    }
                };
                media.dispatch(bridge, method, serde_json::json!({})).await
            }
            "url" => {
                let url = params.get("url").and_then(Value::as_str).unwrap_or("").trim();
                if !url.starts_with("http://") && !url.starts_with("https://") {
                    return Ok(serde_json::json!({
                        "status": "invalid_action",
                        "error": "URL macro action requires a valid http:// or https:// URL"
                    }));
                }
                if app_launch.launch_target(&[url]) {
                    Ok(serde_json::json!({
                        "status": "ok",
                        "action": "url",
                        "url": url
                    }))
                } else {
                    Ok(serde_json::json!({
                        "status": "error",
                        "error": "Failed to open URL"
                    }))
                }
            }
            "shortcut" => {
                let shortcut = params
                    .get("shortcut")
                    .or_else(|| params.get("keys"))
                    .and_then(Value::as_str)
                    .unwrap_or("");

                if shortcut.is_empty() {
                    return Ok(serde_json::json!({
                        "status": "invalid_action",
                        "error": "Shortcut macro action requires key sequence"
                    }));
                }

                let sent = self.send_shortcut(shortcut);
                if sent {
                    Ok(serde_json::json!({
                        "status": "ok",
                        "action": "shortcut",
                        "shortcut": shortcut
                    }))
                } else {
                    Ok(serde_json::json!({
                        "status": "invalid_action",
                        "error": format!("Unsupported or failed shortcut '{shortcut}'")
                    }))
                }
            }
            _ => Ok(serde_json::json!({
                "status": "invalid_action",
                "error": format!("Unknown or unconfigured macro action type '{action_type}'")
            })),
        }
    }

    fn send_shortcut(&self, _shortcut: &str) -> bool {
        #[cfg(windows)]
        {
            use windows::Win32::UI::Input::KeyboardAndMouse::{
                SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
                VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK, VK_VOLUME_DOWN,
                VK_VOLUME_MUTE, VK_VOLUME_UP,
            };

            let vk = match _shortcut.to_lowercase().as_str() {
                "media_play_pause" | "play_pause" => VK_MEDIA_PLAY_PAUSE,
                "media_next" | "next_track" => VK_MEDIA_NEXT_TRACK,
                "media_prev" | "prev_track" => VK_MEDIA_PREV_TRACK,
                "volume_mute" | "mute" => VK_VOLUME_MUTE,
                "volume_up" => VK_VOLUME_UP,
                "volume_down" => VK_VOLUME_DOWN,
                _ => return false,
            };

            unsafe {
                let inputs = [
                    INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: vk,
                                wScan: 0,
                                dwFlags: Default::default(),
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    },
                    INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: vk,
                                wScan: 0,
                                dwFlags: KEYEVENTF_KEYUP,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    },
                ];
                let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
                sent == inputs.len() as u32
            }
        }
        #[cfg(not(windows))]
        {
            let _ = _shortcut;
            false
        }
    }

    pub async fn dispatch(
        &self,
        bridge: &BridgeServer,
        app_launch: &WindowsAppLaunchState,
        media: &WindowsMediaState,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let available = self.is_macros_available();

        match method {
            "macros.get_status" | "macro.get_status" | "macros.get_state" => {
                Ok(serde_json::json!({
                    "status": "ok",
                    "available": available
                }))
            }
            "macros.execute" | "macro.execute" | "macro.run" => {
                if !available {
                    return Ok(serde_json::json!({
                        "status": "unsupported",
                        "available": false
                    }));
                }
                self.execute(bridge, app_launch, media, &params).await
            }
            _ => Err(format!("Unsupported macro method: {method}")),
        }
    }
}
