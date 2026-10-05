 
#[tauri::command]
pub fn ping(name: String) -> String {
    format!("Pong ! Bonjour {}, le backend Rust fonctionne !", name)
}

#[tauri::command]
pub fn calculate_ram_gb(memory_mb: u32) -> u32 {
    memory_mb / 1024
}

#[tauri::command]
pub fn user_downloads_path() -> Result<String, String> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| "Impossible de déterminer le dossier personnel de l'utilisateur.".to_string())?;
    let home = std::path::PathBuf::from(home);
    let downloads = home.join("Downloads");
    let lower_case_downloads = home.join("downloads");

    Ok(if downloads.exists() {
        downloads
    } else if lower_case_downloads.exists() {
        lower_case_downloads
    } else {
        downloads
    }.to_string_lossy().to_string())
}
