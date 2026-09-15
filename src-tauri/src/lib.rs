mod daemon_client;

use daemon_client::Subscriptions;
use std::collections::HashMap;
#[cfg(not(debug_assertions))]
use std::process::Command;
use std::sync::{Arc, RwLock};
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

/**
 * Preview and OpenDesign use user-selected local ports. They run in their own guarded webviews,
 * rather than a child frame in Fluent's privileged webview: Wry's Windows navigation hook does
 * not receive `FrameNavigationStarting`, so an iframe cannot safely be guarded cross-platform.
 */
#[derive(Clone, Default)]
struct EmbeddedOrigins(Arc<RwLock<HashMap<String, String>>>);

fn canonical_embedded_origin(value: &str) -> Result<String, String> {
    let url = tauri::Url::parse(value.trim())
        .map_err(|_| "Embedded content URL must be a valid local HTTP(S) origin".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Embedded content must use HTTP or HTTPS".into());
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if !matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1" | "[::1]") {
        return Err("Embedded content must use localhost, 127.0.0.1, or [::1]".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Embedded content URL must be an origin without credentials, a path, query, or fragment".into());
    }
    let origin = url.origin().ascii_serialization();
    if origin == "null" {
        return Err("Embedded content URL has no usable origin".into());
    }
    Ok(origin)
}

fn authorize_embedded_origin(kind: &str, origin: &str, origins: &EmbeddedOrigins) -> Result<String, String> {
    if kind != "preview" && kind != "open-design" {
        return Err("Unknown embedded-content surface".into());
    }
    let canonical = canonical_embedded_origin(origin)?;
    origins
        .0
        .write()
        .map_err(|_| "Embedded-content policy is unavailable")?
        .insert(kind.to_owned(), canonical.clone());
    Ok(canonical)
}

/** Authorizes and opens one local-content surface in an isolated top-level webview. */
#[tauri::command]
fn open_embedded_content(
    kind: String,
    origin: String,
    origins: tauri::State<'_, EmbeddedOrigins>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let canonical = authorize_embedded_origin(&kind, &origin, origins.inner())?;
    let url = tauri::Url::parse(&canonical).map_err(|_| "Could not open the embedded-content origin".to_string())?;
    let label = format!("fluent-{kind}");
    if let Some(window) = app.get_webview_window(&label) {
        window.navigate(url).map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(canonical);
    }

    let allowed_origins = origins.inner().clone();
    let guard_kind = kind.clone();
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
        .title(if kind == "preview" { "Fluent Code — Preview" } else { "Fluent Code — OpenDesign" })
        .inner_size(1280.0, 800.0)
        // This is a top-level navigation guard on every supported desktop backend, unlike the
        // parent-webview hook which cannot see child frame redirects on WebView2.
        .on_navigation(move |next| navigation_for_surface(next, &guard_kind, &allowed_origins))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(canonical)
}

/** Gets the loopback origin of a page navigation; internal paths remain valid after explicit setup. */
fn navigation_origin(url: &tauri::Url) -> Option<String> {
    if (url.scheme() != "http" && url.scheme() != "https") || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    if !matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1" | "[::1]") {
        return None;
    }
    let origin = url.origin().ascii_serialization();
    (origin != "null").then_some(origin)
}

/** Allows only the selected origin for one isolated content surface, including same-origin routes. */
fn navigation_for_surface(url: &tauri::Url, kind: &str, origins: &EmbeddedOrigins) -> bool {
    navigation_origin(url)
        .and_then(|origin| origins.0.read().ok().map(|allowed| allowed.get(kind).is_some_and(|value| value == &origin)))
        .unwrap_or(false)
}

fn guarded_main_navigation(url: &tauri::Url, origins: &EmbeddedOrigins) -> bool {
    if matches!(url.scheme(), "tauri" | "asset" | "about")
        || matches!(url.host_str(), Some("tauri.localhost") | Some("ipc.localhost"))
    {
        return true;
    }
    navigation_origin(url)
        .and_then(|origin| origins.0.read().ok().map(|allowed| allowed.values().any(|value| value == &origin)))
        .unwrap_or(false)
}

fn allowed_navigation(url: &tauri::Url, origins: &EmbeddedOrigins) -> bool {
    // Development uses a local asset server. Release builds enforce the gate; preserving dev-server
    // navigation keeps `pnpm tauri dev` usable without granting release builds a broad exception.
    cfg!(debug_assertions) || guarded_main_navigation(url, origins)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let subscriptions: Subscriptions = Arc::new(Mutex::new(HashMap::new()));
    let embedded_origins = EmbeddedOrigins::default();
    let navigation_origins = embedded_origins.clone();

    tauri::Builder::default()
        .manage(subscriptions)
        .manage(embedded_origins)
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("embedded-origin-guard")
                .on_navigation(move |_webview, url| allowed_navigation(url, &navigation_origins))
                .build(),
        )
        .invoke_handler(tauri::generate_handler![daemon_request, sessions_subscribe, sessions_unsubscribe, open_embedded_content])
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

#[cfg(test)]
mod embedded_content_tests {
    use super::*;

    #[test]
    fn canonicalizes_only_a_plain_loopback_origin() {
        assert_eq!(canonical_embedded_origin("http://LOCALHOST:3000/").unwrap(), "http://localhost:3000");
        assert_eq!(canonical_embedded_origin("https://[::1]:7456/").unwrap(), "https://[::1]:7456");
        for value in [
            "https://example.com",
            "http://localhost:3000/path",
            "http://localhost:3000/?token=x",
            "http://user@localhost:3000",
            "file:///tmp/preview.html",
            "http://127.0.0.1:3000/#view",
        ] {
            assert!(canonical_embedded_origin(value).is_err(), "{value} should be refused");
        }
    }

    #[test]
    fn surface_navigation_requires_the_exact_user_enabled_origin() {
        let allowed = EmbeddedOrigins::default();
        allowed
            .0
            .write()
            .unwrap()
            .insert("preview".into(), "http://127.0.0.1:3000".into());
        assert!(navigation_for_surface(&tauri::Url::parse("http://127.0.0.1:3000/settings").unwrap(), "preview", &allowed));
        assert!(!navigation_for_surface(&tauri::Url::parse("http://127.0.0.1:3001/").unwrap(), "preview", &allowed));
        assert!(!navigation_for_surface(&tauri::Url::parse("http://localhost:3000/").unwrap(), "preview", &allowed));
        assert!(!navigation_for_surface(&tauri::Url::parse("https://example.com/").unwrap(), "preview", &allowed));
    }
}
