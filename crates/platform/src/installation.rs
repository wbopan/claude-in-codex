#[cfg(target_os = "macos")]
use std::env;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::fs::File;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::io::Read;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::unix::fs::PermissionsExt;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
use plist::Value;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use sha2::{Digest, Sha256};

#[cfg(target_os = "macos")]
use super::DesktopIdentity;
#[cfg(not(target_os = "linux"))]
use super::DesktopInstallation;
use super::PlatformError;

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn sha256_file(path: &Path) -> Result<String, PlatformError> {
    let metadata = path.metadata().map_err(|error| {
        PlatformError::NotFound(format!(
            "Codex Desktop resource '{}' is unavailable: {error}",
            path.display()
        ))
    })?;
    if !metadata.is_file() {
        return Err(PlatformError::Invalid(format!(
            "Codex Desktop resource '{}' is not a regular file",
            path.display()
        )));
    }
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
}
#[cfg(target_os = "macos")]
use super::CUSTOM_INSTALL_ROOT_ENV;

/// Read the standalone portable-installation override.
///
/// This is deliberately independent of the Gate A `CODEXHOST_PROBE_*` set: it
/// names an installation root on its own, so an unpacked Desktop can be located
/// without supplying package identity and version as well.
#[cfg(target_os = "macos")]
fn custom_install_root(
    value: impl Fn(&'static str) -> Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    value(CUSTOM_INSTALL_ROOT_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[cfg(target_os = "macos")]
const CODEX_BUNDLE_IDENTIFIER: &str = "com.openai.codex";
#[cfg(target_os = "macos")]
const MACH_O_MAGICS: [[u8; 4]; 8] = [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
    [0xbe, 0xba, 0xfe, 0xca],
    [0xca, 0xfe, 0xba, 0xbf],
    [0xbf, 0xba, 0xfe, 0xca],
];

#[cfg(target_os = "macos")]
fn required_string<'a>(
    dictionary: &'a plist::Dictionary,
    key: &str,
    bundle: &Path,
) -> Result<&'a str, PlatformError> {
    dictionary
        .get(key)
        .and_then(Value::as_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            PlatformError::Invalid(format!(
                "Codex App '{}' has no string {key}",
                bundle.display()
            ))
        })
}

#[cfg(target_os = "macos")]
fn macos_asar_integrity(
    dictionary: &plist::Dictionary,
    bundle: &Path,
) -> Result<String, PlatformError> {
    let official = dictionary
        .get("ElectronAsarIntegrity")
        .and_then(Value::as_dictionary)
        .and_then(|entries| entries.get("Resources/app.asar"))
        .and_then(Value::as_dictionary)
        .and_then(|entry| {
            let algorithm = entry.get("algorithm")?.as_string()?;
            let hash = entry.get("hash")?.as_string()?;
            (algorithm == "SHA256"
                && hash.len() == 64
                && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| format!("sha256:{}", hash.to_ascii_lowercase()))
        });
    official.map_or_else(
        || sha256_file(&bundle.join("Contents/Resources/app.asar")),
        Ok,
    )
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn canonical_unix_executable(
    path: &Path,
    label: &str,
) -> Result<PathBuf, PlatformError> {
    let metadata = path.symlink_metadata().map_err(|error| {
        PlatformError::NotFound(format!(
            "{label} '{}' is unavailable: {error}",
            path.display()
        ))
    })?;
    if !metadata.file_type().is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return Err(PlatformError::Invalid(format!(
            "{label} '{}' is not an executable regular file",
            path.display()
        )));
    }
    path.canonicalize().map_err(PlatformError::Io)
}

#[cfg(target_os = "macos")]
fn canonical_macho_executable(path: &Path, label: &str) -> Result<PathBuf, PlatformError> {
    let canonical = canonical_unix_executable(path, label)?;
    let mut magic = [0_u8; 4];
    File::open(&canonical)?
        .read_exact(&mut magic)
        .map_err(|error| {
            PlatformError::Invalid(format!(
                "{label} '{}' has no complete Mach-O header: {error}",
                path.display()
            ))
        })?;
    if !MACH_O_MAGICS.contains(&magic) {
        return Err(PlatformError::Invalid(format!(
            "{label} '{}' is not a Mach-O executable",
            path.display()
        )));
    }
    Ok(canonical)
}

#[cfg(target_os = "macos")]
fn inspect_bundle(bundle: &Path) -> Result<DesktopInstallation, PlatformError> {
    let bundle = bundle.canonicalize().map_err(|error| {
        PlatformError::NotFound(format!(
            "Codex App bundle '{}' is unavailable: {error}",
            bundle.display()
        ))
    })?;
    let plist_path = bundle.join("Contents/Info.plist");
    let value = Value::from_file(&plist_path).map_err(|error| {
        PlatformError::Invalid(format!(
            "Codex App Info.plist '{}' is invalid: {error}",
            plist_path.display()
        ))
    })?;
    let dictionary = value.as_dictionary().ok_or_else(|| {
        PlatformError::Invalid(format!(
            "Codex App Info.plist '{}' is not a dictionary",
            plist_path.display()
        ))
    })?;
    let bundle_identifier = required_string(dictionary, "CFBundleIdentifier", &bundle)?;
    if bundle_identifier != CODEX_BUNDLE_IDENTIFIER {
        return Err(PlatformError::Invalid(format!(
            "App bundle '{}' has unexpected identifier '{bundle_identifier}'",
            bundle.display()
        )));
    }
    let executable_name = required_string(dictionary, "CFBundleExecutable", &bundle)?;
    if Path::new(executable_name).components().count() != 1 {
        return Err(PlatformError::Invalid(format!(
            "App bundle '{}' has unsafe CFBundleExecutable '{executable_name}'",
            bundle.display()
        )));
    }
    let version = required_string(dictionary, "CFBundleShortVersionString", &bundle)?.to_owned();
    let build = required_string(dictionary, "CFBundleVersion", &bundle)?.to_owned();
    let asar_integrity = macos_asar_integrity(dictionary, &bundle)?;
    let desktop_executable = canonical_macho_executable(
        &bundle.join("Contents/MacOS").join(executable_name),
        "Desktop executable",
    )?;
    let packaged_codex_cli =
        canonical_macho_executable(&bundle.join("Contents/Resources/codex"), "Codex CLI")?;
    if !desktop_executable.starts_with(&bundle) || !packaged_codex_cli.starts_with(&bundle) {
        return Err(PlatformError::Invalid(format!(
            "App bundle '{}' resolves an executable outside the bundle",
            bundle.display()
        )));
    }

    Ok(DesktopInstallation {
        identity: DesktopIdentity::MacOsBundle {
            bundle_identifier: bundle_identifier.to_owned(),
        },
        version,
        build,
        asar_integrity,
        install_root: bundle,
        desktop_launcher: desktop_executable.clone(),
        desktop_executable,
        packaged_codex_cli: packaged_codex_cli.clone(),
        executable_codex_cli: packaged_codex_cli,
    })
}

#[cfg(target_os = "macos")]
fn discover_from_candidates(
    candidates: impl IntoIterator<Item = PathBuf>,
) -> Result<DesktopInstallation, PlatformError> {
    let mut installations = Vec::new();
    let mut invalid = Vec::new();
    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }
        match inspect_bundle(&candidate) {
            Ok(installation) => installations.push(installation),
            Err(error) => invalid.push(format!("{}: {error}", candidate.display())),
        }
    }
    match installations.len() {
        1 => Ok(installations.remove(0)),
        0 if invalid.is_empty() => Err(PlatformError::NotFound(
            "official Codex App was not found in /Applications or ~/Applications".into(),
        )),
        0 => Err(PlatformError::Invalid(format!(
            "no valid official Codex App candidate: {}",
            invalid.join("; ")
        ))),
        _ => Err(PlatformError::Invalid(format!(
            "multiple valid official Codex App installations were found: {}",
            installations
                .iter()
                .map(|installation| installation.install_root.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

#[cfg(target_os = "macos")]
pub fn discover_codex_desktop() -> Result<DesktopInstallation, PlatformError> {
    let mut candidates = vec![
        PathBuf::from("/Applications/Codex.app"),
        PathBuf::from("/Applications/ChatGPT.app"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let applications = PathBuf::from(home).join("Applications");
        candidates.push(applications.join("Codex.app"));
        candidates.push(applications.join("ChatGPT.app"));
    }
    discover_from_candidates(candidates)
}

/// Resolve a helper's official CLI from a validated Desktop bundle, never PATH.
/// An explicit installation root is authoritative, including when invalid.
#[cfg(target_os = "macos")]
pub fn discover_desktop_managed_codex_cli() -> Result<PathBuf, PlatformError> {
    let installation = match custom_install_root(env::var_os) {
        Some(root) => inspect_bundle(&root)?,
        None => discover_codex_desktop()?,
    };
    Ok(installation.executable_codex_cli)
}

/// Inspect an explicit macOS bundle without selecting another installation.
#[cfg(target_os = "macos")]
pub fn discover_codex_desktop_from_root(root: &Path) -> Result<DesktopInstallation, PlatformError> {
    inspect_bundle(root)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn discover_codex_desktop() -> Result<DesktopInstallation, PlatformError> {
    Err(PlatformError::Unsupported(
        "the Codex Desktop probe currently supports macOS and Linux only",
    ))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::PathBuf;

    use super::{DesktopIdentity, PlatformError, discover_from_candidates};
    use crate::temporary_directory;

    fn temporary_bundle(name: &str, bundle_identifier: &str, include_cli: bool) -> PathBuf {
        let bundle = temporary_directory("codexhost-platform-bundle").join(name);
        fs::create_dir_all(bundle.join("Contents/MacOS")).expect("create MacOS directory");
        fs::create_dir_all(bundle.join("Contents/Resources")).expect("create Resources directory");
        fs::write(
            bundle.join("Contents/Info.plist"),
            format!(
                concat!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
                    "<plist version=\"1.0\"><dict>",
                    "<key>CFBundleIdentifier</key><string>{}</string>",
                    "<key>CFBundleExecutable</key><string>ChatGPT</string>",
                    "<key>CFBundleShortVersionString</key><string>1.2.3</string>",
                    "<key>CFBundleVersion</key><string>456</string>",
                    "</dict></plist>"
                ),
                bundle_identifier
            ),
        )
        .expect("write plist");
        fs::write(
            bundle.join("Contents/Resources/app.asar"),
            b"reviewed app asar",
        )
        .expect("write app.asar");
        for path in [
            Some(bundle.join("Contents/MacOS/ChatGPT")),
            include_cli.then(|| bundle.join("Contents/Resources/codex")),
        ]
        .into_iter()
        .flatten()
        {
            fs::write(&path, [0xcf, 0xfa, 0xed, 0xfe]).expect("write Mach-O marker");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                .expect("make fixture executable");
        }
        bundle
    }

    #[test]
    fn discovers_a_valid_macos_bundle_under_current_or_legacy_app_names() {
        for app_name in ["Codex.app", "ChatGPT.app"] {
            let bundle = temporary_bundle(app_name, "com.openai.codex", true);
            let installation = discover_from_candidates([bundle.clone()]).expect("valid bundle");
            assert_eq!(installation.version, "1.2.3");
            assert_eq!(installation.build, "456");
            assert!(installation.asar_integrity.starts_with("sha256:"));
            assert_eq!(
                installation.install_root,
                bundle.canonicalize().expect("bundle")
            );
            assert_eq!(
                installation.identity,
                DesktopIdentity::MacOsBundle {
                    bundle_identifier: "com.openai.codex".into()
                }
            );
            assert_eq!(
                installation.packaged_codex_cli,
                installation.executable_codex_cli
            );
        }
    }

    #[test]
    fn rejects_wrong_bundle_identity_and_missing_cli() {
        let wrong = temporary_bundle("Wrong.app", "example.invalid", true);
        let missing = temporary_bundle("Missing.app", "com.openai.codex", false);
        assert!(matches!(
            discover_from_candidates([wrong]),
            Err(PlatformError::Invalid(_))
        ));
        assert!(matches!(
            discover_from_candidates([missing]),
            Err(PlatformError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_cli_symlink_outside_bundle() {
        let bundle = temporary_bundle("Codex.app", "com.openai.codex", false);
        let external = bundle.parent().expect("parent").join("external-codex");
        fs::write(&external, [0xcf, 0xfa, 0xed, 0xfe]).expect("write external CLI");
        fs::set_permissions(&external, fs::Permissions::from_mode(0o755))
            .expect("make external CLI executable");
        symlink(&external, bundle.join("Contents/Resources/codex")).expect("link external CLI");
        assert!(matches!(
            discover_from_candidates([bundle]),
            Err(PlatformError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_ambiguous_valid_bundles() {
        let first = temporary_bundle("First.app", "com.openai.codex", true);
        let second = temporary_bundle("Second.app", "com.openai.codex", true);
        assert!(matches!(
            discover_from_candidates([first, second]),
            Err(PlatformError::Invalid(message)) if message.contains("multiple valid")
        ));
    }
}
