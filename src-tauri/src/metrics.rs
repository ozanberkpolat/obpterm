//! Host CPU / memory / swap / disk for the status bar. Sampled on demand; `sysinfo` needs two
//! CPU samples to report a percentage, so the System is kept alive between calls.

use serde::Serialize;
use std::sync::Mutex;
use sysinfo::{Disks, MemoryRefreshKind, Pid, ProcessesToUpdate, RefreshKind, System};
use tauri::State;

pub struct Metrics(Mutex<Sampler>);

struct Sampler {
    system: System,
    disks: Disks,
}

impl Default for Metrics {
    fn default() -> Self {
        Self(Mutex::new(Sampler {
            system: System::new_with_specifics(
                RefreshKind::nothing().with_cpu(sysinfo::CpuRefreshKind::nothing().with_cpu_usage()).with_memory(MemoryRefreshKind::everything()),
            ),
            disks: Disks::new_with_refreshed_list(),
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

    // The disk the shell is actually working on is the one worth watching.
    let target = cwd.map(std::path::PathBuf::from);
    let disk = s
        .disks
        .list()
        .iter()
        .filter(|d| target.as_ref().is_some_and(|p| p.starts_with(d.mount_point())))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .or_else(|| s.disks.list().iter().max_by_key(|d| d.total_space()));

    HostMetrics {
        cpu: s.system.global_cpu_usage(),
        mem_used: s.system.used_memory(),
        mem_total: s.system.total_memory(),
        swap_used: s.system.used_swap(),
        swap_total: s.system.total_swap(),
        disk_used: disk.map(|d| d.total_space().saturating_sub(d.available_space())).unwrap_or(0),
        disk_total: disk.map(|d| d.total_space()).unwrap_or(0),
        disk_name: disk.map(|d| d.mount_point().display().to_string()).unwrap_or_default(),
    }
}

/// RSS of each given process tree (root pid + all descendants), in bytes. Zero for a pid
/// that is gone. Feeds the Agent Deck's per-session memory readout.
#[tauri::command]
pub fn rss_for(metrics: State<Metrics>, pids: Vec<u32>) -> Vec<u64> {
    let mut s = metrics.0.lock().unwrap();
    s.system.refresh_processes(ProcessesToUpdate::All, true);
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
