use super::PlatformError;
use std::path::PathBuf;

#[cfg(target_os = "linux")]
static LINUX_CLOCK_TICKS_PER_SECOND: std::sync::OnceLock<u64> = std::sync::OnceLock::new();

#[cfg(all(test, target_os = "macos"))]
#[path = "process_observation_tests.rs"]
mod observation_tests;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessSnapshot {
    pub id: u32,
    pub parent_id: u32,
    pub process_group_id: u32,
    pub executable: PathBuf,
    pub started_at_micros: u64,
}

#[cfg(target_os = "macos")]
pub(crate) fn unix_process_snapshot(process_id: u32) -> Result<ProcessSnapshot, PlatformError> {
    use libproc::libproc::bsd_info::BSDInfo;
    use libproc::libproc::proc_pid::{pidinfo, pidpath};

    let native_id = i32::try_from(process_id)
        .map_err(|_| PlatformError::Invalid(format!("PID {process_id} exceeds i32::MAX")))?;
    let info = pidinfo::<BSDInfo>(native_id, 0).map_err(|error| {
        PlatformError::NotFound(format!("cannot inspect PID {process_id}: {error}"))
    })?;
    let executable = PathBuf::from(pidpath(native_id).map_err(|error| {
        PlatformError::NotFound(format!(
            "cannot resolve PID {process_id} executable: {error}"
        ))
    })?);
    Ok(ProcessSnapshot {
        id: info.pbi_pid,
        parent_id: info.pbi_ppid,
        process_group_id: info.pbi_pgid,
        executable,
        started_at_micros: info
            .pbi_start_tvsec
            .saturating_mul(1_000_000)
            .saturating_add(info.pbi_start_tvusec),
    })
}

#[cfg(target_os = "linux")]
fn linux_stat_fields(process_id: u32) -> Result<(u32, u32, u64), PlatformError> {
    let path = format!("/proc/{process_id}/stat");
    let text = std::fs::read_to_string(&path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => {
            PlatformError::NotFound(format!("cannot inspect PID {process_id}: {error}"))
        }
        _ => PlatformError::Io(error),
    })?;
    let command_end = text.rfind(')').ok_or_else(|| {
        PlatformError::Invalid(format!("PID {process_id} stat has no command terminator"))
    })?;
    let fields = text
        .get(command_end + 2..)
        .ok_or_else(|| PlatformError::Invalid(format!("PID {process_id} stat is truncated")))?
        .split_ascii_whitespace()
        .collect::<Vec<_>>();
    if fields.len() < 20 {
        return Err(PlatformError::Invalid(format!(
            "PID {process_id} stat has too few fields"
        )));
    }
    let parse = |index: usize, name: &str| {
        fields[index].parse::<u64>().map_err(|error| {
            PlatformError::Invalid(format!("PID {process_id} has invalid {name}: {error}"))
        })
    };
    let parent_id = u32::try_from(parse(1, "parent PID")?)
        .map_err(|_| PlatformError::Invalid(format!("PID {process_id} parent PID exceeds u32")))?;
    let process_group_id = u32::try_from(parse(2, "process group")?).map_err(|_| {
        PlatformError::Invalid(format!("PID {process_id} process group exceeds u32"))
    })?;
    let start_ticks = parse(19, "start time")?;
    let ticks_per_second = if let Some(ticks) = LINUX_CLOCK_TICKS_PER_SECOND.get() {
        *ticks
    } else {
        let ticks = nix::unistd::sysconf(nix::unistd::SysconfVar::CLK_TCK)
            .map_err(|error| PlatformError::Io(std::io::Error::from_raw_os_error(error as i32)))?
            .and_then(|ticks| u64::try_from(ticks).ok())
            .filter(|ticks| *ticks > 0)
            .ok_or_else(|| PlatformError::Invalid("Linux clock tick rate is unavailable".into()))?;
        let _ = LINUX_CLOCK_TICKS_PER_SECOND.set(ticks);
        ticks
    };
    let started_at_micros = start_ticks
        .saturating_mul(1_000_000)
        .checked_div(ticks_per_second)
        .ok_or_else(|| PlatformError::Invalid("Linux clock tick rate is zero".into()))?;
    Ok((parent_id, process_group_id, started_at_micros))
}

#[cfg(target_os = "linux")]
pub(crate) fn unix_process_snapshot(process_id: u32) -> Result<ProcessSnapshot, PlatformError> {
    let (parent_id, process_group_id, started_at_micros) = linux_stat_fields(process_id)?;
    let executable = std::fs::read_link(format!("/proc/{process_id}/exe")).map_err(|error| {
        match error.kind() {
            std::io::ErrorKind::NotFound => {
                PlatformError::NotFound(format!("cannot resolve PID {process_id}: {error}"))
            }
            _ => PlatformError::Io(error),
        }
    })?;
    Ok(ProcessSnapshot {
        id: process_id,
        parent_id,
        process_group_id,
        executable,
        started_at_micros,
    })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn process_snapshot(process_id: u32) -> Result<ProcessSnapshot, PlatformError> {
    unix_process_snapshot(process_id)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn process_snapshot(_process_id: u32) -> Result<ProcessSnapshot, PlatformError> {
    Err(PlatformError::Unsupported(
        "process snapshots require macOS or Linux",
    ))
}

#[cfg(target_os = "macos")]
pub fn process_snapshots() -> Result<Vec<ProcessSnapshot>, PlatformError> {
    use libproc::processes::{ProcFilter, pids_by_type};

    Ok(pids_by_type(ProcFilter::All)?
        .into_iter()
        .filter_map(|process_id| unix_process_snapshot(process_id).ok())
        .collect())
}

#[cfg(target_os = "linux")]
pub fn process_snapshots() -> Result<Vec<ProcessSnapshot>, PlatformError> {
    let entries = std::fs::read_dir("/proc")?;
    Ok(entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
        .filter_map(|process_id| unix_process_snapshot(process_id).ok())
        .collect())
}

pub(crate) fn same_process_instance(expected: &ProcessSnapshot, current: &ProcessSnapshot) -> bool {
    expected.id == current.id && expected.started_at_micros == current.started_at_micros
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn descendant_snapshots(
    roots: &[u32],
    snapshots: &[ProcessSnapshot],
) -> Vec<ProcessSnapshot> {
    let mut owned_ids = roots.to_vec();
    let mut descendants = Vec::new();
    loop {
        let mut changed = false;
        for snapshot in snapshots {
            if !owned_ids.contains(&snapshot.id) && owned_ids.contains(&snapshot.parent_id) {
                owned_ids.push(snapshot.id);
                descendants.push(snapshot.clone());
                changed = true;
            }
        }
        if !changed {
            return descendants;
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
enum RootExecutablePolicy {
    Fixed,
    FollowSameProcess,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) struct ObservedProcessTree {
    pub(crate) root: ProcessSnapshot,
    known: Vec<ProcessSnapshot>,
    process_group_id: Option<u32>,
    process_group_started_at_micros: u64,
    root_executable_policy: RootExecutablePolicy,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl ObservedProcessTree {
    pub(crate) fn new(root: ProcessSnapshot) -> Self {
        let process_group_id = (root.process_group_id == root.id).then_some(root.process_group_id);
        Self::new_with_process_group(root, process_group_id, None)
    }

    pub(crate) fn new_following_root_exec(root: ProcessSnapshot) -> Self {
        let mut tree = Self::new(root);
        tree.root_executable_policy = RootExecutablePolicy::FollowSameProcess;
        tree
    }

    pub(crate) fn new_with_process_group(
        root: ProcessSnapshot,
        process_group_id: Option<u32>,
        process_group_started_at_micros: Option<u64>,
    ) -> Self {
        Self::new_with_owned_processes(
            root,
            process_group_id,
            process_group_started_at_micros,
            Vec::new(),
        )
    }

    pub(crate) fn new_with_owned_processes(
        root: ProcessSnapshot,
        process_group_id: Option<u32>,
        process_group_started_at_micros: Option<u64>,
        mut known: Vec<ProcessSnapshot>,
    ) -> Self {
        if !known
            .iter()
            .any(|process| same_process_instance(process, &root))
        {
            known.push(root.clone());
        }
        Self {
            process_group_id,
            process_group_started_at_micros: process_group_started_at_micros
                .unwrap_or(root.started_at_micros),
            known,
            root,
            root_executable_policy: RootExecutablePolicy::Fixed,
        }
    }

    pub(crate) fn process_group_id(&self) -> u32 {
        self.process_group_id.unwrap_or(self.root.process_group_id)
    }

    pub(crate) fn observe(&mut self) -> Result<Vec<ProcessSnapshot>, PlatformError> {
        #[cfg(target_os = "macos")]
        let snapshots = super::macos_process_observation::tree_snapshots(
            self.root.id,
            &self.known,
            self.process_group_id
                .map(|group| (group, self.process_group_started_at_micros)),
        )?;
        #[cfg(target_os = "linux")]
        let snapshots = process_snapshots()?;
        self.observe_snapshots(&snapshots)
    }

    fn observe_snapshots(
        &mut self,
        snapshots: &[ProcessSnapshot],
    ) -> Result<Vec<ProcessSnapshot>, PlatformError> {
        let current_root = snapshots.iter().find(|process| process.id == self.root.id);
        if let Some(current) = current_root {
            if !same_process_instance(&self.root, current) {
                return Err(PlatformError::Invalid(format!(
                    "PID {} was reused while observing the process tree",
                    self.root.id
                )));
            }
            if current.executable != self.root.executable {
                if matches!(self.root_executable_policy, RootExecutablePolicy::Fixed) {
                    return Err(PlatformError::Invalid(format!(
                        "Desktop root PID {} changed executable identity",
                        self.root.id
                    )));
                }
                // A supervised root may legitimately exec into another executable while
                // retaining the same PID and start identity. Preserve the strict
                // process-instance check above, then follow that exact root across exec.
                self.root.executable = current.executable.clone();
            }
        }

        // `known` is an ownership ledger for live descendants, not a permanent PID history.
        // Once a descendant exits, a later unrelated process may legitimately receive the
        // same PID. Forget retired or replaced descendants here; lineage discovery below may
        // re-adopt a new process only when it is still attributable to the live owned tree.
        // The root remains strict because it anchors the entire ownership boundary.
        let mut refreshed = Vec::with_capacity(self.known.len());
        for expected in std::mem::take(&mut self.known) {
            if expected.id == self.root.id {
                refreshed.push(current_root.cloned().unwrap_or(expected));
                continue;
            }
            if let Some(current) = snapshots
                .iter()
                .find(|process| same_process_instance(&expected, process))
            {
                refreshed.push(current.clone());
            }
        }
        self.known = refreshed;
        let known_ids = self
            .known
            .iter()
            .map(|process| process.id)
            .collect::<Vec<_>>();
        let mut observed = self
            .process_group_id
            .map_or_else(Vec::new, |process_group_id| {
                snapshots
                    .iter()
                    .filter(|process| {
                        process.started_at_micros >= self.process_group_started_at_micros
                            && process.process_group_id == process_group_id
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            });
        // The Linux managed-launch group is private when it is created, but a
        // later foreign member still must not silently become owned. The root
        // itself (exec path) and known descendants prove lineage; a same-PGID
        // process that cannot be traced from either is rejected before any
        // lifecycle signal can reach it.
        #[cfg(target_os = "linux")]
        if self.process_group_id.is_some() {
            let permitted = descendant_snapshots(&known_ids, snapshots);
            if let Some(foreign) = observed.iter().find(|process| {
                !self
                    .known
                    .iter()
                    .any(|known| same_process_instance(known, process))
                    && !permitted
                        .iter()
                        .any(|descendant| same_process_instance(descendant, process))
            }) {
                return Err(PlatformError::Invalid(format!(
                    "unattributed PID {} joined the managed Desktop process group",
                    foreign.id
                )));
            }
        }
        observed.extend(descendant_snapshots(&known_ids, snapshots));
        for process in observed {
            if !self.known.iter().any(|known| known.id == process.id) {
                self.known.push(process);
            }
        }
        Ok(self
            .known
            .iter()
            .filter_map(|expected| {
                snapshots
                    .iter()
                    .find(|current| same_process_instance(expected, current))
                    .cloned()
            })
            .collect())
    }

    pub(crate) fn signal_processes(
        &self,
        processes: &[ProcessSnapshot],
        signal: nix::sys::signal::Signal,
    ) -> Result<(), PlatformError> {
        #[cfg(target_os = "macos")]
        use nix::errno::Errno;
        #[cfg(target_os = "macos")]
        use nix::sys::signal::kill;
        #[cfg(target_os = "macos")]
        use nix::unistd::Pid;

        for expected in processes {
            #[cfg(target_os = "linux")]
            {
                use rustix::process::{Pid, PidfdFlags, Signal, pidfd_open, pidfd_send_signal};

                let process_id = Pid::from_raw(expected.id as i32).ok_or_else(|| {
                    PlatformError::Invalid(format!("PID {} is invalid", expected.id))
                })?;
                let descriptor = match pidfd_open(process_id, PidfdFlags::empty()) {
                    Ok(descriptor) => descriptor,
                    Err(error) if error == rustix::io::Errno::SRCH => continue,
                    Err(error) => return Err(PlatformError::Io(error.into())),
                };
                let current = match unix_process_snapshot(expected.id) {
                    Ok(current) => current,
                    Err(PlatformError::NotFound(_)) => continue,
                    Err(error) => return Err(error),
                };
                // An observed descendant may legitimately exec after it is
                // attributed to this launch. PID plus start time is the
                // process-instance identity; its executable is not. The
                // Desktop root is checked separately in `observe()`.
                if !same_process_instance(expected, &current) {
                    return Err(PlatformError::Invalid(format!(
                        "PID {} was reused before signal delivery",
                        expected.id
                    )));
                }
                let signal = Signal::from_named_raw(signal as i32).ok_or_else(|| {
                    PlatformError::Invalid(format!("unsupported Unix signal {signal}"))
                })?;
                if let Err(error) = pidfd_send_signal(descriptor, signal)
                    && error != rustix::io::Errno::SRCH
                {
                    return Err(PlatformError::Io(error.into()));
                }
            }
            #[cfg(target_os = "macos")]
            {
                let current = match unix_process_snapshot(expected.id) {
                    Ok(current) => current,
                    Err(PlatformError::NotFound(_)) => continue,
                    Err(error) => return Err(error),
                };
                // An observed descendant may legitimately exec after it is
                // attributed to this launch. PID plus start time is the
                // process-instance identity; its executable is not. The
                // Desktop root is checked separately in `observe()`.
                if !same_process_instance(expected, &current) {
                    return Err(PlatformError::Invalid(format!(
                        "PID {} was reused before signal delivery",
                        expected.id
                    )));
                }
                let process_id = i32::try_from(expected.id).map_err(|_| {
                    PlatformError::Invalid(format!("PID {} exceeds i32::MAX", expected.id))
                })?;
                if let Err(error) = kill(Pid::from_raw(process_id), signal)
                    && error != Errno::ESRCH
                {
                    return Err(PlatformError::Io(std::io::Error::from_raw_os_error(
                        error as i32,
                    )));
                }
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub fn process_exists(process_id: u32) -> bool {
    use libproc::libproc::proc_pid::pidpath;

    i32::try_from(process_id).is_ok_and(|process_id| pidpath(process_id).is_ok())
}

#[cfg(target_os = "linux")]
pub fn process_exists(process_id: u32) -> bool {
    let Some(process_id) = i32::try_from(process_id)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
    else {
        return false;
    };
    match rustix::process::test_kill_process(process_id) {
        Ok(()) | Err(rustix::io::Errno::PERM) => true,
        Err(_) => false,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn process_exists(_process_id: u32) -> bool {
    false
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {

    use super::{ObservedProcessTree, ProcessSnapshot, process_snapshot, same_process_instance};

    fn snapshot(
        id: u32,
        parent_id: u32,
        executable: &str,
        started_at_micros: u64,
    ) -> ProcessSnapshot {
        ProcessSnapshot {
            id,
            parent_id,
            process_group_id: id,
            executable: executable.into(),
            started_at_micros,
        }
    }

    #[test]
    fn snapshots_the_current_unix_process() {
        let snapshot = process_snapshot(std::process::id()).expect("current process snapshot");
        assert_eq!(snapshot.id, std::process::id());
        assert!(snapshot.parent_id > 0);
        assert!(snapshot.process_group_id > 0);
        assert!(snapshot.executable.is_absolute());
        assert!(snapshot.started_at_micros > 0);
    }

    #[test]
    fn distinguishes_pid_reuse_from_a_legitimate_exec() {
        let original = snapshot(10, 1, "/tmp/helper", 100);
        let execed = snapshot(10, 1, "/tmp/tool", 100);
        let reused = snapshot(10, 1, "/tmp/helper", 101);
        assert!(same_process_instance(&original, &execed));
        assert!(!same_process_instance(&original, &reused));
    }

    #[test]
    fn forgets_a_retired_descendant_when_its_pid_is_reused() {
        let mut root = snapshot(10, 1, "/tmp/root", 100);
        root.process_group_id = 10;
        let mut retired = snapshot(20, 10, "/tmp/transient-helper", 101);
        retired.process_group_id = 10;
        let mut tree = ObservedProcessTree::new_with_owned_processes(
            root.clone(),
            Some(10),
            Some(100),
            vec![retired],
        );

        let reused = snapshot(20, 1, "/tmp/unrelated", 200);
        let observed = tree
            .observe_snapshots(&[root, reused])
            .expect("a reused retired descendant PID is no longer owned");

        assert_eq!(
            observed
                .iter()
                .map(|process| process.id)
                .collect::<Vec<_>>(),
            [10]
        );
        assert_eq!(
            tree.known
                .iter()
                .map(|process| process.id)
                .collect::<Vec<_>>(),
            [10]
        );
    }

    #[test]
    fn still_rejects_reuse_of_the_owned_root_pid() {
        let root = snapshot(10, 1, "/tmp/root", 100);
        let mut tree = ObservedProcessTree::new(root);
        let reused_root = snapshot(10, 1, "/tmp/unrelated", 200);

        let error = tree
            .observe_snapshots(&[reused_root])
            .expect_err("the ownership root must retain its process identity");

        assert!(error.to_string().contains("PID 10 was reused"));
    }

    #[test]
    fn readopts_a_reused_descendant_pid_only_through_current_lineage() {
        let mut root = snapshot(10, 1, "/tmp/root", 100);
        root.process_group_id = 10;
        let mut retired = snapshot(20, 10, "/tmp/old-helper", 101);
        retired.process_group_id = 10;
        let mut replacement = snapshot(20, 10, "/tmp/new-helper", 200);
        replacement.process_group_id = 10;
        let mut tree = ObservedProcessTree::new_with_owned_processes(
            root.clone(),
            Some(10),
            Some(100),
            vec![retired],
        );

        let observed = tree
            .observe_snapshots(&[root, replacement.clone()])
            .expect("a current descendant may reuse a retired descendant PID");

        assert!(
            observed
                .iter()
                .any(|process| same_process_instance(process, &replacement))
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn pidfd_signal_targets_the_observed_process_instance() {
        use std::process::Command;
        use std::thread;
        use std::time::{Duration, Instant};

        let mut child = Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let observed = process_snapshot(child.id()).expect("snapshot child");
        let tree = ObservedProcessTree::new(observed.clone());
        tree.signal_processes(&[observed], nix::sys::signal::Signal::SIGTERM)
            .expect("signal observed child");
        let started = Instant::now();
        loop {
            if child.try_wait().expect("wait child").is_some() {
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "pidfd signal did not terminate child"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}
