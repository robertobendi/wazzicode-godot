pub mod agent;
pub mod bridge;
pub mod claudeauth;
pub mod codexauth;
pub mod commands;
pub mod error;
pub mod execution;
pub mod gitutil;
pub mod looprunner;
pub mod mcpconfig;
pub mod pairing;
pub mod pathutil;
pub mod proc;
pub mod state;
pub mod store;

use crate::state::AppState;
use crate::store::{config_dir, settings};

/// Wrap the default panic hook so any panic — including ones inside
/// `spawn_blocking` workers or PTY reader threads (added in later phases) —
/// lands in the log file (and stderr, for early-startup panics before the
/// logger is set up).
fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        log::error!("panic: {info}\nbacktrace:\n{backtrace}");
        eprintln!("panic: {info}\nbacktrace:\n{backtrace}");
        default(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                // File under ~/Library/Logs/<id>/ (macOS), %LOCALAPPDATA% (Win),
                // ~/.local/share/<id>/logs/ (Linux) — Tauri's app_log_dir.
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .max_file_size(5 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .build(),
        )
        .setup(|app| {
            use tauri::Manager;
            let cfg_dir = config_dir().expect("could not create config dir");
            let initial = settings::load(&cfg_dir).unwrap_or_default();

            // Let the webview render live captures through the asset protocol.
            // The dir is machine-specific, so we grant it at runtime rather than
            // via a static tauri.conf scope pattern.
            let captures = cfg_dir.join("captures");
            if let Err(e) = std::fs::create_dir_all(&captures) {
                log::warn!("could not create captures dir: {e}");
            }
            if let Err(e) = app.asset_protocol_scope().allow_directory(&captures, false) {
                log::warn!("could not grant captures dir to asset scope: {e}");
            }

            app.manage(AppState::new(cfg_dir, initial));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::settings::ping,
            commands::agent_options::agent_model_catalog,
            commands::project::validate_unity_project,
            commands::project::set_current_project,
            commands::project_map::read_project_map,
            commands::project_map::query_project_map,
            commands::project_map::refresh_project_map,
            commands::project_map::ask_project_map,
            commands::diagnostics::unity_diagnostics,
            commands::diagnostics::unity_clear_console,
            commands::chat::chat_send,
            commands::chat::chat_cancel,
            commands::chat::chat_subscribe,
            commands::revert::revert_last,
            commands::sessions::save_session,
            commands::sessions::list_sessions,
            commands::sessions::load_session,
            commands::sessions::delete_session,
            commands::quick_actions::read_quick_actions,
            commands::loops::loop_start,
            commands::loops::loop_stop,
            commands::loops::loop_feedback,
            commands::loops::loop_state,
            commands::status::status_start,
            commands::status::status_stop,
            commands::screenshot::bridge_capture,
            commands::resources::stage_paths,
            commands::resources::paste_clipboard,
            commands::resources::remove_staged,
            commands::pairing::pairing_start,
            commands::pairing::pairing_submit_code,
            commands::pairing::pairing_cancel,
            commands::pairing::pairing_state,
            commands::pairing::auth_status,
            commands::pairing::auth_verify,
            commands::pairing::auth_clear,
            commands::codex_auth::codex_auth_status,
            commands::codex_auth::codex_login_start,
            commands::codex_auth::codex_login_cancel,
            commands::codex_auth::codex_logout,
            commands::onboarding::onboarding_status,
            commands::onboarding::onboarding_check_cli,
            commands::onboarding::onboarding_install_cli,
            commands::onboarding::onboarding_setup_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
