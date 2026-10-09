use serde_json::Value;

#[derive(Default)]
pub struct WindowsDiscordState;

impl WindowsDiscordState {
    pub fn new() -> Self {
        Self
    }

    pub fn is_discord_running(&self) -> bool {
        #[cfg(windows)]
        {
            use windows::Win32::System::Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            };

            unsafe {
                let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
                    Ok(handle) => handle,
                    Err(_) => return false,
                };

                let mut entry = PROCESSENTRY32W::default();
                entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

                if Process32FirstW(snapshot, &mut entry).is_ok() {
                    loop {
                        let len = entry
                            .szExeFile
                            .iter()
                            .position(|&c| c == 0)
                            .unwrap_or(entry.szExeFile.len());
                        let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                        let lower = name.to_lowercase();
                        if lower == "discord.exe"
                            || lower == "discordptb.exe"
                            || lower == "discordcanary.exe"
                            || lower == "discorddevelopment.exe"
                        {
                            let _ = windows::Win32::Foundation::CloseHandle(snapshot);
                            return true;
                        }

                        if Process32NextW(snapshot, &mut entry).is_err() {
                            break;
                        }
                    }
                }
                let _ = windows::Win32::Foundation::CloseHandle(snapshot);
            }
            false
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    pub async fn dispatch(&self, method: &str, _params: Value) -> Result<Value, String> {
        let running = self.is_discord_running();

        match method {
            "discord.get_status" | "discord.get_state" => {
                Ok(serde_json::json!({
                    "status": "ok",
                    "available": running,
                    "running": running,
                    "state_known": false,
                    "muted": Value::Null,
                    "deafened": Value::Null
                }))
            }
            "discord.toggle_mute" | "discord.toggleMute" => {
                if !running {
                    return Ok(serde_json::json!({
                        "status": "unsupported",
                        "running": false,
                        "available": false,
                        "state_known": false,
                        "muted": Value::Null,
                        "deafened": Value::Null
                    }));
                }
                let sent = self.send_shortcut_toggle(false);
                if !sent {
                    return Ok(serde_json::json!({
                        "status": "error",
                        "message": "SendInput failed to send mute shortcut",
                        "running": true,
                        "available": true,
                        "state_known": false,
                        "muted": Value::Null,
                        "deafened": Value::Null
                    }));
                }
                Ok(serde_json::json!({
                    "status": "ok",
                    "running": true,
                    "available": true,
                    "action": "toggled_mute",
                    "state_known": false,
                    "muted": Value::Null,
                    "deafened": Value::Null
                }))
            }
            "discord.toggle_deafen" | "discord.toggleDeafen" => {
                if !running {
                    return Ok(serde_json::json!({
                        "status": "unsupported",
                        "running": false,
                        "available": false,
                        "state_known": false,
                        "muted": Value::Null,
                        "deafened": Value::Null
                    }));
                }
                let sent = self.send_shortcut_toggle(true);
                if !sent {
                    return Ok(serde_json::json!({
                        "status": "error",
                        "message": "SendInput failed to send deafen shortcut",
                        "running": true,
                        "available": true,
                        "state_known": false,
                        "muted": Value::Null,
                        "deafened": Value::Null
                    }));
                }
                Ok(serde_json::json!({
                    "status": "ok",
                    "running": true,
                    "available": true,
                    "action": "toggled_deafen",
                    "state_known": false,
                    "muted": Value::Null,
                    "deafened": Value::Null
                }))
            }
            "discord.set_mute" | "discord.set_deafen" => {
                Ok(serde_json::json!({
                    "status": "unsupported",
                    "message": "Idempotent set_mute/set_deafen requires verified Discord state; use toggle_mute or toggle_deafen instead",
                    "running": running,
                    "available": running,
                    "state_known": false,
                    "muted": Value::Null,
                    "deafened": Value::Null
                }))
            }
            _ => Err(format!("Unsupported discord method: {method}")),
        }
    }

    fn send_shortcut_toggle(&self, _is_deafen: bool) -> bool {
        #[cfg(windows)]
        {
            use windows::Win32::UI::Input::KeyboardAndMouse::{
                SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
                VK_CONTROL, VK_SHIFT,
            };

            unsafe {
                let vk_key = if _is_deafen {
                    windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0x44) // 'D' key
                } else {
                    windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0x4D) // 'M' key
                };

                let inputs = [
                    INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: VK_CONTROL,
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
                                wVk: VK_SHIFT,
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
                                wVk: vk_key,
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
                                wVk: vk_key,
                                wScan: 0,
                                dwFlags: KEYEVENTF_KEYUP,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    },
                    INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: VK_SHIFT,
                                wScan: 0,
                                dwFlags: KEYEVENTF_KEYUP,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    },
                    INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: VK_CONTROL,
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
            false
        }
    }
}
