use super::PlatformError;
use super::process::{ProcessSnapshot, process_snapshot, same_process_instance};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::process::{ObservedProcessTree, process_snapshots};

pub fn terminate_process_instance(
    expected: &ProcessSnapshot,
    _force: bool,
) -> Result<(), PlatformError> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let signal = if _force {
            nix::sys::signal::Signal::SIGKILL
        } else {
            nix::sys::signal::Signal::SIGTERM
        };
        ObservedProcessTree::new(expected.clone())
            .signal_processes(std::slice::from_ref(expected), signal)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (expected, _force);
        Err(PlatformError::Unsupported(
            "exact process termination requires macOS or Linux",
        ))
    }
}

pub fn terminate_process_group_instance(
    expected_root: &ProcessSnapshot,
    force: bool,
) -> Result<(), PlatformError> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let current = match process_snapshot(expected_root.id) {
            Ok(current) => current,
            Err(PlatformError::NotFound(_)) => return Ok(()),
            Err(error) => return Err(error),
        };
        if !same_process_instance(expected_root, &current) {
            return Ok(());
        }
        let group_members = process_snapshots()?
            .into_iter()
            .filter(|process| {
                process.process_group_id == current.process_group_id
                    && process.started_at_micros >= current.started_at_micros
            })
            .collect::<Vec<_>>();
        let signal = if force {
            nix::sys::signal::Signal::SIGKILL
        } else {
            nix::sys::signal::Signal::SIGTERM
        };
        ObservedProcessTree::new_with_process_group(
            current.clone(),
            Some(current.process_group_id),
            Some(current.started_at_micros),
        )
        .signal_processes(&group_members, signal)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (expected_root, force);
        Err(PlatformError::Unsupported(
            "exact process-group termination requires macOS or Linux",
        ))
    }
}
