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

/// Append-mode log file for the sidecar's stdout/stderr. The desktop app has
/// no console (windows_subsystem = "windows"), so without this a sidecar
/// crash leaves no trace anywhere.
fn sidecar_log() -> Option<std::fs::File> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let dir = std::path::Path::new(&home).join(".crystal").join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("desktop-sidecar.log"))
        .ok()
}

/// Route the sidecar's output to the log file (falls back to inherit).
fn attach_log(cmd: &mut Command) {
    if let Some(out) = sidecar_log() {
        if let Ok(err) = out.try_clone() {
            cmd.stdout(out);
            cmd.stderr(err);
        }
    }
}

/// Spawn the Crystal bridge server.
///
/// Production: the server ships as a sidecar executable next to the app
/// binary (`crystal-server.exe`, a Node SEA build of @crystal/server).
/// Development: `pnpm dev` already runs it, so nothing is spawned unless the
/// `CRYSTAL_SPAWN_SERVER` env var provides an explicit command line.
///
/// `module_base` is the staged-resources dir (`<resource>/sidecar`) that holds
/// node-pty's native module; it's passed to the sidecar as
/// `CRYSTAL_SIDECAR_MODULE_BASE` so the SEA bundle's require() can find it.
fn spawn_bridge(module_base: Option<&std::path::Path>) -> Option<Child> {
    if let Ok(cmdline) = std::env::var("CRYSTAL_SPAWN_SERVER") {
        let mut parts = cmdline.split_whitespace();
        let program = parts.next()?;
        let args: Vec<&str> = parts.collect();
        let mut cmd = Command::new(program);
        cmd.args(&args);
        if let Some(base) = module_base {
            cmd.env("CRYSTAL_SIDECAR_MODULE_BASE", base);
        }
        attach_log(&mut cmd);
        return match cmd.spawn() {
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
    let mut cmd = Command::new(&sidecar);
    cmd.args(["--root", &root.to_string_lossy(), "--port", "4517"]);
    if let Some(base) = module_base {
        cmd.env("CRYSTAL_SIDECAR_MODULE_BASE", base);
    }
    attach_log(&mut cmd);
    match cmd.spawn() {
        Ok(child) => Some(child),
        Err(err) => {
            eprintln!("[crystal] failed to spawn sidecar {sidecar:?}: {err}");
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // The staged node-pty resource lives at `<resource>/sidecar`; the
            // SEA sidecar anchors its require() there to load the native addon.
            let base = app
                .path()
                .resolve("sidecar", tauri::path::BaseDirectory::Resource)
                .ok();
            let child = spawn_bridge(base.as_deref());
            app.manage(BridgeProcess(Mutex::new(child)));
            Ok(())
        })
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
