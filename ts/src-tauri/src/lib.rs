mod server;

use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Start the embedded local backend and inject its base URL into the
      // webview before any page script runs, so ui/src/api-base.ts can resolve
      // /api/* against it. The window is built here (not in tauri.conf.json)
      // because an initialization_script can only be attached at build time.
      let port = server::start();
      let init = format!("window.__ALOUD_API_BASE__ = 'http://127.0.0.1:{port}';");

      let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("aloud")
        .inner_size(1000.0, 820.0)
        .min_inner_size(480.0, 600.0)
        .resizable(true)
        .initialization_script(init.as_str());

      // macOS: frameless-feeling window that keeps the native traffic-light
      // controls. The .nav doubles as the draggable title bar (see the TS UI).
      #[cfg(target_os = "macos")]
      let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

      builder.build()?;
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
