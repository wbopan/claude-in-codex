#![forbid(unsafe_code)]

use std::process;

fn main() {
    let exit_code = match claude_in_codex_shim::run_from_environment() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("claude-in-codex shim: {error}");
            1
        }
    };
    process::exit(exit_code);
}
