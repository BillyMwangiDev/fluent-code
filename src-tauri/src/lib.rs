mod daemon_client;

use daemon_client::Subscriptions;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

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
        .invoke_handler(tauri::generate_handler![daemon_request, sessions_subscribe, sessions_unsubscribe])
        .setup(|app| {
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
