#[path = "bluetooth.rs"]
mod bluetooth;
#[path = "discord.rs"]
mod discord;
#[path = "media.rs"]
mod media;
#[path = "security.rs"]
mod security;
#[path = "system_stats.rs"]
mod system_stats;

use crate::bridge::BridgeServer;
use serde_json::Value;
use std::sync::Arc;

pub struct WindowsNativeState {
    bluetooth: Arc<bluetooth::WindowsBluetoothState>,
    discord: Arc<discord::WindowsDiscordState>,
    media: Arc<media::WindowsMediaState>,
    system_stats: Arc<system_stats::WindowsSystemStatsState>,
}

impl WindowsNativeState {
    pub fn new() -> Self {
        Self {
            bluetooth: Arc::new(bluetooth::WindowsBluetoothState::new()),
            discord: Arc::new(discord::WindowsDiscordState::new()),
            media: Arc::new(media::WindowsMediaState::new()),
            system_stats: Arc::new(system_stats::WindowsSystemStatsState::new()),
        }
    }

    pub async fn start(&self, bridge: BridgeServer) {
        self.bluetooth.start(bridge.clone()).await;
        self.media.start(bridge).await;
    }

    pub async fn replay(&self, bridge: &BridgeServer) {
        self.media.replay(bridge);
    }

    pub fn reset_routes(&self) {
        self.bluetooth.reset_routes();
    }

    pub async fn dispatch(
        &self,
        bridge: &BridgeServer,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        if method.starts_with("bluetooth.") || method.starts_with("rfcomm.") {
            return self.bluetooth.dispatch(bridge, method, params).await;
        }
        if method.starts_with("media.") || method.starts_with("volume.") {
            return self.media.dispatch(bridge, method, params).await;
        }
        if method.starts_with("discord.") {
            return self.discord.dispatch(method, params).await;
        }
        if method.starts_with("system_stats.")
            || method.starts_with("systemStats.")
            || method.starts_with("stats.")
            || method == "system.get_stats"
        {
            return self.system_stats.dispatch(method, params).await;
        }
        if method == "security.protect" {
            let value = params
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| "Missing security payload".to_string())?;
            return security::protect(value).map(|value| serde_json::json!({ "value": value }));
        }
        if method == "security.unprotect" {
            let value = params
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| "Missing security payload".to_string())?;
            return security::unprotect(value).map(|value| serde_json::json!({ "value": value }));
        }
        Err(format!("Unsupported native host method: {method}"))
    }
}
