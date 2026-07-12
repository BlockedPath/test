//! Tauri host shell for Grok GUI.
//!
//! Foundation ticket: the desktop window hosts the web frontend.
//! The AgentEnginePort seam lives in the frontend TypeScript layer for the
//! fake-engine vertical slice. A later ticket moves the real ACP bridge here.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
