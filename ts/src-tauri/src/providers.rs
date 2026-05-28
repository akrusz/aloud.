//! Provider availability + model listing for the desktop backend.
//!
//! Trimmed port of Flask's `/api/providers` + `/api/models/<provider>`. The TS
//! UI consumes only `{available, installed?, hint?}` per provider, plus
//! `ollama.models` (used by the model picker), so this skips the elaborate
//! Ollama RAM-tier / version / GPU detection from the Python route — that UX
//! lives in a settings tour that gracefully no-ops when the field is absent.
//!
//! API-key providers report env-var availability (parity with Flask). On
//! desktop the user's keys typically live in localStorage rather than the
//! environment, so most API providers will read as "unavailable" here; the TS
//! UI already merges that with its own key store for the final UI state.

use serde_json::{json, Value};

const OLLAMA_URL: &str = "http://localhost:11434";

/// `GET /api/providers` body. Synchronous: shells out to `which` and pings
/// localhost — callers should run this on a blocking thread.
pub fn providers() -> Value {
    let has_claude = which::which("claude").is_ok();
    let has_ollama_bin = which::which("ollama").is_ok();
    let (ollama_running, models) = probe_ollama();

    json!({
        "claude_proxy": {
            "available": has_claude,
            "installed": has_claude,
            "hint": if has_claude {
                ""
            } else {
                "Claude Code CLI is not installed. Install Claude Code, then \
                 run `claude` once to log in with your Pro/Max subscription."
            },
        },
        "anthropic": api_key_provider("ANTHROPIC_API_KEY"),
        "openai": api_key_provider("OPENAI_API_KEY"),
        "openrouter": api_key_provider("OPENROUTER_API_KEY"),
        "venice": api_key_provider("VENICE_API_KEY"),
        "groq": api_key_provider("GROQ_API_KEY"),
        "ollama": ollama_status(has_ollama_bin, ollama_running, &models),
    })
}

/// `GET /api/models/<provider>` body — currently a stub. Model lists need the
/// provider's API key, which on desktop lives in the UI's localStorage rather
/// than the embedded backend; the model picker already falls back to a
/// free-form text input when this returns empty, so a stub keeps the UI
/// functional until a key-forwarding path is added.
pub fn models(_provider: &str) -> Value {
    Value::Array(Vec::new())
}

fn api_key_provider(env_var: &str) -> Value {
    json!({
        "available": std::env::var(env_var).is_ok_and(|v| !v.is_empty()),
        "hint": format!("Add your API key in Settings or set {env_var} in your environment."),
    })
}

/// Returns (running, model_names). `running` means the daemon responded;
/// model_names may be empty even when running (no models pulled yet).
fn probe_ollama() -> (bool, Vec<String>) {
    let url = format!("{OLLAMA_URL}/api/tags");
    let resp = match ureq::get(&url)
        .config()
        .timeout_global(Some(std::time::Duration::from_millis(1500)))
        .build()
        .call()
    {
        Ok(r) => r,
        Err(_) => return (false, Vec::new()),
    };
    let reader = resp.into_body().into_reader();
    let body: Value = match serde_json::from_reader(reader) {
        Ok(v) => v,
        Err(_) => return (true, Vec::new()),
    };
    let models = body
        .get("models")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("name").and_then(Value::as_str).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    (true, models)
}

fn ollama_status(has_bin: bool, running: bool, models: &[String]) -> Value {
    let available = running && !models.is_empty();
    let installed = has_bin || running;
    let hint = if available {
        ""
    } else if running {
        "Ollama is running but has no models. Run `ollama pull llama3.2:3b` to start."
    } else if has_bin {
        "Ollama is installed but not running. Start it from the menu bar or `ollama serve`."
    } else {
        "Ollama is not installed. Visit ollama.ai to install."
    };
    json!({
        "available": available,
        "installed": installed,
        "models": models,
        "hint": hint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ollama_status_running_with_models_is_available() {
        let s = ollama_status(true, true, &["llama3.2:3b".to_string()]);
        assert_eq!(s["available"], json!(true));
        assert_eq!(s["installed"], json!(true));
        assert_eq!(s["models"][0], json!("llama3.2:3b"));
    }

    #[test]
    fn ollama_status_running_no_models_pushes_pull_hint() {
        let s = ollama_status(true, true, &[]);
        assert_eq!(s["available"], json!(false));
        assert!(s["hint"].as_str().unwrap().contains("ollama pull"));
    }

    #[test]
    fn ollama_status_not_running_but_installed() {
        let s = ollama_status(true, false, &[]);
        assert_eq!(s["installed"], json!(true));
        assert!(s["hint"].as_str().unwrap().contains("not running"));
    }

    #[test]
    fn api_key_provider_reports_env_var() {
        // Use a name unlikely to collide with the host env.
        let key = "ALOUD_TEST_FAKE_PROVIDER_KEY_DO_NOT_SET";
        std::env::remove_var(key);
        let v = api_key_provider(key);
        assert_eq!(v["available"], json!(false));
    }

    #[test]
    fn providers_response_carries_every_expected_key() {
        // Smoke: end-to-end call doesn't panic and exposes the keys the TS UI
        // looks up. Ollama may or may not be running on the test host — we
        // assert only that the entry exists, not its availability.
        let v = providers();
        for k in [
            "claude_proxy",
            "anthropic",
            "openai",
            "openrouter",
            "venice",
            "groq",
            "ollama",
        ] {
            assert!(v.get(k).is_some(), "missing provider key: {k}");
            assert!(v[k].get("available").is_some(), "{k} missing `available`");
        }
        assert!(v["ollama"]["models"].is_array());
    }
}
