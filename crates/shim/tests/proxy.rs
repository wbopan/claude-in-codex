use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{self, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::time::Instant;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use claude_in_codex_platform::process_exists;
use claude_in_codex_platform::{CODEX_CLI_PATH_ENV, STOCK_CODEX_PATH_ENV};
use claude_in_codex_shim::{HOST_NODE_PATH_ENV, HOST_RUNTIME_PATH_ENV, REMOTE_SSH_MANAGED_ENV};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::unix::fs::MetadataExt;

fn shim_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_claude-in-codex-shim"))
}

fn proxy_shim() -> Command {
    Command::new(shim_path())
}

fn fake_codex_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-cli"))
}

fn temporary_directory() -> PathBuf {
    static NEXT_DIRECTORY_ID: AtomicU64 = AtomicU64::new(0);

    loop {
        let directory_id = NEXT_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "claude-in-codex-shim-test-{}-{directory_id}",
            process::id(),
        ));
        match fs::create_dir(&path) {
            Ok(()) => return path,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("create temporary directory {}: {error}", path.display()),
        }
    }
}

#[test]
fn creates_unique_temporary_directories_concurrently() {
    let workers = (0..16)
        .map(|_| std::thread::spawn(temporary_directory))
        .collect::<Vec<_>>();
    let directories = workers
        .into_iter()
        .map(|worker| worker.join().expect("create temporary directory"))
        .collect::<std::collections::HashSet<_>>();

    assert_eq!(directories.len(), 16);
    for directory in directories {
        fs::remove_dir(directory).expect("remove temporary directory");
    }
}

fn run_shim(
    input: &[u8],
    arguments: &[&str],
    environment: &[(&str, &str)],
) -> std::process::Output {
    let mut command = proxy_shim();
    command
        .args(arguments)
        .env_remove(HOST_NODE_PATH_ENV)
        .env_remove(HOST_RUNTIME_PATH_ENV)
        .env_remove(REMOTE_SSH_MANAGED_ENV)
        .env_remove("CLAUDE_IN_CODEX_REMOTE_LISTENER_CHILD")
        .env(STOCK_CODEX_PATH_ENV, fake_codex_path())
        .env(CODEX_CLI_PATH_ENV, shim_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
        "NODE_USE_ENV_PROXY",
    ] {
        command.env_remove(name);
    }
    for (key, value) in environment {
        command.env(key, value);
    }
    let mut child = command.spawn().expect("spawn shim");
    let mut stdin = child.stdin.take().expect("shim stdin");
    let input = input.to_vec();
    let writer = thread::spawn(move || stdin.write_all(&input));
    let output = child.wait_with_output().expect("wait for shim");
    writer
        .join()
        .expect("join shim stdin writer")
        .expect("write shim stdin");
    output
}

#[test]
fn preserves_arbitrary_bytes_and_chunk_boundaries() {
    let mut input = b"{\"id\":1}\r\n{\"split\":".to_vec();
    input.extend_from_slice(&[0, 0x7f, 0x80, 0xff, b'\n']);
    let output = run_shim(
        &input,
        &["app-server", "--stdio"],
        &[("FAKE_CODEX_BYTE_CHUNKS", "1")],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, input);
}

#[test]
fn forwards_response_before_stdin_eof() {
    let mut shim = proxy_shim()
        .env(STOCK_CODEX_PATH_ENV, fake_codex_path())
        .env("FAKE_CODEX_STREAM_RESPONSE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn streaming shim");
    let mut stdin = shim.stdin.take().expect("shim stdin");
    stdin.write_all(b"x").expect("write streaming request");

    let mut stdout = shim.stdout.take().expect("shim stdout");
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    let reader = thread::spawn(move || {
        let mut response = [0_u8; 8];
        stdout
            .read_exact(&mut response)
            .expect("read streaming response");
        response_sender
            .send(response)
            .expect("send streaming response");
        let mut trailing = Vec::new();
        stdout
            .read_to_end(&mut trailing)
            .expect("drain streaming stdout");
        (response, trailing)
    });
    let response = response_receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("Shim did not forward a response while stdin remained open");
    assert_eq!(response, *b"response");
    drop(stdin);
    let status = shim.wait().expect("wait for streaming shim");
    let mut stderr = Vec::new();
    shim.stderr
        .take()
        .expect("shim stderr")
        .read_to_end(&mut stderr)
        .expect("read streaming shim stderr");
    assert!(
        status.success(),
        "streaming shim exited {status}; stderr={}",
        String::from_utf8_lossy(&stderr)
    );
    let (response, trailing) = reader.join().expect("join response reader");
    assert_eq!(response, *b"response");
    assert!(trailing.is_empty());
}

#[test]
fn preserves_arguments_and_removes_recursive_environment() {
    let output = run_shim(
        b"",
        &["app-server", "--analytics-default-enabled"],
        &[("FAKE_CODEX_PRINT_INVOCATION", "1")],
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("args=app-server|--analytics-default-enabled"));
    assert!(stderr.contains("codex_cli_path_present=false"));
    assert!(output.stdout.is_empty());
}

#[test]
fn routes_skysight_memory_app_server_to_the_stock_codex_cli() {
    let fake_codex = fake_codex_path();
    let fake_codex_text = fake_codex.to_string_lossy();
    let output = run_shim(
        b"",
        &[
            "app-server",
            "--stdio",
            "-c",
            "model_provider=\"openai-memgen\"",
        ],
        &[
            (HOST_NODE_PATH_ENV, fake_codex_text.as_ref()),
            (HOST_RUNTIME_PATH_ENV, fake_codex_text.as_ref()),
            ("FAKE_CODEX_PRINT_INVOCATION", "1"),
        ],
    );
    let stderr = String::from_utf8_lossy(&output.stderr);

    // Even with a Host Runtime configured, the Skysight-specific provider must execute the stock
    // CLI directly so its one-shot summary response reaches SkyComputerUseService.
    assert!(output.status.success(), "{stderr}");
    assert!(stderr.contains("args=app-server|--stdio|-c|model_provider=\"openai-memgen\""));
    assert!(stderr.contains("codex_cli_path_present=false"));
    assert!(output.stdout.is_empty());
}

#[test]
fn routes_internal_codex_auxiliary_app_server_to_the_stock_cli() {
    let fake_codex = fake_codex_path();
    let fake_codex_text = fake_codex.to_string_lossy();
    let output = run_shim(
        b"",
        &["app-server", "--stdio"],
        &[
            (HOST_NODE_PATH_ENV, fake_codex_text.as_ref()),
            (HOST_RUNTIME_PATH_ENV, fake_codex_text.as_ref()),
            ("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "skysight"),
            ("FAKE_CODEX_PRINT_INVOCATION", "1"),
        ],
    );
    let stderr = String::from_utf8_lossy(&output.stderr);

    // The internal originator marker is an official ownership boundary. It must override an
    // otherwise valid Host Runtime route without removing the caller's marker from the stock CLI.
    assert!(output.status.success(), "{stderr}");
    assert!(stderr.contains("args=app-server|--stdio"));
    assert!(stderr.contains("codex_cli_path_present=false"));
    assert!(output.stdout.is_empty());
}

#[test]
fn managed_remote_child_receives_inherited_proxy_environment() {
    let output = run_shim(
        b"",
        &["app-server", "--analytics-default-enabled"],
        &[
            (REMOTE_SSH_MANAGED_ENV, "1"),
            ("HTTP_PROXY", "http://remote-proxy:8080"),
            ("FAKE_CODEX_PRINT_PROXY_ENV", "1"),
        ],
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stderr}");
    assert!(
        stderr.contains("HTTP_PROXY=http://remote-proxy:8080"),
        "stderr={stderr}"
    );
    assert!(
        stderr.contains("http_proxy=http://remote-proxy:8080"),
        "stderr={stderr}"
    );
}

#[test]
fn stdio_app_server_under_the_remote_profile_reaches_the_stock_cli() {
    let missing_runtime = temporary_directory().join("missing-host-runtime.mjs");
    let missing_runtime_text = missing_runtime.to_string_lossy();
    for arguments in [&["app-server"][..], &["app-server", "--stdio"][..]] {
        let output = run_shim(
            b"",
            arguments,
            &[
                (REMOTE_SSH_MANAGED_ENV, "1"),
                (HOST_NODE_PATH_ENV, missing_runtime_text.as_ref()),
                (HOST_RUNTIME_PATH_ENV, missing_runtime_text.as_ref()),
                ("FAKE_CODEX_PRINT_INVOCATION", "1"),
            ],
        );
        let stderr = String::from_utf8_lossy(&output.stderr);

        // Only the SSH-managed Unix listener belongs to the Host Runtime. A stdio app-server
        // started under the remote profile is an ordinary stock Codex CLI invocation.
        assert!(output.status.success(), "{arguments:?}: {stderr}");
        assert!(
            stderr.contains(&format!("args={}", arguments.join("|"))),
            "{arguments:?}: {stderr}"
        );
        assert!(output.stdout.is_empty());
    }
    fs::remove_dir_all(missing_runtime.parent().expect("missing runtime parent"))
        .expect("remove remote profile passthrough fixture");
}

#[test]
fn forwards_stderr_and_exit_code_without_polluting_stdout() {
    let output = run_shim(
        b"request",
        &[],
        &[
            ("FAKE_CODEX_STDERR", "official stderr"),
            ("FAKE_CODEX_EXIT_CODE", "23"),
        ],
    );
    assert_eq!(output.status.code(), Some(23));
    assert_eq!(output.stdout, b"request");
    assert_eq!(output.stderr, b"official stderr");
}

#[test]
fn drains_large_output_after_stdin_eof() {
    let input = vec![b'x'; 2 * 1024 * 1024];
    let output = run_shim(&input, &[], &[]);
    assert!(
        output.status.success(),
        "large-output shim exited {}; stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, input);
}

#[test]
fn production_shim_ignores_gate_capture_environment() {
    let output_directory = temporary_directory().join("capture-must-not-exist");
    let output = run_shim(
        b"request",
        &[],
        &[(
            "CLAUDE_IN_CODEX_PROBE_OUTPUT",
            output_directory.to_str().expect("UTF-8 test path"),
        )],
    );
    assert!(output.status.success());
    assert_eq!(output.stdout, b"request");
    assert!(!output_directory.exists());
}

#[test]
fn rejects_recursion_without_stdout_output() {
    let output = proxy_shim()
        .env(STOCK_CODEX_PATH_ENV, shim_path())
        .stdin(Stdio::null())
        .output()
        .expect("run recursive shim");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Shim itself"));
}

#[test]
fn rejects_missing_official_cli_without_falling_back_to_path() {
    let missing = temporary_directory().join("missing-codex.exe");
    let output = proxy_shim()
        .env(STOCK_CODEX_PATH_ENV, missing)
        .stdin(Stdio::null())
        .output()
        .expect("run shim with missing target");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("does not exist"));
}

#[test]
fn rejects_missing_stock_cli_even_with_a_cli_override() {
    let output = proxy_shim()
        .args(["sandbox", "--", "/usr/bin/true"])
        .env_remove(STOCK_CODEX_PATH_ENV)
        .env(CODEX_CLI_PATH_ENV, shim_path())
        .env("PATH", fake_codex_path().parent().expect("fake CLI parent"))
        .stdin(Stdio::null())
        .output()
        .expect("run shim without managed environment");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains(&format!("{STOCK_CODEX_PATH_ENV} is required"))
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn managed_remote_listener_detaches_and_reuses_a_matching_socket_owner() {
    static NEXT_REMOTE_DIRECTORY_ID: AtomicU64 = AtomicU64::new(0);

    let directory = PathBuf::from("/tmp").join(format!(
        "claude-in-codex-remote-test-{}-{}",
        process::id(),
        NEXT_REMOTE_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed),
    ));
    fs::create_dir(&directory).expect("create short remote listener fixture directory");
    let codex_home = directory.join("home");
    let socket = codex_home
        .join("app-server-control")
        .join("app-server-control.sock");
    let ready = directory.join("ready");
    let started = Instant::now();
    let child = proxy_shim()
        .args([
            "-c",
            "features.code_mode_host=true",
            "app-server",
            "--listen",
            "unix://",
        ])
        .env_remove(HOST_NODE_PATH_ENV)
        .env_remove(HOST_RUNTIME_PATH_ENV)
        .env_remove("CLAUDE_IN_CODEX_REMOTE_LISTENER_CHILD")
        .env(STOCK_CODEX_PATH_ENV, fake_codex_path())
        .env(CODEX_CLI_PATH_ENV, shim_path())
        .env(REMOTE_SSH_MANAGED_ENV, "1")
        .env("CODEX_HOME", &codex_home)
        .env("FAKE_CODEX_UNIX_LISTENER_PATH", &socket)
        .env("FAKE_CODEX_READY_PATH", &ready)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start managed remote listener");
    let (completion_sender, completion_receiver) = mpsc::channel();
    let waiter = thread::spawn(move || completion_sender.send(child.wait_with_output()));

    let ready_deadline = Instant::now() + Duration::from_secs(2);
    while !ready.exists() && Instant::now() < ready_deadline {
        thread::sleep(Duration::from_millis(20));
    }
    let ready_contents = fs::read_to_string(&ready).expect("read detached listener identity");
    let value = |label: &str| {
        ready_contents
            .lines()
            .find_map(|line| line.strip_prefix(label))
            .expect("listener identity field")
            .parse::<u32>()
            .expect("listener identity PID")
    };
    let root_id = value("root=");
    let shim_id = value("shim=");
    let output = match completion_receiver.recv_timeout(Duration::from_secs(2)) {
        Ok(output) => output.expect("wait for managed remote listener bootstrap"),
        Err(error) => {
            let _ = Command::new("/bin/kill")
                .args(["-KILL", &shim_id.to_string(), &root_id.to_string()])
                .status();
            let _ = completion_receiver.recv_timeout(Duration::from_secs(5));
            waiter
                .join()
                .expect("join failed bootstrap waiter")
                .expect("send failed bootstrap output");
            fs::remove_dir_all(&directory).expect("remove failed remote listener fixture");
            panic!("remote listener bootstrap kept its output pipes open: {error}");
        }
    };
    waiter
        .join()
        .expect("join remote listener bootstrap waiter")
        .expect("send remote listener bootstrap output");
    assert!(
        output.status.success(),
        "remote listener bootstrap failed: {}; stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "remote listener bootstrap did not detach promptly"
    );

    assert!(socket.exists(), "detached listener socket is unavailable");
    assert!(process_exists(root_id), "detached listener root exited");
    assert!(process_exists(shim_id), "detached listener Shim exited");

    let original_socket = fs::metadata(&socket).expect("read original listener socket identity");
    let repeated_started = Instant::now();
    let repeated = proxy_shim()
        .args([
            "-c",
            "features.code_mode_host=true",
            "app-server",
            "--listen",
            "unix://",
        ])
        .env_remove(HOST_NODE_PATH_ENV)
        .env_remove(HOST_RUNTIME_PATH_ENV)
        .env_remove("CLAUDE_IN_CODEX_REMOTE_LISTENER_CHILD")
        .env(STOCK_CODEX_PATH_ENV, fake_codex_path())
        .env(CODEX_CLI_PATH_ENV, shim_path())
        .env(REMOTE_SSH_MANAGED_ENV, "1")
        .env("CODEX_HOME", &codex_home)
        .env("FAKE_CODEX_UNIX_LISTENER_PATH", &socket)
        .env("FAKE_CODEX_READY_PATH", &ready)
        .stdin(Stdio::null())
        .output()
        .expect("repeat managed remote listener bootstrap");
    let repeated_elapsed = repeated_started.elapsed();
    let repeated_ready = fs::read_to_string(&ready).expect("read repeated listener identity");
    let repeated_value = |label: &str| {
        repeated_ready
            .lines()
            .find_map(|line| line.strip_prefix(label))
            .expect("repeated listener identity field")
            .parse::<u32>()
            .expect("repeated listener identity PID")
    };
    let repeated_root_id = repeated_value("root=");
    let repeated_shim_id = repeated_value("shim=");
    let repeated_socket = fs::metadata(&socket).expect("read repeated listener socket identity");

    let alternate_stock = directory.join("alternate-fake-codex");
    fs::copy(fake_codex_path(), &alternate_stock).expect("copy alternate stock Codex fixture");
    let mismatched = proxy_shim()
        .args([
            "-c",
            "features.code_mode_host=true",
            "app-server",
            "--listen",
            "unix://",
        ])
        .env_remove(HOST_NODE_PATH_ENV)
        .env_remove(HOST_RUNTIME_PATH_ENV)
        .env_remove("CLAUDE_IN_CODEX_REMOTE_LISTENER_CHILD")
        .env(STOCK_CODEX_PATH_ENV, &alternate_stock)
        .env(CODEX_CLI_PATH_ENV, shim_path())
        .env(REMOTE_SSH_MANAGED_ENV, "1")
        .env("CODEX_HOME", &codex_home)
        .env("FAKE_CODEX_UNIX_LISTENER_PATH", &socket)
        .env("FAKE_CODEX_READY_PATH", &ready)
        .stdin(Stdio::null())
        .output()
        .expect("run mismatched managed remote listener bootstrap");
    let mismatched_ready = fs::read_to_string(&ready).expect("read mismatched listener identity");
    let mismatched_value = |label: &str| {
        mismatched_ready
            .lines()
            .find_map(|line| line.strip_prefix(label))
            .expect("mismatched listener identity field")
            .parse::<u32>()
            .expect("mismatched listener identity PID")
    };
    let mismatched_root_id = mismatched_value("root=");
    let mismatched_shim_id = mismatched_value("shim=");
    let mismatched_socket =
        fs::metadata(&socket).expect("read mismatched listener socket identity");
    let original_processes_survived = process_exists(root_id) && process_exists(shim_id);

    let process_ids = [
        root_id,
        shim_id,
        repeated_root_id,
        repeated_shim_id,
        mismatched_root_id,
        mismatched_shim_id,
    ]
    .into_iter()
    .collect::<std::collections::HashSet<_>>();
    for process_id in [shim_id, repeated_shim_id, mismatched_shim_id]
        .into_iter()
        .collect::<std::collections::HashSet<_>>()
    {
        let _ = Command::new("/bin/kill")
            .args(["-TERM", &process_id.to_string()])
            .status();
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_ids.iter().copied().any(process_exists) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    for process_id in process_ids
        .iter()
        .copied()
        .filter(|process_id| process_exists(*process_id))
    {
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &process_id.to_string()])
            .status();
    }
    fs::remove_dir_all(directory).expect("remove remote listener fixture");

    assert!(
        repeated.status.success(),
        "repeated bootstrap failed: {}; stderr={}",
        repeated.status,
        String::from_utf8_lossy(&repeated.stderr)
    );
    assert!(
        repeated_elapsed < Duration::from_secs(2),
        "repeated bootstrap did not reuse the listener promptly"
    );
    assert!(
        original_processes_survived,
        "repeated bootstrap terminated the original listener"
    );
    assert_eq!(
        repeated_root_id, root_id,
        "repeated bootstrap replaced the listener root"
    );
    assert_eq!(
        repeated_shim_id, shim_id,
        "repeated bootstrap replaced the listener Shim"
    );
    assert_eq!(
        (repeated_socket.dev(), repeated_socket.ino()),
        (original_socket.dev(), original_socket.ino()),
        "repeated bootstrap replaced the listener socket"
    );
    assert!(
        !mismatched.status.success(),
        "bootstrap unexpectedly reused a listener from another installed runtime"
    );
    assert!(
        String::from_utf8_lossy(&mismatched.stderr)
            .contains("remote Host socket owner does not match"),
        "unexpected mismatched bootstrap error: {}",
        String::from_utf8_lossy(&mismatched.stderr)
    );
    assert_eq!(
        mismatched_root_id, root_id,
        "mismatched bootstrap replaced the listener root"
    );
    assert_eq!(
        mismatched_shim_id, shim_id,
        "mismatched bootstrap replaced the listener Shim"
    );
    assert_eq!(
        (mismatched_socket.dev(), mismatched_socket.ino()),
        (original_socket.dev(), original_socket.ino()),
        "mismatched bootstrap replaced the listener socket"
    );
    for process_id in process_ids {
        assert!(
            !process_exists(process_id),
            "detached listener process {process_id} survived shutdown"
        );
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn remote_lifecycle_terminates_only_the_matching_socket_listener() {
    let directory = temporary_directory();
    let socket = directory.join("control.sock");
    let ready = directory.join("ready");
    let mut listener = Command::new(fake_codex_path())
        .args(["app-server", "--listen", "unix://"])
        .env("FAKE_CODEX_UNIX_LISTENER_PATH", &socket)
        .env("FAKE_CODEX_READY_PATH", &ready)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start lifecycle listener fixture");
    let ready = wait_for_file(&ready, Duration::from_secs(2));
    let root_id = ready
        .lines()
        .find_map(|line| line.strip_prefix("root="))
        .expect("listener root identity")
        .parse::<u32>()
        .expect("listener root PID");

    let output = proxy_shim()
        .args(["--claude-in-codex-remote-terminate", "stock", "--socket"])
        .arg(&socket)
        .arg("--stock-codex")
        .arg(fake_codex_path())
        .arg("--node")
        .arg(fake_codex_path())
        .arg("--host-runtime")
        .arg(directory.join("host-runtime.mjs"))
        .output()
        .expect("terminate lifecycle listener fixture");
    assert!(
        output.status.success(),
        "lifecycle termination failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    while process_exists(root_id) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    if process_exists(root_id) {
        let _ = listener.kill();
    }
    let _ = listener.wait();
    assert!(
        !process_exists(root_id),
        "matching socket listener survived"
    );
    fs::remove_dir_all(directory).expect("remove lifecycle listener fixture");
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn remote_lifecycle_refuses_a_mismatched_installed_command() {
    let directory = temporary_directory();
    let socket = directory.join("control.sock");
    let ready = directory.join("ready");
    let mut listener = Command::new(fake_codex_path())
        .args(["app-server", "--listen", "unix://"])
        .env("FAKE_CODEX_UNIX_LISTENER_PATH", &socket)
        .env("FAKE_CODEX_READY_PATH", &ready)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start mismatched lifecycle listener fixture");
    let _ = wait_for_file(&ready, Duration::from_secs(2));

    let output = proxy_shim()
        .args(["--claude-in-codex-remote-terminate", "stock", "--socket"])
        .arg(&socket)
        .arg("--stock-codex")
        .arg(directory.join("different-codex"))
        .arg("--node")
        .arg(fake_codex_path())
        .arg("--host-runtime")
        .arg(directory.join("host-runtime.mjs"))
        .output()
        .expect("reject mismatched lifecycle listener fixture");
    assert!(!output.status.success());
    assert!(
        listener
            .try_wait()
            .expect("poll mismatched listener")
            .is_none()
    );
    let _ = listener.kill();
    let _ = listener.wait();
    fs::remove_dir_all(directory).expect("remove mismatched lifecycle fixture");
}

#[cfg(target_os = "macos")]
#[test]
fn reports_an_official_cli_crash_without_polluting_stdout() {
    let output = run_shim(b"", &[], &[("FAKE_CODEX_CRASH", "1")]);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("terminated by signal"),
        "unexpected crash status {:?} with stderr: {stderr}",
        output.status
    );
}

fn wait_for_file(path: &std::path::Path, timeout: Duration) -> String {
    wait_for_optional_file(path, timeout)
        .unwrap_or_else(|| panic!("timed out waiting for {}", path.display()))
}

fn wait_for_optional_file(path: &std::path::Path, timeout: Duration) -> Option<String> {
    let started = Instant::now();
    loop {
        if let Ok(contents) = fs::read_to_string(path) {
            return Some(contents);
        }
        if started.elapsed() >= timeout {
            return None;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn process_id_from_ready(contents: &str, label: &str) -> u32 {
    contents
        .lines()
        .find_map(|line| line.strip_prefix(label))
        .expect("ready process identity field")
        .parse::<u32>()
        .expect("ready process identity PID")
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn managed_listener_child_shim(ready: &std::path::Path) -> process::Child {
    // Play the detached listener child that the managed remote bootstrap re-executes.
    proxy_shim()
        .args(["app-server", "--listen", "unix://"])
        .env(REMOTE_SSH_MANAGED_ENV, "1")
        .env("CLAUDE_IN_CODEX_REMOTE_LISTENER_CHILD", "1")
        .env(STOCK_CODEX_PATH_ENV, fake_codex_path())
        .env(HOST_NODE_PATH_ENV, fake_codex_path())
        .env(HOST_RUNTIME_PATH_ENV, fake_codex_path())
        .env_remove("FAKE_CODEX_UNIX_LISTENER_PATH")
        .env("FAKE_CODEX_HOST_RUNTIME_READY", ready)
        .env("FAKE_CODEX_HOST_RUNTIME_EOF_DELAY_MS", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn fake managed listener Shim")
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn force_stop_test_process(process_id: u32) {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let _ = Command::new("/bin/kill")
        .args(["-KILL", &process_id.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn wait_for_process_exit(child: &mut process::Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while child.try_wait().expect("poll test process").is_none() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    child.try_wait().expect("final test process poll").is_some()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn forwards_validated_host_runtime_paths_to_the_host_runtime() {
    let directory = temporary_directory();
    let ready = directory.join("ready");
    let mut shim = managed_listener_child_shim(&ready);
    let stdin = shim.stdin.take().expect("Host Runtime stdin");
    let identity = wait_for_file(&ready, Duration::from_secs(5));
    let expected = fake_codex_path()
        .canonicalize()
        .expect("canonical fake Host Runtime path")
        .display()
        .to_string();

    assert!(
        identity
            .lines()
            .any(|line| line == format!("host_node_path={expected}")),
        "Host Runtime did not inherit the validated Node path: {identity}"
    );
    assert!(
        identity
            .lines()
            .any(|line| line == format!("host_runtime_path={expected}")),
        "Host Runtime did not inherit the validated runtime path: {identity}"
    );

    drop(stdin);
    if !wait_for_process_exit(&mut shim, Duration::from_secs(5)) {
        force_stop_test_process(shim.id());
        let root = process_id_from_ready(&identity, "root=");
        force_stop_test_process(root);
        let _ = shim.wait();
        let _ = fs::remove_dir_all(&directory);
        panic!("Host Runtime Shim did not converge after stdin EOF");
    }
    fs::remove_dir_all(directory).expect("remove Host Runtime path forwarding fixture");
}

#[cfg(target_os = "macos")]
fn run_external_signal_case(signal: &str, expected_signal: i32, ignore_signal: bool) {
    let directory = temporary_directory();
    let ready = directory.join("ready");
    let observed = directory.join("observed");
    let mut command = proxy_shim();
    command
        .env(STOCK_CODEX_PATH_ENV, fake_codex_path())
        .env("FAKE_CODEX_SIGNAL_READY", &ready)
        .env("FAKE_CODEX_SIGNAL_OBSERVED", &observed)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if ignore_signal {
        command.env("FAKE_CODEX_IGNORE_SIGNALS", "1");
    }
    let mut shim = command.spawn().expect("spawn signal test shim");
    let shim_id = shim.id();
    let child_id = wait_for_file(&ready, Duration::from_secs(5))
        .trim()
        .parse::<u32>()
        .expect("ready child PID");

    let kill_status = Command::new("/bin/kill")
        .args([format!("-{signal}"), shim_id.to_string()])
        .status()
        .expect("send external signal");
    assert!(kill_status.success());
    assert_eq!(
        wait_for_file(&observed, Duration::from_secs(5)).trim(),
        expected_signal.to_string()
    );

    let started = Instant::now();
    while shim.try_wait().expect("poll shim").is_none()
        && started.elapsed() < Duration::from_secs(6)
    {
        thread::sleep(Duration::from_millis(20));
    }
    if shim.try_wait().expect("final shim poll").is_none() {
        let _ = shim.kill();
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &child_id.to_string()])
            .status();
        panic!("Shim did not converge after {signal}");
    }
    let output = shim.wait_with_output().expect("collect shim output");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains(&format!("forwarded shutdown signal {expected_signal}")));
    if ignore_signal {
        assert!(stderr.contains("terminated by signal 9"));
    }
    assert!(
        !process_exists(child_id),
        "official CLI PID {child_id} survived shutdown"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn forwards_external_sigterm_to_the_official_cli_group() {
    run_external_signal_case("TERM", 15, false);
}

#[cfg(target_os = "macos")]
#[test]
fn forwards_external_sigint_to_the_official_cli_group() {
    run_external_signal_case("INT", 2, false);
}

#[cfg(target_os = "macos")]
#[test]
fn forwards_external_sighup_to_the_official_cli_group() {
    run_external_signal_case("HUP", 1, false);
}

#[cfg(target_os = "macos")]
#[test]
fn converges_once_when_multiple_shutdown_signals_arrive() {
    let directory = temporary_directory();
    let ready = directory.join("ready");
    let observed = directory.join("observed");
    let mut shim = proxy_shim()
        .env(STOCK_CODEX_PATH_ENV, fake_codex_path())
        .env("FAKE_CODEX_SIGNAL_READY", &ready)
        .env("FAKE_CODEX_SIGNAL_OBSERVED", &observed)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn concurrent-signal shim");
    let child_id = wait_for_file(&ready, Duration::from_secs(5))
        .trim()
        .parse::<u32>()
        .expect("ready child PID");
    for signal in ["TERM", "INT"] {
        let status = Command::new("/bin/kill")
            .args([format!("-{signal}"), shim.id().to_string()])
            .status()
            .expect("send shutdown signal");
        assert!(status.success());
    }
    let _ = wait_for_file(&observed, Duration::from_secs(5));
    let started = Instant::now();
    while shim.try_wait().expect("poll shim").is_none()
        && started.elapsed() < Duration::from_secs(5)
    {
        thread::sleep(Duration::from_millis(20));
    }
    if shim.try_wait().expect("final shim poll").is_none() {
        let _ = shim.kill();
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &child_id.to_string()])
            .status();
        panic!("Shim did not converge after concurrent signals");
    }
    let output = shim
        .wait_with_output()
        .expect("collect concurrent-signal output");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(stderr.matches("forwarded shutdown signal").count(), 1);
    assert!(!process_exists(child_id));
}

#[cfg(target_os = "macos")]
#[test]
fn escalates_when_the_official_cli_ignores_sigterm() {
    run_external_signal_case("TERM", 15, true);
}

#[cfg(target_os = "macos")]
#[test]
fn cleans_an_escaped_descendant_after_the_cli_root_exits() {
    let directory = temporary_directory();
    let ready = directory.join("ready");
    let child_ready = directory.join("child-ready");
    let observations = directory.join("observations");
    let mut shim = proxy_shim()
        .env(STOCK_CODEX_PATH_ENV, fake_codex_path())
        .env("FAKE_CODEX_SPAWN_CHILD", "1")
        .env("FAKE_CODEX_ROOT_EXIT", "1")
        .env("FAKE_CODEX_ROOT_EXIT_ON_INPUT", "1")
        .env("CLAUDE_IN_CODEX_TEST_PROCESS_OBSERVATIONS", &observations)
        .env("FAKE_CODEX_CHILD_NEW_GROUP", "1")
        .env("FAKE_CODEX_CHILD_READY_PATH", &child_ready)
        .env("FAKE_CODEX_READY_PATH", &ready)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn descendant-cleanup shim");
    let ready = wait_for_file(&ready, Duration::from_secs(5));
    let child_id = ready
        .lines()
        .find_map(|line| line.strip_prefix("child="))
        .expect("child identity")
        .parse::<u32>()
        .expect("child PID");
    assert_eq!(
        wait_for_file(&child_ready, Duration::from_secs(5)).trim(),
        child_id.to_string()
    );
    // Ignore scans predating the child's completed setpgid. The first new
    // observation may already be in flight; the second must start after it.
    let observation_count = || fs::metadata(&observations).map_or(0, |metadata| metadata.len());
    let previous_observations = observation_count();
    let started = Instant::now();
    while observation_count() < previous_observations + 2 {
        if started.elapsed() >= Duration::from_secs(5) {
            let _ = shim.kill();
            let _ = Command::new("/bin/kill")
                .args(["-KILL", &child_id.to_string()])
                .status();
            let _ = shim.wait();
            panic!("Shim did not observe the fixture before root exit");
        }
        thread::sleep(Duration::from_millis(20));
    }
    shim.stdin
        .take()
        .expect("root release pipe")
        .write_all(b"x")
        .expect("release CLI root exit");

    let started = Instant::now();
    while shim.try_wait().expect("poll shim").is_none()
        && started.elapsed() < Duration::from_secs(6)
    {
        thread::sleep(Duration::from_millis(20));
    }
    if shim.try_wait().expect("final shim poll").is_none() {
        let _ = shim.kill();
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &child_id.to_string()])
            .status();
        panic!("Shim did not clean escaped descendant");
    }
    let output = shim.wait_with_output().expect("collect descendant output");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success());
    assert!(
        stderr.contains("terminated official CLI descendants after root exit"),
        "{stderr}"
    );
    assert!(
        !process_exists(child_id),
        "escaped descendant PID {child_id} survived"
    );
}
