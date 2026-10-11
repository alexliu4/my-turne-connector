# My-Turne Windows Connector Development & Configuration Guide

## Local Development & Build Workflow

### Prerequisites
- Windows 10/11
- Bun (for backend server in `src/`)
- Rust 1.85+ & Cargo (for native components in `windows/`)

### Running Backend Server
```bash
cd src
bun install
bun run dev
```

### Checking Windows Rust Codebase
On Linux or cross-compilation target:
```bash
cargo check --manifest-path windows/Cargo.toml --target x86_64-pc-windows-gnu
```

On native Windows:
```bash
cargo check --manifest-path windows/Cargo.toml
```

---

## Configuration File Paths

Configuration files are persisted under the local state directory:
- **Windows:** `%LOCALAPPDATA%\Nocturne\Connector\`
- **Linux/Pi:** `/data/nocturne-connector/` or `/etc/nocturne-connector/`

### 1. App Launch Configuration (`app-launch-config.json`)
File Path: `%LOCALAPPDATA%\Nocturne\Connector\app-launch-config.json`

Remote execution over RPC is restricted strictly to explicitly configured application definitions. Malformed files fall back safely to default definitions.

#### Example `app-launch-config.json`:
```json
{
  "apps": {
    "vscode": {
      "id": "vscode",
      "name": "VS Code",
      "target": "vscode://",
      "fallbacks": ["code://", "code"],
      "enabled": true
    },
    "discord": {
      "id": "discord",
      "name": "Discord",
      "target": "discord://",
      "fallbacks": ["discord"],
      "enabled": true
    },
    "browser": {
      "id": "browser",
      "name": "Default Browser",
      "target": "https://usenocturne.com/",
      "enabled": true
    },
    "terminal": {
      "id": "terminal",
      "name": "Terminal",
      "target": "wt.exe",
      "fallbacks": ["cmd.exe"],
      "enabled": false
    }
  }
}
```

### 2. Macros Configuration (`macros-config.json`)
File Path: `%LOCALAPPDATA%\Nocturne\Connector\macros-config.json`

Macro actions require explicit macro IDs to execute. Unconfigured or invalid IDs are rejected safely over RPC without executing arbitrary commands or URLs.

#### Example `macros-config.json`:
```json
{
  "macros": {
    "open_vscode": {
      "id": "open_vscode",
      "name": "Launch VS Code",
      "action": {
        "type": "app",
        "appId": "vscode"
      },
      "enabled": true
    },
    "toggle_media": {
      "id": "toggle_media",
      "name": "Play/Pause Media",
      "action": {
        "type": "media",
        "control": "toggle"
      },
      "enabled": true
    },
    "open_home": {
      "id": "open_home",
      "name": "Open Nocturne Site",
      "action": {
        "type": "url",
        "url": "https://usenocturne.com/"
      },
      "enabled": true
    },
    "mute_toggle": {
      "id": "mute_toggle",
      "name": "Mute Toggle",
      "action": {
        "type": "shortcut",
        "shortcut": "ctrl+shift+m"
      },
      "enabled": true
    }
  }
}
```
