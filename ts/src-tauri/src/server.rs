//! Embedded local HTTP backend for the desktop shell.
//!
//! Replaces the endpoints the TS UI used to reach on Flask (`/api/*`). The UI
//! keeps issuing `fetch('/api/...')` but, in a Tauri build, against this server
//! via an injected base URL (see `ui/src/api-base.ts` and the
//! `initialization_script` in `lib.rs`). Bound to an ephemeral `127.0.0.1`
//! port so nothing is exposed off-box.
//!
//! Local inference (whisper.cpp STT, Piper TTS) and the `claude` CLI bridge
//! land here next; this slice stands up the server + `/api/system-info` to
//! prove the path end to end (see meditation-pal-clk).

use axum::{routing::get, Json, Router};
use serde_json::{json, Value};
use tower_http::cors::{Any, CorsLayer};

fn router() -> Router {
    Router::new().route("/api/system-info", get(system_info)).layer(
        // The webview origin (tauri://localhost in prod, http://localhost:1420
        // in dev) differs from this server's 127.0.0.1:<port>, so every request
        // is cross-origin. Permissive CORS is safe here: the server only binds
        // to loopback.
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any),
    )
}

/// Mirror Flask's `/api/system-info` shape: platform + tool availability. The
/// UI keys desktop-only features off this (and uses a successful response as
/// its "is desktop" signal).
async fn system_info() -> Json<Value> {
    let claude = which::which("claude").ok();
    let ollama = which::which("ollama").ok();
    let path_str = |p: Option<std::path::PathBuf>| -> Value {
        match p {
            Some(p) => json!(p.display().to_string()),
            None => Value::Null,
        }
    };
    // Flask reports platform.system().lower(); map Rust's "macos" to "darwin"
    // so any platform-string consumers stay byte-compatible.
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    Json(json!({
        "platform": platform,
        "has_homebrew": which::which("brew").is_ok(),
        "tools": {
            "claude_cli": { "installed": claude.is_some(), "path": path_str(claude) },
            "ollama": { "installed": ollama.is_some(), "path": path_str(ollama) },
        },
    }))
}

/// Bind an ephemeral loopback port, spawn the server on Tauri's async runtime,
/// and return the chosen port so the caller can inject it into the webview.
pub fn start() -> u16 {
    tauri::async_runtime::block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local api server");
        let port = listener
            .local_addr()
            .expect("local api server addr")
            .port();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = axum::serve(listener, router()).await {
                log::error!("local api server stopped: {e}");
            }
        });
        log::info!("local api server listening on 127.0.0.1:{port}");
        port
    })
}
