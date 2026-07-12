//! Tauri host shell for Grok GUI.
//!
//! Hosts the web frontend and exposes native process/FS commands so the
//! TypeScript `GrokAcpEngine` can supervise the official Grok CLI over ACP.

mod engine_host;

use std::sync::Arc;

use engine_host::ProcRegistry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(ProcRegistry::default()))
        .invoke_handler(tauri::generate_handler![
            engine_host::host_env,
            engine_host::host_path_exists,
            engine_host::host_path_is_dir,
            engine_host::host_path_any_exists,
            engine_host::host_resolve_path,
            engine_host::host_which,
            engine_host::host_exec,
            engine_host::host_list_dir,
            engine_host::host_read_file,
            engine_host::host_write_text,
            engine_host::host_delete_file,
            engine_host::host_move_file,
            engine_host::host_taskkill,
            engine_host::engine_spawn,
            engine_host::engine_write,
            engine_host::engine_kill,
            engine_host::terminal_spawn,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
