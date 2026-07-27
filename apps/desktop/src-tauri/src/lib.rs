use std::collections::HashMap;
use std::io::Write;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// A sidecar exit faster than this counts as a startup failure (port conflict,
/// bad binary) rather than a crash worth retrying indefinitely.
const RAPID_EXIT: Duration = Duration::from_secs(5);
/// Consecutive rapid exits before the supervisor gives up restarting.
const MAX_RAPID_FAILURES: u32 = 5;
/// How long shutdown waits for the sidecar to exit after stdin closes.
const SHUTDOWN_GRACE: Duration = Duration::from_millis(3000);

/// State shared between the supervisor thread and app shutdown.
struct BridgeSupervisor {
    /// Set when the app is closing: the supervisor must not restart the child.
    shutdown: AtomicBool,
    /// The live child's stdin. Dropping it asks the server to exit cleanly —
    /// Windows has no SIGTERM equivalent for a GUI-spawned child, so the
    /// server watches for stdin end (CRYSTAL_SHUTDOWN_ON_STDIN_END).
    stdin: Mutex<Option<ChildStdin>>,
    /// Pid of the live child, cleared once it has exited.
    pid: Mutex<Option<u32>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl BridgeSupervisor {
    fn new() -> Self {
        Self {
            shutdown: AtomicBool::new(false),
            stdin: Mutex::new(None),
            pid: Mutex::new(None),
        }
    }

    /// Ask the sidecar to exit cleanly, give it a grace window, then hard-kill
    /// whatever is left. Blocks the caller briefly at app exit.
    fn begin_shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        drop(lock(&self.stdin).take());
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while Instant::now() < deadline {
            if lock(&self.pid).is_none() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if let Some(pid) = *lock(&self.pid) {
            log_line(&format!("sidecar did not exit in time — killing pid {pid}"));
            hard_kill(pid);
        }
    }
}

struct SupervisorState(Arc<BridgeSupervisor>);

/// Kill a process tree that ignored the graceful request. The Windows job
/// object already covers the crash case; this covers a wedged-but-alive child.
fn hard_kill(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
}

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

/// Append-mode file under `~/.crystal/logs`. The desktop app has no console
/// (windows_subsystem = "windows"), so without these a sidecar crash or a
/// Rust panic leaves no trace anywhere.
fn log_file(name: &str) -> Option<std::fs::File> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let dir = std::path::Path::new(&home).join(".crystal").join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(name))
        .ok()
}

/// Supervisor breadcrumbs land in the same log the sidecar writes to, so one
/// file tells the whole story of a crash + restart.
fn log_line(msg: &str) {
    if let Some(mut f) = log_file("desktop-sidecar.log") {
        let _ = writeln!(f, "[crystal-desktop] {msg}");
    }
    eprintln!("[crystal-desktop] {msg}");
}

/// Route the sidecar's output to the log file (falls back to inherit).
fn attach_log(cmd: &mut Command) {
    if let Some(out) = log_file("desktop-sidecar.log") {
        if let Ok(err) = out.try_clone() {
            cmd.stdout(out);
            cmd.stderr(err);
        }
    }
}

/// Release builds abort on panic with no console — record the panic message
/// before the process disappears.
fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(mut f) = log_file("desktop-panic.log") {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "[{secs}] panic: {info}");
        }
        default(info);
    }));
}

/// Split a command line on whitespace, honoring single/double quotes so a
/// program path containing spaces survives.
fn split_cmdline(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in s.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => cur.push(c),
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            None => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// The IPC endpoint this desktop instance asks its sidecar to listen on:
/// pid-unique, so several Crystal windows (or a stray dev server) can never
/// collide the way a fixed TCP port did.
fn desktop_pipe_path() -> String {
    let pid = std::process::id();
    if cfg!(windows) {
        return format!(r"\\.\pipe\crystal-desktop-{pid}");
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let dir = std::path::Path::new(&home).join(".crystal").join("run");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("crystal-desktop-{pid}.sock"))
        .to_string_lossy()
        .into_owned()
}

/// Build the (re-spawnable) bridge server command plus the IPC endpoint the
/// webview relay should dial, or None when nothing should be spawned.
///
/// Production: the server ships as a sidecar executable next to the app
/// binary (`crystal-server.exe`, a Node SEA build of @crystal/server).
/// Development: `pnpm dev` already runs it, so nothing is spawned unless the
/// `CRYSTAL_SPAWN_SERVER` env var provides an explicit command line.
///
/// `module_base` is the staged-resources dir (`<resource>/sidecar`) that holds
/// node-pty's native module; it's passed to the sidecar as
/// `CRYSTAL_SIDECAR_MODULE_BASE` so the SEA bundle's require() can find it.
fn plan_bridge_command(module_base: Option<&std::path::Path>) -> Option<(Command, String)> {
    let (mut cmd, pipe) = if let Ok(cmdline) = std::env::var("CRYSTAL_SPAWN_SERVER") {
        let parts = split_cmdline(&cmdline);
        let (program, args) = parts.split_first()?;
        let mut cmd = Command::new(program);
        cmd.args(args);
        // Honor an explicit --pipe in the custom command line; otherwise ask
        // the server to use ours so the relay knows where to dial.
        let pipe = match args.iter().position(|a| a == "--pipe") {
            Some(i) => args.get(i + 1)?.clone(),
            None => {
                let pipe = desktop_pipe_path();
                cmd.args(["--pipe", &pipe]);
                pipe
            }
        };
        (cmd, pipe)
    } else {
        let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
        let sidecar =
            exe_dir.join(if cfg!(windows) { "crystal-server.exe" } else { "crystal-server" });
        if !sidecar.exists() {
            // tauri dev — the workspace dev server owns the bridge.
            return None;
        }
        let root = workspace_root();
        let pipe = desktop_pipe_path();
        let mut cmd = Command::new(&sidecar);
        cmd.args(["--root", &root.to_string_lossy(), "--pipe", &pipe]);
        (cmd, pipe)
    };
    if let Some(base) = module_base {
        cmd.env("CRYSTAL_SIDECAR_MODULE_BASE", base);
    }
    // Parent-controlled shutdown: we hold the child's stdin and close it to
    // request a graceful exit (see BridgeSupervisor::begin_shutdown).
    cmd.env("CRYSTAL_SHUTDOWN_ON_STDIN_END", "1");
    cmd.stdin(Stdio::piped());
    attach_log(&mut cmd);
    Some((cmd, pipe))
}

// --- Pipe relay: the webview cannot open a named pipe / unix socket, so the
// bridge connection goes JS → Tauri command → pipe. Frames are the bridge
// protocol's newline-delimited JSON; Rust stays a dumb byte relay.

/// One relayed frame to the webview.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum RelayEvent {
    Line { data: String },
    Close,
}

type BoxWriter = Box<dyn tokio::io::AsyncWrite + Send + Unpin>;
type BoxReader = Box<dyn tokio::io::AsyncRead + Send + Unpin>;

struct RelayConn {
    writer: Arc<tokio::sync::Mutex<BoxWriter>>,
    reader: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
struct RelayState {
    conns: Mutex<HashMap<u32, RelayConn>>,
    next_id: AtomicU32,
}

/// The sidecar's IPC endpoint, None when this shell spawned no server
/// (tauri dev — the webview falls back to the dev WebSocket).
struct BridgeEndpoint(Mutex<Option<String>>);

async fn open_pipe(path: &str) -> std::io::Result<(BoxReader, BoxWriter)> {
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;
        // A fresh pipe instance can be briefly unavailable while the server
        // accepts the previous client; retry a few times before giving up.
        let mut last_err = std::io::Error::other("pipe open failed");
        for _ in 0..5 {
            match ClientOptions::new().open(path) {
                Ok(client) => {
                    let (r, w) = tokio::io::split(client);
                    return Ok((Box::new(r), Box::new(w)));
                }
                Err(err) => {
                    last_err = err;
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
        Err(last_err)
    }
    #[cfg(not(windows))]
    {
        let stream = tokio::net::UnixStream::connect(path).await?;
        let (r, w) = stream.into_split();
        Ok((Box::new(r), Box::new(w)))
    }
}

#[tauri::command]
fn bridge_endpoint(state: tauri::State<'_, BridgeEndpoint>) -> Option<String> {
    lock(&state.0).clone()
}

#[tauri::command]
async fn bridge_connect(
    app: tauri::AppHandle,
    endpoint: Option<String>,
    on_event: Channel<RelayEvent>,
) -> Result<u32, String> {
    // No explicit endpoint (the historical call shape) dials the supervised
    // sidecar's pipe; an explicit one dials any other local server's pipe or
    // socket — typically discovered via `list_bridge_instances`.
    let endpoint = match endpoint {
        Some(endpoint) => endpoint,
        None => lock(&app.state::<BridgeEndpoint>().0)
            .clone()
            .ok_or("no bridge pipe")?,
    };
    let (reader, writer) = open_pipe(&endpoint).await.map_err(|e| e.to_string())?;
    let id = {
        let relay = app.state::<RelayState>();
        relay.next_id.fetch_add(1, Ordering::SeqCst)
    };
    let app_for_task = app.clone();
    let reader_task = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if on_event.send(RelayEvent::Line { data: line }).is_err() {
                break;
            }
        }
        let _ = on_event.send(RelayEvent::Close);
        let state = app_for_task.state::<RelayState>();
        let dropped = lock(&state.conns).remove(&id);
        drop(dropped);
    });
    let relay = app.state::<RelayState>();
    lock(&relay.conns).insert(
        id,
        RelayConn {
            writer: Arc::new(tokio::sync::Mutex::new(writer)),
            reader: reader_task,
        },
    );
    Ok(id)
}

#[tauri::command]
async fn bridge_send(
    id: u32,
    line: String,
    state: tauri::State<'_, RelayState>,
) -> Result<(), String> {
    let writer = lock(&state.conns)
        .get(&id)
        .map(|c| c.writer.clone())
        .ok_or("unknown connection")?;
    let mut w = writer.lock().await;
    w.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    w.write_all(b"\n").await.map_err(|e| e.to_string())?;
    w.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn bridge_close(id: u32, state: tauri::State<'_, RelayState>) -> Result<(), String> {
    let conn = lock(&state.conns).remove(&id);
    if let Some(conn) = conn {
        conn.reader.abort();
        let mut w = conn.writer.lock().await;
        let _ = w.shutdown().await;
    }
    Ok(())
}

// --- Instance discovery: every running bridge server advertises itself in
// `~/.crystal/instances/<pid>.json` (see apps/server/src/instances.ts). The
// webview lists them here to offer "connect to another local bridge", then
// dials the chosen pipe via bridge_connect's endpoint argument.

/// Probe a pid without signaling it. Access denied still proves a live
/// process owns the pid (another user's server — the pipe may still accept us).
#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        // The handle alone can outlive the process — check it still runs.
        let mut code = 0u32;
        let running = GetExitCodeProcess(handle, &mut code) != 0 && code == STILL_ACTIVE as u32;
        CloseHandle(handle);
        running
    }
}

/// `kill -0` probes liveness without delivering a signal (same tool the
/// graceful-shutdown path already shells out to).
#[cfg(not(windows))]
fn pid_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// List the bridge servers advertised under `~/.crystal/instances`.
///
/// Parsing is deliberately lenient — the schema is still growing (serverId,
/// name, workspaces…), so each file is surfaced as its raw JSON object with
/// every unknown field intact; unreadable or non-object files are skipped.
/// Each entry gains `file` (the discovery file's own path) and `alive` (a
/// cheap pid probe). Dead entries are **returned, not filtered**: deleting or
/// hiding stale files is the servers' own sweep's job, and the webview may
/// want to show a recently-crashed server. The `token` field is stripped —
/// local pipe connections need no auth, and a remote bridge's token must come
/// from the user, never ride a discovery listing into the webview.
#[tauri::command]
fn list_bridge_instances() -> Vec<serde_json::Value> {
    let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        Ok(home) => home,
        Err(_) => return Vec::new(),
    };
    let dir = std::path::Path::new(&home).join(".crystal").join("instances");
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(serde_json::Value::Object(mut obj)) = serde_json::from_str(&text) else {
            continue;
        };
        obj.remove("token");
        let alive = obj
            .get("pid")
            .and_then(|pid| pid.as_u64())
            .is_some_and(|pid| u32::try_from(pid).is_ok_and(|pid| pid_alive(pid)));
        obj.insert("alive".into(), serde_json::Value::Bool(alive));
        obj.insert(
            "file".into(),
            serde_json::Value::String(path.to_string_lossy().into_owned()),
        );
        out.push(serde_json::Value::Object(obj));
    }
    out
}

/// One job object for the whole app lifetime: kill-on-close means the OS reaps
/// the entire sidecar tree (node, claude.exe runs, ConPTY hosts, test runners)
/// even if the desktop process crashes without running its shutdown path.
#[cfg(windows)]
fn make_job() -> Option<win32job::Job> {
    let job = win32job::Job::create().ok()?;
    let mut info = job.query_extended_limit_info().ok()?;
    info.limit_kill_on_job_close();
    job.set_extended_limit_info(&mut info).ok()?;
    Some(job)
}

/// Own the sidecar for the app's lifetime: spawn, wait, restart with capped
/// backoff, and surface state to the webview via the `bridge-status` event
/// ("up" | "restarting" | "down").
fn supervise(app: tauri::AppHandle, sup: Arc<BridgeSupervisor>, mut cmd: Command) {
    #[cfg(windows)]
    let job = {
        let job = make_job();
        if job.is_none() {
            log_line("could not create job object — orphan reaping degraded");
        }
        job
    };

    let mut rapid_failures = 0u32;
    let mut backoff_secs = 1u64;
    loop {
        if sup.shutdown.load(Ordering::SeqCst) {
            break;
        }
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(err) => {
                log_line(&format!("failed to spawn bridge server: {err}"));
                let _ = app.emit("bridge-status", "down");
                break;
            }
        };
        #[cfg(windows)]
        if let Some(job) = job.as_ref() {
            use std::os::windows::io::AsRawHandle;
            if let Err(err) = job.assign_process(child.as_raw_handle() as _) {
                log_line(&format!("could not assign sidecar to job object: {err}"));
            }
        }
        *lock(&sup.stdin) = child.stdin.take();
        *lock(&sup.pid) = Some(child.id());
        let _ = app.emit("bridge-status", "up");

        let started = Instant::now();
        let status = child.wait();
        *lock(&sup.pid) = None;
        *lock(&sup.stdin) = None;
        if sup.shutdown.load(Ordering::SeqCst) {
            break;
        }

        let lifetime = started.elapsed();
        log_line(&format!("bridge server exited ({status:?}) after {lifetime:.0?}"));
        if lifetime < RAPID_EXIT {
            rapid_failures += 1;
        } else {
            rapid_failures = 0;
            backoff_secs = 1;
        }
        if rapid_failures >= MAX_RAPID_FAILURES {
            log_line("bridge server keeps exiting immediately — giving up (see desktop-sidecar.log)");
            let _ = app.emit("bridge-status", "down");
            break;
        }
        let _ = app.emit("bridge-status", "restarting");
        // Sleep in slices so a shutdown during backoff isn't delayed.
        let deadline = Instant::now() + Duration::from_secs(backoff_secs);
        while Instant::now() < deadline && !sup.shutdown.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(100));
        }
        backoff_secs = (backoff_secs * 2).min(10);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    // Updater + process (relaunch) are desktop-only; the mobile entry point
    // skips them. The JS side (checkForDesktopUpdate in @crystal/client) drives
    // the check on launch through these plugins.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }
    builder
        .invoke_handler(tauri::generate_handler![
            bridge_endpoint,
            bridge_connect,
            bridge_send,
            bridge_close,
            list_bridge_instances
        ])
        .setup(|app| {
            // The staged node-pty resource lives at `<resource>/sidecar`; the
            // SEA sidecar anchors its require() there to load the native addon.
            let base = app
                .path()
                .resolve("sidecar", tauri::path::BaseDirectory::Resource)
                .ok();
            let sup = Arc::new(BridgeSupervisor::new());
            app.manage(SupervisorState(sup.clone()));
            app.manage(RelayState::default());
            let planned = plan_bridge_command(base.as_deref());
            app.manage(BridgeEndpoint(Mutex::new(
                planned.as_ref().map(|(_, pipe)| pipe.clone()),
            )));
            if let Some((cmd, _)) = planned {
                let handle = app.handle().clone();
                std::thread::spawn(move || supervise(handle, sup, cmd));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<SupervisorState>().0.begin_shutdown();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Crystal");
}

#[cfg(test)]
mod tests {
    use super::split_cmdline;

    #[test]
    fn splits_plain_words() {
        assert_eq!(split_cmdline("node server.js --port 4517"), vec![
            "node",
            "server.js",
            "--port",
            "4517"
        ]);
    }

    #[test]
    fn honors_quotes_around_spaced_paths() {
        assert_eq!(
            split_cmdline(r#""C:\Program Files\nodejs\node.exe" dist/index.cjs --root 'C:\My Repos\app'"#),
            vec![
                r"C:\Program Files\nodejs\node.exe",
                "dist/index.cjs",
                "--root",
                r"C:\My Repos\app"
            ]
        );
    }

    #[test]
    fn empty_and_whitespace_only() {
        assert!(split_cmdline("").is_empty());
        assert!(split_cmdline("   ").is_empty());
    }
}
