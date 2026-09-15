//! Rust mirror of `src/daemon-client.ts` — the app's only way of talking to `fluentd`. Every
//! call here is a plain newline-delimited JSON-RPC exchange over the same Unix socket the Node
//! daemon already serves (spec §7.2/§7.3): this module renders and forwards keystrokes, it does
//! not own any session state itself.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;
use uuid::Uuid;

#[cfg(not(windows))]
use tokio::net::UnixStream as DaemonStream;
#[cfg(windows)]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient as DaemonStream};
#[cfg(windows)]
use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY;

fn socket_path(override_path: Option<&str>) -> String {
    if let Some(path) = override_path.filter(|path| !path.trim().is_empty()) {
        return path.to_string();
    }
    std::env::var("FLUENT_SOCKET").unwrap_or_else(|_| default_socket_path())
}

#[cfg(not(windows))]
fn default_socket_path() -> String {
    let runtime_dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".to_string());
    format!("{runtime_dir}/fluent-code.sock")
}

#[cfg(windows)]
fn default_socket_path() -> String {
    let raw_name = std::env::var("FLUENT_PIPE_NAME")
        .or_else(|_| std::env::var("USERNAME"))
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "default".to_string());
    let sanitized: String = raw_name.chars().map(|character| {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-') { character } else { '-' }
    }).collect();
    let pipe_name = sanitized.trim_matches('-');
    format!(r"\\.\pipe\fluent-code-{}", if pipe_name.is_empty() { "default" } else { &pipe_name[..pipe_name.len().min(80)] })
}

#[cfg(not(windows))]
async fn connect_socket(path: String) -> std::io::Result<DaemonStream> {
    DaemonStream::connect(path).await
}

#[cfg(windows)]
async fn connect_socket(path: String) -> std::io::Result<DaemonStream> {
    // A named-pipe server can briefly have no free instance while accepting another client. Tokio
    // documents ERROR_PIPE_BUSY as retriable; bound it so a request cannot hang forever.
    for attempt in 0..20 {
        match ClientOptions::new().open(&path) {
            Ok(stream) => return Ok(stream),
            Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) && attempt < 19 => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("the bounded named-pipe retry loop always returns")
}

fn unavailable(e: impl std::fmt::Display) -> String {
    if cfg!(debug_assertions) {
        format!("fluentd unavailable: {e}. Start it with `pnpm daemon`.")
    } else {
        format!("fluentd unavailable: {e}. Fluent Code could not start its local engine; quit and reopen the app.")
    }
}

/// One-shot request/response: connect, write one line, read one line, close. Used for every RPC
/// method except the two that keep the socket open (`sessions.subscribe`, `stream.open`).
pub async fn request(method: &str, params: Option<Value>, target_socket: Option<&str>) -> Result<Value, String> {
    let mut stream = connect_socket(socket_path(target_socket)).await.map_err(unavailable)?;

    let id = Uuid::new_v4().to_string();
    let mut payload = json!({"id": id, "method": method});
    if let Some(p) = params {
        payload["params"] = p;
    }
    let mut line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    line.push('\n');
    stream.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(stream);
    let mut response_line = String::new();
    reader.read_line(&mut response_line).await.map_err(|e| e.to_string())?;
    let response: Value = serde_json::from_str(response_line.trim()).map_err(|e| e.to_string())?;
    if response["ok"].as_bool().unwrap_or(false) {
        Ok(response["result"].clone())
    } else {
        Err(response["error"].as_str().unwrap_or("unknown fluentd error").to_string())
    }
}

/// One background task streaming a session's events, shared by every view showing that session.
///
/// Shared because Tauri events are broadcast to every listener: a second stream for the same
/// session delivered each chunk twice into the same terminal. Counted because two views of one lane
/// (the lane grid and the single-session screen) subscribe and unsubscribe in no guaranteed order
/// while navigating, and one view leaving must not cut off the other.
pub struct Subscription {
    handle: tauri::async_runtime::JoinHandle<()>,
    alive: Arc<AtomicBool>,
    holders: usize,
}

/// Session id -> its shared stream, so `sessions_unsubscribe` can release the right connection
/// instead of guessing.
pub type Subscriptions = Arc<Mutex<HashMap<String, Subscription>>>;

fn forward_event(app: &AppHandle, event: &Value) {
    match event["event"].as_str() {
        Some("sessions.output") => {
            let _ = app.emit("session-output", event);
        }
        Some("sessions.status") => {
            let _ = app.emit("session-status", event);
        }
        Some("credential.switched") => {
            let _ = app.emit("credential-switched", event);
        }
        Some("credential.notice") => {
            let _ = app.emit("credential-notice", event);
        }
        Some("coordination.claimsExpired") => {
            let _ = app.emit("coordination-claims-expired", event);
        }
        Some("sessions.verification") => {
            let _ = app.emit("session-verification", event);
        }
        Some("coordination.conflicts") => {
            let _ = app.emit("coordination-conflicts", event);
        }
        Some("merge.outcome") => {
            let _ = app.emit("merge-outcome", event);
        }
        Some("admission.warning") => {
            let _ = app.emit("admission-warning", event);
        }
        Some("coordination.message") => {
            let _ = app.emit("coordination-message", event);
        }
        Some("evals.finished") => {
            let _ = app.emit("evals-finished", event);
        }
        Some("sessions.attention") => {
            let _ = app.emit("session-attention", event);
        }
        _ => {}
    }
}

/// Opens a dedicated long-lived connection for one session and re-emits every pushed line as a
/// Tauri event, mirroring `daemon-client.ts`'s `subscribeSession`. Returns the initial snapshot
/// (the subscribe ack), same as the TS client's `onSnapshot`.
pub async fn subscribe_session(app: AppHandle, subscriptions: Subscriptions, session_id: String, target_socket: Option<String>) -> Result<Value, String> {
    // Held for the whole call, so two first subscriptions to one session cannot both open a stream.
    let mut subscriptions = subscriptions.lock().await;
    if let Some(existing) = subscriptions.get_mut(&session_id) {
        if existing.alive.load(Ordering::SeqCst) {
            // The lane's output is already being forwarded; this view only needs the text so far.
            let snapshot = request("sessions.get", Some(json!({"sessionId": session_id})), target_socket.as_deref()).await?;
            existing.holders += 1;
            return Ok(snapshot);
        }
    }

    let stream = connect_socket(socket_path(target_socket.as_deref())).await.map_err(unavailable)?;
    let (read_half, mut write_half) = tokio::io::split(stream);

    let id = Uuid::new_v4().to_string();
    let payload = json!({"id": id, "method": "sessions.subscribe", "params": {"sessionId": session_id}});
    let mut line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    line.push('\n');
    write_half.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(read_half);
    let mut first_line = String::new();
    reader.read_line(&mut first_line).await.map_err(|e| e.to_string())?;
    let ack: Value = serde_json::from_str(first_line.trim()).map_err(|e| e.to_string())?;
    if !ack["ok"].as_bool().unwrap_or(false) {
        return Err(ack["error"].as_str().unwrap_or("subscribe failed").to_string());
    }
    let snapshot = ack["result"].clone();

    let alive = Arc::new(AtomicBool::new(true));
    let stream_alive = alive.clone();
    let handle = tauri::async_runtime::spawn(async move {
        // `write_half` is kept alive only so the socket isn't half-closed by the writer dropping;
        // unsubscribe tears the whole task down via `abort()`.
        let _keep_alive = write_half;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(event) = serde_json::from_str::<Value>(trimmed) {
                        if event.get("id").is_some() {
                            continue; // a stray response line, not a pushed event
                        }
                        forward_event(&app, &event);
                    }
                }
                Err(_) => break,
            }
        }
        // A stream the daemon closed is replaced by the next subscription rather than shared.
        stream_alive.store(false, Ordering::SeqCst);
    });

    subscriptions.insert(session_id, Subscription { handle, alive, holders: 1 });
    Ok(snapshot)
}

pub async fn unsubscribe_session(subscriptions: Subscriptions, session_id: String, target_socket: Option<&str>) {
    let mut subscriptions = subscriptions.lock().await;
    let Some(existing) = subscriptions.get_mut(&session_id) else { return };
    existing.holders = existing.holders.saturating_sub(1);
    if existing.holders > 0 {
        return;
    }
    if let Some(released) = subscriptions.remove(&session_id) {
        released.handle.abort();
    }
    drop(subscriptions);
    let _ = request("sessions.unsubscribe", Some(json!({"sessionId": session_id})), target_socket).await;
}

/// One persistent global stream for provider-wide events (credential broadcasts) not tied to a
/// specific session — opened once at app startup and retried with backoff if fluentd isn't up
/// yet, so the Credentials screen gets fallback notices even with no session open.
pub fn spawn_global_event_stream(app: AppHandle) {
    // `tauri::async_runtime::spawn`, not `tokio::spawn` — this fn runs synchronously from
    // Tauri's `.setup()` hook, outside any Tokio reactor context, and a bare `tokio::spawn`
    // there panics ("there is no reactor running"). Tauri's wrapper schedules onto its own
    // managed runtime regardless of the caller's context.
    tauri::async_runtime::spawn(async move {
        loop {
            if let Ok(stream) = connect_socket(socket_path(None)).await {
                let (read_half, mut write_half) = tokio::io::split(stream);
                let id = Uuid::new_v4().to_string();
                let payload = json!({"id": id, "method": "stream.open"});
                let mut line = serde_json::to_string(&payload).unwrap();
                line.push('\n');
                if write_half.write_all(line.as_bytes()).await.is_ok() {
                    let mut reader = BufReader::new(read_half);
                    loop {
                        let mut line = String::new();
                        match reader.read_line(&mut line).await {
                            Ok(0) => break,
                            Ok(_) => {
                                let trimmed = line.trim();
                                if trimmed.is_empty() {
                                    continue;
                                }
                                if let Ok(event) = serde_json::from_str::<Value>(trimmed) {
                                    if event.get("id").is_some() {
                                        continue;
                                    }
                                    forward_event(&app, &event);
                                }
                            }
                            Err(_) => break,
                        }
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    });
}
