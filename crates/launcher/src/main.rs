#![forbid(unsafe_code)]

mod compatibility;
#[cfg(target_os = "macos")]
mod debug_instance;
mod desktop_attachment;
mod desktop_path_overrides;
mod installation_layout;
mod native_harness_broker;
mod runtime_instance;
#[cfg(target_os = "linux")]
mod secure_storage;
#[cfg(target_os = "macos")]
mod system_proxy_environment;

use std::env;
use std::error::Error;
use std::ffi::OsString;
#[cfg(target_os = "linux")]
use std::fmt::{self, Display, Formatter};
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::{OnceLock, mpsc};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use codexhost_platform::launch_desktop_session;
#[cfg(target_os = "macos")]
use codexhost_platform::{
    DesktopIdentity, DesktopInstallation, DesktopLaunchMode, SupervisedChild,
    canonical_existing_file, configure_background_command,
    desktop_root_process_ids_for_installation, discover_codex_desktop, node_entrypoint_path,
    spawn_supervised,
};
use compatibility::{MAX_CONTROLLER_READINESS_LINE_BYTES, parse_controller_readiness_line};
use desktop_attachment::{
    LauncherOwnership, RuntimeControl, acquire_launcher_ownership, allocate_runtime_control,
    endpoint_ready, publish_runtime_descriptor, stop_stale_launcher, wait_for_host_chain,
};
use installation_layout::InstalledResources;
use native_harness_broker::run_native_harness_broker_cli;
use runtime_instance::{
    StartupObservation, StartupState, classify_startup, default_descriptor_path, read_descriptor,
    remove_matching_descriptor,
};
#[cfg(target_os = "macos")]
use system_proxy_environment::launcher_proxy_environment;

const HOST_NODE_PATH_ENV: &str = "CODEXHOST_HOST_NODE_PATH";
const HOST_RUNTIME_PATH_ENV: &str = "CODEXHOST_HOST_RUNTIME_PATH";
const DATA_DIRECTORY_ENV: &str = "CODEXHOST_DATA_DIR";
const REMOTE_SSH_MANAGED_ENV: &str = "CODEXHOST_REMOTE_SSH_MANAGED";
const DEFAULT_AGENT_ENV: &str = "CODEXHOST_DEFAULT_AGENT";
const LAUNCHER_PID_ENV: &str = "CODEXHOST_LAUNCHER_PID";
const LAUNCHER_EXECUTABLE_ENV: &str = "CODEXHOST_LAUNCHER_EXECUTABLE";
const RUNTIME_DESCRIPTOR_PATH_ENV: &str = "CODEXHOST_RUNTIME_DESCRIPTOR_PATH";
const CONTROL_PORT_ENV: &str = "CODEXHOST_CONTROL_PORT";
const CONTROL_NONCE_ENV: &str = "CODEXHOST_CONTROL_NONCE";
const START_MENU_ARGUMENT: &str = "--start-menu";
const READY_LINE: &str = "ready";
const STARTUP_TRACE_ENV: &str = "CODEXHOST_STARTUP_TRACE";
const CONTROLLER_STOP_GRACE: Duration = Duration::from_secs(1);
#[cfg(any(target_os = "macos", target_os = "linux"))]
const DESKTOP_TREE_REFRESH_INTERVAL: Duration = Duration::from_millis(500);
#[cfg(target_os = "linux")]
const UNMANAGED_DESKTOP_MESSAGE: &str = "Codex Desktop is already running outside codexhost; completely quit it before starting codexhost";

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn desktop_tree_refresh_due(last_refresh: Instant, now: Instant) -> bool {
    now.saturating_duration_since(last_refresh) >= DESKTOP_TREE_REFRESH_INTERVAL
}

/// Data root handed to the Shim and Host as `CODEXHOST_DATA_DIR`.
///
/// An explicit local value wins. A value inherited from a managed SSH login profile names the
/// remote data root and is ignored. Without a usable value the launcher falls back to the same
/// `~/.codexhost` the Host and the npm wrapper use: the Shim enters the native parent topology
/// only when this variable is present, and without that topology the Desktop's peer
/// code-signing check rejects the `codex_app` MCP server.
fn managed_desktop_data_directory(
    data_directory: Option<OsString>,
    remote_ssh_managed: Option<OsString>,
    home: Option<OsString>,
) -> Option<OsString> {
    let explicit = if remote_ssh_managed.as_deref() == Some(std::ffi::OsStr::new("1")) {
        None
    } else {
        data_directory.filter(|value| !value.is_empty())
    };
    explicit.or_else(|| {
        home.filter(|value| !value.is_empty())
            .map(|home| PathBuf::from(home).join(".codexhost").into_os_string())
    })
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
struct UnmanagedDesktopConflict;

#[cfg(target_os = "linux")]
impl Display for UnmanagedDesktopConflict {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(UNMANAGED_DESKTOP_MESSAGE)
    }
}

#[cfg(target_os = "linux")]
impl Error for UnmanagedDesktopConflict {}

fn usage() {
    eprintln!(
        "usage:\n  codexhost\n  codexhost inspect\n  codexhost launch [--shim <absolute-file>] [--node <absolute-file>] [--host-runtime <absolute-file>] [--desktop-controller <absolute-file>] [--renderer <absolute-file>]\n  codexhost broker install|status|stop|uninstall"
    );
}

const LOOPBACK_URL_MAX_BYTES: u64 = 4096;

fn validate_loopback_root_url(value: &str) -> Result<(), &'static str> {
    let authority_and_path = value
        .strip_prefix("http://")
        .or_else(|| value.strip_prefix("https://"))
        .ok_or("native URL must use HTTP or HTTPS")?;
    let (authority, path) = authority_and_path
        .split_once('/')
        .ok_or("native URL must include a root path")?;
    if authority.contains('@') || path.contains('#') || !(path.is_empty() || path.starts_with('?'))
    {
        return Err("native URL must be an uncredentialed loopback root");
    }
    let loopback = authority
        .parse::<SocketAddr>()
        .map(|address| address.port() != 0 && address.ip().is_loopback())
        .unwrap_or_else(|_| {
            authority.rsplit_once(':').is_some_and(|(host, port)| {
                host.eq_ignore_ascii_case("localhost")
                    && port.parse::<u16>().is_ok_and(|port| port != 0)
            })
        });
    if !loopback {
        return Err("native URL must target a loopback authority with an explicit port");
    }
    Ok(())
}

fn read_bounded_loopback_url(reader: impl Read) -> Result<String, Box<dyn Error>> {
    let mut bytes = Vec::new();
    reader
        .take(LOOPBACK_URL_MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LOOPBACK_URL_MAX_BYTES {
        return Err("native URL exceeds its byte limit".into());
    }
    let value = String::from_utf8(bytes)?;
    if value.is_empty() || value.contains('\r') || value.contains('\n') {
        return Err("native URL must be one non-empty line".into());
    }
    Ok(value)
}

fn startup_trace(stage: &str) {
    if env::var_os(STARTUP_TRACE_ENV).as_deref() != Some(std::ffi::OsStr::new("1")) {
        return;
    }
    static STARTED: OnceLock<Instant> = OnceLock::new();
    let elapsed = STARTED.get_or_init(Instant::now).elapsed().as_millis();
    eprintln!("[codexhost startup +{elapsed}ms] launcher: {stage}");
}

/// Emits the exact startup-success signal consumed by the npm/dev wrappers so
/// they can return immediately instead of holding the terminal open.
fn emit_ready_line(output: &mut impl Write) -> std::io::Result<()> {
    writeln!(output, "{READY_LINE}")?;
    output.flush()
}

/// Signals startup success to the invoking parent, then detaches from the
/// controlling terminal so this Launcher keeps supervising the Desktop after
/// the command returns. Startup failures must not reach this point: they exit
/// non-zero on stderr exactly like before.
fn notify_ready_and_detach() -> Result<(), Box<dyn Error>> {
    startup_trace("publishing ready");
    emit_ready_line(&mut std::io::stdout())?;
    codexhost_platform::detach_from_terminal()?;
    Ok(())
}

fn print_installation(installation: &DesktopInstallation, process_ids: &[u32]) {
    match &installation.identity {
        DesktopIdentity::MacOsBundle { bundle_identifier } => {
            println!("platform=macos");
            println!("bundle_identifier={bundle_identifier}");
        }
        DesktopIdentity::LinuxPackage {
            package_name,
            brand,
            flavor,
        } => {
            println!("platform=linux");
            println!("package_name={package_name}");
            println!("package_brand={brand}");
            println!("package_flavor={flavor}");
        }
    }
    println!("desktop_version={}", installation.version);
    println!("desktop_build={}", installation.build);
    println!("desktop_asar_integrity={}", installation.asar_integrity);
    println!("install_root={}", installation.install_root.display());
    println!(
        "desktop_launcher={}",
        installation.desktop_launcher.display()
    );
    println!(
        "desktop_executable={}",
        installation.desktop_executable.display()
    );
    println!(
        "packaged_codex_cli={}",
        installation.packaged_codex_cli.display()
    );
    println!(
        "executable_codex_cli={}",
        installation.executable_codex_cli.display()
    );
    let process_list = process_ids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    println!("desktop_process_ids={process_list}");
}

fn inspect() -> Result<(), Box<dyn Error>> {
    let installation = discover_codex_desktop()?;
    let process_ids = codexhost_platform::desktop_process_ids_for_installation(&installation)?;
    print_installation(&installation, &process_ids);
    Ok(())
}

#[derive(Debug)]
struct LaunchOptions {
    shim: Option<PathBuf>,
    node: Option<PathBuf>,
    host_runtime: Option<PathBuf>,
    desktop_controller: Option<PathBuf>,
    renderer_extension: Option<PathBuf>,
}

#[derive(Debug)]
struct ResolvedLaunchOptions {
    shim: PathBuf,
    node: PathBuf,
    host_runtime: PathBuf,
    desktop_controller: PathBuf,
    renderer_extension: PathBuf,
}

fn required_path(arguments: &[String], index: &mut usize, option: &str) -> Result<PathBuf, String> {
    *index += 1;
    arguments
        .get(*index)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{option} requires a path"))
}

fn parse_launch_options(arguments: &[String]) -> Result<LaunchOptions, String> {
    let mut shim = None;
    let mut node = None;
    let mut host_runtime = None;
    let mut desktop_controller = None;
    let mut renderer_extension = None;
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--shim" => shim = Some(required_path(arguments, &mut index, "--shim")?),
            "--node" => node = Some(required_path(arguments, &mut index, "--node")?),
            "--host-runtime" => {
                host_runtime = Some(required_path(arguments, &mut index, "--host-runtime")?)
            }
            "--desktop-controller" => {
                desktop_controller = Some(required_path(
                    arguments,
                    &mut index,
                    "--desktop-controller",
                )?)
            }
            "--renderer" => {
                renderer_extension = Some(required_path(arguments, &mut index, "--renderer")?)
            }
            unknown => return Err(format!("unknown launch option: {unknown}")),
        }
        index += 1;
    }
    Ok(LaunchOptions {
        shim,
        node,
        host_runtime,
        desktop_controller,
        renderer_extension,
    })
}

fn absolute_file(path: &Path, label: &str) -> Result<PathBuf, Box<dyn Error>> {
    if !path.is_absolute() {
        return Err(format!("{label} must be an absolute path").into());
    }
    canonical_existing_file(path)
        .map_err(|error| format!("{label} '{}': {error}", path.display()).into())
}

fn resolve_resource_path(
    explicit: Option<PathBuf>,
    bundled: &Path,
    option: &str,
    bundled_label: &str,
) -> Result<PathBuf, Box<dyn Error>> {
    match explicit {
        Some(path) => absolute_file(&path, option),
        None => absolute_file(bundled, bundled_label),
    }
}

impl LaunchOptions {
    fn resolve(self) -> Result<ResolvedLaunchOptions, Box<dyn Error>> {
        let installed = InstalledResources::from_current_executable()?;
        Ok(ResolvedLaunchOptions {
            shim: resolve_resource_path(self.shim, &installed.shim, "--shim", "bundled Shim")?,
            node: resolve_resource_path(
                self.node,
                &installed.node,
                "--node",
                "bundled Node.js runtime",
            )?,
            host_runtime: resolve_resource_path(
                self.host_runtime,
                &installed.host_runtime,
                "--host-runtime",
                "bundled Host Runtime",
            )?,
            desktop_controller: resolve_resource_path(
                self.desktop_controller,
                &installed.desktop_controller,
                "--desktop-controller",
                "bundled Desktop Controller",
            )?,
            renderer_extension: resolve_resource_path(
                self.renderer_extension,
                &installed.renderer_extension,
                "--renderer",
                "bundled Renderer Extension",
            )?,
        })
    }
}

fn desktop_controller_command(
    options: &ResolvedLaunchOptions,
    control: &RuntimeControl,
    environment: &[(OsString, OsString)],
) -> Command {
    let mut command = Command::new(&options.node);
    command
        .arg(node_entrypoint_path(&options.desktop_controller))
        .arg("--renderer-cdp-endpoint")
        .arg(&control.renderer_cdp_endpoint)
        .arg("--renderer")
        .arg(&options.renderer_extension)
        .arg("--default-agent")
        .arg("codex")
        .arg("--attachment-port")
        .arg(control.attachment_port.to_string())
        .arg("--attachment-nonce")
        .arg(&control.nonce);
    for (name, value) in environment {
        if matches!(
            name.to_str(),
            Some(
                "CODEXHOST_STARTUP_TRACE"
                    | "HTTP_PROXY"
                    | "http_proxy"
                    | "HTTPS_PROXY"
                    | "https_proxy"
                    | "ALL_PROXY"
                    | "all_proxy"
                    | "NO_PROXY"
                    | "no_proxy"
                    | "NODE_USE_ENV_PROXY"
            )
        ) {
            command.env(name, value);
        }
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    configure_background_command(&mut command);
    command
}

fn read_bounded_controller_line(mut input: impl Read) -> std::io::Result<Vec<u8>> {
    let mut line = Vec::new();
    while line.len() < MAX_CONTROLLER_READINESS_LINE_BYTES {
        let mut byte = [0_u8; 1];
        if input.read(&mut byte)? == 0 {
            break;
        }
        line.push(byte[0]);
        if byte[0] == b'\n' {
            return Ok(line);
        }
    }
    if line.len() == MAX_CONTROLLER_READINESS_LINE_BYTES && !line.ends_with(b"\n") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Desktop Controller readiness exceeded its size limit",
        ));
    }
    Ok(line)
}

fn wait_for_controller_ready(
    controller: &mut SupervisedChild,
    timeout: Duration,
) -> Result<(), Box<dyn Error>> {
    let stdout = controller
        .take_stdout()
        .ok_or("Desktop Controller stdout is unavailable")?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(read_bounded_controller_line(stdout));
    });
    let line = receiver
        .recv_timeout(timeout)
        .map_err(|_| "Desktop Controller did not become ready before timeout")??;
    parse_controller_readiness_line(&line)
        .map(|_| ())
        .map_err(|error| format!("Desktop Controller returned invalid readiness: {error}").into())
}

fn start_desktop_controller(
    options: &ResolvedLaunchOptions,
    control: &RuntimeControl,
    environment: &[(OsString, OsString)],
) -> Result<SupervisedChild, Box<dyn Error>> {
    startup_trace("spawning Desktop Controller");
    let mut controller = spawn_supervised(&mut desktop_controller_command(
        options,
        control,
        environment,
    ))?;
    startup_trace("waiting for Desktop Controller readiness");
    match wait_for_controller_ready(&mut controller, Duration::from_secs(120)) {
        Ok(()) => {
            startup_trace("Desktop Controller ready");
            Ok(controller)
        }
        Err(error) => {
            let _ = controller.force_terminate();
            let _ = controller.wait();
            Err(error)
        }
    }
}

fn stop_desktop_controller(controller: &mut SupervisedChild) -> Result<(), Box<dyn Error>> {
    if let Some(status) = controller.try_wait()? {
        controller.disarm_cleanup();
        if !status.success() {
            return Err(format!("Desktop Controller exited unsuccessfully: {status}").into());
        }
        return Ok(());
    }

    startup_trace("stopping Desktop Controller");
    controller.terminate()?;
    let started = Instant::now();
    while started.elapsed() < CONTROLLER_STOP_GRACE {
        if controller.try_wait()?.is_some() {
            startup_trace("Desktop Controller stopped");
            controller.disarm_cleanup();
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }

    startup_trace("Desktop Controller did not stop gracefully; forcing termination");
    controller.force_terminate()?;
    let _ = controller.wait()?;
    controller.disarm_cleanup();
    startup_trace("Desktop Controller force-stopped");
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn supervise_desktop(
    installation: &DesktopInstallation,
    options: &ResolvedLaunchOptions,
    desktop_arguments: &[OsString],
    environment: &[(OsString, OsString)],
    control: &RuntimeControl,
    descriptor_path: &Path,
    debug_root: Option<&Path>,
) -> Result<(), Box<dyn Error>> {
    startup_trace("launching Codex Desktop");
    let desktop_arguments =
        desktop_path_overrides::launch_arguments(desktop_arguments, environment);
    let mut desktop = launch_desktop_session(
        installation,
        &options.shim,
        if cfg!(target_os = "macos") {
            DesktopLaunchMode::LaunchServices
        } else {
            DesktopLaunchMode::DirectExecutable
        },
        &desktop_arguments,
        environment,
        Duration::from_secs(30),
    )?;
    startup_trace("Codex Desktop launched");
    #[cfg(target_os = "macos")]
    let _debug_record = debug_root
        .map(|root| debug_instance::record_process(root, desktop.root_snapshot()))
        .transpose()?;
    #[cfg(target_os = "linux")]
    let _ = debug_root;
    let mut controller = start_desktop_controller(options, control, environment)?;
    let desktop_pid = desktop.root_snapshot().id;
    startup_trace("waiting for Host chain");
    if !wait_for_host_chain(
        desktop_pid,
        options,
        &installation.executable_codex_cli,
        Duration::from_secs(30),
    )? {
        let _ = stop_desktop_controller(&mut controller);
        let _ = desktop.shutdown(Duration::from_secs(2));
        return Err("Codex Desktop did not start the codexhost Host chain before timeout".into());
    }
    startup_trace("Host chain ready");
    let _runtime = publish_runtime_descriptor(descriptor_path, control)?;
    startup_trace("runtime descriptor published");
    notify_ready_and_detach()?;
    let mut last_desktop_tree_refresh = Instant::now();
    loop {
        if let Some(status) = controller.try_wait()? {
            let _ = desktop.shutdown(Duration::from_secs(2));
            return Err(
                format!("Desktop Controller exited while Desktop was running: {status}").into(),
            );
        }
        let now = Instant::now();
        // Check only the owned Desktop root on every 100 ms lifecycle tick. Refresh the full
        // process tree less often so newly spawned descendants remain attributable for cleanup
        // without repeatedly enumerating every system process while the Desktop is idle.
        let root_is_running = desktop.is_running()?;
        let refresh_desktop_tree = desktop_tree_refresh_due(last_desktop_tree_refresh, now);
        let desktop_is_running = if root_is_running && refresh_desktop_tree {
            let live = desktop.observe()?;
            last_desktop_tree_refresh = now;
            live.iter().any(|process| process.id == desktop_pid)
        } else {
            root_is_running
        };
        if !desktop_is_running {
            stop_desktop_controller(&mut controller)?;
            desktop.cleanup_escaped(Duration::from_secs(2))?;
            desktop.disarm_cleanup();
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn desktop_environment(
    options: &ResolvedLaunchOptions,
    control: &RuntimeControl,
    launcher_executable: &Path,
    descriptor_path: &Path,
    data_directory: Option<OsString>,
) -> Vec<(OsString, OsString)> {
    let mut environment = vec![
        (
            OsString::from(HOST_NODE_PATH_ENV),
            options.node.as_os_str().to_owned(),
        ),
        (
            OsString::from(HOST_RUNTIME_PATH_ENV),
            options.host_runtime.as_os_str().to_owned(),
        ),
        (OsString::from(DEFAULT_AGENT_ENV), OsString::from("codex")),
        (
            OsString::from(LAUNCHER_PID_ENV),
            OsString::from(std::process::id().to_string()),
        ),
        (
            OsString::from(LAUNCHER_EXECUTABLE_ENV),
            launcher_executable.as_os_str().to_owned(),
        ),
        (
            OsString::from(RUNTIME_DESCRIPTOR_PATH_ENV),
            descriptor_path.as_os_str().to_owned(),
        ),
        (
            OsString::from(CONTROL_PORT_ENV),
            OsString::from(control.attachment_port.to_string()),
        ),
        (
            OsString::from(CONTROL_NONCE_ENV),
            OsString::from(&control.nonce),
        ),
    ];
    if let Some(data_directory) = data_directory {
        environment.push((OsString::from(DATA_DIRECTORY_ENV), data_directory));
    }
    if env::var_os(STARTUP_TRACE_ENV).as_deref() == Some(std::ffi::OsStr::new("1")) {
        environment.push((OsString::from(STARTUP_TRACE_ENV), OsString::from("1")));
    }
    // Native app tools are on by default; only the explicit opt-out has to reach the Shim.
    if cfg!(target_os = "macos")
        && env::var_os("CODEXHOST_NATIVE_APP_TOOLS").as_deref() == Some(std::ffi::OsStr::new("0"))
    {
        environment.push(("CODEXHOST_NATIVE_APP_TOOLS".into(), "0".into()));
    }
    environment.extend(desktop_path_overrides::forwarded(env::vars_os()));
    environment
}

#[cfg(not(target_os = "linux"))]
fn launch(
    options: LaunchOptions,
    _interactive_running_desktop: bool,
) -> Result<(), Box<dyn Error>> {
    startup_trace("launch requested");
    let options = options.resolve()?;
    startup_trace("resources resolved");
    let installation = discover_codex_desktop()?;
    startup_trace("Codex Desktop installation discovered");
    startup_trace("acquiring Launcher ownership");
    let _launcher_guard = match acquire_launcher_ownership(&installation, Duration::from_secs(120))?
    {
        LauncherOwnership::Acquired(guard) => {
            startup_trace("Launcher ownership acquired");
            guard
        }
        LauncherOwnership::Attached => {
            startup_trace("attached to existing controlled Desktop");
            return Ok(());
        }
    };

    loop {
        let roots = desktop_root_process_ids_for_installation(&installation)?;
        let descriptor_path = default_descriptor_path()?;
        let descriptor = read_descriptor(&descriptor_path).ok().flatten();
        let descriptor_present = descriptor_path.exists();
        let control_endpoint_ready = descriptor.as_ref().is_some_and(|descriptor| {
            endpoint_ready(descriptor.control_port, Duration::from_millis(300))
        });
        let state = classify_startup(StartupObservation {
            desktop_running: !roots.is_empty(),
            descriptor_present,
            control_endpoint_ready,
        });

        match state {
            StartupState::RecoverStale => {
                if let Some(descriptor) = &descriptor {
                    stop_stale_launcher(descriptor)?;
                    let _ = remove_matching_descriptor(&descriptor_path, descriptor)?;
                } else if descriptor_present {
                    std::fs::remove_file(&descriptor_path)?;
                }
            }
            StartupState::Attach => {
                #[cfg(target_os = "macos")]
                {
                    codexhost_platform::force_stop_desktop(&installation, Duration::from_secs(10))?;
                    continue;
                }
            }
            StartupState::CleanLaunch => {
                if descriptor_present && control_endpoint_ready {
                    return Err(
                        "codexhost control endpoint is still active without a live Desktop; retry after it exits"
                            .into(),
                    );
                }
            }
        }

        let control = allocate_runtime_control()?;
        let launcher_executable = env::current_exe()?.canonicalize()?;
        let environment = desktop_environment(
            &options,
            &control,
            &launcher_executable,
            &descriptor_path,
            managed_desktop_data_directory(
                env::var_os(DATA_DIRECTORY_ENV),
                env::var_os(REMOTE_SSH_MANAGED_ENV),
                env::var_os("HOME"),
            ),
        );
        #[cfg(target_os = "macos")]
        let environment = {
            let mut environment = environment;
            environment.extend(launcher_proxy_environment());
            environment
        };
        let result = supervise_desktop(
            &installation,
            &options,
            &control.renderer_cdp_arguments,
            &environment,
            &control,
            &descriptor_path,
            None,
        );
        #[cfg(target_os = "macos")]
        return result;
    }
}

#[cfg(target_os = "linux")]
fn launch(
    options: LaunchOptions,
    _interactive_running_desktop: bool,
) -> Result<(), Box<dyn Error>> {
    startup_trace("launch requested");
    let options = options.resolve()?;
    startup_trace("resources resolved");
    let installation = discover_codex_desktop()?;
    startup_trace("Codex Desktop installation discovered");
    startup_trace("acquiring Launcher ownership");
    let _launcher_guard = match acquire_launcher_ownership(&installation, Duration::from_secs(120))?
    {
        LauncherOwnership::Acquired(guard) => {
            startup_trace("Launcher ownership acquired");
            guard
        }
        LauncherOwnership::Attached => {
            startup_trace("attached to existing controlled Desktop");
            return Ok(());
        }
    };

    let roots = desktop_root_process_ids_for_installation(&installation)?;
    if !roots.is_empty() {
        return Err(Box::new(UnmanagedDesktopConflict));
    }
    let descriptor_path = default_descriptor_path()?;
    let descriptor = read_descriptor(&descriptor_path).ok().flatten();
    let descriptor_present = descriptor_path.exists();
    let control_endpoint_ready = descriptor.as_ref().is_some_and(|descriptor| {
        endpoint_ready(descriptor.control_port, Duration::from_millis(300))
    });
    match classify_startup(StartupObservation {
        desktop_running: false,
        descriptor_present,
        control_endpoint_ready,
    }) {
        StartupState::RecoverStale => {
            if let Some(descriptor) = &descriptor {
                stop_stale_launcher(descriptor)?;
                let _ = remove_matching_descriptor(&descriptor_path, descriptor)?;
            } else if descriptor_present {
                return Err("codexhost runtime descriptor is invalid; remove it after checking its ownership".into());
            }
        }
        StartupState::Attach => unreachable!("no Desktop roots were observed"),
        StartupState::CleanLaunch if descriptor_present && control_endpoint_ready => {
            return Err(
                "codexhost control endpoint is still active without a live Desktop; retry after it exits"
                    .into(),
            );
        }
        StartupState::CleanLaunch => {}
    }
    let control = allocate_runtime_control()?;
    let launcher_executable = env::current_exe()?.canonicalize()?;
    let environment = desktop_environment(
        &options,
        &control,
        &launcher_executable,
        &descriptor_path,
        managed_desktop_data_directory(
            env::var_os(DATA_DIRECTORY_ENV),
            env::var_os(REMOTE_SSH_MANAGED_ENV),
            env::var_os("HOME"),
        ),
    );
    supervise_desktop(
        &installation,
        &options,
        &control.renderer_cdp_arguments,
        &environment,
        &control,
        &descriptor_path,
        None,
    )
}

fn default_launch_options() -> LaunchOptions {
    LaunchOptions {
        shim: None,
        node: None,
        host_runtime: None,
        desktop_controller: None,
        renderer_extension: None,
    }
}

fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    match arguments.first().map(String::as_str) {
        None => launch(default_launch_options(), false),
        Some(START_MENU_ARGUMENT) if arguments.len() == 1 => launch(default_launch_options(), true),
        Some("inspect") if arguments.len() == 1 => inspect(),
        Some("launch") => launch(parse_launch_options(&arguments[1..])?, false),
        #[cfg(target_os = "macos")]
        Some("debug") => debug_instance::run(&arguments[1..]),
        Some("open-loopback-url") if arguments.len() == 1 => {
            let url = read_bounded_loopback_url(std::io::stdin().lock())?;
            validate_loopback_root_url(&url)?;
            codexhost_platform::open_external_url(&url).map_err(Into::into)
        }
        Some("open-loopback-url") => Err("open-loopback-url accepts no arguments".into()),
        Some("broker") => run_native_harness_broker_cli(&arguments[1..]),
        _ => {
            usage();
            Err("invalid launcher arguments".into())
        }
    }
}

fn main() -> ExitCode {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match run(&arguments) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let message = format!("codexhost launcher: {error}");
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    #[cfg(target_os = "macos")]
    use std::process::Stdio;
    use std::thread;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use std::time::Duration;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use std::time::Instant;

    #[cfg(target_os = "macos")]
    use codexhost_platform::spawn_supervised;

    #[cfg(target_os = "macos")]
    use super::stop_desktop_controller;
    #[cfg(target_os = "macos")]
    use super::wait_for_controller_ready;
    use super::{
        CONTROL_NONCE_ENV, CONTROL_PORT_ENV, DEFAULT_AGENT_ENV, HOST_NODE_PATH_ENV,
        LAUNCHER_EXECUTABLE_ENV, LAUNCHER_PID_ENV, RUNTIME_DESCRIPTOR_PATH_ENV,
        ResolvedLaunchOptions, RuntimeControl, STARTUP_TRACE_ENV, allocate_runtime_control,
        desktop_controller_command, desktop_environment, emit_ready_line,
        managed_desktop_data_directory, parse_launch_options, read_bounded_controller_line,
        read_bounded_loopback_url, validate_loopback_root_url,
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use super::{DESKTOP_TREE_REFRESH_INTERVAL, desktop_tree_refresh_due};
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn throttles_full_desktop_tree_refreshes() {
        let started = Instant::now();

        assert!(!desktop_tree_refresh_due(
            started,
            started + DESKTOP_TREE_REFRESH_INTERVAL - Duration::from_millis(1),
        ));
        assert!(desktop_tree_refresh_due(
            started,
            started + DESKTOP_TREE_REFRESH_INTERVAL,
        ));
    }

    #[test]
    fn native_url_handoff_accepts_only_loopback_roots() {
        let token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        for accepted in [
            format!("http://127.0.0.1:43123/?token={token}"),
            format!("https://localhost:43123/?token={token}"),
            format!("http://[::1]:43123/?token={token}"),
            "http://127.0.0.1:43123/".into(),
            "http://127.0.0.1:43123/?service=local".into(),
        ] {
            assert!(validate_loopback_root_url(&accepted).is_ok(), "{accepted}");
        }
        for rejected in [
            format!("https://example.com:43123/?token={token}"),
            format!("http://user@127.0.0.1:43123/?token={token}"),
            format!("http://127.0.0.1:43123/path?token={token}"),
            format!("http://127.0.0.1/?token={token}"),
            format!("file:///tmp/page?token={token}"),
            format!("http://127.0.0.1:43123/?token={token}#fragment"),
            format!("http://user%40name@127.0.0.1:43123/?token={token}"),
            format!("http://127%2e0%2e0%2e1:43123/?token={token}"),
        ] {
            assert!(validate_loopback_root_url(&rejected).is_err(), "{rejected}");
        }
    }

    #[test]
    fn native_url_handoff_bounds_stdin() {
        assert_eq!(
            read_bounded_loopback_url(std::io::Cursor::new(b"http://127.0.0.1:43123/"))
                .expect("bounded URL"),
            "http://127.0.0.1:43123/"
        );
        assert!(read_bounded_loopback_url(std::io::Cursor::new(vec![b'a'; 4097])).is_err());
        assert!(read_bounded_loopback_url(std::io::Cursor::new(b"one\ntwo")).is_err());
    }

    #[test]
    fn ready_line_is_the_exact_wrapper_protocol() {
        let mut output = Vec::new();
        emit_ready_line(&mut output).expect("emit ready line");
        assert_eq!(output, b"ready\n");
    }

    #[test]
    fn controller_readiness_reader_bounds_eof_and_missing_newline() {
        assert_eq!(
            read_bounded_controller_line(std::io::Cursor::new(Vec::<u8>::new()))
                .expect("empty EOF"),
            Vec::<u8>::new()
        );
        assert_eq!(
            read_bounded_controller_line(std::io::Cursor::new(b"partial".to_vec()))
                .expect("partial EOF"),
            b"partial"
        );
        assert!(
            read_bounded_controller_line(std::io::Cursor::new(vec![
                b'a';
                crate::compatibility::MAX_CONTROLLER_READINESS_LINE_BYTES
            ]))
            .is_err()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn force_stops_a_controller_that_ignores_graceful_termination() {
        let mut command = Command::new("/bin/bash");
        command.args(["-c", "trap '' TERM; while :; do sleep 1; done"]);
        command.stdout(Stdio::null()).stderr(Stdio::null());
        let mut controller = spawn_supervised(&mut command).expect("spawn Controller fixture");
        thread::sleep(Duration::from_millis(50));

        let started = Instant::now();
        stop_desktop_controller(&mut controller).expect("force-stop owned Controller");

        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(controller.try_wait().expect("Controller status").is_some());
    }

    #[test]
    fn bundled_runtime_paths_are_optional_launch_arguments() {
        let options = parse_launch_options(&[]).expect("bundled launch options");

        assert!(options.shim.is_none());
        assert!(options.node.is_none());
        assert!(options.host_runtime.is_none());
        assert!(options.desktop_controller.is_none());
        assert!(options.renderer_extension.is_none());
    }

    #[test]
    fn explicit_development_paths_remain_supported() {
        let options = parse_launch_options(&[
            "--shim".into(),
            "/opt/codexhost-shim".into(),
            "--node".into(),
            "/opt/node".into(),
            "--host-runtime".into(),
            "/opt/host-runtime.mjs".into(),
            "--desktop-controller".into(),
            "/opt/desktop-controller.mjs".into(),
            "--renderer".into(),
            "/opt/renderer-extension.js".into(),
        ])
        .expect("explicit development paths");

        assert!(options.shim.is_some());
        assert!(options.node.is_some());
        assert!(options.host_runtime.is_some());
        assert!(options.desktop_controller.is_some());
        assert!(options.renderer_extension.is_some());
    }

    #[test]
    fn removed_custom_install_option_is_rejected() {
        assert!(
            parse_launch_options(&["--custom-install".into(), "/opt/CodexPortable".into()])
                .is_err()
        );
    }

    #[test]
    fn removed_agent_option_is_rejected() {
        assert!(parse_launch_options(&["--agent".into(), "pi".into()]).is_err());
    }

    fn resolved_options() -> ResolvedLaunchOptions {
        ResolvedLaunchOptions {
            shim: PathBuf::from("/opt/codexhost-shim"),
            node: PathBuf::from("/opt/node"),
            host_runtime: PathBuf::from("/opt/host-runtime.mjs"),
            desktop_controller: PathBuf::from("/opt/desktop-controller.mjs"),
            renderer_extension: PathBuf::from("/opt/renderer-extension.js"),
        }
    }

    fn runtime_control() -> RuntimeControl {
        RuntimeControl {
            renderer_cdp_endpoint: "http://127.0.0.1:43123".into(),
            renderer_cdp_arguments: [
                "--remote-debugging-address=127.0.0.1".into(),
                "--remote-debugging-port=43123".into(),
            ],
            attachment_port: 43124,
            nonce: "0123456789abcdef0123456789abcdef".into(),
        }
    }

    #[test]
    fn production_controller_uses_private_node_and_loopback_renderer_cdp() {
        let options = resolved_options();
        let command = desktop_controller_command(&options, &runtime_control(), &[]);
        assert_eq!(command.get_program(), "/opt/node");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "/opt/desktop-controller.mjs",
                "--renderer-cdp-endpoint",
                "http://127.0.0.1:43123",
                "--renderer",
                "/opt/renderer-extension.js",
                "--default-agent",
                "codex",
                "--attachment-port",
                "43124",
                "--attachment-nonce",
                "0123456789abcdef0123456789abcdef",
            ]
        );

        let control = allocate_runtime_control().expect("ephemeral runtime control");
        assert!(
            control
                .renderer_cdp_endpoint
                .starts_with("http://127.0.0.1:")
        );
        let renderer_cdp_port = control
            .renderer_cdp_endpoint
            .rsplit(':')
            .next()
            .expect("Renderer CDP endpoint port")
            .parse::<u16>()
            .expect("numeric Renderer CDP endpoint port");
        assert_ne!(renderer_cdp_port, control.attachment_port);
        assert_eq!(
            control.renderer_cdp_arguments[0].to_string_lossy(),
            "--remote-debugging-address=127.0.0.1"
        );
        assert_eq!(
            control.renderer_cdp_arguments[1].to_string_lossy(),
            format!("--remote-debugging-port={renderer_cdp_port}")
        );
        let environment = desktop_environment(
            &options,
            &control,
            Path::new("/opt/codexhost"),
            Path::new("/run/user/1000/codexhost/desktop-runtime-v1.json"),
            None,
        );
        let value = |name: &str| {
            environment
                .iter()
                .find(|(candidate, _)| candidate == name)
                .map(|(_, value)| value)
        };
        assert_eq!(value(DEFAULT_AGENT_ENV), Some(&OsString::from("codex")));
        assert_eq!(
            value(LAUNCHER_PID_ENV),
            Some(&OsString::from(std::process::id().to_string()))
        );
        assert_eq!(
            value(LAUNCHER_EXECUTABLE_ENV),
            Some(&OsString::from("/opt/codexhost"))
        );
        assert_eq!(
            value(RUNTIME_DESCRIPTOR_PATH_ENV),
            Some(&OsString::from(
                "/run/user/1000/codexhost/desktop-runtime-v1.json"
            ))
        );
        assert_eq!(
            value(CONTROL_PORT_ENV),
            Some(&OsString::from(control.attachment_port.to_string()))
        );
        assert_eq!(
            value(CONTROL_NONCE_ENV),
            Some(&OsString::from(&control.nonce))
        );
    }

    #[test]
    fn desktop_environment_propagates_an_explicit_local_data_directory() {
        let environment = desktop_environment(
            &resolved_options(),
            &runtime_control(),
            Path::new("/opt/codexhost"),
            Path::new("/run/user/1000/codexhost/desktop-runtime-v1.json"),
            Some(OsString::from("/home/codex/.codexhost")),
        );

        assert!(environment.contains(&(
            OsString::from("CODEXHOST_DATA_DIR"),
            OsString::from("/home/codex/.codexhost"),
        )));
    }

    #[test]
    fn desktop_environment_preserves_explicit_native_home_and_profile() {
        const MARKER: &str = "CODEXHOST_TEST_DESKTOP_PATH_OVERRIDES";
        if std::env::var_os(MARKER).is_none() {
            let root = std::env::temp_dir().join("codexhost-desktop-path-fixture");
            let output = Command::new(std::env::current_exe().expect("test executable"))
                .args([
                    "--exact",
                    "tests::desktop_environment_preserves_explicit_native_home_and_profile",
                    "--nocapture",
                ])
                .env(MARKER, "1")
                .env("HOME", root.join("home"))
                .env("ZDOTDIR", root.join("shell"))
                .env("CODEX_HOME", root.join("codex"))
                .env("CODEX_ELECTRON_USER_DATA_PATH", root.join("electron"))
                .env("OPENAI_API_KEY", "synthetic-not-forwarded")
                .env_remove(super::REMOTE_SSH_MANAGED_ENV)
                .output()
                .expect("run isolated environment test");
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
            return;
        }
        let environment = desktop_environment(
            &resolved_options(),
            &runtime_control(),
            Path::new("/synthetic/codexhost"),
            Path::new("/synthetic/runtime.json"),
            None,
        );
        for name in [
            "HOME",
            "ZDOTDIR",
            "CODEX_HOME",
            "CODEX_ELECTRON_USER_DATA_PATH",
        ] {
            assert!(
                environment.contains(&(
                    OsString::from(name),
                    std::env::var_os(name).expect("synthetic path override"),
                )),
                "missing Desktop environment {name}"
            );
        }
        assert!(!environment.iter().any(|(name, _)| name == "OPENAI_API_KEY"));
    }

    #[test]
    fn managed_desktop_data_directory_rejects_a_remote_profile_value() {
        let remote_data = Some(OsString::from("/home/codex/.codexhost/remote/data"));
        let home = Some(OsString::from("/home/codex"));

        assert_eq!(
            managed_desktop_data_directory(remote_data.clone(), Some(OsString::from("1")), home),
            Some(OsString::from("/home/codex/.codexhost"))
        );
        assert_eq!(
            managed_desktop_data_directory(remote_data.clone(), None, None),
            remote_data
        );
    }

    #[test]
    fn managed_desktop_data_directory_defaults_to_the_home_data_root() {
        let home = Some(OsString::from("/Users/codex"));

        assert_eq!(
            managed_desktop_data_directory(None, None, home.clone()),
            Some(OsString::from("/Users/codex/.codexhost"))
        );
        assert_eq!(
            managed_desktop_data_directory(Some(OsString::new()), None, home),
            Some(OsString::from("/Users/codex/.codexhost"))
        );
        assert_eq!(managed_desktop_data_directory(None, None, None), None);
    }

    #[test]
    fn controller_receives_only_the_managed_network_environment() {
        let options = resolved_options();
        let command = desktop_controller_command(
            &options,
            &runtime_control(),
            &[
                (
                    OsString::from("HTTPS_PROXY"),
                    OsString::from("http://proxy:8443"),
                ),
                (
                    OsString::from(HOST_NODE_PATH_ENV),
                    OsString::from("/private/node"),
                ),
                (OsString::from(STARTUP_TRACE_ENV), OsString::from("1")),
            ],
        );
        let environment = command.get_envs().collect::<Vec<_>>();

        assert!(environment.contains(&(
            std::ffi::OsStr::new("HTTPS_PROXY"),
            Some(std::ffi::OsStr::new("http://proxy:8443")),
        )));
        assert!(environment.contains(&(
            std::ffi::OsStr::new(STARTUP_TRACE_ENV),
            Some(std::ffi::OsStr::new("1")),
        )));
        assert!(
            !environment
                .iter()
                .any(|(name, _)| *name == HOST_NODE_PATH_ENV)
        );
    }

    #[test]
    fn controlled_attachment_uses_the_exact_nonce_handshake() {
        use crate::desktop_attachment::try_activate_controlled_instance;
        use crate::runtime_instance::RuntimeDescriptor;
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("attachment listener");
        let port = listener.local_addr().expect("attachment address").port();
        let descriptor =
            RuntimeDescriptor::new(10, port, "0123456789abcdef0123456789abcdef".into())
                .expect("runtime descriptor");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("attachment connection");
            let mut request = String::new();
            BufReader::new(stream.try_clone().expect("clone stream"))
                .read_line(&mut request)
                .expect("attachment request");
            assert_eq!(request, "ATTACH 0123456789abcdef0123456789abcdef\n");
            writeln!(stream, "ready").expect("attachment response");
        });
        assert!(try_activate_controlled_instance(&descriptor).expect("controlled attachment"));
        server.join().expect("attachment server");
    }

    #[test]
    fn controlled_attachment_is_unavailable_when_its_controller_is_absent() {
        use crate::desktop_attachment::try_activate_controlled_instance;
        use crate::runtime_instance::RuntimeDescriptor;
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("temporary listener");
        let port = listener.local_addr().expect("listener address").port();
        drop(listener);
        let descriptor =
            RuntimeDescriptor::new(10, port, "0123456789abcdef0123456789abcdef".into())
                .expect("runtime descriptor");

        assert!(!try_activate_controlled_instance(&descriptor).expect("unavailable Controller"));
    }

    #[test]
    fn controlled_attachment_retries_a_transient_empty_controller_response() {
        use crate::desktop_attachment::try_activate_controlled_instance;
        use crate::runtime_instance::RuntimeDescriptor;
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("attachment listener");
        let port = listener.local_addr().expect("attachment address").port();
        let descriptor =
            RuntimeDescriptor::new(10, port, "0123456789abcdef0123456789abcdef".into())
                .expect("runtime descriptor");
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("attachment connection");
            let mut request = String::new();
            BufReader::new(stream.try_clone().expect("clone stream"))
                .read_line(&mut request)
                .expect("attachment request");
            assert_eq!(request, "ATTACH 0123456789abcdef0123456789abcdef\n");
            // Simulate a Controller that was still restoring the Desktop: close
            // the socket without a response line.
            drop(stream);
        });
        assert!(!try_activate_controlled_instance(&descriptor).expect("transient response"));
        server.join().expect("attachment server");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn controller_must_emit_strict_json_readiness() {
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "printf '%s\\n' '{\"schemaVersion\":2,\"state\":\"compatible\",\"issues\":[]}'",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut controller = spawn_supervised(&mut command).expect("fake Controller");
        wait_for_controller_ready(&mut controller, Duration::from_secs(2))
            .expect("Controller ready");
        controller.wait().expect("wait fake Controller");
        controller.disarm_cleanup();
    }
}
