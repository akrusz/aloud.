//! Embedded local HTTP backend for the desktop shell.
//!
//! Replaces the endpoints the TS UI used to reach on Flask (`/api/*`). The UI
//! keeps issuing `fetch('/api/...')` but, in a Tauri build, against this server
//! via an injected base URL (see `ui/src/api-base.ts` and the
//! `initialization_script` in `lib.rs`). Bound to an ephemeral `127.0.0.1`
//! port so nothing is exposed off-box.
//!
//! Endpoints:
//! - `GET  /api/system-info` — platform + tool availability.
//! - `POST /api/stt/whisper` — local Whisper STT via whisper.cpp (whisper-rs).
//!   Wire-compatible with the old Flask route: raw little-endian f32 mono PCM
//!   in the body, `?sample_rate=` query, `{text,language,duration}` back, and
//!   503 while the model is still loading (the UI already handles that).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::cors::{Any, CorsLayer};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

// Default STT model: base.en GGML (~142 MB). Good accuracy/size balance for a
// turn-based meditation app; the meditation-pal-nn1 research calls for a
// capability-tiered choice (tiny/base/small) later. Downloaded on first run.
const WHISPER_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const WHISPER_MODEL_FILE: &str = "ggml-base.en.bin";
const TARGET_SAMPLE_RATE: u32 = 16_000;
// 30 s of 16 kHz f32 mono ≈ 1.9 MB; with onset pre-buffering an utterance can
// run longer, so cap generously (matches the Flask route's intent).
const MAX_AUDIO_BYTES: usize = 8 * 1024 * 1024;

pub struct AppState {
    whisper: Mutex<Option<Arc<WhisperContext>>>,
    whisper_ready: AtomicBool,
    model_dir: PathBuf,
    // Piper voice models (.onnx/.onnx.json) live here, downloaded on demand.
    piper_dir: PathBuf,
    // LRU-of-1 cache of the last-loaded Piper model (see tts::PiperCache).
    piper: crate::tts::PiperCache,
}

type Shared = Arc<AppState>;

fn router(state: Shared) -> Router {
    Router::new()
        .route("/api/system-info", get(system_info))
        .route("/api/stt/whisper", post(stt_whisper))
        .route("/api/voices", get(voices))
        .route("/api/voices/preview", get(voices_preview))
        .route("/api/tts/download-model", post(tts_download_model))
        .route("/api/tts/uninstall-model", post(tts_uninstall_model))
        .route("/api/llm/claude_proxy/complete", post(llm_claude_proxy_complete))
        // The webview origin (tauri://localhost in prod, http://localhost:1420
        // in dev) differs from this server's 127.0.0.1:<port>, so every request
        // is cross-origin. Permissive CORS is safe here: loopback only.
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .layer(DefaultBodyLimit::max(MAX_AUDIO_BYTES))
        .with_state(state)
}

/// Bind an ephemeral loopback port, kick off model loading in the background,
/// spawn the server on Tauri's async runtime, and return the chosen port.
pub fn start(data_dir: PathBuf) -> u16 {
    let state: Shared = Arc::new(AppState {
        whisper: Mutex::new(None),
        whisper_ready: AtomicBool::new(false),
        model_dir: data_dir.join("models"),
        piper_dir: data_dir.join("piper-models"),
        piper: Mutex::new(None),
    });

    // Model download + load is slow (and the download is large) — do it off the
    // server path. Until it finishes, /api/stt/whisper returns 503, which the UI
    // surfaces as "model still loading".
    {
        let state = state.clone();
        std::thread::spawn(move || {
            if let Err(e) = load_whisper(&state) {
                log::error!("whisper init failed: {e}");
            }
        });
    }

    tauri::async_runtime::block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local api server");
        let port = listener
            .local_addr()
            .expect("local api server addr")
            .port();
        let app = router(state);
        tauri::async_runtime::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                log::error!("local api server stopped: {e}");
            }
        });
        log::info!("local api server listening on 127.0.0.1:{port}");
        port
    })
}

fn load_whisper(state: &AppState) -> Result<(), String> {
    std::fs::create_dir_all(&state.model_dir).map_err(|e| e.to_string())?;
    let path = state.model_dir.join(WHISPER_MODEL_FILE);
    if !path.exists() {
        log::info!("downloading whisper model -> {}", path.display());
        download(WHISPER_MODEL_URL, &path)?;
        log::info!("whisper model downloaded");
    }
    let model_path = path.to_str().ok_or("model path not UTF-8")?;
    let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|e| format!("load model: {e}"))?;
    *state.whisper.lock().unwrap() = Some(Arc::new(ctx));
    state.whisper_ready.store(true, Ordering::SeqCst);
    log::info!("whisper model ready");
    Ok(())
}

/// Stream a URL to a file, downloading to a `.part` sibling then renaming so a
/// half-finished download can't be mistaken for a complete model.
fn download(url: &str, dest: &Path) -> Result<(), String> {
    let tmp = dest.with_extension("part");
    let response = ureq::get(url).call().map_err(|e| e.to_string())?;
    let mut reader = response.into_body().into_reader();
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    std::io::copy(&mut reader, &mut file).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// Mirror Flask's `/api/system-info` shape: platform + tool availability. The
/// UI keys desktop-only features off this (and uses a successful response as
/// its "is desktop" signal).
async fn system_info() -> Json<Value> {
    let claude = which::which("claude").ok();
    let ollama = which::which("ollama").ok();
    let path_str = |p: Option<PathBuf>| -> Value {
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

#[derive(Deserialize)]
struct SttQuery {
    sample_rate: Option<u32>,
}

/// Transcribe raw f32 mono PCM. Body and response match the old Flask route so
/// the existing ServerWhisperSttEngine adapter is unchanged.
async fn stt_whisper(
    State(state): State<Shared>,
    Query(q): Query<SttQuery>,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    if !state.whisper_ready.load(Ordering::SeqCst) {
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "Whisper model still loading — try again in a moment.",
        );
    }
    if body.is_empty() {
        return err(StatusCode::BAD_REQUEST, "Empty request body.");
    }
    if body.len() % 4 != 0 {
        return err(
            StatusCode::BAD_REQUEST,
            "Body length not aligned to float32 frames.",
        );
    }

    let samples: Vec<f32> = body
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    if samples.is_empty() {
        return (StatusCode::OK, Json(json!({ "text": "" })));
    }

    let sample_rate = q.sample_rate.unwrap_or(TARGET_SAMPLE_RATE);
    let ctx = match state.whisper.lock().unwrap().clone() {
        Some(c) => c,
        None => {
            return err(
                StatusCode::SERVICE_UNAVAILABLE,
                "Whisper model still loading — try again in a moment.",
            )
        }
    };

    // Whisper inference is CPU-heavy and blocking — keep it off the async
    // reactor so concurrent requests / the server stay responsive.
    match tokio::task::spawn_blocking(move || transcribe(&ctx, &samples, sample_rate)).await {
        Ok(Ok((text, duration))) => (
            StatusCode::OK,
            Json(json!({ "text": text.trim(), "language": "en", "duration": duration })),
        ),
        Ok(Err(e)) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Transcription failed: {e}"),
        ),
        Err(e) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Transcription task failed: {e}"),
        ),
    }
}

fn err(code: StatusCode, msg: &str) -> (StatusCode, Json<Value>) {
    (code, Json(json!({ "error": msg })))
}

// --- TTS: /api/voices + /api/voices/preview --------------------------------

/// Fallback preview phrase when the client doesn't supply `?text=`. The UI
/// always sends text (preview line or a session sentence), so this is rarely
/// hit; kept short to match the old Flask default.
const DEFAULT_PREVIEW_TEXT: &str = "Take a slow breath, and let your shoulders soften.";

#[derive(Deserialize)]
struct VoicesQuery {
    engine: Option<String>,
    lang: Option<String>,
}

/// `GET /api/voices` — aggregated Piper + macOS voice catalogue (or one engine
/// when `?engine=` is set), optionally filtered by `?lang=`. Runs off the async
/// reactor because it shells out to `say -v ?` and stats the model dir.
async fn voices(State(state): State<Shared>, Query(q): Query<VoicesQuery>) -> Json<Value> {
    let dir = state.piper_dir.clone();
    let voices = tokio::task::spawn_blocking(move || {
        crate::tts::list_voices(q.engine.as_deref(), q.lang.as_deref(), &dir)
    })
    .await
    .unwrap_or_else(|_| Value::Array(Vec::new()));
    Json(voices)
}

#[derive(Deserialize)]
struct PreviewQuery {
    voice: Option<String>,
    engine: Option<String>,
    text: Option<String>,
    rate: Option<u32>,
}

/// `GET /api/voices/preview` — synthesize one utterance to a WAV. This is also
/// the session TTS path the UI streams sentences through, so the model cache in
/// AppState matters here, not just for previews.
async fn voices_preview(State(state): State<Shared>, Query(q): Query<PreviewQuery>) -> Response {
    let voice = match q.voice {
        Some(v) if !v.is_empty() => v,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let text = q.text.unwrap_or_else(|| DEFAULT_PREVIEW_TEXT.to_string());

    // Synthesis (and any first-run model download) is blocking and CPU-heavy.
    let result = tokio::task::spawn_blocking(move || {
        crate::tts::synth_preview(
            &state.piper_dir,
            &state.piper,
            &voice,
            q.engine.as_deref(),
            &text,
            q.rate,
        )
    })
    .await;

    match result {
        Ok(Ok(bytes)) => ([(header::CONTENT_TYPE, "audio/wav")], bytes).into_response(),
        Ok(Err(e)) => {
            log::warn!("voice preview failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            log::error!("voice preview task failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Deserialize)]
struct ModelReq {
    #[serde(default)]
    engine: String,
    #[serde(default)]
    voice: String,
}

/// `POST /api/tts/download-model` — stream a Piper model download as NDJSON
/// progress lines. The download runs on a blocking thread and pushes each
/// progress event through a channel that backs the response body, so the UI
/// gets live progress for a 60–105 MB fetch.
async fn tts_download_model(State(state): State<Shared>, Json(req): Json<ModelReq>) -> Response {
    if req.engine.is_empty() || req.voice.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "engine and voice are required" })))
            .into_response();
    }

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<String, std::io::Error>>(64);
    let dir = state.piper_dir.clone();
    tokio::task::spawn_blocking(move || {
        let mut send = move |v: Value| {
            // Best-effort: if the client hangs up, the receiver drops and sends
            // fail — that's fine, we just stop reporting.
            let _ = tx.blocking_send(Ok(format!("{v}\n")));
        };
        if let Err(e) = crate::tts::download_model(&dir, &req.engine, &req.voice, &mut send) {
            send(json!({ "status": "error", "error": e }));
        }
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(axum::body::Body::from_stream(stream))
        .expect("build ndjson response")
}

/// `POST /api/tts/uninstall-model` — delete a downloaded Piper model.
async fn tts_uninstall_model(
    State(state): State<Shared>,
    Json(req): Json<ModelReq>,
) -> (StatusCode, Json<Value>) {
    if req.voice.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "voice is required" })));
    }
    match crate::tts::uninstall_model(&state.piper_dir, &req.engine, &req.voice) {
        Ok(status) => (StatusCode::OK, Json(json!({ "status": status }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))),
    }
}

// --- /api/llm/claude_proxy/complete ----------------------------------------

/// `POST /api/llm/claude_proxy/complete` — run one `claude` CLI completion for
/// the "Anthropic (Subscription)" provider. Desktop-only by nature (needs the
/// authenticated CLI). See `crate::llm`.
async fn llm_claude_proxy_complete(Json(req): Json<crate::llm::CompleteRequest>) -> Response {
    match crate::llm::claude_complete(req).await {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(e) => {
            let code = StatusCode::from_u16(e.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            (code, Json(json!({ "error": e.message }))).into_response()
        }
    }
}

fn transcribe(
    ctx: &WhisperContext,
    samples: &[f32],
    sample_rate: u32,
) -> Result<(String, f64), String> {
    // The TS client always sends 16 kHz mono f32 (it downsamples before POST),
    // which is what whisper.cpp wants; guard the assumption rather than resample.
    if sample_rate != TARGET_SAMPLE_RATE {
        return Err(format!(
            "expected {TARGET_SAMPLE_RATE} Hz audio, got {sample_rate} Hz"
        ));
    }

    let mut wstate = ctx.create_state().map_err(|e| e.to_string())?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);

    wstate.full(params, samples).map_err(|e| e.to_string())?;

    let n = wstate.full_n_segments();
    let mut text = String::new();
    for i in 0..n {
        if let Some(segment) = wstate.get_segment(i) {
            let piece = segment.to_str_lossy().map_err(|e| e.to_string())?;
            text.push_str(piece.as_ref());
        }
    }
    let duration = samples.len() as f64 / sample_rate as f64;
    Ok((text, duration))
}
