#![deny(unsafe_code)]

use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io;
use std::path::{Path, PathBuf};

mod macos_native_harness_broker;
#[cfg(target_os = "macos")]
mod macos_process_observation;
mod process;
mod process_supervision;
mod process_termination;
mod proxy_environment;
#[cfg(target_os = "macos")]
mod system_proxy;

pub use macos_native_harness_broker::{
    NATIVE_HARNESS_BROKER_LABEL, NativeHarnessBrokerCommand, NativeHarnessBrokerInstallStep,
    NativeHarnessBrokerLaunchAgentPlan, NativeHarnessBrokerLaunchctlPlan,
    NativeHarnessBrokerObservedState, NativeHarnessBrokerPaths, native_harness_broker_label,
    plan_native_harness_broker_install, plan_native_harness_broker_launch_agent,
    plan_native_harness_broker_launch_agent_with_environment, plan_native_harness_broker_launchctl,
};
#[cfg(target_os = "macos")]
pub use macos_native_harness_broker::{
    NativeHarnessBrokerInstallOutcome, NativeHarnessBrokerStatus, inspect_native_harness_broker,
    install_native_harness_broker, stop_native_harness_broker, uninstall_native_harness_broker,
};
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub use process::process_snapshots;
pub use process::{ProcessSnapshot, process_exists, process_snapshot};
pub use process_supervision::{ChildProcessGuard, SupervisedChild, spawn_supervised};
pub use process_termination::terminate_process_instance;
pub use proxy_environment::proxy_environment;
#[cfg(target_os = "macos")]
pub use system_proxy::{SystemProxySettings, system_proxy_settings};

pub const CRATE_NAME: &str = "claude-in-codex-platform";
pub const CODEX_CLI_PATH_ENV: &str = "CODEX_CLI_PATH";
pub const STOCK_CODEX_PATH_ENV: &str = "CLAUDE_IN_CODEX_STOCK_CODEX_PATH";

#[derive(Debug)]
pub enum PlatformError {
    Unsupported(&'static str),
    NotFound(String),
    Invalid(String),
    ProcessInspection {
        process_id: u32,
        operation: &'static str,
        source: io::Error,
    },
    Io(io::Error),
}

impl Display for PlatformError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(message) => write!(formatter, "{message}"),
            Self::NotFound(message) => write!(formatter, "{message}"),
            Self::Invalid(message) => write!(formatter, "{message}"),
            Self::ProcessInspection {
                process_id,
                operation,
                source,
            } => write!(
                formatter,
                "{operation} while inspecting PID {process_id}: {source}"
            ),
            Self::Io(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for PlatformError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::ProcessInspection { source, .. } | Self::Io(source) => Some(source),
            _ => None,
        }
    }
}

impl From<io::Error> for PlatformError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub fn configure_background_command(_command: &mut std::process::Command) {}

pub fn canonical_existing_file(path: &Path) -> Result<PathBuf, PlatformError> {
    if !path.is_file() {
        return Err(PlatformError::NotFound(format!(
            "executable path '{}' does not exist or is not a file",
            path.display()
        )));
    }
    path.canonicalize().map_err(PlatformError::Io)
}

pub fn node_entrypoint_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn comparable_path(path: &Path) -> Result<String, PlatformError> {
    let canonical = canonical_existing_file(path)?;
    Ok(canonical.to_string_lossy().into_owned())
}

pub fn validate_proxy_target(shim: &Path, target: &Path) -> Result<PathBuf, PlatformError> {
    let shim_identity = comparable_path(shim)?;
    let target_identity = comparable_path(target)?;
    if shim_identity == target_identity {
        return Err(PlatformError::Invalid(format!(
            "official Codex CLI resolves to the Shim itself: {}",
            target.display()
        )));
    }
    canonical_existing_file(target)
}

#[cfg(test)]
fn temporary_directory(prefix: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "{prefix}-{}-{}-{unique}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&directory).expect("create unique temp directory");
    directory
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{CRATE_NAME, PlatformError, temporary_directory, validate_proxy_target};

    fn temporary_file(name: &str) -> std::path::PathBuf {
        let path = temporary_directory("claude-in-codex-platform").join(name);
        fs::write(&path, b"test").expect("create temp file");
        path
    }

    #[test]
    fn exposes_the_platform_crate_identity() {
        assert_eq!(CRATE_NAME, "claude-in-codex-platform");
    }

    #[test]
    fn rejects_proxy_recursion() {
        let shim = temporary_file("shim.exe");
        let error = validate_proxy_target(&shim, &shim).expect_err("same path must fail");
        assert!(matches!(error, PlatformError::Invalid(_)));
    }

    #[test]
    fn accepts_distinct_existing_target() {
        let shim = temporary_file("shim.exe");
        let target = shim.parent().expect("parent").join("codex.exe");
        fs::write(&target, b"target").expect("create target");
        assert_eq!(
            validate_proxy_target(&shim, &target).expect("distinct target"),
            target.canonicalize().expect("canonical target")
        );
    }

    #[test]
    fn rejects_missing_target() {
        let shim = temporary_file("shim.exe");
        let target = shim.parent().expect("parent").join("missing.exe");
        assert!(matches!(
            validate_proxy_target(&shim, &target),
            Err(PlatformError::NotFound(_))
        ));
    }
}
