mod daemon_client;

use daemon_client::Subscriptions;
use std::collections::HashMap;
#[cfg(not(debug_assertions))]
use std::process::Command;
use std::sync::Arc;
#[cfg(not(debug_assertions))]
use tauri::Manager;
use tokio::sync::Mutex;

/**
 * Release builds own the packaged local daemon. Development deliberately keeps the documented
 * `pnpm daemon` workflow, which makes protocol work inspectable without hiding a process behind
 * the UI. The sidecar is long-lived by design: closing a window must not interrupt a user's
 * active terminal lane.
 */
#[cfg(not(debug_assertions))]
fn start_bundled_daemon(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let daemon_name = if cfg!(windows) { "fluentd.exe" } else { "fluentd" };
    // Tauri's path resolver intentionally has no executable-directory value while an app is
    // mounted from a macOS disk image. `current_exe` is the concrete, platform-native location
    // of this trusted bundle executable on both installed Windows and macOS apps.
    let mut daemon_path = std::env::current_exe()?;
    daemon_path.set_file_name(daemon_name);
    // fluentd defaults its state directory to `cwd/.fluent`, which is right for the documented
    // `pnpm daemon` CLI workflow but not for a GUI-launched app: LaunchServices/Explorer starts
    // this process with a cwd fluentd cannot write to (e.g. `/` on macOS, `Program Files` on
    // Windows), so it fails before ever opening its socket. Point it at the app's real data dir.
    let state_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&state_dir)?;
    let mut child = Command::new(&daemon_path)
        .env("FLUENT_STATE_DIR", &state_dir)
        .spawn()?;
    // The daemon intentionally survives a window close. Keep its handle in a detached watcher so
    // an unexpected exit is observable without granting the webview generic shell privileges.
    std::thread::spawn(move || {
        match child.wait() {
            Ok(status) => log::warn!("fluentd sidecar exited: {status}"),
            Err(error) => log::error!("fluentd sidecar wait failed: {error}"),
        }
    });
    Ok(())
}

#[tauri::command]
async fn daemon_request(method: String, params: Option<serde_json::Value>, socket_path: Option<String>) -> Result<serde_json::Value, String> {
    daemon_client::request(&method, params, socket_path.as_deref()).await
}

#[tauri::command]
async fn sessions_subscribe(
    app: tauri::AppHandle,
    subscriptions: tauri::State<'_, Subscriptions>,
    session_id: String,
    socket_path: Option<String>
) -> Result<serde_json::Value, String> {
    daemon_client::subscribe_session(app, subscriptions.inner().clone(), session_id, socket_path).await
}

#[tauri::command]
async fn sessions_unsubscribe(subscriptions: tauri::State<'_, Subscriptions>, session_id: String, socket_path: Option<String>) -> Result<(), String> {
    daemon_client::unsubscribe_session(subscriptions.inner().clone(), session_id, socket_path.as_deref()).await;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let subscriptions: Subscriptions = Arc::new(Mutex::new(HashMap::new()));

    tauri::Builder::default()
        .manage(subscriptions)
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![daemon_request, sessions_subscribe, sessions_unsubscribe])
        .setup(|app| {
            #[cfg(not(debug_assertions))]
            start_bundled_daemon(app.handle())?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build()
                )?;
            }
            daemon_client::spawn_global_event_stream(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
