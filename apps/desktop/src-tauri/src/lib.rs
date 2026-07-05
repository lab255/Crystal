use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

/// Handle to the spawned Crystal bridge server, killed on app exit.
struct BridgeProcess(Mutex<Option<Child>>);

/// Spawn the Crystal bridge server next to the app when configured.
///
/// The desktop shell talks to the same bridge protocol as the web app. In
/// development `pnpm dev` already runs the server, so we only spawn one when
/// the `CRYSTAL_SPAWN_SERVER` env var provides a command line, e.g.
/// `CRYSTAL_SPAWN_SERVER=node C:/crystal/apps/server/dist/index.js`.
fn spawn_bridge() -> Option<Child> {
    let cmdline = std::env::var("CRYSTAL_SPAWN_SERVER").ok()?;
    let mut parts = cmdline.split_whitespace();
    let program = parts.next()?;
    let args: Vec<&str> = parts.collect();
    match Command::new(program).args(&args).spawn() {
        Ok(child) => Some(child),
        Err(err) => {
            eprintln!("[crystal] failed to spawn bridge server: {err}");
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let bridge = BridgeProcess(Mutex::new(spawn_bridge()));

    tauri::Builder::default()
        .manage(bridge)
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<BridgeProcess>();
                let mut guard = match state.0.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                if let Some(child) = guard.as_mut() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Crystal");
}
