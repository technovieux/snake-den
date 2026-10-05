mod commands;
use commands::vm::DownloadState;
use commands::quick::QuickemuState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DownloadState::default())
        .manage(QuickemuState::default())
        .setup(|_| {
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
        
            commands::system::ping,
            commands::system::calculate_ram_gb,
            commands::system::user_downloads_path,
            commands::vm::list_vms,
            commands::vm::start_vm,
            commands::vm::stop_vm,
            commands::vm::force_stop_vm,
            commands::vm::delete_vm,
            commands::vm::create_vm,
            commands::vm::download_file,
            commands::vm::cancel_download,
            commands::vm::check_iso_exists,
            commands::quick::quickget_download,
            commands::quick::download_iso_only,
            commands::quick::cancel_quickget_download,
            commands::quick::ensure_hero_banner,
            commands::quick::ensure_os_icon,
            commands::quick::start_quickemu,
            commands::quick::stop_quickemu,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}



















