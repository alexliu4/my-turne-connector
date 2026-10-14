//! One serialized writer for native lifecycle, bridge and Bluetooth diagnostics.
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 8 * 1024;
static WRITER: Mutex<()> = Mutex::new(());

pub fn log_directory() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|base| {
        PathBuf::from(base)
            .join("Nocturne")
            .join("Connector")
            .join("logs")
    })
}

pub fn write(message: &str) {
    let Some(directory) = log_directory() else {
        return;
    };
    let Ok(_guard) = WRITER.lock() else { return };
    if append(&directory.join("host.log"), message, MAX_BYTES).is_err() {
        eprintln!("Unable to write native host diagnostic log");
    }
}

fn size(path: &Path) -> io::Result<u64> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error),
    }
}

fn archive(path: &Path, index: usize) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".{index}"));
    PathBuf::from(name)
}

fn append(path: &Path, message: &str, max_bytes: u64) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Remove oversized files from older releases before applying bounded retention.
    for candidate in std::iter::once(path.to_path_buf()).chain((1..=4).map(|i| archive(path, i))) {
        if size(&candidate)? > max_bytes {
            fs::remove_file(candidate)?;
        }
    }
    // Native callers log events and numeric state only. No bridge params, tokens,
    // pairing comparison codes or child output are passed to this writer.
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut line = format!("[{seconds}] {message}").replace(['\r', '\n', '\0'], " ");
    let mut end = line
        .len()
        .min(MAX_LINE_BYTES - 1)
        .min(max_bytes.saturating_sub(1) as usize);
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    line.truncate(end);
    line.push('\n');
    if size(path)? + line.len() as u64 > max_bytes {
        let oldest = archive(path, 4);
        if size(&oldest)? > 0 {
            fs::remove_file(oldest)?;
        }
        for index in (1..4).rev() {
            let source = archive(path, index);
            if size(&source)? > 0 {
                fs::rename(source, archive(path, index + 1))?;
            }
        }
        if size(path)? > 0 {
            fs::rename(path, archive(path, 1))?;
        }
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(line.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rotation_caps_all_files_and_keeps_newest_events() {
        let dir = std::env::temp_dir().join(format!("nocturne-log-{}", uuid::Uuid::new_v4()));
        let path = dir.join("host.log");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&path, "legacy".repeat(100)).unwrap();
        fs::write(archive(&path, 4), "legacy".repeat(100)).unwrap();
        for index in 0..20 {
            append(&path, &format!("event={index} {}", "é".repeat(100)), 64).unwrap();
        }
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 5);
        for entry in fs::read_dir(&dir).unwrap() {
            assert!(entry.unwrap().metadata().unwrap().len() <= 64);
        }
        assert!(fs::read_to_string(&path).unwrap().contains("event=19"));
        assert!(fs::read_to_string(archive(&path, 4))
            .unwrap()
            .contains("event=15"));
        fs::remove_dir_all(dir).unwrap();
    }
}
