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
            .get("type")
            .or_else(|| params.get("action"))
            .and_then(Value::as_str)
            .unwrap_or("");

        match action_type {
            "app" | "launch_app" => {
                let app_id = params
                    .get("appId")
                    .or_else(|| params.get("app"))
                    .or_else(|| params.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("");

                if app_id.is_empty() {
                    return Ok(serde_json::json!({
                        "status": "invalid_action",
                        "error": "Macro action 'app' requires an app identifier"
                    }));
                }
                let target = params.get("target").and_then(Value::as_str);
                let fallbacks: Vec<&str> = params
                    .get("fallbacks")
                    .and_then(Value::as_array)
                    .map(|arr| arr.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();

                app_launch.launch(app_id, target, &fallbacks)
            }
            "media" => {
                let control = params
                    .get("control")
                    .or_else(|| params.get("command"))
                    .and_then(Value::as_str)
                    .unwrap_or("");

                let action = match control {
                    "play" => "play",
                    "pause" => "pause",
                    "next" => "next",
                    "previous" | "prev" => "previous",
                    "toggle" => "toggle",
                    "volumeUp" | "volume_up" => "volume_up",
                    "volumeDown" | "volume_down" => "volume_down",
                    _ => {
                        return Ok(serde_json::json!({
                            "status": "invalid_action",
                            "error": format!("Unsupported media macro control '{control}'")
                        }));
                    }
                };
                media
                    .dispatch(bridge, "media.control", serde_json::json!({ "action": action }))
                    .await
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
                        "error": format!("Unsupported or failed shortcut combination '{shortcut}'")
                    }))
                }
            }
            _ => Ok(serde_json::json!({
                "status": "invalid_action",
                "error": format!("Unknown or unconfigured macro action type '{action_type}'")
            })),
        }
    }

    fn send_shortcut(&self, shortcut: &str) -> bool {
        let (modifiers, key) = match parse_shortcut(shortcut) {
            Some(res) => res,
            None => return false,
        };

        #[cfg(windows)]
        {
            use windows::Win32::UI::Input::KeyboardAndMouse::{
                SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
            };

            unsafe {
                let mut inputs: Vec<INPUT> = Vec::new();

                // Key down for modifiers
                for &mod_vk in &modifiers {
                    inputs.push(INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: mod_vk,
                                wScan: 0,
                                dwFlags: Default::default(),
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    });
                }

                // Key down for primary key
                inputs.push(INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: key,
                            wScan: 0,
                            dwFlags: Default::default(),
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                });

                // Key up for primary key
                inputs.push(INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: key,
                            wScan: 0,
                            dwFlags: KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                });

                // Key up for modifiers in reverse order
                for &mod_vk in modifiers.iter().rev() {
                    inputs.push(INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: mod_vk,
                                wScan: 0,
                                dwFlags: KEYEVENTF_KEYUP,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    });
                }

                let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
                sent == inputs.len() as u32
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (modifiers, key);
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

#[cfg(windows)]
type VirtKey = windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY;
#[cfg(not(windows))]
type VirtKey = u16;

fn parse_shortcut(shortcut: &str) -> Option<(Vec<VirtKey>, VirtKey)> {
    let parts: Vec<&str> = shortcut.split('+').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return None;
    }

    #[cfg(windows)]
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_CONTROL, VK_LWIN, VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK,
        VK_MENU, VK_RETURN, VK_SHIFT, VK_SPACE, VK_TAB, VK_VOLUME_DOWN, VK_VOLUME_MUTE,
        VK_VOLUME_UP, VIRTUAL_KEY,
    };

    let mut modifiers = Vec::new();
    let key_part = parts.last().unwrap().to_lowercase();

    for &mod_part in &parts[..parts.len() - 1] {
        match mod_part.to_lowercase().as_str() {
            #[cfg(windows)]
            "ctrl" | "control" => modifiers.push(VK_CONTROL),
            #[cfg(windows)]
            "alt" => modifiers.push(VK_MENU),
            #[cfg(windows)]
            "shift" => modifiers.push(VK_SHIFT),
            #[cfg(windows)]
            "win" | "windows" | "cmd" | "meta" => modifiers.push(VK_LWIN),
            #[cfg(not(windows))]
            "ctrl" | "control" | "alt" | "shift" | "win" | "windows" | "cmd" | "meta" => modifiers.push(1),
            _ => return None,
        }
    }

    let key = match key_part.as_str() {
        #[cfg(windows)]
        "media_play_pause" | "play_pause" => VK_MEDIA_PLAY_PAUSE,
        #[cfg(windows)]
        "media_next" | "next_track" => VK_MEDIA_NEXT_TRACK,
        #[cfg(windows)]
        "media_prev" | "prev_track" => VK_MEDIA_PREV_TRACK,
        #[cfg(windows)]
        "volume_mute" | "mute" => VK_VOLUME_MUTE,
        #[cfg(windows)]
        "volume_up" => VK_VOLUME_UP,
        #[cfg(windows)]
        "volume_down" => VK_VOLUME_DOWN,
        #[cfg(windows)]
        "space" => VK_SPACE,
        #[cfg(windows)]
        "enter" | "return" => VK_RETURN,
        #[cfg(windows)]
        "tab" => VK_TAB,
        #[cfg(windows)]
        "escape" | "esc" => VIRTUAL_KEY(0x1B),
        #[cfg(not(windows))]
        "media_play_pause" | "play_pause" | "media_next" | "next_track" | "media_prev" | "prev_track"
        | "volume_mute" | "mute" | "volume_up" | "volume_down" | "space" | "enter" | "return"
        | "tab" | "escape" | "esc" => 10,
        _ => {
            if key_part.len() == 1 {
                let ch = key_part.chars().next().unwrap();
                if ch.is_ascii_alphanumeric() {
                    let uppercase = ch.to_ascii_uppercase();
                    #[cfg(windows)]
                    { VIRTUAL_KEY(uppercase as u16) }
                    #[cfg(not(windows))]
                    { uppercase as u16 }
                } else {
                    return None;
                }
            } else if key_part.starts_with('f') && key_part.len() <= 3 {
                if let Ok(num) = key_part[1..].parse::<u16>() {
                    if (1..=12).contains(&num) {
                        #[cfg(windows)]
                        { VIRTUAL_KEY(0x70 + num - 1) }
                        #[cfg(not(windows))]
                        { 0x70 + num - 1 }
                    } else {
                        return None;
                    }
                } else {
                    return None;
                }
            } else {
                return None;
            }
        }
    };

    Some((modifiers, key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_bounded_shortcuts() {
        assert!(parse_shortcut("ctrl+shift+m").is_some());
        assert!(parse_shortcut("alt+f4").is_some());
        assert!(parse_shortcut("ctrl+alt+t").is_some());
        assert!(parse_shortcut("media_next").is_some());
        assert!(parse_shortcut("volume_up").is_some());
    }

    #[test]
    fn rejects_invalid_or_unbounded_shortcut_strings() {
        assert!(parse_shortcut("").is_none());
        assert!(parse_shortcut("invalid_modifier+a").is_none());
        assert!(parse_shortcut("ctrl+invalid_key_name").is_none());
        assert!(parse_shortcut("ctrl+f999").is_none());
    }
}
