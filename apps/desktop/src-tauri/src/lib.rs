use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

/// Handle to the spawned Crystal bridge server, killed on app exit.
struct BridgeProcess(Mutex<Option<Child>>);

/// Workspace the desktop app serves: `CRYSTAL_ROOT` env, else
/// `~/CrystalWorkspace` (created on first launch).
fn workspace_root() -> std::path::PathBuf {
    if let Ok(root) = std::env::var("CRYSTAL_ROOT") {
        return std::path::PathBuf::from(root);
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    let root = std::path::Path::new(&home).join("CrystalWorkspace");
    let _ = std::fs::create_dir_all(&root);
    root
}

/// Spawn the Crystal bridge server.
///
/// Production: the server ships as a sidecar executable next to the app
/// binary (`crystal-server.exe`, a Node SEA build of @crystal/server).
/// Development: `pnpm dev` already runs it, so nothing is spawned unless the
/// `CRYSTAL_SPAWN_SERVER` env var provides an explicit command line.
fn spawn_bridge() -> Option<Child> {
    if let Ok(cmdline) = std::env::var("CRYSTAL_SPAWN_SERVER") {
        let mut parts = cmdline.split_whitespace();
        let program = parts.next()?;
        let args: Vec<&str> = parts.collect();
        return match Command::new(program).args(&args).spawn() {
            Ok(child) => Some(child),
            Err(err) => {
                eprintln!("[crystal] failed to spawn bridge server: {err}");
                None
            }
        };
    }

    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let sidecar = exe_dir.join(if cfg!(windows) { "crystal-server.exe" } else { "crystal-server" });
    if !sidecar.exists() {
        // tauri dev — the workspace dev server owns the bridge.
        return None;
    }
    let root = workspace_root();
    match Command::new(&sidecar)
        .args(["--root", &root.to_string_lossy(), "--port", "4517"])
        .spawn()
    {
        Ok(child) => Some(child),
        Err(err) => {
            eprintln!("[crystal] failed to spawn sidecar {sidecar:?}: {err}");
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
