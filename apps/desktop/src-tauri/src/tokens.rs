//! Token storage for the access + refresh tokens.
//!
//! The spec calls for the OS keychain. In dev that triggers a Keychain access
//! prompt on every rebuilt (re-signed) binary, which silently blocks login, so
//! here we use a simple JSON file under `~/.meetscribe/tokens.json`. For a
//! signed production build, swap this back to the `keyring` crate (the command
//! surface in lib.rs stays identical).

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Default, Serialize, Deserialize)]
struct Tokens {
    access: Option<String>,
    refresh: Option<String>,
}

fn tokens_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".meetscribe").join("tokens.json")
}

fn read() -> Tokens {
    fs::read_to_string(tokens_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn store(access: &str, refresh: &str) -> Result<(), String> {
    let path = tokens_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tokens = Tokens {
        access: Some(access.to_string()),
        refresh: Some(refresh.to_string()),
    };
    let json = serde_json::to_string(&tokens).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

pub fn get_access() -> Option<String> {
    read().access
}

pub fn get_refresh() -> Option<String> {
    read().refresh
}

pub fn clear() -> Result<(), String> {
    let path = tokens_path();
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
