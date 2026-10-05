use std::process::Command;
use serde::{Deserialize, Serialize};

use futures_util::StreamExt;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;
use std::path::{Path, PathBuf};
use crate::commands::quick::{process_running, start_process, stop_process, QuickemuState};

fn vm_directory(storage_path: &str, name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
    {
        return Err("Nom de VM invalide.".to_string());
    }

    Ok(Path::new(storage_path).join(name))
}

fn memory_value_to_mb(value: &str) -> Option<u32> {
    let value = value.trim().trim_matches('"').trim_matches('\'');
    let digit_count = value.chars().take_while(|character| character.is_ascii_digit()).count();
    if digit_count == 0 {
        return None;
    }

    let amount = value[..digit_count].parse::<u64>().ok()?;
    let unit = value[digit_count..].trim().to_ascii_lowercase();
    let megabytes = match unit.as_str() {
        "" | "m" | "mb" | "mi" | "mib" => amount,
        "k" | "kb" | "ki" | "kib" => amount / 1024,
        "g" | "gb" | "gi" | "gib" => amount.saturating_mul(1024),
        "t" | "tb" | "ti" | "tib" => amount.saturating_mul(1024 * 1024),
        _ => return None,
    };

    u32::try_from(megabytes).ok()
}

fn vm_resources(config_path: &Path) -> (u32, u32) {
    let mut vcpus = 1;
    let mut memory_mb = 1024;

    if let Ok(contents) = fs::read_to_string(config_path) {
        for line in contents.lines() {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            match key.trim() {
                "cpu_cores" => vcpus = value.trim().trim_matches('"').parse().unwrap_or(vcpus),
                "ram" | "memory" => {
                    if let Some(parsed_memory) = memory_value_to_mb(value) {
                        memory_mb = parsed_memory;
                    }
                }
                _ => {}
            }
        }
    }

    (vcpus, memory_mb)
}

fn migrate_legacy_memory_setting(config_path: &Path) -> Result<(), String> {
    let contents = fs::read_to_string(config_path)
        .map_err(|e| format!("Impossible de lire la configuration Quickemu : {}", e))?;
    let has_ram = contents.lines().any(|line| {
        line.split_once('=')
            .is_some_and(|(key, _)| key.trim() == "ram")
    });
    if has_ram {
        return Ok(());
    }

    let mut changed = false;
    let migrated = contents
        .lines()
        .map(|line| {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim() == "memory" {
                    changed = true;
                    return format!("ram={}", value.trim());
                }
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n");

    if changed {
        fs::write(config_path, format!("{}\n", migrated))
            .map_err(|e| format!("Impossible de migrer la mémoire de la VM : {}", e))?;
    }
    Ok(())
}

// Structure pour stocker les jetons d'annulation des téléchargements en cours
#[derive(Default)]
pub struct DownloadState {
    pub cancel_tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub download_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percentage: f64,
}






#[tauri::command]
pub async fn download_file(
    app_handle: AppHandle,
    state: State<'_, DownloadState>,
    download_id: String,
    url: String,
    output_path: String,
) -> Result<(), String> {
    let cancel_token = CancellationToken::new();
    
    // Stocker le token pour ce download_id
    {
        let mut tokens = state.cancel_tokens.lock().unwrap();
        tokens.insert(download_id.clone(), cancel_token.clone());
    }

    let download_id_clone = download_id.clone();
    let state_tokens = state.cancel_tokens.clone();

    tokio::spawn(async move {
        let client = reqwest::Client::new();
        let res = match client.get(&url).send().await {
            Ok(response) => response,
            Err(e) => {
                eprintln!("Erreur requete: {}", e);
                state_tokens.lock().unwrap().remove(&download_id_clone);
                return;
            }
        };

        if !res.status().is_success() {
            eprintln!("Erreur HTTP: {}", res.status());
            state_tokens.lock().unwrap().remove(&download_id_clone);
            return;
        }

        let total_size = res.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;
        let mut stream = res.bytes_stream();

        let mut file = match File::create(&output_path) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("Erreur création fichier: {}", e);
                state_tokens.lock().unwrap().remove(&download_id_clone);
                return;
            }
        };

        loop {
            tokio::select! {
                // Si l'utilisateur clique sur Annuler
                _ = cancel_token.cancelled() => {
                    drop(file); // Fermer le descripteur de fichier
                    let _ = fs::remove_file(&output_path); // Supprimer le fichier incomplet
                    eprintln!("Téléchargement annulé et fichier supprimé : {}", output_path);
                    state_tokens.lock().unwrap().remove(&download_id_clone);
                    return;
                }
                // Réception des données HTTP
                maybe_item = stream.next() => {
                    match maybe_item {
                        Some(Ok(chunk)) => {
                            if file.write_all(&chunk).is_ok() {
                                downloaded += chunk.len() as u64;

                                let percentage = if total_size > 0 {
                                    ((downloaded as f64 / total_size as f64) * 100.0 * 100.0).round() / 100.0
                                } else {
                                    50.0
                                };

                                let payload = DownloadProgress {
                                    download_id: download_id_clone.clone(),
                                    downloaded_bytes: downloaded,
                                    total_bytes: total_size,
                                    percentage,
                                };

                                let _ = app_handle.emit("download-progress", payload);
                            }
                        }
                        _ => break, // Fin du flux ou erreur
                    }
                }
            }
        }

        // Nettoyage une fois terminé
        state_tokens.lock().unwrap().remove(&download_id_clone);
    });

    Ok(())
}




#[tauri::command]
pub async fn cancel_download(
    state: State<'_, DownloadState>,
    download_id: String,
) -> Result<(), String> {
    let mut tokens = state.cancel_tokens.lock().unwrap();
    if let Some(token) = tokens.remove(&download_id) {
        token.cancel(); // Déclenche l'annulation et la suppression du fichier dans le thread
    }
    Ok(())
}













#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VmInfo {
    pub name: String,
    pub os_id: Option<String>,
    pub state: String,
    pub vcpus: u32,
    pub memory_mb: u32,
    pub disk_gb: u32,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct VmMetadata {
    os_id: Option<String>,
}

#[tauri::command]
pub async fn list_vms(storage_path: String) -> Result<Vec<VmInfo>, String> {
    let root = Path::new(&storage_path);
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut vms = Vec::new();

    let entries = fs::read_dir(root)
        .map_err(|e| format!("Impossible de lire le dossier des VMs : {}", e))?;

    for entry in entries.flatten().filter(|entry| entry.path().is_dir()) {
        let name = entry.file_name().to_string_lossy().to_string();
        let vm_path = entry.path();
        let config_path = vm_path.join(format!("{}.conf", name));
        let os_id = fs::read_to_string(vm_path.join("snakeden.json"))
            .ok()
            .and_then(|metadata| serde_json::from_str::<VmMetadata>(&metadata).ok())
            .and_then(|metadata| metadata.os_id);
        let (vcpus, memory_mb) = vm_resources(&config_path);
        let state_text = if process_running(&config_path) { "running" } else { "shut off" };

        // 2. Inspection du fichier disque qcow2 pour avoir la taille
        let disk_path = entry.path().join(format!("{}.qcow2", name));
        let mut disk_gb = 10; // valeur par défaut

        let qemu_img = Command::new("qemu-img")
            .args(["info", disk_path.to_string_lossy().as_ref()])
            .output();

        if let Ok(img_out) = qemu_img {
            let img_str = String::from_utf8_lossy(&img_out.stdout);
            for line in img_str.lines() {
                if line.starts_with("virtual size:") {
                    // Exemple de ligne: "virtual size: 20 GiB (21474836480 bytes)"
                    if let Some(size_str) = line.split('(').nth(1) {
                        if let Some(bytes_str) = size_str.split_whitespace().next() {
                            if let Ok(bytes) = bytes_str.parse::<u64>() {
                                disk_gb = (bytes / (1024 * 1024 * 1024)) as u32;
                            }
                        }
                    }
                }
            }
        }

        vms.push(VmInfo {
            name,
            os_id,
            state: state_text.to_string(),
            vcpus,
            memory_mb,
            disk_gb,
        });
    }

    Ok(vms)
}







// 2. Démarrer une VM
#[tauri::command]
pub async fn start_vm(state: State<'_, QuickemuState>, name: String, storage_path: String) -> Result<(), String> {
    let config_path = vm_directory(&storage_path, &name)?.join(format!("{}.conf", name));
    if !config_path.exists() {
        return Err(format!("Configuration Quickemu absente : {}", config_path.display()));
    }
    migrate_legacy_memory_setting(&config_path)?;
    start_process(&state, name, config_path.to_string_lossy().to_string())
}





// 3. Arrêter proprement une VM
#[tauri::command]
pub fn stop_vm(state: State<'_, QuickemuState>, name: String, storage_path: String) -> Result<(), String> {
    let config_path = vm_directory(&storage_path, &name)?.join(format!("{}.conf", name));
    stop_process(&state, &name, &config_path)
}

// 4. Forcer l'arrêt de la VM
#[tauri::command]
pub fn force_stop_vm(state: State<'_, QuickemuState>, name: String, storage_path: String) -> Result<(), String> {
    let config_path = vm_directory(&storage_path, &name)?.join(format!("{}.conf", name));
    stop_process(&state, &name, &config_path)
}







// 5. Supprimer une VM
#[tauri::command]
pub async fn delete_vm(state: State<'_, QuickemuState>, name: String, storage_path: String) -> Result<(), String> {
    let vm_path = vm_directory(&storage_path, &name)?;
    let config_path = vm_path.join(format!("{}.conf", name));
    stop_process(&state, &name, &config_path)?;
    // Le dossier contient le disque, l'ISO et la configuration Quickemu.
    if vm_path.exists() {
        fs::remove_dir_all(&vm_path)
            .map_err(|e| format!("VM désinscrite mais échec de suppression du dossier : {}", e))?;
    }

    Ok(())
}












#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VmConfig {
    pub name: String,
    pub os_id: Option<String>,
    pub vcpus: u32,
    pub memory_mb: u32,
    pub disk_gb: u32,
    pub iso_path: Option<String>,
    pub edition: String,
    pub storage_path: String,
}

#[tauri::command]
pub async fn create_vm(state: State<'_, QuickemuState>, config: VmConfig) -> Result<(), String> {
    let vm_path = vm_directory(&config.storage_path, &config.name)?;
    fs::create_dir_all(&vm_path)
        .map_err(|e| format!("Impossible de créer le dossier de la VM : {}", e))?;
    let disk_path = vm_path.join(format!("{}.qcow2", config.name));

    // 1. Création de l'image disque qcow2
    let disk_status = Command::new("qemu-img")
        .args([
            "create",
            "-f",
            "qcow2",
            disk_path.to_string_lossy().as_ref(),
            &format!("{}G", config.disk_gb),
        ])
        .output()
        .map_err(|e| format!("Échec du lancement de qemu-img : {}", e))?;

    if !disk_status.status.success() {
        let stderr = String::from_utf8_lossy(&disk_status.stderr);
        return Err(format!("Erreur lors de la création du disque (qemu-img) : {}", stderr));
    }

    let quickemu_config = format!(
        "guest_os=\"linux\"\ndisk_img=\"{}\"\niso=\"{}\"\nram=\"{}M\"\ncpu_cores=\"{}\"\nwidth=\"1024\"\nheight=\"600\"\n",
        disk_path.to_string_lossy(),
        config.iso_path.as_deref().unwrap_or(""),
        config.memory_mb,
        config.vcpus
    );
    fs::write(vm_path.join(format!("{}.conf", config.name)), quickemu_config)
        .map_err(|e| format!("Impossible d'écrire la configuration Quickemu : {}", e))?;

    let metadata_json = serde_json::to_vec(&VmMetadata { os_id: config.os_id })
        .map_err(|e| format!("Impossible de sérialiser les métadonnées de la VM : {}", e))?;
    fs::write(vm_path.join("snakeden.json"), metadata_json)
        .map_err(|e| format!("Impossible d'écrire les métadonnées de la VM : {}", e))?;

    start_process(
        &state,
        config.name.clone(),
        vm_path.join(format!("{}.conf", config.name)).to_string_lossy().to_string(),
    )?;

    Ok(())
}





#[tauri::command]
pub fn check_iso_exists(file_path: String) -> bool {
    Path::new(&file_path).exists()
}
