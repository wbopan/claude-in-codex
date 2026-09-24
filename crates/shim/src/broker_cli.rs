//! Hidden `--claude-in-codex-broker` command that manages the per-Harness native broker LaunchAgent.
//!
//! The npm Remote Host wrapper invokes it with the exact Node.js runtime and Host Runtime paths
//! it ships, so the LaunchAgent runs only what the package ships.

use std::error::Error;
use std::path::PathBuf;

#[cfg(target_os = "macos")]
use claude_in_codex_platform::{
    NativeHarnessBrokerInstallOutcome, NativeHarnessBrokerObservedState, NativeHarnessBrokerPaths,
    inspect_native_harness_broker, install_native_harness_broker, proxy_environment,
    stop_native_harness_broker, uninstall_native_harness_broker,
};

pub(crate) const BROKER_COMMAND: &str = "--claude-in-codex-broker";

const USAGE: &str = "usage: claude-in-codex-shim --claude-in-codex-broker install|status|stop|uninstall --node <absolute-file> --host-runtime <absolute-file> [--harness <id>]";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BrokerCommand {
    Install,
    Status,
    Stop,
    Uninstall,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BrokerCli {
    command: BrokerCommand,
    harness_id: String,
    node: PathBuf,
    host_runtime: PathBuf,
}

fn macos_absolute_path(value: &str, option: &str) -> Result<PathBuf, String> {
    if !value.starts_with('/') {
        return Err(format!("{option} must be an absolute macOS path"));
    }
    Ok(PathBuf::from(value))
}

fn parse_broker_cli(arguments: &[String]) -> Result<BrokerCli, String> {
    let Some(command) = arguments.first() else {
        return Err(USAGE.to_owned());
    };
    let command = match command.as_str() {
        "install" => BrokerCommand::Install,
        "status" => BrokerCommand::Status,
        "stop" => BrokerCommand::Stop,
        "uninstall" => BrokerCommand::Uninstall,
        unknown => Err(format!(
            "unknown native Harness broker command '{unknown}'; expected install, status, stop, or uninstall"
        ))?,
    };
    let mut node = None;
    let mut host_runtime = None;
    let mut harness_id = None;
    let mut index = 1;
    while index < arguments.len() {
        let option = arguments[index].as_str();
        let value = arguments
            .get(index + 1)
            .ok_or_else(|| format!("{option} requires a value"))?;
        match option {
            "--node" if node.is_none() => node = Some(macos_absolute_path(value, "--node")?),
            "--host-runtime" if host_runtime.is_none() => {
                host_runtime = Some(macos_absolute_path(value, "--host-runtime")?)
            }
            "--harness" if harness_id.is_none() => {
                claude_in_codex_platform::native_harness_broker_label(value)
                    .map_err(|e| e.to_string())?;
                harness_id = Some(value.clone());
            }
            "--node" | "--host-runtime" | "--harness" => {
                return Err(format!("duplicate option: {option}"));
            }
            unknown => return Err(format!("unknown native Harness broker option: {unknown}")),
        }
        index += 2;
    }
    let (Some(node), Some(host_runtime)) = (node, host_runtime) else {
        return Err(format!("--node and --host-runtime are required\n{USAGE}"));
    };
    Ok(BrokerCli {
        command,
        harness_id: harness_id.unwrap_or_else(|| "claude-code".to_owned()),
        node,
        host_runtime,
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn run_broker_cli(arguments: &[String]) -> Result<i32, Box<dyn Error>> {
    let cli = parse_broker_cli(arguments)?;
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("HOME is required to manage the current user's native Harness broker")?;
    let paths = NativeHarnessBrokerPaths {
        harness_id: &cli.harness_id,
        home: &home,
        node: &cli.node,
        host_runtime: &cli.host_runtime,
    };
    let proxy_environment = proxy_environment()
        .into_iter()
        .map(|(name, value)| {
            let name = name
                .into_string()
                .map_err(|_| "native Harness broker proxy variable name is not UTF-8")?;
            let value = value.into_string().map_err(|_| {
                format!("native Harness broker proxy value for {name} is not UTF-8")
            })?;
            Ok::<_, Box<dyn Error>>((name, value))
        })
        .collect::<Result<Vec<_>, _>>()?;
    match cli.command {
        BrokerCommand::Install => {
            let outcome = install_native_harness_broker(paths, &proxy_environment)?;
            let state = match outcome {
                NativeHarnessBrokerInstallOutcome::AlreadyRunning => "already-running",
                NativeHarnessBrokerInstallOutcome::Started => "restarted",
                NativeHarnessBrokerInstallOutcome::Installed => "installed",
                NativeHarnessBrokerInstallOutcome::Reinstalled => "reinstalled",
            };
            println!("state={state}");
        }
        BrokerCommand::Status => {
            let status = inspect_native_harness_broker(paths, &proxy_environment)?;
            let state = match status.observed {
                NativeHarnessBrokerObservedState::NotLoaded => "not-loaded",
                NativeHarnessBrokerObservedState::LoadedStopped => "stopped",
                NativeHarnessBrokerObservedState::Running => "running",
            };
            println!("state={state}");
            println!("label={}", status.label);
            println!("launchctl_target={}", status.launchctl_target);
            println!("plist={}", status.plist_path.display());
            println!("plist_matches={}", status.plist_matches);
            println!("descriptor_ready={}", status.descriptor_ready);
        }
        BrokerCommand::Stop => {
            println!("stopped={}", stop_native_harness_broker(paths)?);
        }
        BrokerCommand::Uninstall => {
            println!("removed={}", uninstall_native_harness_broker(paths)?);
        }
    }
    Ok(0)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn run_broker_cli(arguments: &[String]) -> Result<i32, Box<dyn Error>> {
    let _ = parse_broker_cli(arguments)?;
    Err("the native Harness broker is available only on macOS".into())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{BrokerCommand, parse_broker_cli};

    fn with_runtime(values: &[&str]) -> Vec<String> {
        let mut arguments = values
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>();
        arguments.extend(
            [
                "--node",
                "/opt/claude-in-codex/runtime/node",
                "--host-runtime",
                "/opt/claude-in-codex/app/host-runtime.mjs",
            ]
            .map(str::to_owned),
        );
        arguments
    }

    #[test]
    fn selected_harness_is_explicit_and_defaults_to_legacy_claude() {
        assert_eq!(
            parse_broker_cli(&with_runtime(&["status"]))
                .unwrap()
                .harness_id,
            "claude-code"
        );
        for id in ["example-harness", "other-harness", "third-harness"] {
            assert_eq!(
                parse_broker_cli(&with_runtime(&["install", "--harness", id]))
                    .unwrap()
                    .harness_id,
                id
            );
        }
        assert!(parse_broker_cli(&with_runtime(&["stop", "--harness", "../claude-code"])).is_err());
        assert!(
            parse_broker_cli(&with_runtime(&[
                "stop",
                "--harness",
                "example-harness",
                "--harness",
                "third-harness"
            ]))
            .is_err()
        );
    }

    #[test]
    fn parses_the_broker_lifecycle_commands_without_accepting_extra_arguments() {
        for (argument, expected) in [
            ("install", BrokerCommand::Install),
            ("status", BrokerCommand::Status),
            ("stop", BrokerCommand::Stop),
            ("uninstall", BrokerCommand::Uninstall),
        ] {
            assert_eq!(
                parse_broker_cli(&with_runtime(&[argument]))
                    .expect("valid command")
                    .command,
                expected
            );
        }
        assert!(parse_broker_cli(&with_runtime(&["install", "unexpected"])).is_err());
        assert!(parse_broker_cli(&[]).is_err());
    }

    #[test]
    fn requires_a_complete_absolute_runtime_pair() {
        let parsed = parse_broker_cli(&with_runtime(&["install"])).expect("absolute pair");
        assert_eq!(parsed.node, Path::new("/opt/claude-in-codex/runtime/node"));
        assert_eq!(
            parsed.host_runtime,
            Path::new("/opt/claude-in-codex/app/host-runtime.mjs")
        );

        assert!(parse_broker_cli(&["install".into()]).is_err());
        assert!(
            parse_broker_cli(&["install".into(), "--node".into(), "/opt/node".into()]).is_err()
        );
        assert!(
            parse_broker_cli(&[
                "install".into(),
                "--node".into(),
                "relative/node".into(),
                "--host-runtime".into(),
                "/opt/host-runtime.mjs".into(),
            ])
            .is_err()
        );
    }
}
