//! Host CPU / memory / swap / disk for the status bar. Sampled on demand; `sysinfo` needs two
//! CPU samples to report a percentage, so the System is kept alive between calls.

use serde::Serialize;
use std::sync::Mutex;
use sysinfo::{Disks, MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};
use tauri::State;

pub struct Metrics(Mutex<Sampler>);

struct Sampler {
    system: System,
    disks: Disks,
    /// The last few CPU readings, so one bad delta cannot pin the bar at 100%.
    cpu: Vec<f32>,
    #[cfg(windows)]
    utility: Option<pdh::Counter>,
}

impl Default for Metrics {
    fn default() -> Self {
        Self(Mutex::new(Sampler {
            system: System::new_with_specifics(
                RefreshKind::nothing().with_cpu(sysinfo::CpuRefreshKind::nothing().with_cpu_usage()).with_memory(MemoryRefreshKind::everything()),
            ),
            disks: Disks::new_with_refreshed_list(),
            cpu: Vec::new(),
            #[cfg(windows)]
            utility: pdh::Counter::processor_utility(),
        }))
    }
}

#[derive(Serialize, Default)]
pub struct HostMetrics {
    pub cpu: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub swap_used: u64,
    pub swap_total: u64,
    /// Windows commit charge — RAM plus pagefile in use — and the limit. This is the number
    /// the OS actually runs out of: physical RAM can read 80% while the pagefile fills, and
    /// the machine is a minute from swap thrash. Both 0 where the OS does not report it.
    pub commit_used: u64,
    pub commit_total: u64,
    pub disk_used: u64,
    pub disk_total: u64,
    /// Which disk the figures are for — the one holding `cwd`, else the largest.
    pub disk_name: String,
}

#[tauri::command]
pub fn host_metrics(metrics: State<Metrics>, cwd: Option<String>) -> HostMetrics {
    let mut s = metrics.0.lock().unwrap();
    s.system.refresh_cpu_usage();
    s.system.refresh_memory();
    s.disks.refresh(false);

    // `sysinfo` reports % Processor TIME — the share of wall time cores were not idle. Task
    // Manager shows % Processor UTILITY, which scales that by actual frequency over base
    // frequency, so a throttled laptop reads 100 here and 73 there, and the number the user
    // can check is the one they believe. Prefer Windows' own counter; fall back to sysinfo.
    let raw = {
        #[cfg(windows)]
        {
            s.utility.as_mut().and_then(|c| c.read()).unwrap_or_else(|| s.system.global_cpu_usage())
        }
        #[cfg(not(windows))]
        {
            s.system.global_cpu_usage()
        }
    };
    s.cpu.push(raw.clamp(0.0, 100.0));
    if s.cpu.len() > 3 {
        s.cpu.remove(0);
    }
    let cpu = s.cpu.iter().sum::<f32>() / s.cpu.len() as f32;

    // The disk the shell is actually working on is the one worth watching.
    let target = cwd.map(std::path::PathBuf::from);
    let disk = s
        .disks
        .list()
        .iter()
        .filter(|d| target.as_ref().is_some_and(|p| p.starts_with(d.mount_point())))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .or_else(|| s.disks.list().iter().max_by_key(|d| d.total_space()));

    let (commit_used, commit_total) = commit();
    HostMetrics {
        cpu,
        mem_used: s.system.used_memory(),
        mem_total: s.system.total_memory(),
        swap_used: s.system.used_swap(),
        swap_total: s.system.total_swap(),
        commit_used,
        commit_total,
        disk_used: disk.map(|d| d.total_space().saturating_sub(d.available_space())).unwrap_or(0),
        disk_total: disk.map(|d| d.total_space()).unwrap_or(0),
        disk_name: disk.map(|d| d.mount_point().display().to_string()).unwrap_or_default(),
    }
}

/// (used, limit) of the system commit charge, from the one call that reports it. `sysinfo` has
/// no notion of it — it reports physical memory and swap separately, and neither says how close
/// the OS is to refusing allocations.
#[cfg(windows)]
fn commit() -> (u64, u64) {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    if unsafe { GlobalMemoryStatusEx(&mut status) }.is_err() {
        return (0, 0);
    }
    (status.ullTotalPageFile.saturating_sub(status.ullAvailPageFile), status.ullTotalPageFile)
}

#[cfg(not(windows))]
fn commit() -> (u64, u64) {
    (0, 0)
}

/// RSS of each given process tree (root pid + all descendants), in bytes. Zero for a pid
/// that is gone. Feeds the Agent Deck's per-session memory readout.
#[tauri::command]
pub fn rss_for(metrics: State<Metrics>, pids: Vec<u32>) -> Vec<u64> {
    let mut s = metrics.0.lock().unwrap();
    // Memory + parent link only — CPU/disk/cmdline/environ cost nothing here and this sweep
    // runs every few seconds while every process on the box is at its biggest, mid fan-out.
    s.system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_memory());
    // parent -> children, one pass
    let mut children: std::collections::HashMap<Pid, Vec<Pid>> = std::collections::HashMap::new();
    for (pid, proc_) in s.system.processes() {
        if let Some(parent) = proc_.parent() {
            children.entry(parent).or_default().push(*pid);
        }
    }
    pids.iter()
        .map(|&root| {
            let mut total = 0u64;
            let mut stack = vec![Pid::from_u32(root)];
            let mut seen = std::collections::HashSet::new();
            while let Some(pid) = stack.pop() {
                if !seen.insert(pid) {
                    continue; // a cycle in parent links must not hang the loop
                }
                if let Some(p) = s.system.process(pid) {
                    total += p.memory();
                }
                if let Some(kids) = children.get(&pid) {
                    stack.extend(kids.iter().copied());
                }
            }
            total
        })
        .collect()
}

/// The one performance counter worth the FFI: `\Processor Information(_Total)\% Processor
/// Utility`, which is exactly what Task Manager's CPU column shows. Any failure along the way
/// leaves the caller on `sysinfo`, so a machine without the counter simply keeps the old number.
#[cfg(windows)]
mod pdh {
    use windows::core::PCWSTR;
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCollectQueryData, PdhGetFormattedCounterValue, PdhOpenQueryW, PDH_FMT_COUNTERVALUE,
        PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
    };

    pub struct Counter {
        query: PDH_HQUERY,
        counter: PDH_HCOUNTER,
        primed: bool,
    }

    // The handles are plain integers owned by this struct and only touched under the Mutex.
    unsafe impl Send for Counter {}

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    impl Counter {
        pub fn processor_utility() -> Option<Self> {
            unsafe {
                let mut query = PDH_HQUERY::default();
                if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
                    return None;
                }
                let path = wide("\\Processor Information(_Total)\\% Processor Utility");
                let mut counter = PDH_HCOUNTER::default();
                if PdhAddEnglishCounterW(query, PCWSTR(path.as_ptr()), 0, &mut counter) != 0 {
                    return None;
                }
                // A rate counter needs two samples; the first collection is the baseline.
                if PdhCollectQueryData(query) != 0 {
                    return None;
                }
                Some(Self { query, counter, primed: false })
            }
        }

        /// The current value, or None until the counter has two samples to work from.
        pub fn read(&mut self) -> Option<f32> {
            unsafe {
                if PdhCollectQueryData(self.query) != 0 {
                    return None;
                }
                if !self.primed {
                    self.primed = true;
                    return None;
                }
                let mut value = PDH_FMT_COUNTERVALUE::default();
                if PdhGetFormattedCounterValue(self.counter, PDH_FMT_DOUBLE, None, &mut value) != 0 {
                    return None;
                }
                Some(value.Anonymous.doubleValue as f32)
            }
        }
    }
}
