//! OpenLoop desktop shell.
//!
//! Tauri is a thin native window over the existing React SPA. It:
//!   1. picks a free localhost port and starts the Python `openloop-server` as a managed
//!      sidecar on that port (so it never clashes with a hand-run server on 8765);
//!   2. injects the sidecar HTTP/WS addresses and per-launch authentication token before the
//!      SPA loads (single codebase — the browser build still hits 8765);
//!   3. lives in the system tray: closing the window hides it (keeps OpenLoop + the scheduler
//!      running); only tray → Quit stops the sidecar;
//!   4. exposes native commands: folder picker, autostart (open-at-login), and keep-awake
//!      (caffeinate, so scheduled tasks fire while the Mac is idle).
//!
//! The sidecar inherits this process's environment, so a shell-launched `npm run tauri dev`
//! passes `OPENAI_API_KEY` through. A Finder-launched app has no shell env — there the key
//! comes from the SecretStore (Settings tab), see the Python provider resolver.

mod updater;

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use openloop_stt::{Dictation, DownloadProgress};
use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use updater::{
    check_for_update, clear_pending_update, download_update, get_app_version, install_update,
    UpdateManager,
};
use uuid::Uuid;

/// The sidecar server child — killed on exit (orphaned servers have bitten us before).
struct ServerProcess(Mutex<Option<Child>>);
/// The active keep-awake guard plus the user's sleep-prevention rule. Dropping the guard
/// releases the hold (kills `caffeinate` on macOS, clears the execution state on Windows).
struct KeepAwake(Mutex<AwakeState>);
struct TrayMenuItems {
    open: MenuItem<tauri::Wry>,
    settings: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AwakeRule {
    Off,
    WhileRunning,
    Always,
}

impl AwakeRule {
    fn as_str(self) -> &'static str {
        match self {
            AwakeRule::Off => "off",
            AwakeRule::WhileRunning => "while_running",
            AwakeRule::Always => "always",
        }
    }

    fn from_str(raw: &str) -> Option<Self> {
        match raw {
            "off" => Some(AwakeRule::Off),
            "while_running" => Some(AwakeRule::WhileRunning),
            "always" => Some(AwakeRule::Always),
            _ => None,
        }
    }
}

struct AwakeState {
    guard: Option<KeepAwakeGuard>,
    rule: AwakeRule,
    running: bool,
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(8765)
}

fn launch_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn server_executable_names(windows: bool) -> [&'static str; 1] {
    if windows {
        ["openloop-server.exe"]
    } else {
        ["openloop-server"]
    }
}

/// Path to the server entrypoint. Resolution order:
///   1. `OPENLOOP_SERVER_BIN` env override.
///   2. The bundled onedir sidecar shipped via Tauri `resources` (production): the
///      `sidecar/` folder lands in Contents/Resources on macOS and in the install dir
///      (next to the app exe) on Windows.
///   3. Dev fallback: the repo venv, relative to this crate (`src-tauri` → `platform/.venv`;
///      `bin/` on POSIX, `Scripts\` on Windows).
fn server_bin() -> PathBuf {
    if let Ok(p) = std::env::var("OPENLOOP_SERVER_BIN") {
        return PathBuf::from(p);
    }
    let exe_names = server_executable_names(cfg!(windows));
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // macOS: Contents/MacOS/<app> → Contents/Resources/sidecar/; Windows: resources
            // unpack next to the exe, so <install>/sidecar/.
            let mut candidates = Vec::new();
            for exe_name in exe_names {
                candidates.push(dir.join("sidecar").join(exe_name));
                if let Some(contents) = dir.parent() {
                    candidates.push(contents.join("Resources").join("sidecar").join(exe_name));
                }
                candidates.push(dir.join(exe_name));
            }
            for c in candidates {
                if c.exists() {
                    return c;
                }
            }
        }
    }
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if cfg!(windows) {
        p.push("../../../.venv/Scripts/openloop-server.exe");
    } else {
        p.push("../../../.venv/bin/openloop-server");
    }
    if p.exists() {
        return p;
    }
    p
}

/// Mirror the Python state-dir resolver so the shell and server agree on `desktop.json`.
/// Windows: `%APPDATA%\openloop`; POSIX: `~/.config/openloop`.
fn state_dir_from(
    override_dir: Option<&str>,
    appdata: Option<&str>,
    home: Option<&str>,
    windows: bool,
) -> PathBuf {
    if let Some(path) = override_dir {
        return PathBuf::from(path);
    }
    if windows {
        return PathBuf::from(appdata.or(home).unwrap_or(".")).join("openloop");
    }
    PathBuf::from(home.unwrap_or("."))
        .join(".config")
        .join("openloop")
}

fn state_dir() -> PathBuf {
    let override_dir = std::env::var("OPENLOOP_STATE_DIR").ok();
    let appdata = std::env::var("APPDATA").ok();
    let home = std::env::var("HOME").ok();
    state_dir_from(
        override_dir.as_deref(),
        appdata.as_deref(),
        home.as_deref(),
        cfg!(windows),
    )
}

fn desktop_prefs_path() -> PathBuf {
    state_dir().join("desktop.json")
}

/// The sidecar's log file: `<state_dir>/logs/openloop-server.log`, fresh per
/// launch with the previous run kept as `.old`. None (→ /dev/null) only if the
/// directory can't be created — logging must never block startup.
fn server_log_file() -> Option<std::fs::File> {
    let dir = state_dir().join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("openloop-server.log");
    if path.exists() {
        let _ = std::fs::rename(&path, dir.join("openloop-server.log.old"));
    }
    std::fs::File::create(&path).ok()
}

fn read_desktop_prefs() -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(desktop_prefs_path())
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn write_desktop_prefs(prefs: serde_json::Map<String, serde_json::Value>) {
    let path = desktop_prefs_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, serde_json::Value::Object(prefs).to_string());
}

fn read_awake_rule_pref() -> AwakeRule {
    let prefs = read_desktop_prefs();
    prefs
        .get("awake_rule")
        .and_then(|v| v.as_str())
        .and_then(AwakeRule::from_str)
        .unwrap_or_else(|| {
            if prefs
                .get("keep_awake")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                AwakeRule::Always
            } else {
                AwakeRule::Off
            }
        })
}

fn write_awake_rule_pref(rule: AwakeRule) {
    let mut prefs = read_desktop_prefs();
    prefs.insert(
        "awake_rule".into(),
        serde_json::Value::String(rule.as_str().into()),
    );
    // Keep the legacy key in sync so older builds still interpret the strongest rule.
    prefs.insert(
        "keep_awake".into(),
        serde_json::Value::Bool(rule == AwakeRule::Always),
    );
    write_desktop_prefs(prefs);
}

fn reconcile_awake(state: &mut AwakeState) {
    let should_hold =
        state.rule == AwakeRule::Always || (state.rule == AwakeRule::WhileRunning && state.running);
    if should_hold {
        if state.guard.is_none() {
            state.guard = start_keep_awake();
        }
    } else {
        drop(state.guard.take());
    }
}

// -- keep-awake: hold off idle + system sleep so the scheduler keeps firing -------------------
// Cross-platform behind a uniform `start_keep_awake() -> Option<KeepAwakeGuard>`; dropping the
// guard releases the hold. macOS uses the built-in `caffeinate`; Windows uses the
// SetThreadExecutionState API (a dedicated thread holds ES_CONTINUOUS so the state survives
// regardless of which Tauri worker thread toggled it); other platforms are a no-op.

#[cfg(target_os = "macos")]
struct KeepAwakeGuard(Child);

#[cfg(target_os = "macos")]
impl Drop for KeepAwakeGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

#[cfg(target_os = "macos")]
fn start_keep_awake() -> Option<KeepAwakeGuard> {
    Command::new("caffeinate")
        .args(["-i", "-s"])
        .spawn()
        .ok()
        .map(KeepAwakeGuard)
}

#[cfg(target_os = "windows")]
extern "system" {
    fn SetThreadExecutionState(es_flags: u32) -> u32;
}

#[cfg(target_os = "windows")]
const ES_CONTINUOUS: u32 = 0x8000_0000;
#[cfg(target_os = "windows")]
const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;

#[cfg(target_os = "windows")]
struct KeepAwakeGuard {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

#[cfg(target_os = "windows")]
impl Drop for KeepAwakeGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

#[cfg(target_os = "windows")]
fn start_keep_awake() -> Option<KeepAwakeGuard> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    let handle = std::thread::spawn(move || {
        // SetThreadExecutionState is thread-affine and the ES_CONTINUOUS hold is dropped when
        // the setting thread exits — so keep this thread alive, re-asserting periodically,
        // until asked to stop, then clear the hold from this same thread.
        unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
        while !stop_thread.load(Ordering::SeqCst) {
            unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
        unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
    });
    Some(KeepAwakeGuard {
        stop,
        handle: Some(handle),
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
struct KeepAwakeGuard;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn start_keep_awake() -> Option<KeepAwakeGuard> {
    // No portable built-in inhibitor on Linux; keep-awake is a no-op (the toggle still reflects
    // state so the UI behaves, but the OS sleep policy is left to the user).
    Some(KeepAwakeGuard)
}

// -- native commands (invoked from the SPA via window.__TAURI__.core.invoke) -----------------

/// Native macOS folder picker for the workspace gate. `default_dir` (optional) pre-navigates
/// the dialog to that folder — the "New project" flow opens at the configured default location.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle, default_dir: Option<String>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    let mut builder = app.dialog().file();
    if let Some(dir) = default_dir
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        if std::path::Path::new(dir).is_dir() {
            builder = builder.set_directory(dir);
        }
    }
    builder.pick_folder(move |p| {
        let _ = tx.send(p);
    });
    rx.recv().ok().flatten().map(|fp| fp.to_string())
}

#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> bool {
    let m = app.autolaunch();
    let _ = if enabled { m.enable() } else { m.disable() };
    m.is_enabled().unwrap_or(false)
}

#[tauri::command]
fn get_keep_awake(state: tauri::State<KeepAwake>) -> bool {
    state.0.lock().unwrap().rule == AwakeRule::Always
}

#[tauri::command]
fn set_keep_awake(state: tauri::State<KeepAwake>, enabled: bool) -> bool {
    let mut awake = state.0.lock().unwrap();
    awake.rule = if enabled {
        AwakeRule::Always
    } else {
        AwakeRule::Off
    };
    reconcile_awake(&mut awake);
    write_awake_rule_pref(awake.rule);
    awake.rule == AwakeRule::Always
}

#[tauri::command]
fn get_awake_rule(state: tauri::State<KeepAwake>) -> String {
    state.0.lock().unwrap().rule.as_str().into()
}

#[tauri::command]
fn set_awake_rule(state: tauri::State<KeepAwake>, rule: String) -> String {
    let next = AwakeRule::from_str(rule.as_str()).unwrap_or(AwakeRule::Off);
    let mut awake = state.0.lock().unwrap();
    awake.rule = next;
    reconcile_awake(&mut awake);
    write_awake_rule_pref(awake.rule);
    awake.rule.as_str().into()
}

#[tauri::command]
fn set_awake_running(state: tauri::State<KeepAwake>, running: bool) -> bool {
    let mut awake = state.0.lock().unwrap();
    awake.running = running;
    reconcile_awake(&mut awake);
    awake.guard.is_some()
}

fn tray_menu_labels(lang: &str) -> (&'static str, &'static str, &'static str) {
    if lang == "zh-CN" {
        ("打开 OpenLoop", "设置", "退出")
    } else {
        ("Open OpenLoop", "Settings", "Quit")
    }
}

#[tauri::command]
fn set_tray_language(state: tauri::State<TrayMenuItems>, lang: String) -> bool {
    let (open, settings, quit) = tray_menu_labels(&lang);
    state.open.set_text(open).is_ok()
        && state.settings.set_text(settings).is_ok()
        && state.quit.set_text(quit).is_ok()
}

#[tauri::command]
fn start_window_drag(window: tauri::WebviewWindow) -> bool {
    window.start_dragging().is_ok()
}

// -- local dictation ---------------------------------------------------------------------------
// The actual microphone/model code lives in the Tauri-free `openloop-stt` crate. This shell owns the
// macOS permission prompt and translates the reusable API into React-friendly Tauri commands.

#[derive(Clone, Serialize)]
struct VoiceInputStatus {
    recording: bool,
    model_installed: bool,
    model_verified: bool,
    test_passed: bool,
    download_in_progress: bool,
    model_name: &'static str,
    model_bytes: u64,
    supported: bool,
    device_summary: String,
    compatibility_reason: Option<String>,
}

fn voice_input_status(dictation: &Dictation) -> VoiceInputStatus {
    let status = dictation.status();
    let (supported, device_summary, compatibility_reason) = voice_input_compatibility();
    VoiceInputStatus {
        recording: status.recording,
        model_installed: status.model_installed,
        model_verified: status.model_verified,
        test_passed: status.test_passed,
        download_in_progress: status.download_in_progress,
        model_name: status.model_name,
        model_bytes: status.model_bytes,
        supported,
        device_summary,
        compatibility_reason,
    }
}

#[cfg(target_os = "macos")]
fn voice_input_compatibility() -> (bool, String, Option<String>) {
    let version = Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .unwrap_or_else(|| "unknown version".to_owned());
    let major = version
        .split('.')
        .next()
        .and_then(|part| part.parse::<u32>().ok())
        .unwrap_or(0);
    let apple_silicon = std::env::consts::ARCH == "aarch64";
    let supported = apple_silicon && major >= 12;
    let architecture = if apple_silicon {
        "Apple Silicon"
    } else {
        "Intel"
    };
    let summary = format!("macOS {version} · {architecture}");
    let reason = if !apple_silicon {
        Some("Voice Input currently requires an Apple Silicon Mac (M1 or newer).".to_owned())
    } else if major < 12 {
        Some("Voice Input requires macOS 12 or newer.".to_owned())
    } else {
        None
    };
    (supported, summary, reason)
}

#[cfg(target_os = "windows")]
fn voice_input_compatibility() -> (bool, String, Option<String>) {
    let version = Command::new("cmd")
        .args(["/C", "ver"])
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .unwrap_or_else(|| "Windows (unknown version)".to_owned());
    let build = version
        .split(|character: char| !character.is_ascii_digit() && character != '.')
        .find(|part| part.matches('.').count() >= 2)
        .and_then(|part| part.split('.').nth(2))
        .and_then(|part| part.parse::<u32>().ok())
        .unwrap_or(0);
    let x64 = std::env::consts::ARCH == "x86_64";
    let supported = x64 && build >= 19_045;
    let reason = if !x64 {
        Some("Voice Input currently requires a 64-bit x64 Windows PC.".to_owned())
    } else if build < 19_045 {
        Some("Voice Input requires Windows 10 22H2 or Windows 11.".to_owned())
    } else {
        None
    };
    (supported, format!("{version} · x64"), reason)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn voice_input_compatibility() -> (bool, String, Option<String>) {
    (
        false,
        format!("{} · {}", std::env::consts::OS, std::env::consts::ARCH),
        Some("Voice Input is currently supported on macOS and Windows.".to_owned()),
    )
}

#[tauri::command]
fn get_dictation_status(state: tauri::State<Arc<Dictation>>) -> VoiceInputStatus {
    voice_input_status(&state)
}

#[tauri::command]
async fn start_dictation(
    state: tauri::State<'_, Arc<Dictation>>,
) -> Result<VoiceInputStatus, String> {
    // Off the main thread: opening the input device blocks on macOS's one-time microphone
    // permission dialog (and CoreAudio device setup) — a sync command would freeze the UI
    // behind the system prompt.
    let (supported, _, reason) = voice_input_compatibility();
    if !supported {
        return Err(
            reason.unwrap_or_else(|| "Voice Input is not supported on this device.".to_owned())
        );
    }
    let dictation = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        dictation.start()?;
        Ok::<VoiceInputStatus, String>(voice_input_status(&dictation))
    })
    .await
    .map_err(|e| format!("Dictation failed to start: {e}"))?
}

#[tauri::command]
async fn stop_dictation(state: tauri::State<'_, Arc<Dictation>>) -> Result<String, String> {
    let dictation = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || dictation.stop_and_transcribe())
        .await
        .map_err(|e| format!("Dictation stopped unexpectedly: {e}"))?
}

#[tauri::command]
fn cancel_dictation(state: tauri::State<Arc<Dictation>>) {
    state.cancel();
}

#[tauri::command]
async fn download_dictation_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Dictation>>,
) -> Result<VoiceInputStatus, String> {
    let dictation = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        dictation.install_default_model_with_progress(|progress: DownloadProgress| {
            let _ = app.emit("dictation-download-progress", progress);
        })?;
        Ok::<VoiceInputStatus, String>(voice_input_status(&dictation))
    })
    .await
    .map_err(|e| format!("Voice model download stopped unexpectedly: {e}"))?
}

#[tauri::command]
fn cancel_dictation_model_download(state: tauri::State<Arc<Dictation>>) {
    state.cancel_model_download();
}

#[tauri::command]
async fn verify_dictation_model(
    state: tauri::State<'_, Arc<Dictation>>,
) -> Result<VoiceInputStatus, String> {
    let dictation = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        dictation.verify_default_model()?;
        Ok::<VoiceInputStatus, String>(voice_input_status(&dictation))
    })
    .await
    .map_err(|e| format!("Voice model verification stopped unexpectedly: {e}"))?
}

#[tauri::command]
fn mark_dictation_test_passed(
    state: tauri::State<Arc<Dictation>>,
) -> Result<VoiceInputStatus, String> {
    state.mark_test_passed()?;
    Ok(voice_input_status(&state))
}

#[tauri::command]
fn delete_dictation_model(state: tauri::State<Arc<Dictation>>) -> Result<VoiceInputStatus, String> {
    state.delete_default_model()?;
    Ok(voice_input_status(&state))
}

/// Instantaneous mic loudness (0..1) while a dictation is recording — the composer polls
/// this to draw a real input-driven waveform instead of decorative bars (owner catch,
/// DMG #28 walkthrough).
#[tauri::command]
fn dictation_level(state: tauri::State<Arc<Dictation>>) -> f32 {
    state.input_level()
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg(target_os = "macos")]
fn should_show_main_on_reopen(has_visible_windows: bool) -> bool {
    !has_visible_windows
}

fn initialization_script(http: &str, ws: &str, api_token: &str, platform: &str) -> String {
    format!(
        "window.__OPENLOOP_HTTP__={http:?};window.__OPENLOOP_WS__={ws:?};window.__OPENLOOP_API_TOKEN__={api_token:?};window.__OPENLOOP_PLATFORM__={platform:?};"
    )
}

fn sidecar_environment(parent_pid: u32, api_token: &str) -> Vec<(&'static str, String)> {
    vec![
        ("OPENLOOP_EXIT_WITH_PARENT", "1".to_string()),
        ("OPENLOOP_PARENT_PID", parent_pid.to_string()),
        ("OPENLOOP_API_TOKEN", api_token.to_string()),
    ]
}

pub fn run() {
    let port = free_port();
    let api_token = launch_token();
    let http = format!("http://127.0.0.1:{port}");
    let ws = format!("ws://127.0.0.1:{port}");
    // Debug-format yields a quoted JS string literal.
    let inject = initialization_script(&http, &ws, &api_token, std::env::consts::OS);

    tauri::Builder::default()
        // MUST be the first plugin: when a second launch happens (e.g. the user relaunches
        // while the window is closed-to-tray), this fires in the ALREADY-running instance to
        // surface its healthy window, and the second process exits before it can spawn a
        // duplicate sidecar — which previously left a window stuck on "Starting OpenLoop…".
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            get_autostart,
            set_autostart,
            get_keep_awake,
            set_keep_awake,
            get_awake_rule,
            set_awake_rule,
            set_awake_running,
            set_tray_language,
            start_window_drag,
            get_dictation_status,
            start_dictation,
            stop_dictation,
            cancel_dictation,
            download_dictation_model,
            cancel_dictation_model_download,
            verify_dictation_model,
            mark_dictation_test_passed,
            delete_dictation_model,
            dictation_level,
            get_app_version,
            check_for_update,
            download_update,
            clear_pending_update,
            install_update
        ])
        .setup(move |app| {
            // 1. Start the Python server sidecar on the chosen port (inherits our env).
            let mut server_cmd = Command::new(server_bin());
            server_cmd
                .args(["--host", "127.0.0.1", "--port", &port.to_string()])
                // The sidecar self-exits if we die abruptly (dev-watcher restart, crash) —
                // belt-and-suspenders alongside the RunEvent::ExitRequested kill below.
                // The explicit PID matters: under PyInstaller onefile the python process is a
                // *grandchild* (bootloader in between), so getppid() never points at us and a
                // reparenting check alone leaks both processes on quit.
                // This GUI app has no console, so a console-subsystem child would inherit
                // invalid std handles and crash a few seconds in when uvicorn writes its logs
                // (the "Starting OpenLoop…" freeze on Windows). Hand it real handles: the
                // server's output goes to a log file so field issues are debuggable at all
                // ("relay off, no messages" was undiagnosable with everything on /dev/null).
                // One file per launch, previous run kept as .old.
                .stdin(Stdio::null());
            for (key, value) in sidecar_environment(std::process::id(), &api_token) {
                server_cmd.env(key, value);
            }
            match server_log_file() {
                Some(log) => {
                    if let Ok(err_clone) = log.try_clone() {
                        server_cmd
                            .stdout(Stdio::from(log))
                            .stderr(Stdio::from(err_clone));
                    } else {
                        server_cmd.stdout(Stdio::from(log)).stderr(Stdio::null());
                    }
                }
                None => {
                    server_cmd.stdout(Stdio::null()).stderr(Stdio::null());
                }
            }
            // CREATE_NO_WINDOW: the sidecar is a console binary; without this a console window
            // would flash when the GUI app spawns it on Windows.
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                server_cmd.creation_flags(0x0800_0000);
            }
            let child = match server_cmd.spawn() {
                Ok(child) => Some(child),
                Err(e) => {
                    eprintln!("[openloop] failed to start server sidecar: {e}");
                    None
                }
            };
            app.manage(ServerProcess(Mutex::new(child)));

            // Restore the sleep-prevention rule from the last session. Only "always" starts
            // a native guard immediately; "while_running" waits for the sidecar running-state
            // event before holding the system awake.
            let mut awake = AwakeState {
                guard: None,
                rule: read_awake_rule_pref(),
                running: false,
            };
            reconcile_awake(&mut awake);
            app.manage(KeepAwake(Mutex::new(awake)));
            app.manage(UpdateManager::default());
            // Voice recordings are transient; only the explicitly installed local Whisper model
            // lives in the existing application state directory.
            app.manage(Arc::new(Dictation::new(state_dir().join("models"))));

            // 2. Build the window, injecting the sidecar endpoints before the SPA loads.
            //    Overlay title bar (macOS): traffic lights float over the edge-to-edge UI.
            let mut builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("OpenLoop")
                    .inner_size(1360.0, 900.0)
                    .min_inner_size(980.0, 640.0)
                    // Let the WEBVIEW receive OS file drags: Tauri's own drag-drop handler
                    // otherwise intercepts them, so the composer's HTML5 onDrop (attach by
                    // dragging a file in) never fired in the desktop shell — browser dev
                    // worked, DMGs didn't. main.tsx guards against drops outside the
                    // composer navigating the page.
                    .disable_drag_drop_handler()
                    // External links must open in the system browser, never navigate the SPA
                    // away. This catches full-page navigations the SPA can't intercept —
                    // notably the webview's context-menu "Open Link" (issue #270), which was
                    // silently dropped before. Left-clicks are handled in the SPA (openExternal),
                    // so anything landing here that isn't the app itself goes to the OS.
                    .on_navigation(|url| {
                        eprintln!("[openloop] on_navigation: {url}");
                        let scheme = url.scheme();
                        let host = url.host_str().unwrap_or("");
                        // The SPA itself: tauri:// (macOS/Linux prod), http://tauri.localhost
                        // (Windows prod), the Vite devUrl in dev builds. Any other localhost
                        // URL (e.g. a preview server the agent started) is still external.
                        let is_dev_spa = cfg!(debug_assertions)
                            && host == "localhost"
                            && url.port() == Some(1420);
                        if scheme == "tauri" || host == "tauri.localhost" || is_dev_spa {
                            return true;
                        }
                        if matches!(scheme, "http" | "https" | "mailto") {
                            let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                        }
                        false
                    })
                    // target="_blank" links (and the webview's context-menu "Open Link" for
                    // them) request a NEW webview window on macOS via WKWebView's
                    // createWebViewWith — those never reach on_navigation. wry's default is
                    // to silently drop the request (the "click does nothing" bug, issue
                    // #227/#270). Open external URLs in the system browser instead and deny
                    // the new window. SPA left-clicks are already intercepted in JS
                    // (preventDefault + openExternal), so this is the native backstop for
                    // anything that slips past, e.g. the right-click "Open Link" menu.
                    .on_new_window(|url, _features| {
                        eprintln!("[openloop] on_new_window: {url}");
                        if matches!(url.scheme(), "http" | "https" | "mailto") {
                            let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                        }
                        tauri::webview::NewWindowResponse::Deny
                    })
                    .initialization_script(&inject);
            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    // Nudge the traffic lights down + in so they sit vertically centered with
                    // the sidebar wordmark/title line instead of riding high above it.
                    .traffic_light_position(tauri::LogicalPosition::new(19.0, 30.0));
            }
            let win = builder.build()?;

            // Close-to-tray: hide instead of quitting so the sidecar keeps running.
            let w = win.clone();
            win.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let _ = w.hide();
                    api.prevent_close();
                }
            });

            // 3. System tray: Open / Settings / Quit.
            let open_i = MenuItem::with_id(app, "open", "Open OpenLoop", true, None::<&str>)?;
            let settings_i = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &settings_i, &quit_i])?;
            app.manage(TrayMenuItems {
                open: open_i.clone(),
                settings: settings_i.clone(),
                quit: quit_i.clone(),
            });

            // A monochrome template icon (black + alpha, raw RGBA 44×44) so the menu bar tints
            // it for light/dark automatically — not the full-color app icon.
            let tray_icon = tauri::image::Image::new(include_bytes!("../icons/tray.rgba"), 44, 44);
            TrayIconBuilder::new()
                .tooltip("OpenLoop")
                .icon(tray_icon)
                .icon_as_template(true)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "settings" => {
                        show_main(app);
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.eval(
                                "window.dispatchEvent(new CustomEvent('openloop:open-settings'))",
                            );
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the OpenLoop desktop app")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen {
                has_visible_windows,
                ..
            } = &event
            {
                if should_show_main_on_reopen(*has_visible_windows) {
                    show_main(app);
                }
                return;
            }

            // Also on Exit: belt-and-suspenders in case a quit path reaches teardown without
            // a preceding ExitRequested (observed with macOS Cmd+Q under the tray setup).
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                if let Some(state) = app.try_state::<ServerProcess>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
                if let Some(state) = app.try_state::<KeepAwake>() {
                    // Dropping the guard releases the hold (caffeinate kill / execution-state clear).
                    drop(state.0.lock().unwrap().guard.take());
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn state_resolution_uses_openloop_defaults_and_explicit_override() {
        assert_eq!(
            state_dir_from(None, None, Some("/Users/test"), false),
            PathBuf::from("/Users/test/.config/openloop")
        );
        assert_eq!(
            state_dir_from(None, Some("C:\\Users\\test\\AppData\\Roaming"), None, true),
            PathBuf::from("C:\\Users\\test\\AppData\\Roaming").join("openloop")
        );
        assert_eq!(
            state_dir_from(Some("/tmp/.config/openloop"), None, None, false),
            PathBuf::from("/tmp/.config/openloop")
        );
    }

    #[test]
    fn sidecar_names_are_openloop_only() {
        assert_eq!(server_executable_names(false), ["openloop-server"]);
        assert_eq!(server_executable_names(true), ["openloop-server.exe"]);
    }

    #[test]
    fn browser_injection_exposes_openloop_globals_only() {
        let script = initialization_script(
            "http://127.0.0.1:1234",
            "ws://127.0.0.1:1234",
            "token",
            "macos",
        );

        assert!(script.contains("__OPENLOOP_HTTP__"));
        assert!(script.contains("__OPENLOOP_WS__"));
        assert!(script.contains("__OPENLOOP_API_TOKEN__"));
        assert!(script.contains("__OPENLOOP_PLATFORM__"));
    }

    #[test]
    fn sidecar_environment_uses_openloop_names_only() {
        let env: HashMap<_, _> = sidecar_environment(42, "token").into_iter().collect();

        assert_eq!(env.get("OPENLOOP_EXIT_WITH_PARENT"), Some(&"1".to_string()));
        assert_eq!(env.get("OPENLOOP_PARENT_PID"), Some(&"42".to_string()));
        assert_eq!(env.get("OPENLOOP_API_TOKEN"), Some(&"token".to_string()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dock_reopen_restores_only_when_no_window_is_visible() {
        assert!(should_show_main_on_reopen(false));
        assert!(!should_show_main_on_reopen(true));
    }

    #[test]
    fn tray_menu_labels_follow_the_interface_language() {
        assert_eq!(tray_menu_labels("zh-CN"), ("打开 OpenLoop", "设置", "退出"));
        assert_eq!(
            tray_menu_labels("en"),
            ("Open OpenLoop", "Settings", "Quit")
        );
    }
}
