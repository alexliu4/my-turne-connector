use serde_json::Value;
use std::sync::Mutex;
use std::time::Instant;

#[derive(Debug, Clone)]
struct CachedStats {
    timestamp: Instant,
    cpu_percent: Option<f64>,
    memory_percent: Option<f64>,
    memory_used_bytes: Option<u64>,
    memory_total_bytes: Option<u64>,
    gpu_percent: Option<f64>,
}

#[derive(Default)]
struct CpuSample {
    idle: u64,
    kernel: u64,
    user: u64,
}

pub struct WindowsSystemStatsState {
    cache: Mutex<Option<CachedStats>>,
    last_cpu_sample: Mutex<Option<(Instant, CpuSample)>>,
}

impl WindowsSystemStatsState {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(None),
            last_cpu_sample: Mutex::new(None),
        }
    }

    pub async fn dispatch(&self, method: &str, _params: Value) -> Result<Value, String> {
        match method {
            "system_stats.get" | "systemStats.get" | "stats.get" | "system.get_stats" => {
                let stats = self.get_stats();
                Ok(stats)
            }
            _ => Err(format!("Unsupported system stats method: {method}")),
        }
    }

    fn get_stats(&self) -> Value {
        // Enforce rate limiting on sampling (at most once every 1 second)
        if let Ok(guard) = self.cache.lock() {
            if let Some(ref cached) = *guard {
                if cached.timestamp.elapsed().as_millis() < 1000 {
                    let available = cached.cpu_percent.is_some()
                        || cached.memory_percent.is_some()
                        || cached.memory_used_bytes.is_some()
                        || cached.memory_total_bytes.is_some()
                        || cached.gpu_percent.is_some();

                    return serde_json::json!({
                        "status": "ok",
                        "available": available,
                        "cpu_percent": cached.cpu_percent,
                        "memory_percent": cached.memory_percent,
                        "memory_used_bytes": cached.memory_used_bytes,
                        "memory_total_bytes": cached.memory_total_bytes,
                        "gpu_percent": cached.gpu_percent,
                    });
                }
            }
        }

        let (cpu_percent, memory_percent, memory_used_bytes, memory_total_bytes, gpu_percent) =
            self.sample_system();

        let stats = CachedStats {
            timestamp: Instant::now(),
            cpu_percent,
            memory_percent,
            memory_used_bytes,
            memory_total_bytes,
            gpu_percent,
        };

        if let Ok(mut guard) = self.cache.lock() {
            *guard = Some(stats.clone());
        }

        let available = stats.cpu_percent.is_some()
            || stats.memory_percent.is_some()
            || stats.memory_used_bytes.is_some()
            || stats.memory_total_bytes.is_some()
            || stats.gpu_percent.is_some();

        serde_json::json!({
            "status": "ok",
            "available": available,
            "cpu_percent": stats.cpu_percent,
            "memory_percent": stats.memory_percent,
            "memory_used_bytes": stats.memory_used_bytes,
            "memory_total_bytes": stats.memory_total_bytes,
            "gpu_percent": stats.gpu_percent,
        })
    }

    fn sample_system(
        &self,
    ) -> (
        Option<f64>,
        Option<f64>,
        Option<u64>,
        Option<u64>,
        Option<f64>,
    ) {
        #[cfg(windows)]
        {
            use windows::Win32::Foundation::FILETIME;
            use windows::Win32::System::SystemInformation::{
                GlobalMemoryStatusEx, MEMORYSTATUSEX,
            };
            use windows::Win32::System::Threading::GetSystemTimes;

            // Sample Memory
            let mut mem_status = MEMORYSTATUSEX::default();
            mem_status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;

            let (mem_pct, mem_used, mem_total) = unsafe {
                if GlobalMemoryStatusEx(&mut mem_status).is_ok() && mem_status.ullTotalPhys > 0 {
                    let total = mem_status.ullTotalPhys;
                    let avail = mem_status.ullAvailPhys;
                    let used = total.saturating_sub(avail);
                    let pct = ((used as f64 / total as f64) * 100.0 * 10.0).round() / 10.0;
                    (Some(pct), Some(used), Some(total))
                } else {
                    (None, None, None)
                }
            };

            // Sample CPU
            let mut idle = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();

            let cpu_pct = unsafe {
                if GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)).is_ok() {
                    let current_sample = CpuSample {
                        idle: filetime_to_u64(&idle),
                        kernel: filetime_to_u64(&kernel),
                        user: filetime_to_u64(&user),
                    };

                    let mut cpu_val = None;
                    if let Ok(mut guard) = self.last_cpu_sample.lock() {
                        if let Some((_prev_time, ref prev_sample)) = *guard {
                            let idle_diff = current_sample.idle.saturating_sub(prev_sample.idle);
                            let kernel_diff = current_sample.kernel.saturating_sub(prev_sample.kernel);
                            let user_diff = current_sample.user.saturating_sub(prev_sample.user);

                            // Note: kernel_time in GetSystemTimes includes idle_time.
                            let total_diff = kernel_diff.saturating_add(user_diff);
                            if total_diff > 0 {
                                let busy_diff = total_diff.saturating_sub(idle_diff);
                                let calculated = ((busy_diff as f64) / (total_diff as f64) * 100.0)
                                    .clamp(0.0, 100.0);
                                cpu_val = Some((calculated * 10.0).round() / 10.0);
                            }
                        }
                        *guard = Some((Instant::now(), current_sample));
                    }
                    cpu_val
                } else {
                    None
                }
            };

            (cpu_pct, mem_pct, mem_used, mem_total, None)
        }

        #[cfg(not(windows))]
        {
            (None, None, None, None, None)
        }
    }
}

impl Default for WindowsSystemStatsState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
fn filetime_to_u64(ft: &windows::Win32::Foundation::FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)
}
