use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
pub struct WindowsDiscordState {
    muted: AtomicBool,
    deafened: AtomicBool,
}

impl WindowsDiscordState {
    pub fn new() -> Self {
        Self {
            muted: AtomicBool::new(false),
            deafened: AtomicBool::new(false),
        }
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

    pub async fn dispatch(&self, method: &str, params: Value) -> Result<Value, String> {
        let running = self.is_discord_running();

        match method {
            "discord.get_status" | "discord.get_state" => {
                let muted = self.muted.load(Ordering::Relaxed);
                let deafened = self.deafened.load(Ordering::Relaxed);
                Ok(serde_json::json!({
                    "status": "ok",
                    "available": running,
                    "running": running,
                    "muted": muted,
                    "deafened": deafened
                }))
            }
            "discord.toggle_mute" | "discord.toggleMute" => {
                if !running {
                    return Ok(serde_json::json!({
                        "status": "unsupported",
                        "running": false,
                        "muted": false,
                        "deafened": false
                    }));
                }
                let current = self.muted.load(Ordering::Relaxed);
                let next = !current;
                self.muted.store(next, Ordering::Relaxed);
                self.send_shortcut_toggle(next, false);
                let deafened = self.deafened.load(Ordering::Relaxed);
                Ok(serde_json::json!({
                    "status": "ok",
                    "running": true,
                    "muted": next,
                    "deafened": deafened
                }))
            }
            "discord.toggle_deafen" | "discord.toggleDeafen" => {
                if !running {
                    return Ok(serde_json::json!({
                        "status": "unsupported",
                        "running": false,
                        "muted": false,
                        "deafened": false
                    }));
                }
                let current = self.deafened.load(Ordering::Relaxed);
                let next = !current;
                self.deafened.store(next, Ordering::Relaxed);
                self.send_shortcut_toggle(next, true);
                let muted = self.muted.load(Ordering::Relaxed);
                Ok(serde_json::json!({
                    "status": "ok",
                    "running": true,
                    "muted": muted,
                    "deafened": next
                }))
            }
            "discord.set_mute" => {
                if !running {
                    return Ok(serde_json::json!({
                        "status": "unsupported",
                        "running": false
                    }));
                }
                let requested = params
                    .get("muted")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| "Missing 'muted' boolean field".to_string())?;

                let current = self.muted.load(Ordering::Relaxed);
                if current != requested {
                    self.muted.store(requested, Ordering::Relaxed);
                    self.send_shortcut_toggle(requested, false);
                }
                let deafened = self.deafened.load(Ordering::Relaxed);
                Ok(serde_json::json!({
                    "status": "ok",
                    "running": true,
                    "muted": requested,
                    "deafened": deafened
                }))
            }
            "discord.set_deafen" => {
                if !running {
                    return Ok(serde_json::json!({
                        "status": "unsupported",
                        "running": false
                    }));
                }
                let requested = params
                    .get("deafened")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| "Missing 'deafened' boolean field".to_string())?;

                let current = self.deafened.load(Ordering::Relaxed);
                if current != requested {
                    self.deafened.store(requested, Ordering::Relaxed);
                    self.send_shortcut_toggle(requested, true);
                }
                let muted = self.muted.load(Ordering::Relaxed);
                Ok(serde_json::json!({
                    "status": "ok",
                    "running": true,
                    "muted": muted,
                    "deafened": requested
                }))
            }
            _ => Err(format!("Unsupported discord method: {method}")),
        }
    }

    fn send_shortcut_toggle(&self, _target_state: bool, _is_deafen: bool) {
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

                SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
            }
        }
    }
}
