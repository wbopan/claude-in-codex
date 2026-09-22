use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::desktop_backend_proxy::{ProxyPin, chromium_arguments, default_user_data_directory};

const PATH_OVERRIDES: [&str; 5] = [
    "HOME",
    "USERPROFILE",
    "ZDOTDIR",
    "CODEX_HOME",
    "CODEX_ELECTRON_USER_DATA_PATH",
];

/// LaunchServices does not inherit the launcher's environment. Forward only
/// explicit directory overrides, never arbitrary variables or authentication
/// material: macOS passes these entries through `open --env` arguments.
pub(crate) fn forwarded(
    variables: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let variables = variables.into_iter().collect::<Vec<_>>();
    if variables
        .iter()
        .any(|(name, value)| name == "CODEXHOST_REMOTE_SSH_MANAGED" && value == "1")
    {
        return Vec::new();
    }
    variables
        .into_iter()
        .filter(|(name, value)| {
            PATH_OVERRIDES.iter().any(|expected| name == *expected)
                && Path::new(value).is_absolute()
        })
        .collect()
}

/// Electron's app-level userData override does not redirect Chromium's early
/// session storage by itself. Match the official Desktop's isolated launch:
/// provide the same explicit profile as a Chromium argument as well.
pub(crate) fn launch_arguments(
    base: &[OsString],
    environment: &[(OsString, OsString)],
) -> Vec<OsString> {
    let mut arguments = base.to_vec();
    let explicit_profile = environment
        .iter()
        .find(|(name, directory)| {
            name == "CODEX_ELECTRON_USER_DATA_PATH" && Path::new(directory).is_absolute()
        })
        .map(|(_, directory)| PathBuf::from(directory));
    // The backend proxy pins one loopback certificate, and Chromium only reads
    // that pin for a profile it was told about. Both switches therefore have to
    // be appended together, and `--user-data-dir` exactly once: when no profile
    // was forwarded, the stock Desktop's own profile is named explicitly.
    if let Some(pin) = proxy_pin(environment) {
        let profile = explicit_profile
            .clone()
            .or_else(|| default_user_data_directory(&home_directory(environment)?));
        if let Some(profile) = profile {
            arguments.extend(chromium_arguments(&pin, &profile));
            return arguments;
        }
    }
    if let Some(profile) = explicit_profile {
        let mut argument = OsString::from("--user-data-dir=");
        argument.push(profile);
        arguments.push(argument);
    }
    arguments
}

fn proxy_pin(environment: &[(OsString, OsString)]) -> Option<ProxyPin> {
    environment
        .iter()
        .find(|(name, value)| name == "CODEXHOST_DESKTOP_PROXY_SPKI" && !value.is_empty())
        .and_then(|(_, value)| value.to_str())
        .map(|value| ProxyPin {
            spki_sha256_base64: value.to_owned(),
        })
}

/// The forwarded `HOME` decides the profile; a launch that forwards none still
/// runs under the launcher's own home, so that is the fallback.
fn home_directory(environment: &[(OsString, OsString)]) -> Option<PathBuf> {
    environment
        .iter()
        .find(|(name, value)| name == "HOME" && Path::new(value).is_absolute())
        .map(|(_, value)| PathBuf::from(value))
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
}

#[cfg(test)]
mod tests {
    use super::{forwarded, launch_arguments};
    use std::ffi::OsString;

    const PIN: &str = "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=";

    fn pin_entry() -> (OsString, OsString) {
        (
            OsString::from("CODEXHOST_DESKTOP_PROXY_SPKI"),
            OsString::from(PIN),
        )
    }

    #[test]
    fn rejects_relative_paths_and_unrelated_secrets() {
        let root = std::env::temp_dir().join("synthetic-desktop");
        let expected = (OsString::from("CODEX_HOME"), root.into_os_string());
        assert_eq!(
            forwarded([
                expected.clone(),
                (OsString::from("HOME"), OsString::from("relative")),
                (
                    OsString::from("CODEX_ELECTRON_USER_DATA_PATH"),
                    OsString::new()
                ),
                (
                    OsString::from("OPENAI_API_KEY"),
                    OsString::from("synthetic-secret")
                ),
                (
                    OsString::from("HTTPS_PROXY"),
                    OsString::from("https://synthetic:secret@example.invalid")
                ),
            ]),
            [expected],
        );
    }

    #[test]
    fn redirects_chromium_to_the_same_explicit_profile_without_splitting_spaces() {
        let profile = std::env::temp_dir()
            .join("synthetic profile")
            .into_os_string();
        let base = [OsString::from("--remote-debugging-port=12345")];
        let environment = [(
            OsString::from("CODEX_ELECTRON_USER_DATA_PATH"),
            profile.clone(),
        )];
        let mut expected = OsString::from("--user-data-dir=");
        expected.push(profile);
        assert_eq!(
            launch_arguments(&base, &environment),
            [base[0].clone(), expected]
        );
        assert_eq!(launch_arguments(&base, &[]), base);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn pins_the_stock_profile_when_no_explicit_profile_was_forwarded() {
        let base = [OsString::from("--remote-debugging-port=12345")];
        let environment = [
            (
                OsString::from("HOME"),
                OsString::from("/Users/synthetic home"),
            ),
            pin_entry(),
        ];
        assert_eq!(
            launch_arguments(&base, &environment),
            [
                base[0].clone(),
                OsString::from(
                    "--user-data-dir=/Users/synthetic home/Library/Application Support/Codex"
                ),
                OsString::from(format!("--ignore-certificate-errors-spki-list={PIN}")),
            ]
        );
    }

    #[test]
    fn pins_the_explicit_debug_profile_without_repeating_the_profile_switch() {
        let profile = std::env::temp_dir()
            .join("synthetic debug profile")
            .into_os_string();
        let base = [OsString::from("--remote-debugging-port=12345")];
        let environment = [
            (
                OsString::from("CODEX_ELECTRON_USER_DATA_PATH"),
                profile.clone(),
            ),
            (OsString::from("HOME"), OsString::from("/Users/synthetic")),
            pin_entry(),
        ];
        let mut expected_profile = OsString::from("--user-data-dir=");
        expected_profile.push(&profile);
        let arguments = launch_arguments(&base, &environment);
        assert_eq!(
            arguments,
            [
                base[0].clone(),
                expected_profile,
                OsString::from(format!("--ignore-certificate-errors-spki-list={PIN}")),
            ]
        );
        assert_eq!(
            arguments
                .iter()
                .filter(|argument| argument.to_string_lossy().starts_with("--user-data-dir="))
                .count(),
            1
        );
    }

    #[test]
    fn leaves_the_arguments_alone_without_a_pin() {
        let base = [OsString::from("--remote-debugging-port=12345")];
        let environment = [(OsString::from("HOME"), OsString::from("/Users/synthetic"))];
        assert_eq!(launch_arguments(&base, &environment), base);
        assert_eq!(
            launch_arguments(
                &base,
                &[(
                    OsString::from("CODEXHOST_DESKTOP_PROXY_SPKI"),
                    OsString::new()
                )]
            ),
            base
        );
    }

    #[test]
    fn does_not_install_remote_profile_paths_in_a_local_desktop() {
        let path = std::env::temp_dir()
            .join("synthetic-remote")
            .into_os_string();
        assert!(
            forwarded([
                (OsString::from("CODEX_HOME"), path.clone()),
                (OsString::from("HOME"), path),
                (
                    OsString::from("CODEXHOST_REMOTE_SSH_MANAGED"),
                    OsString::from("1")
                ),
            ])
            .is_empty()
        );
    }
}
