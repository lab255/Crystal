//! Attention toasts with click-to-jump.
//!
//! `tauri-plugin-notification` is deliberately not used here: its desktop
//! backends are fire-and-forget (the handle is dropped, so no activation
//! callback ever reaches the app), which left a click on a Crystal toast doing
//! nothing while the browser build's web Notification onclick focuses the
//! window and deep-links to the waiting item. This module drives notify-rust
//! directly instead, keeps the notification handle, and blocks a small thread
//! on the platform's activation callback: a click focuses the main window and
//! echoes the serialized attention target back to the webview on the
//! `attention-clicked` event, where @crystal/client replays the exact jump the
//! web build performs (see useAttentionNotifications in attention-notifier.ts).

use tauri::{AppHandle, Emitter, Manager};

/// Event the webview listens for. The payload is the `target` JSON the webview
/// handed to `notify_attention`, untouched — Rust never interprets it, so the
/// client's AttentionTarget shape can evolve without touching the shell.
const ATTENTION_CLICKED: &str = "attention-clicked";

#[tauri::command]
pub fn notify_attention(
    app: AppHandle,
    title: String,
    body: String,
    target: serde_json::Value,
) -> Result<(), String> {
    // The activation wait blocks until the user clicks or dismisses the toast,
    // so each notification parks one thread. Attention transitions are rare
    // and the client collapses bursts into a single summary toast, so the
    // count stays small.
    std::thread::Builder::new()
        .name("attention-toast".into())
        .spawn(move || show_and_wait(&app, &title, &body, target))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn show_and_wait(app: &AppHandle, title: &str, body: &str, target: serde_json::Value) {
    use notify_rust::{Notification, NotificationResponse};

    let mut notification = Notification::new();
    notification.summary(title).body(body).auto_icon();
    // macOS: an action is what makes the send waitable (the delegate reports a
    // body click only when a response is expected); XDG: "default" is the
    // spec's body-click action. Windows body clicks always activate, and an
    // action there would render as an extra button — so no action on Windows.
    #[cfg(not(windows))]
    notification.action("default", "Open");
    // App identity, same recipe as tauri-plugin-notification's desktop path.
    #[cfg(windows)]
    {
        const SEP: char = std::path::MAIN_SEPARATOR;
        // Toasts need a registered AppUserModelID; the installed app has one
        // (the NSIS shortcut carries it), a bare `cargo run` does not — there
        // notify-rust falls back to its PowerShell app id so dev toasts still
        // show.
        let cargo_run = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.display().to_string()))
            .is_some_and(|dir| {
                dir.ends_with(&format!("{SEP}target{SEP}debug"))
                    || dir.ends_with(&format!("{SEP}target{SEP}release"))
            });
        if !cargo_run {
            notification.app_id(&app.config().identifier);
        }
    }
    #[cfg(target_os = "macos")]
    {
        // First caller wins; later calls error ("already set") and are ignored.
        let _ = notify_rust::set_application(if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            &app.config().identifier
        });
    }

    let handle = match notification.show() {
        Ok(handle) => handle,
        Err(err) => {
            crate::log_line(&format!("attention toast failed: {err}"));
            return;
        }
    };
    // Default = body click; Action = the "Open" button (macOS renders the
    // XDG default action as one). A toast that times out into the Windows
    // action center settles as Closed here — later clicks from the action
    // center can't reach an unpackaged app, which is a platform limit, not
    // ours. macOS keeps listening, so a click from Notification Center still
    // jumps long after the banner slid away.
    let _ = handle.wait_for_response(move |response: &NotificationResponse| {
        if matches!(
            response,
            NotificationResponse::Default | NotificationResponse::Action(_)
        ) {
            clicked(app, target);
        }
    });
}

/// Focus the shell and forward the target — the webview does the navigating.
fn clicked(app: &AppHandle, target: serde_json::Value) {
    if let Some(window) = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().values().next().cloned())
    {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let _ = app.emit(ATTENTION_CLICKED, target);
}
