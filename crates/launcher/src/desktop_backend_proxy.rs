//! Loopback TLS material for the Desktop backend proxy.
//!
//! The Host terminates TLS for the Desktop's backend calls on `127.0.0.1`, so
//! Chromium has to be told to trust exactly one self-signed key. Chromium only
//! accepts that instruction as a base64 SHA-256 of the certificate's SPKI
//! passed through `--ignore-certificate-errors-spki-list`, and only when the
//! profile is named explicitly with `--user-data-dir`.
//!
//! Generation goes through `/usr/bin/openssl` on purpose: the workspace carries
//! no TLS crate and adding one for a single self-signed leaf would grow the
//! dependency graph far more than it is worth. LibreSSL 3.3.6 (the macOS
//! system build) copies `-addext` extensions into the `-x509` certificate, so
//! no temporary config file is needed.
//!
//! Nothing here may panic or abort a launch: the caller treats every failure as
//! "no proxy" and starts the Desktop unchanged.

use std::error::Error;
use std::ffi::OsString;
use std::fs::{self, DirBuilder, Permissions};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// System OpenSSL/LibreSSL. An absolute path keeps a hijacked `PATH` out of the
/// certificate pipeline.
const OPENSSL: &str = "/usr/bin/openssl";
const PROXY_DIRECTORY: &str = "desktop-proxy";
const CERTIFICATE_FILE: &str = "cert.pem";
const KEY_FILE: &str = "key.pem";
/// Regenerate once the leaf has less than 30 days left, well inside its 365-day
/// lifetime, so a long-lived install never serves an expired certificate.
const RENEWAL_WINDOW_SECONDS: &str = "2592000";
const CERTIFICATE_MODE: u32 = 0o644;
const KEY_MODE: u32 = 0o600;
const DIRECTORY_MODE: u32 = 0o700;

/// The pin both ends of the handshake compare: base64 SHA-256 of the DER SPKI.
pub(crate) struct ProxyPin {
    pub spki_sha256_base64: String,
}

/// Ensure `<data>/desktop-proxy/{cert.pem,key.pem}` exist and return their pin.
pub(crate) fn prepare(data_directory: &Path) -> Result<ProxyPin, Box<dyn Error>> {
    let directory = data_directory.join(PROXY_DIRECTORY);
    DirBuilder::new()
        .mode(DIRECTORY_MODE)
        .recursive(true)
        .create(&directory)
        .map_err(|error| {
            format!(
                "desktop proxy directory '{}' could not be created: {error}",
                directory.display()
            )
        })?;
    // `recursive` keeps the mode of a directory that already existed, so an
    // earlier, looser directory is tightened here rather than trusted.
    if let Ok(metadata) = fs::metadata(&directory)
        && metadata.permissions().mode() & 0o777 != DIRECTORY_MODE
    {
        let _ = fs::set_permissions(&directory, Permissions::from_mode(DIRECTORY_MODE));
    }

    let certificate = directory.join(CERTIFICATE_FILE);
    let key = directory.join(KEY_FILE);
    if needs_regeneration(&certificate, &key) {
        generate(&directory, &certificate, &key)?;
    }
    Ok(ProxyPin {
        spki_sha256_base64: spki_pin(&key)?,
    })
}

/// Regenerate when either half is missing, when the key is readable by anyone
/// but its owner, or when the certificate is inside its renewal window.
fn needs_regeneration(certificate: &Path, key: &Path) -> bool {
    let Ok(key_metadata) = fs::metadata(key) else {
        return true;
    };
    if !key_metadata.is_file() || key_metadata.permissions().mode() & 0o777 != KEY_MODE {
        return true;
    }
    if !fs::metadata(certificate).is_ok_and(|metadata| metadata.is_file()) {
        return true;
    }
    !certificate_outlives_renewal_window(certificate)
}

fn certificate_outlives_renewal_window(certificate: &Path) -> bool {
    Command::new(OPENSSL)
        .arg("x509")
        .arg("-in")
        .arg(certificate)
        .arg("-noout")
        .arg("-checkend")
        .arg(RENEWAL_WINDOW_SECONDS)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn generate(directory: &Path, certificate: &Path, key: &Path) -> Result<(), Box<dyn Error>> {
    // Stage inside the same 0700 directory: the private key never exists under
    // a world-traversable path, and the rename below stays on one filesystem.
    let staged_certificate = directory.join(format!("{CERTIFICATE_FILE}.{}.new", process_tag()));
    let staged_key = directory.join(format!("{KEY_FILE}.{}.new", process_tag()));
    let _ = fs::remove_file(&staged_certificate);
    let _ = fs::remove_file(&staged_key);

    let output = Command::new(OPENSSL)
        .arg("req")
        .arg("-x509")
        .arg("-newkey")
        .arg("rsa:2048")
        .arg("-nodes")
        .arg("-sha256")
        .arg("-days")
        .arg("365")
        .arg("-subj")
        .arg("/CN=codexhost desktop backend proxy")
        .arg("-addext")
        .arg("subjectAltName=IP:127.0.0.1,DNS:localhost")
        .arg("-addext")
        .arg("basicConstraints=critical,CA:FALSE")
        .arg("-addext")
        .arg("keyUsage=critical,digitalSignature,keyEncipherment")
        .arg("-addext")
        .arg("extendedKeyUsage=serverAuth")
        .arg("-keyout")
        .arg(&staged_key)
        .arg("-out")
        .arg(&staged_certificate)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("{OPENSSL} could not be started: {error}"))?;
    if !output.status.success() {
        let _ = fs::remove_file(&staged_certificate);
        let _ = fs::remove_file(&staged_key);
        return Err(format!(
            "{OPENSSL} could not create the desktop proxy certificate ({}): {}",
            output.status,
            first_error_line(&output.stderr)
        )
        .into());
    }

    let secure = |path: &Path, mode: u32| -> Result<(), Box<dyn Error>> {
        fs::set_permissions(path, Permissions::from_mode(mode)).map_err(|error| {
            format!(
                "desktop proxy file '{}' could not be secured: {error}",
                path.display()
            )
        })?;
        Ok(())
    };
    secure(&staged_key, KEY_MODE)?;
    secure(&staged_certificate, CERTIFICATE_MODE)?;

    codexhost_platform::atomic_replace_file(&staged_key, key)
        .map_err(|error| format!("desktop proxy key could not be installed: {error}"))?;
    codexhost_platform::atomic_replace_file(&staged_certificate, certificate)
        .map_err(|error| format!("desktop proxy certificate could not be installed: {error}"))?;
    Ok(())
}

/// Base64 SHA-256 of the DER SubjectPublicKeyInfo, derived from the private key
/// so it stays correct even if the certificate is replaced out from under us.
fn spki_pin(key: &Path) -> Result<String, Box<dyn Error>> {
    let output = Command::new(OPENSSL)
        .arg("pkey")
        .arg("-in")
        .arg(key)
        .arg("-pubout")
        .arg("-outform")
        .arg("der")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("{OPENSSL} could not be started: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "{OPENSSL} could not read the desktop proxy key ({}): {}",
            output.status,
            first_error_line(&output.stderr)
        )
        .into());
    }
    if output.stdout.is_empty() {
        return Err(format!("{OPENSSL} produced an empty desktop proxy public key").into());
    }
    Ok(codexhost_platform::sha256_base64(&output.stdout))
}

/// The two Chromium switches that pin the loopback certificate. They are single
/// `OsString`s: the profile path may contain spaces and must never be split.
pub(crate) fn chromium_arguments(pin: &ProxyPin, user_data_dir: &Path) -> Vec<OsString> {
    let mut profile = OsString::from("--user-data-dir=");
    profile.push(user_data_dir);
    let mut pinned = OsString::from("--ignore-certificate-errors-spki-list=");
    pinned.push(&pin.spki_sha256_base64);
    vec![profile, pinned]
}

/// The profile the stock Desktop computes for itself. Chromium ignores the SPKI
/// list unless the profile is named, so the default launch has to spell out the
/// very directory it would have used anyway.
#[cfg(target_os = "macos")]
pub(crate) fn default_user_data_directory(home: &Path) -> Option<PathBuf> {
    if !home.is_absolute() {
        return None;
    }
    Some(home.join("Library/Application Support/Codex"))
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn default_user_data_directory(_home: &Path) -> Option<PathBuf> {
    None
}

fn process_tag() -> String {
    std::process::id().to_string()
}

fn first_error_line(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no diagnostic output")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory(name: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};

        static NEXT: AtomicU64 = AtomicU64::new(0);
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "codexhost-desktop-proxy-{name}-{}-{}-{unique}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&directory).expect("create temp directory");
        directory
    }

    #[test]
    fn pins_the_profile_and_the_key_without_splitting_spaces() {
        let pin = ProxyPin {
            spki_sha256_base64: "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=".into(),
        };
        let profile = Path::new("/tmp/synthetic profile/Codex");
        assert_eq!(
            chromium_arguments(&pin, profile),
            [
                OsString::from("--user-data-dir=/tmp/synthetic profile/Codex"),
                OsString::from(
                    "--ignore-certificate-errors-spki-list=ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="
                ),
            ]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn names_the_stock_desktop_profile() {
        assert_eq!(
            default_user_data_directory(Path::new("/Users/synthetic")),
            Some(PathBuf::from(
                "/Users/synthetic/Library/Application Support/Codex"
            ))
        );
        assert_eq!(default_user_data_directory(Path::new("relative")), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn regenerates_when_material_is_missing_or_exposed() {
        let directory = temporary_directory("regeneration");
        let certificate = directory.join(CERTIFICATE_FILE);
        let key = directory.join(KEY_FILE);
        assert!(
            needs_regeneration(&certificate, &key),
            "missing material must regenerate"
        );

        generate(&directory, &certificate, &key).expect("generate certificate");
        assert!(
            !needs_regeneration(&certificate, &key),
            "a fresh pair must be reused"
        );

        fs::remove_file(&certificate).expect("remove certificate");
        assert!(
            needs_regeneration(&certificate, &key),
            "a missing certificate must regenerate"
        );

        generate(&directory, &certificate, &key).expect("regenerate certificate");
        fs::set_permissions(&key, Permissions::from_mode(0o644)).expect("expose key");
        assert!(
            needs_regeneration(&certificate, &key),
            "a world-readable key must regenerate"
        );

        fs::remove_dir_all(&directory).expect("clean up");
    }

    /// The Host recomputes this pin with Node's
    /// `createHash("sha256").digest("base64")`, so the Rust encoder has to
    /// agree with the ordinary OpenSSL/Node spelling of the same digest.
    #[cfg(target_os = "macos")]
    #[test]
    fn matches_the_openssl_spelling_of_the_digest() {
        let data_directory = temporary_directory("digest");
        let pin = prepare(&data_directory).expect("prepare");
        let key = data_directory.join(PROXY_DIRECTORY).join(KEY_FILE);
        let expected = Command::new("/bin/sh")
            .arg("-c")
            .arg(format!(
                "{OPENSSL} pkey -in '{}' -pubout -outform der | {OPENSSL} dgst -sha256 -binary | {OPENSSL} base64 -A",
                key.display()
            ))
            .output()
            .expect("run openssl digest pipeline");
        assert!(expected.status.success());
        assert_eq!(
            pin.spki_sha256_base64,
            String::from_utf8_lossy(&expected.stdout).trim()
        );

        fs::remove_dir_all(&data_directory).expect("clean up");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reuses_the_same_material_across_calls() {
        use std::os::unix::fs::MetadataExt;

        let data_directory = temporary_directory("reuse");
        let first = prepare(&data_directory).expect("first prepare");
        let directory = data_directory.join(PROXY_DIRECTORY);
        assert_eq!(
            fs::metadata(&directory)
                .expect("proxy directory")
                .permissions()
                .mode()
                & 0o777,
            DIRECTORY_MODE
        );
        let key = directory.join(KEY_FILE);
        let certificate = directory.join(CERTIFICATE_FILE);
        assert_eq!(
            fs::metadata(&key).expect("key").permissions().mode() & 0o777,
            KEY_MODE
        );
        assert_eq!(
            fs::metadata(&certificate)
                .expect("certificate")
                .permissions()
                .mode()
                & 0o777,
            CERTIFICATE_MODE
        );
        let key_inode = fs::metadata(&key).expect("key").ino();
        let certificate_inode = fs::metadata(&certificate).expect("certificate").ino();

        let second = prepare(&data_directory).expect("second prepare");
        assert_eq!(first.spki_sha256_base64, second.spki_sha256_base64);
        assert!(!first.spki_sha256_base64.is_empty());
        assert_eq!(fs::metadata(&key).expect("key").ino(), key_inode);
        assert_eq!(
            fs::metadata(&certificate).expect("certificate").ino(),
            certificate_inode
        );
        assert!(
            !fs::read_dir(&directory)
                .expect("read proxy directory")
                .any(|entry| entry
                    .expect("directory entry")
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".new")),
            "staging files must not survive a successful generation"
        );

        fs::remove_dir_all(&data_directory).expect("clean up");
    }
}
