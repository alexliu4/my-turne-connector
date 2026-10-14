use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

use crate::bridge::BridgeServer;

pub struct ManagedChild {
    child: Child,
    #[cfg(windows)]
    job: JobObject,
}

// A reader from an exited attempt must never announce replacement readiness.
struct ReadinessLease {
    active: Arc<Mutex<bool>>,
    ready: Arc<AtomicBool>,
}

impl Drop for ReadinessLease {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            *active = false;
            self.ready.store(false, Ordering::Release);
        }
    }
}

fn publish_ready(active: &Mutex<bool>, ready: &AtomicBool, port: &Mutex<Option<u16>>, value: u16) {
    let Ok(active) = active.lock() else { return };
    if !*active || value == 0 {
        return;
    }
    if let Ok(mut target) = port.lock() {
        *target = Some(value);
        ready.store(true, Ordering::Release);
        crate::logging::write("Sidecar HTTP ready");
    }
}

pub type ChildSlot = Arc<Mutex<Option<ManagedChild>>>;

pub fn supervise(
    bridge: BridgeServer,
    port: Arc<Mutex<Option<u16>>>,
    ready: Arc<AtomicBool>,
    shutting_down: Arc<AtomicBool>,
    child_slot: ChildSlot,
) {
    thread::spawn(move || {
        let mut restart_delay = Duration::from_secs(1);
        while !shutting_down.load(Ordering::Acquire) {
            ready.store(false, Ordering::Release);
            let started = Instant::now();
            crate::logging::write("Sidecar launch attempt");
            match spawn_once(&bridge, &port, &ready, &child_slot, &shutting_down) {
                Ok(status) => {
                    eprintln!("Nocturne Connector server exited with {status}");
                    crate::logging::write(&format!("Sidecar exited code={status}"));
                }
                Err(error) => {
                    eprintln!("Nocturne Connector server failed to start: {error}");
                    crate::logging::write("Sidecar failed to start or exited unsuccessfully; check installation and OS security history");
                }
            }
            ready.store(false, Ordering::Release);
            bridge.reset_after_sidecar_exit();

            if shutting_down.load(Ordering::Acquire) {
                break;
            }
            if started.elapsed() >= Duration::from_secs(60) {
                restart_delay = Duration::from_secs(1);
            }
            crate::logging::write(&format!(
                "Sidecar restart scheduled delay_seconds={}",
                restart_delay.as_secs()
            ));
            // Quit remains responsive during backoff.
            wait_for_restart(restart_delay, &shutting_down);
            restart_delay = next_restart_delay(restart_delay);
        }
    });
}

fn next_restart_delay(delay: Duration) -> Duration {
    (delay * 2).min(Duration::from_secs(30))
}

// The port is retained solely to request the same bind address after a restart.
// It is never evidence that the current sidecar is serving HTTP.
pub fn ready_port(ready: &AtomicBool, port: &Mutex<Option<u16>>) -> Option<u16> {
    let port = port.lock().ok()?;
    ready.load(Ordering::Acquire).then_some(*port).flatten()
}

fn wait_for_restart(delay: Duration, shutting_down: &AtomicBool) {
    let deadline = Instant::now() + delay;
    while !shutting_down.load(Ordering::Acquire) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        thread::sleep(remaining.min(Duration::from_millis(100)));
    }
}

pub fn stop(shutting_down: &AtomicBool, child_slot: &ChildSlot) {
    shutting_down.store(true, Ordering::Release);
    crate::logging::write("Native host shutdown requested");
    if let Ok(mut child) = child_slot.lock() {
        if let Some(process) = child.as_mut() {
            #[cfg(windows)]
            process.job.terminate();
            let _ = process.child.kill();
        }
        *child = None;
    }
}

fn spawn_once(
    _bridge: &BridgeServer,
    port: &Arc<Mutex<Option<u16>>>,
    ready: &Arc<AtomicBool>,
    child_slot: &ChildSlot,
    shutting_down: &AtomicBool,
) -> Result<i32, String> {
    ready.store(false, Ordering::Release);
    let requested_port = port.lock().ok().and_then(|current_port| *current_port);
    let executable = server_executable();
    let mut command = if executable.exists() {
        Command::new(executable)
    } else if let Ok(fallback) = std::env::var("NOCTURNE_SERVER_COMMAND") {
        Command::new(fallback)
    } else {
        crate::logging::write(
            "Sidecar executable missing; reinstall the complete Windows artifact",
        );
        return Err(format!(
            "server executable does not exist: {}",
            executable.display()
        ));
    };

    let client_dist = client_dist_directory();
    command
        .env("NOCTURNE_CONNECTOR_BIND_HOST", "127.0.0.1")
        .env(
            "PORT",
            requested_port
                .map(|value| value.to_string())
                .unwrap_or_else(|| "0".to_string()),
        )
        .env("NOCTURNE_CONNECTOR_VERSION", env!("CARGO_PKG_VERSION"))
        .env("NOCTURNE_CLIENT_DIST_DIR", client_dist)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    run_child(command, port, ready, child_slot, shutting_down)
}

fn run_child(
    mut command: Command,
    port: &Arc<Mutex<Option<u16>>>,
    ready: &Arc<AtomicBool>,
    child_slot: &ChildSlot,
    shutting_down: &AtomicBool,
) -> Result<i32, String> {
    ready.store(false, Ordering::Release);
    let mut child = command.spawn().map_err(|error| {
        crate::logging::write(&format!(
            "Sidecar process creation failed os_code={:?}; check OS security history",
            error.raw_os_error()
        ));
        error.to_string()
    })?;
    #[cfg(windows)]
    let job = match JobObject::new(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            return Err(error);
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let lease = ReadinessLease {
        active: Arc::new(Mutex::new(true)),
        ready: Arc::clone(ready),
    };
    if let Some(stdout) = stdout {
        let active = Arc::clone(&lease.active);
        let port = Arc::clone(port);
        let ready = Arc::clone(ready);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(value) = line.strip_prefix("NOCTURNE_READY_PORT=") {
                    if let Ok(value) = value.trim().parse::<u16>() {
                        publish_ready(&active, &ready, &port, value);
                    }
                }
                eprintln!("[connector] {line}");
            }
        });
    }
    if let Some(stderr) = stderr {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[connector] {line}");
            }
        });
    }

    {
        let mut slot = child_slot
            .lock()
            .map_err(|_| "child slot is poisoned".to_string())?;
        if shutting_down.load(Ordering::Acquire) {
            #[cfg(windows)]
            job.terminate();
            let _ = child.kill();
            return Err("shutdown requested during sidecar startup".to_string());
        }
        *slot = Some(ManagedChild {
            child,
            #[cfg(windows)]
            job,
        });
    }
    let status = loop {
        let result = {
            let mut slot = child_slot
                .lock()
                .map_err(|_| "child slot is poisoned".to_string())?;
            let Some(process) = slot.as_mut() else {
                return Err("server child disappeared".to_string());
            };
            process
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
        };
        if let Some(status) = result {
            break status;
        }
        thread::sleep(Duration::from_millis(100));
    };
    if let Ok(mut slot) = child_slot.lock() {
        *slot = None;
    }
    drop(lease);
    crate::logging::write(&format!(
        "Sidecar process ended exit_code={:?} success={}",
        status.code(),
        status.success()
    ));
    if status.success() {
        Ok(status.code().unwrap_or(0))
    } else {
        Err(format!("exit status {status}"))
    }
}

fn server_executable() -> PathBuf {
    if let Ok(path) = std::env::var("NOCTURNE_SERVER_EXECUTABLE") {
        return PathBuf::from(path);
    }
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
        .join(if cfg!(windows) {
            "nocturne-connector-server.exe"
        } else {
            "nocturne-connector-server"
        })
}

fn client_dist_directory() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("client")
}

#[cfg(windows)]
struct JobObject(usize);

#[cfg(windows)]
impl JobObject {
    fn new(child: &Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let job = unsafe { CreateJobObjectW(None, None) }
            .map_err(|error| format!("Unable to create server job object: {error}"))?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if let Err(error) = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(job);
            }
            return Err(format!("Unable to configure server job object: {error}"));
        }
        let process = windows::Win32::Foundation::HANDLE(child.as_raw_handle() as _);
        if let Err(error) = unsafe { AssignProcessToJobObject(job, process) } {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(job);
            }
            return Err(format!("Unable to assign server to job object: {error}"));
        }
        Ok(Self(job.0 as usize))
    }

    fn terminate(&self) {
        use windows::Win32::System::JobObjects::TerminateJobObject;
        unsafe {
            let _ = TerminateJobObject(
                windows::Win32::Foundation::HANDLE(self.0 as *mut std::ffi::c_void),
                1,
            );
        }
    }
}

#[cfg(windows)]
impl Drop for JobObject {
    fn drop(&mut self) {
        use windows::Win32::Foundation::CloseHandle;
        unsafe {
            let _ = CloseHandle(windows::Win32::Foundation::HANDLE(
                self.0 as *mut std::ffi::c_void,
            ));
        }
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    #[test]
    fn stale_reader_cannot_publish_readiness() {
        let ready = Arc::new(AtomicBool::new(false));
        let lease = ReadinessLease {
            active: Arc::new(Mutex::new(true)),
            ready: Arc::clone(&ready),
        };
        let active = Arc::clone(&lease.active);
        let port = Mutex::new(None);
        publish_ready(&active, &ready, &port, 1000);
        assert!(ready.load(Ordering::Acquire));
        drop(lease);
        publish_ready(&active, &ready, &port, 2000);
        assert!(!ready.load(Ordering::Acquire));
        assert_eq!(*port.lock().unwrap(), Some(1000));
    }
    fn fixture_command() -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--ignored",
                "--exact",
                "sidecar::recovery_tests::sidecar_process_fixture",
                "--nocapture",
            ])
            .env("NOCTURNE_SIDECAR_TEST_FIXTURE", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    #[test]
    #[ignore = "subprocess fixture, invoked only by the lifecycle test"]
    fn sidecar_process_fixture() {
        assert_eq!(
            std::env::var("NOCTURNE_SIDECAR_TEST_FIXTURE").as_deref(),
            Ok("1")
        );
        thread::sleep(Duration::from_millis(200));
        println!("NOCTURNE_READY_PORT=43210");
        thread::sleep(Duration::from_millis(500));
    }

    #[test]
    fn exit_failed_replacement_and_delayed_success_keep_port_separate_from_readiness() {
        let port = Arc::new(Mutex::new(Some(43210)));
        let ready = Arc::new(AtomicBool::new(true));
        let slot: ChildSlot = Arc::new(Mutex::new(None));
        let shutdown = Arc::new(AtomicBool::new(false));
        assert!(run_child(
            Command::new("nocturne-nonexistent-sidecar-test"),
            &port,
            &ready,
            &slot,
            &shutdown
        )
        .is_err());
        assert_eq!(*port.lock().unwrap(), Some(43210));
        assert_eq!(ready_port(&ready, &port), None);
        for _ in 0..2 {
            let (process_port, process_ready, process_slot, process_shutdown) =
                (port.clone(), ready.clone(), slot.clone(), shutdown.clone());
            let process = thread::spawn(move || {
                run_child(
                    fixture_command(),
                    &process_port,
                    &process_ready,
                    &process_slot,
                    &process_shutdown,
                )
            });
            thread::sleep(Duration::from_millis(50));
            assert_eq!(ready_port(&ready, &port), None);
            let deadline = Instant::now() + Duration::from_secs(5);
            while ready_port(&ready, &port).is_none() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(ready_port(&ready, &port), Some(43210));
            assert_eq!(process.join().unwrap(), Ok(0));
            assert_eq!(ready_port(&ready, &port), None);
            assert_eq!(*port.lock().unwrap(), Some(43210));
        }
    }

    #[test]
    fn stale_stdout_cannot_change_replacement_port_or_readiness() {
        let ready = Arc::new(AtomicBool::new(false));
        let old = ReadinessLease {
            active: Arc::new(Mutex::new(true)),
            ready: ready.clone(),
        };
        let stale_reader = old.active.clone();
        let port = Mutex::new(Some(1234));
        drop(old);
        let current = ReadinessLease {
            active: Arc::new(Mutex::new(true)),
            ready: ready.clone(),
        };
        publish_ready(&stale_reader, &ready, &port, 9999);
        assert_eq!(ready_port(&ready, &port), None);
        publish_ready(&current.active, &ready, &port, 1234);
        publish_ready(&stale_reader, &ready, &port, 9999);
        assert_eq!(ready_port(&ready, &port), Some(1234));
    }

    #[test]
    fn shutdown_interrupts_restart_backoff() {
        let shutdown = Arc::new(AtomicBool::new(false));
        let waiting = shutdown.clone();
        let worker = thread::spawn(move || wait_for_restart(Duration::from_secs(30), &waiting));
        thread::sleep(Duration::from_millis(20));
        let started = Instant::now();
        stop(&shutdown, &Arc::new(Mutex::new(None)));
        worker.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn restart_backoff_is_capped() {
        let mut delay = Duration::from_secs(1);
        let mut values = Vec::new();
        for _ in 0..8 {
            values.push(delay.as_secs());
            delay = next_restart_delay(delay);
        }
        assert_eq!(values, [1, 2, 4, 8, 16, 30, 30, 30]);
    }
}
