//! MeetScribe Tauri shell.
//!
//! Responsibilities:
//!   - spawn the Python sidecar (`meetscribe-sidecar`) and keep it alive
//!   - register the `meetscribe://` deep link for the OAuth callback
//!   - raise the floating `bar` window to a macOS floating level on all spaces
//!   - bridge token storage to the OS keychain
//!   - tear the sidecar down on exit

mod tokens;

use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Holds the spawned sidecar child so we can kill it on exit.
#[derive(Default)]
struct SidecarProcess(Mutex<Option<CommandChild>>);

#[derive(Clone, serde::Serialize)]
struct AuthCallbackPayload {
    access_token: String,
    refresh_token: String,
}

// --- Commands ---------------------------------------------------------------

#[tauri::command]
fn toggle_panel(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("panel")
        .ok_or_else(|| "panel window not found".to_string())?;
    if window.is_visible().unwrap_or(false) {
        window.hide().map_err(|e| e.to_string())?;
    } else {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn toggle_caption(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("caption")
        .ok_or_else(|| "caption window not found".to_string())?;
    if window.is_visible().unwrap_or(false) {
        window.hide().map_err(|e| e.to_string())?;
    } else {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// Absolute path to a session's local recording, if it exists on this machine.
/// Recordings live only locally at ~/.meetscribe/recordings/<localId>.wav.
#[tauri::command]
fn recording_path(local_id: String) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let path = std::path::PathBuf::from(home)
        .join(".meetscribe")
        .join("recordings")
        .join(format!("{local_id}.wav"));
    if path.exists() {
        Some(path.to_string_lossy().into_owned())
    } else {
        None
    }
}

#[tauri::command]
fn hide_bar(app: AppHandle) -> Result<(), String> {
    // Hide (not close) so the menu-bar tray can bring it back.
    if let Some(window) = app.get_webview_window("bar") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Show + focus the floating bar window (used by the tray menu).
fn show_bar(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("bar") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
async fn open_auth_browser(app: AppHandle) -> Result<(), String> {
    // PKCE: a real implementation generates a verifier/challenge pair and keeps
    // the verifier locally. We pass the challenge to the backend, which begins
    // the Google consent flow and deep-links the tokens back to us.
    let url = format!("{}/api/v1/auth/google", backend_url());
    app.shell()
        .open(url, None)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn store_tokens(access: String, refresh: String) -> Result<(), String> {
    tokens::store(&access, &refresh)
}

#[tauri::command]
fn get_access_token() -> Option<String> {
    tokens::get_access()
}

#[tauri::command]
fn get_refresh_token() -> Option<String> {
    tokens::get_refresh()
}

#[tauri::command]
fn clear_tokens() -> Result<(), String> {
    tokens::clear()
}

fn backend_url() -> String {
    option_env!("MEETSCRIBE_BACKEND_URL")
        .unwrap_or("https://meetscribe-api.onrender.com")
        .to_string()
}

// --- Deep link handling -----------------------------------------------------

/// Parse `meetscribe://auth/callback?access_token=..&refresh_token=..` and emit
/// `auth-callback` to the frontend.
fn handle_deep_link(app: &AppHandle, urls: &[String]) {
    for raw in urls {
        let Ok(parsed) = url::Url::parse(raw) else {
            continue;
        };
        if parsed.host_str() != Some("auth") {
            continue;
        }
        let mut access = None;
        let mut refresh = None;
        for (k, v) in parsed.query_pairs() {
            match k.as_ref() {
                "access_token" => access = Some(v.into_owned()),
                "refresh_token" => refresh = Some(v.into_owned()),
                _ => {}
            }
        }
        if let (Some(access_token), Some(refresh_token)) = (access, refresh) {
            let _ = app.emit(
                "auth-callback",
                AuthCallbackPayload {
                    access_token,
                    refresh_token,
                },
            );
            if let Some(panel) = app.get_webview_window("panel") {
                let _ = panel.show();
                let _ = panel.set_focus();
            }
        }
    }
}

// --- macOS window level -----------------------------------------------------

/// Raise the floating windows (bar + caption overlay) to a level that joins all
/// spaces, including fullscreen apps. No-op on non-macOS targets.
#[cfg(target_os = "macos")]
fn raise_window_level(app: &AppHandle) {
    use cocoa::appkit::NSWindow;
    use cocoa::base::id;

    for label in ["bar", "caption"] {
        if let Some(window) = app.get_webview_window(label) {
            if let Ok(ns_window) = window.ns_window() {
                let ns_window = ns_window as id;
                unsafe {
                    // NSFloatingWindowLevel == 5
                    NSWindow::setLevel_(ns_window, 5);
                    // NSWindowCollectionBehaviorCanJoinAllSpaces (1<<0)
                    // | NSWindowCollectionBehaviorFullScreenAuxiliary (1<<8)
                    let behavior: u64 = (1 << 0) | (1 << 8);
                    let _: () = msg_send_set_collection_behavior(ns_window, behavior);
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
unsafe fn msg_send_set_collection_behavior(ns_window: cocoa::base::id, behavior: u64) {
    use objc::{msg_send, sel, sel_impl};
    let _: () = msg_send![ns_window, setCollectionBehavior: behavior];
}

#[cfg(not(target_os = "macos"))]
fn raise_window_level(_app: &AppHandle) {}

// --- Sidecar ----------------------------------------------------------------

fn spawn_sidecar(app: &AppHandle) {
    let state: State<SidecarProcess> = app.state();
    let sidecar = match app.shell().sidecar("meetscribe-sidecar") {
        Ok(cmd) => cmd,
        Err(e) => {
            eprintln!("failed to locate sidecar: {e}");
            return;
        }
    };
    match sidecar.spawn() {
        Ok((mut rx, child)) => {
            *state.0.lock().unwrap() = Some(child);
            // Pipe sidecar stderr/stdout to our console for debugging.
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stderr(line) => {
                            eprintln!("[sidecar] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stdout(line) => {
                            println!("[sidecar] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[sidecar] terminated: {:?}", payload);
                            break;
                        }
                        _ => {}
                    }
                }
            });
        }
        Err(e) => eprintln!("failed to spawn sidecar: {e}"),
    }
}

fn kill_sidecar(app: &AppHandle) {
    let state: State<SidecarProcess> = app.state();
    // Take the child out (releasing the lock) before killing, so the
    // MutexGuard temporary doesn't outlive `state`.
    let child = state.0.lock().unwrap().take();
    if let Some(child) = child {
        let _ = child.kill();
    }
}

// --- Menu-bar tray ----------------------------------------------------------

/// Build the macOS menu-bar (status bar) icon with a menu to re-open the bar /
/// panel after they've been hidden, and to quit. This is how the user brings
/// the floating control bar back from the menu bar.
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_bar_item =
        MenuItem::with_id(app, "show_bar", "Show Control Bar", true, None::<&str>)?;
    let show_panel_item =
        MenuItem::with_id(app, "show_panel", "Show Panel", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit MeetScribe", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_bar_item, &show_panel_item, &quit_item])?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("MeetScribe")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show_bar" => show_bar(app),
            "show_panel" => {
                if let Some(window) = app.get_webview_window("panel") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

// --- Entry point ------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .manage(SidecarProcess::default())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Surface the existing instance instead of opening a second one.
            if let Some(bar) = app.get_webview_window("bar") {
                let _ = bar.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            toggle_panel,
            toggle_caption,
            recording_path,
            quit,
            hide_bar,
            open_auth_browser,
            store_tokens,
            get_access_token,
            get_refresh_token,
            clear_tokens
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Deep-link events (cold start args + runtime).
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let dl_handle = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                    handle_deep_link(&dl_handle, &urls);
                });
            }

            spawn_sidecar(&handle);
            raise_window_level(&handle);
            if let Err(e) = setup_tray(&handle) {
                eprintln!("failed to set up tray: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the bar quits the app; closing the panel just hides it.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "panel" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building MeetScribe")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                kill_sidecar(app);
            }
        });
}
