//! Host CPU / memory / swap / disk for the status bar. Sampled on demand; `sysinfo` needs two
//! CPU samples to report a percentage, so the System is kept alive between calls.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Instant;
use sysinfo::{Disks, MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System, UpdateKind};
use tauri::State;

pub struct Metrics(Mutex<Sampler>);

struct Sampler {
    system: System,
    disks: Disks,
    /// The last few CPU readings, so one bad delta cannot pin the bar at 100%.
    cpu: Vec<f32>,
    /// Every process ever seen inside one of our shells' trees, pid → start time. The start
    /// time is what makes a remembered pid still mean the same process: Windows recycles pids
    /// aggressively, and a pid seen in a Claude tree an hour ago can be anything now.
    seen: HashMap<u32, u64>,
    /// When the process table was last refreshed, so two commands on one tick share a walk.
    refreshed_at: Option<Instant>,
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
            seen: HashMap::new(),
            refreshed_at: None,
            #[cfg(windows)]
            utility: pdh::Counter::processor_utility(),
        }))
    }
}

/// The one process-table walk both `rss_for` and `reap_leaks` read from. Memory, plus the
/// executable and command line ONLY for processes not seen before (`OnlyIfNotSet`): those are
/// the expensive fields, and they do not change for a process's lifetime.
fn refresh_table(s: &mut Sampler) {
    s.system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory().with_exe(UpdateKind::OnlyIfNotSet).with_cmd(UpdateKind::OnlyIfNotSet),
    );
    s.refreshed_at = Some(Instant::now());
}

/// parent → children, one pass over the table.
fn children_of(system: &System) -> HashMap<Pid, Vec<Pid>> {
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, proc_) in system.processes() {
        if let Some(parent) = proc_.parent() {
            children.entry(parent).or_default().push(*pid);
        }
    }
    children
}

/// `root` and everything under it. A cycle in parent links must not hang the loop.
fn descendants(children: &HashMap<Pid, Vec<Pid>>, root: Pid) -> Vec<Pid> {
    let mut out = Vec::new();
    let mut stack = vec![root];
    let mut seen = HashSet::new();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        out.push(pid);
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    out
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
    let mut guard = metrics.0.lock().unwrap();
    let s = &mut *guard; // split borrows: read `system` while writing `seen`
    refresh_table(s);
    let children = children_of(&s.system);
    let mut totals = Vec::with_capacity(pids.len());
    for &root in &pids {
        let mut total = 0u64;
        for pid in descendants(&children, Pid::from_u32(root)) {
            if let Some(p) = s.system.process(pid) {
                total += p.memory();
                // Remember it as ours, with the start time that pins the identity.
                s.seen.insert(pid.as_u32(), p.start_time());
            }
        }
        totals.push(total);
    }
    totals
}

#[derive(Serialize)]
pub struct Reaped {
    pub pid: u32,
    pub name: String,
    pub bytes: u64,
}

/// Claude Code leaks: a sub-agent's Node process can outlive its agent, and a session that
/// `/exit`s leaves them behind, reparented to nobody (anthropics/claude-code #11502). Ends a
/// process only when ALL of these hold, and leaves it alone if any cannot be checked:
///
/// 1. it was seen, by `rss_for`, inside one of OUR shells' trees, and its start time still
///    matches — so a recycled pid is not mistaken for the process that once had it;
/// 2. it is not inside any of those trees now, and its parent is gone (absent, or a process
///    started after it — that is a recycled pid too);
/// 3. its image is Node or Claude AND its command line or path says "claude" — the CLI itself,
///    not a dev server you started in a shell that has since been slept.
///
/// A Node process from VS Code, another terminal, or your own tooling never qualifies: it was
/// never inside one of our trees.
#[tauri::command]
pub fn reap_leaks(metrics: State<Metrics>, roots: Vec<u32>) -> Vec<Reaped> {
    let mut guard = metrics.0.lock().unwrap();
    let s = &mut *guard;
    // Same tick as `rss_for`: reuse its walk unless it is stale.
    if !s.refreshed_at.is_some_and(|t| t.elapsed().as_secs() < 5) {
        refresh_table(s);
    }
    let children = children_of(&s.system);
    let mut inside: HashSet<Pid> = HashSet::new();
    for &root in &roots {
        inside.extend(descendants(&children, Pid::from_u32(root)));
    }

    let mut reaped = Vec::new();
    let mut forget = Vec::new();
    for (&pid, &start) in &s.seen {
        let Some(p) = s.system.process(Pid::from_u32(pid)) else {
            forget.push(pid); // gone on its own
            continue;
        };
        if p.start_time() != start {
            forget.push(pid); // the pid now belongs to something else
            continue;
        }
        if inside.contains(&Pid::from_u32(pid)) {
            continue; // still in a live tree of ours: not a leak
        }
        let parent_gone = match p.parent().and_then(|pp| s.system.process(pp)) {
            None => true,
            Some(pp) => pp.start_time() > p.start_time(),
        };
        if !parent_gone || !is_claude_cli(p) {
            continue;
        }
        let bytes = p.memory();
        let name = p.name().to_string_lossy().into_owned();
        if p.kill() {
            reaped.push(Reaped { pid, name, bytes });
            forget.push(pid);
        } else {
            eprintln!("OBPTerm: could not end leaked process {pid} ({name})");
        }
    }
    for pid in forget {
        s.seen.remove(&pid);
    }
    reaped
}

/// Node or Claude by image, and "claude" somewhere in what it was started as.
fn is_claude_cli(p: &sysinfo::Process) -> bool {
    let name = p.name().to_string_lossy().to_ascii_lowercase();
    if !matches!(name.as_str(), "node.exe" | "node" | "claude.exe" | "claude") {
        return false;
    }
    let cmd = p.cmd().iter().map(|a| a.to_string_lossy().to_ascii_lowercase()).collect::<Vec<_>>().join(" ");
    let exe = p.exe().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    cmd.contains("claude") || exe.contains("claude")
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
