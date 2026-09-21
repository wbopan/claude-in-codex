//! Keep the official CLI in the PID launched by Desktop. Host owns the byte
//! transport in a sidecar, while the signed CLI owns its native MCP children.
use std::collections::BTreeMap;
use std::fs::{self, DirBuilder};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::ShimResult;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeLaunch {
    arguments: Vec<String>,
    environment: BTreeMap<String, String>,
}

pub(crate) fn run(mut host: Command, stock_codex: &Path) -> ShimResult<i32> {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let directory =
        std::env::temp_dir().join(format!("cxh-native-{}-{nonce:x}", std::process::id()));
    DirBuilder::new().mode(0o700).create(&directory)?;
    let socket = directory.join("backend.sock");
    let bootstrap = directory.join("launch.json");
    host.env("CODEXHOST_DESKTOP_PARENT_SOCKET", &socket)
        .env(
            "CODEXHOST_DESKTOP_PARENT_PID",
            std::process::id().to_string(),
        )
        .env("CODEXHOST_DESKTOP_PARENT_LAUNCH", &bootstrap)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .process_group(0);
    let mut child = match host.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = fs::remove_dir_all(&directory);
            return Err(error.into());
        }
    };
    let result = (|| -> ShimResult<i32> {
        let started = Instant::now();
        let launch = loop {
            if let Some(status) = child.try_wait()? {
                return Err(format!("Host exited before native bootstrap: {status}").into());
            }
            match fs::read(&bootstrap) {
                Ok(bytes) => break serde_json::from_slice::<NativeLaunch>(&bytes)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            if started.elapsed() > Duration::from_secs(20) {
                return Err("Host did not publish its native launch plan".into());
            }
            thread::sleep(Duration::from_millis(10));
        };
        fs::remove_file(&bootstrap)?;
        // exec preserves the real Desktop -> Codex relationship. No injected
        // ancestry, alternate identity, or changes to native authorization.
        let error = Command::new(stock_codex)
            .args(launch.arguments)
            .env_clear()
            .envs(launch.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .exec();
        Err(error.into())
    })();
    let _ = child.kill();
    let _ = child.wait();
    let _ = fs::remove_dir_all(directory);
    result
}
