use super::PlatformError;
use super::process::ProcessSnapshot;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::process::ObservedProcessTree;

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
