#![deny(unsafe_code)]

use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io;
use std::path::{Path, PathBuf};

mod background;
mod desktop_launch;
mod installation;
#[cfg(target_os = "linux")]
mod linux_installation;
mod macos_native_harness_broker;
#[cfg(target_os = "macos")]
mod macos_process_observation;
mod process;
mod process_supervision;
mod process_termination;
mod proxy_environment;
#[cfg(target_os = "macos")]
mod system_proxy;

pub use background::detach_from_terminal;
pub use desktop_launch::{
    DesktopProcess, launch_desktop, launch_stock_desktop, open_external_url,
    open_latest_codexhost_release,
};
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub use desktop_launch::{DesktopSession, launch_desktop_session};
#[cfg(not(target_os = "linux"))]
pub use installation::discover_codex_desktop;
#[cfg(target_os = "macos")]
pub use installation::discover_codex_desktop_from_root;
#[cfg(target_os = "macos")]
pub use installation::discover_desktop_managed_codex_cli;
#[cfg(target_os = "linux")]
pub use linux_installation::discover_codex_desktop;
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
#[cfg(target_os = "macos")]
pub use process::force_stop_desktop;
pub use process::{
    ProcessSnapshot, descendant_executable_exists, desktop_process_ids_for_installation,
    desktop_root_process_ids_for_installation, parent_process_id, process_executable_path,
    process_exists, process_snapshot, terminate_process_by_id,
};
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub use process::{
    desktop_process_tree, desktop_root_snapshots_for_installation, process_snapshots,
};
pub use process_supervision::{ChildProcessGuard, SupervisedChild, spawn_supervised};
pub use process_termination::{terminate_process_group_instance, terminate_process_instance};
pub use proxy_environment::proxy_environment;
#[cfg(target_os = "macos")]
pub use system_proxy::{SystemProxySettings, system_proxy_settings};

pub const CRATE_NAME: &str = "codexhost-platform";
pub const CODEX_CLI_PATH_ENV: &str = "CODEX_CLI_PATH";
pub const STOCK_CODEX_PATH_ENV: &str = "CODEXHOST_STOCK_CODEX_PATH";
/// Points at an explicit Codex Desktop installation root: either the package
/// directory that holds the `app` payload or the payload directory itself.
pub const CUSTOM_INSTALL_ROOT_ENV: &str = "CODEXHOST_INSTALL_ROOT";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopLaunchMode {
    LaunchServices,
    DirectExecutable,
}

impl DesktopLaunchMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LaunchServices => "launch-services",
            Self::DirectExecutable => "direct-executable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopIdentity {
    MacOsBundle {
        bundle_identifier: String,
    },
    LinuxPackage {
        package_name: String,
        brand: String,
        flavor: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopInstallation {
    pub identity: DesktopIdentity,
    pub version: String,
    pub build: String,
    pub asar_integrity: String,
    pub install_root: PathBuf,
    pub desktop_launcher: PathBuf,
    pub desktop_executable: PathBuf,
    pub packaged_codex_cli: PathBuf,
    pub executable_codex_cli: PathBuf,
}

#[derive(Debug)]
pub enum PlatformError {
    Unsupported(&'static str),
    NotFound(String),
    UnmanagedDesktopConflict,
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
            Self::UnmanagedDesktopConflict => formatter.write_str(
                "Codex Desktop is already running outside codexhost; completely quit it before starting codexhost",
            ),
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

const BASE64_STANDARD_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard-alphabet, padded base64 (RFC 4648 section 4).
///
/// The pinning handshake has to travel through an environment variable and a
/// Chromium switch, so it needs a textual digest. A local encoder keeps the
/// dependency graph unchanged: the certificate tooling deliberately adds no
/// crates.
fn base64_standard(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = u32::from(chunk[0]);
        let second = chunk.get(1).copied().map_or(0, u32::from);
        let third = chunk.get(2).copied().map_or(0, u32::from);
        let group = (first << 16) | (second << 8) | third;
        let indices = [
            (group >> 18) & 0x3f,
            (group >> 12) & 0x3f,
            (group >> 6) & 0x3f,
            group & 0x3f,
        ];
        for (position, index) in indices.into_iter().enumerate() {
            if position > chunk.len() {
                encoded.push('=');
            } else {
                encoded.push(char::from(BASE64_STANDARD_ALPHABET[index as usize]));
            }
        }
    }
    encoded
}

/// SHA-256 of `bytes`, rendered as padded standard base64.
///
/// This is the shape Chromium expects for
/// `--ignore-certificate-errors-spki-list` and the shape Node's
/// `createHash("sha256").digest("base64")` produces, so both ends of the
/// handshake compare the same string.
#[must_use]
pub fn sha256_base64(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    let mut digest = Sha256::new();
    digest.update(bytes);
    base64_standard(&digest.finalize())
}

pub fn atomic_replace_file(source: &Path, target: &Path) -> Result<(), PlatformError> {
    std::fs::rename(source, target)?;
    Ok(())
}

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

    use super::{
        CRATE_NAME, PlatformError, base64_standard, sha256_base64, temporary_directory,
        validate_proxy_target,
    };

    fn temporary_file(name: &str) -> std::path::PathBuf {
        let path = temporary_directory("codexhost-platform").join(name);
        fs::write(&path, b"test").expect("create temp file");
        path
    }

    #[test]
    fn exposes_the_platform_crate_identity() {
        assert_eq!(CRATE_NAME, "codexhost-platform");
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
    fn encodes_the_rfc_4648_base64_test_vectors() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(
                base64_standard(input.as_bytes()),
                expected,
                "input {input:?}"
            );
        }
    }

    #[test]
    fn hashes_the_known_sha256_vector() {
        assert_eq!(
            sha256_base64(b"abc"),
            "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
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
