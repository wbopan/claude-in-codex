#![cfg(target_os = "macos")]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn directory() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("native-parent-test-{nonce}"));
    fs::create_dir(&root).unwrap();
    root
}

fn executable(file: &Path, text: &str) {
    fs::write(file, text).unwrap();
    fs::set_permissions(file, fs::Permissions::from_mode(0o700)).unwrap();
}

fn shim(root: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_codexhost-shim"));
    command
        .arg("app-server")
        // Unset on purpose: the native parent topology is the macOS default.
        .env_remove("CODEXHOST_NATIVE_APP_TOOLS")
        .env("CODEXHOST_STOCK_CODEX_PATH", root.join("stock"))
        .env("CODEXHOST_HOST_NODE_PATH", root.join("host"))
        .env("CODEXHOST_HOST_RUNTIME_PATH", root.join("runtime"))
        .env("CODEXHOST_DATA_DIR", root)
        .env_remove("CODEXHOST_LAUNCHER_PID")
        .env_remove("CODEX_INTERNAL_ORIGINATOR_OVERRIDE")
        .env_remove("CODEXHOST_REMOTE_SSH_MANAGED")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    command
}

#[test]
fn official_exec_keeps_desktop_child_pid_and_moves_host_to_sidecar() {
    let root = directory();
    fs::write(root.join("runtime"), "fixture").unwrap();
    let record = root.join("identity");
    executable(
        &root.join("stock"),
        &format!(
            "#!/bin/sh\nprintf '%s %s' \"$$\" \"$PPID\" > '{}'\nexec /bin/sleep 20\n",
            record.display()
        ),
    );
    let plan = serde_json::json!({ "arguments": [], "environment": {"PATH":"/usr/bin:/bin"} });
    executable(
        &root.join("host"),
        &format!(
            "#!/bin/sh\nprintf '%s' '{}' > \"$CODEXHOST_DESKTOP_PARENT_LAUNCH.tmp\"\nmv \"$CODEXHOST_DESKTOP_PARENT_LAUNCH.tmp\" \"$CODEXHOST_DESKTOP_PARENT_LAUNCH\"\nwhile kill -0 \"$PPID\" 2>/dev/null; do /bin/sleep 0.05; done\n",
            plan
        ),
    );
    let mut process = shim(&root).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !record.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let identity = fs::read_to_string(&record).unwrap();
    assert_eq!(identity, format!("{} {}", process.id(), std::process::id()));
    process.kill().unwrap();
    process.wait().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_host_bootstrap_does_not_start_the_official_backend() {
    let root = directory();
    fs::write(root.join("runtime"), "fixture").unwrap();
    executable(&root.join("stock"), "#!/bin/sh\nexit 99\n");
    executable(&root.join("host"), "#!/bin/sh\nexit 7\n");
    let result = shim(&root).output().unwrap();
    assert!(!result.status.success());
    assert!(
        String::from_utf8_lossy(&result.stderr).contains("Host exited before native bootstrap")
    );
    fs::remove_dir_all(root).unwrap();
}
