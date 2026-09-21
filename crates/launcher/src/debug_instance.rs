//! An opt-in local development lifecycle. Never attach to, recover, or stop a
//! Desktop outside this instance's private, unchanged application copy.
use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{
    PlatformError, ProcessSnapshot, desktop_root_process_ids_for_installation, process_snapshot,
    process_snapshots, terminate_process_instance,
};
use serde::{Deserialize, Serialize};

use crate::runtime_instance::try_acquire_launcher_guard;

const MARKER: &str = "codexhost-debug-instance-v1\n";
const PROCESS_FILE: &str = "host/debug-process.json";

fn private_directory(path: &Path) -> Result<(), Box<dyn Error>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.uid() != fs::metadata(std::env::var_os("HOME").ok_or("HOME missing")?)?.uid()
    {
        return Err(format!(
            "debug directory must be private, owned, and not a symlink: {}",
            path.display()
        )
        .into());
    }
    Ok(())
}

fn validate_root(path: &Path) -> Result<PathBuf, Box<dyn Error>> {
    if !path.is_absolute() || path.canonicalize()? != path {
        return Err("debug instance must be an absolute canonical directory".into());
    }
    private_directory(path)?;
    if fs::read_to_string(path.join("instance-version"))? != MARKER {
        return Err("directory is not a prepared debug instance".into());
    }
    for name in ["host", "codex", "electron", "claude", "broker", "app"] {
        private_directory(&path.join(name))?;
    }
    let app = path.join("app/ChatGPT.app");
    if app.canonicalize()? != app {
        return Err("debug Desktop must be an independent app copy, not a symlink".into());
    }
    Ok(path.to_path_buf())
}

fn instance_environment(
    root: &Path,
    environment: &mut Vec<(OsString, OsString)>,
    claude_credential_store: OsString,
) {
    let paths = [
        ("CODEX_HOME", "codex"),
        ("CODEX_SQLITE_HOME", "codex"),
        ("CODEX_ELECTRON_USER_DATA_PATH", "electron"),
        ("CLAUDE_CONFIG_DIR", "claude"),
        ("CODEXHOST_DATA_DIR", "host"),
        ("CODEXHOST_HARNESS_BROKER_DIR", "broker"),
        (
            "CODEXHOST_CLAUDE_BROKER_DESCRIPTOR",
            "broker/claude-code-broker-v1.json",
        ),
        ("CODEXHOST_DEBUG_INSTANCE_DIR", ""),
    ];
    environment.retain(|(key, _)| {
        !paths.iter().any(|(name, _)| key == name)
            && key != "CODEXHOST_REMOTE_SSH_MANAGED"
            && key != "CODEXHOST_PLUGIN_DIRECTORY"
            && key != "CLAUDE_SECURESTORAGE_CONFIG_DIR"
    });
    environment
        .extend(paths.map(|(key, relative)| (key.into(), root.join(relative).into_os_string())));
    // LaunchServices does not inherit the shell environment. Preserve even an empty value:
    // Claude uses it to select the default Keychain entry independently of CLAUDE_CONFIG_DIR.
    environment.push((
        "CLAUDE_SECURESTORAGE_CONFIG_DIR".into(),
        claude_credential_store,
    ));
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DebugProcess {
    desktop_pid: u32,
    desktop_started_at_micros: u64,
    desktop_executable: PathBuf,
    launcher_pid: u32,
    launcher_started_at_micros: u64,
    launcher_executable: PathBuf,
}

pub(super) struct ProcessRecordGuard {
    file: PathBuf,
    root: PathBuf,
}

impl Drop for ProcessRecordGuard {
    fn drop(&mut self) {
        // The instance launch lock remains held until this record is removed.
        if let Err(error) = cleanup_crash_reporters(&self.root) {
            eprintln!("debug crash reporter cleanup: {error}");
        }
        let _ = fs::remove_file(&self.file);
    }
}

pub(super) fn record_process(
    root: &Path,
    desktop: &ProcessSnapshot,
) -> Result<ProcessRecordGuard, Box<dyn Error>> {
    let launcher = process_snapshot(std::process::id())?;
    let record = DebugProcess {
        desktop_pid: desktop.id,
        desktop_started_at_micros: desktop.started_at_micros,
        desktop_executable: desktop.executable.clone(),
        launcher_pid: launcher.id,
        launcher_started_at_micros: launcher.started_at_micros,
        launcher_executable: launcher.executable,
    };
    let file = root.join(PROCESS_FILE);
    let temporary = file.with_extension("tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(&record)?)?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    fs::rename(&temporary, &file)?;
    Ok(ProcessRecordGuard {
        file,
        root: root.to_path_buf(),
    })
}

fn is_debug_crash_reporter(root: &Path, process: &ProcessSnapshot) -> bool {
    process
        .executable
        .starts_with(root.join("app/ChatGPT.app/Contents/Frameworks"))
        && matches!(
            process
                .executable
                .file_name()
                .and_then(|name| name.to_str()),
            Some("browser_crashpad_handler" | "chrome_crashpad_handler")
        )
}

// Crashpad detaches before the launcher's first tree observation. The dedicated
// app copy provides a narrow executable namespace, and each signal still checks
// PID + start time + executable. Never scan or signal the system app's helpers.
fn cleanup_crash_reporters(root: &Path) -> Result<(), Box<dyn Error>> {
    let reporters = process_snapshots()?
        .into_iter()
        .filter(|process| is_debug_crash_reporter(root, process))
        .collect::<Vec<_>>();
    for reporter in &reporters {
        terminate_process_instance(reporter, false)?;
    }
    let started = Instant::now();
    loop {
        let mut live = Vec::new();
        for reporter in &reporters {
            if let Some(current) = matching_process(
                reporter.id,
                reporter.started_at_micros,
                &reporter.executable,
            )? {
                live.push(current);
            }
        }
        if live.is_empty() {
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(3) {
            return Err("debug crash reporters did not exit".into());
        }
        if started.elapsed() > Duration::from_secs(1) {
            for reporter in &live {
                terminate_process_instance(reporter, true)?;
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn matching_process(
    pid: u32,
    started_at: u64,
    executable: &Path,
) -> Result<Option<ProcessSnapshot>, Box<dyn Error>> {
    match process_snapshot(pid) {
        Ok(current) => Ok((current.started_at_micros == started_at
            && current.executable == executable)
            .then_some(current)),
        Err(PlatformError::NotFound(_)) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn read_process(root: &Path) -> Result<Option<DebugProcess>, Box<dyn Error>> {
    let file = root.join(PROCESS_FILE);
    let metadata = match fs::symlink_metadata(&file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || metadata.len() > 8192 || metadata.permissions().mode() & 0o077 != 0 {
        return Err("invalid debug process record".into());
    }
    let record: DebugProcess = serde_json::from_slice(&fs::read(file)?)?;
    let expected = root.join("app/ChatGPT.app/Contents/MacOS/ChatGPT");
    if record.desktop_executable != expected || expected.canonicalize()? != expected {
        return Err("debug process record does not belong to this app copy".into());
    }
    Ok(Some(record))
}

fn stop(root: &Path) -> Result<(), Box<dyn Error>> {
    let Some(record) = read_process(root)? else {
        println!("stopped");
        return Ok(());
    };
    if let Some(desktop) = matching_process(
        record.desktop_pid,
        record.desktop_started_at_micros,
        &record.desktop_executable,
    )? {
        // Signal only the recorded process instance. Its owning launcher handles
        // descendants and controller shutdown, never an installation-wide pkill.
        terminate_process_instance(&desktop, false)?;
    }
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(20) {
        let desktop = matching_process(
            record.desktop_pid,
            record.desktop_started_at_micros,
            &record.desktop_executable,
        )?;
        let launcher = matching_process(
            record.launcher_pid,
            record.launcher_started_at_micros,
            &record.launcher_executable,
        )?;
        if desktop.is_none() && launcher.is_none() {
            println!("stopped");
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("debug shutdown timed out; no unrelated process was signalled".into())
}

fn start(root: &Path) -> Result<(), Box<dyn Error>> {
    let descriptor = root.join("host/desktop-runtime-v1.json");
    let _guard = try_acquire_launcher_guard(&root.join("host/launcher-v1.lock"))?
        .ok_or("debug instance already has a launcher; use debug:restart")?;
    let mut options = crate::default_launch_options();
    options.custom_install_root = Some(root.join("app/ChatGPT.app"));
    let options = options.resolve()?;
    let installation =
        codexhost_platform::discover_codex_desktop_from_root(&root.join("app/ChatGPT.app"))?;
    if !desktop_root_process_ids_for_installation(&installation)?.is_empty() {
        return Err("debug app copy is already running; refusing to attach or terminate it".into());
    }
    cleanup_crash_reporters(root)?;
    let control = crate::allocate_runtime_control()?;
    let mut environment = crate::desktop_environment(
        &options,
        &control,
        &std::env::current_exe()?.canonicalize()?,
        &descriptor,
        Some(root.join("host").into_os_string()),
    );
    environment.extend(crate::launcher_proxy_environment());
    instance_environment(
        root,
        &mut environment,
        std::env::var_os("CLAUDE_SECURESTORAGE_CONFIG_DIR").unwrap_or_default(),
    );
    crate::supervise_desktop(
        &installation,
        &options,
        &control.renderer_cdp_arguments,
        &environment,
        &control,
        &descriptor,
        Some(root),
    )
}

pub(super) fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let [command, root] = arguments else {
        return Err(
            "usage: codexhost debug start|stop|status <absolute-instance-directory>".into(),
        );
    };
    let root = validate_root(Path::new(root))?;
    match command.as_str() {
        "start" => start(&root),
        "stop" => stop(&root),
        "status" => {
            let record = read_process(&root)?;
            let running = record
                .as_ref()
                .map(|record| {
                    matching_process(
                        record.desktop_pid,
                        record.desktop_started_at_micros,
                        &record.desktop_executable,
                    )
                })
                .transpose()?
                .flatten()
                .is_some();
            println!(
                "{}",
                serde_json::json!({"running": running, "instance": root, "process": record})
            );
            Ok(())
        }
        _ => Err("unknown debug command".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orphan_cleanup_excludes_stable_helpers_and_other_debug_executables() {
        let root = Path::new("/private/debug");
        let mut process = process_snapshot(std::process::id()).unwrap();
        for excluded in [
            "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/browser_crashpad_handler",
            "/private/debug/app/ChatGPT.app/Contents/MacOS/ChatGPT",
            "/private/debug-other/app/ChatGPT.app/Contents/Frameworks/browser_crashpad_handler",
        ] {
            process.executable = excluded.into();
            assert!(!is_debug_crash_reporter(root, &process));
        }
        process.executable = root.join("app/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/browser_crashpad_handler");
        assert!(is_debug_crash_reporter(root, &process));
    }

    #[test]
    fn debug_environment_replaces_shared_state_and_remote_broker_routing() {
        let root = Path::new("/private/debug instance");
        let mut environment = vec![
            ("CODEX_HOME".into(), "/Users/example/.codex".into()),
            ("CODEXHOST_REMOTE_SSH_MANAGED".into(), "1".into()),
            (
                "CODEXHOST_PLUGIN_DIRECTORY".into(),
                "/shared/plugins".into(),
            ),
            ("HOME".into(), "/Users/example".into()),
        ];
        instance_environment(root, &mut environment, OsString::new());
        assert!(environment.contains(&("CODEX_HOME".into(), root.join("codex").into_os_string())));
        assert!(environment.contains(&(
            "CLAUDE_CONFIG_DIR".into(),
            root.join("claude").into_os_string()
        )));
        assert!(environment.contains(&("HOME".into(), "/Users/example".into())));
        assert!(environment.contains(&("CLAUDE_SECURESTORAGE_CONFIG_DIR".into(), OsString::new())));
        assert!(
            !environment
                .iter()
                .any(|(key, _)| key == "CODEXHOST_REMOTE_SSH_MANAGED"
                    || key == "CODEXHOST_PLUGIN_DIRECTORY")
        );
        assert_eq!(
            environment
                .iter()
                .filter(|(key, _)| key == "CODEX_HOME")
                .count(),
            1
        );
    }

    #[test]
    fn debug_environment_preserves_an_explicit_credential_store_without_duplicates() {
        let root = Path::new("/private/debug");
        let mut environment = vec![(
            "CLAUDE_SECURESTORAGE_CONFIG_DIR".into(),
            "/wrong/store".into(),
        )];
        instance_environment(root, &mut environment, "/Users/example/auth store".into());
        let stores = environment
            .iter()
            .filter(|(key, _)| key == "CLAUDE_SECURESTORAGE_CONFIG_DIR")
            .collect::<Vec<_>>();
        assert_eq!(stores.len(), 1);
        assert_eq!(stores[0].1, OsString::from("/Users/example/auth store"));
        assert!(environment.contains(&(
            "CLAUDE_CONFIG_DIR".into(),
            root.join("claude").into_os_string()
        )));
    }

    #[test]
    fn recycled_pid_and_other_executable_never_match() {
        let current = process_snapshot(std::process::id()).unwrap();
        assert!(
            matching_process(
                current.id,
                current.started_at_micros + 1,
                &current.executable
            )
            .unwrap()
            .is_none()
        );
        assert!(
            matching_process(
                current.id,
                current.started_at_micros,
                Path::new("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT")
            )
            .unwrap()
            .is_none()
        );
        assert!(
            matching_process(current.id, current.started_at_micros, &current.executable)
                .unwrap()
                .is_some()
        );
    }
}
