use regex::Regex;
use serde::Serialize;
use std::io::{BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::fs::OpenOptions;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct QuickemuState {
    pub processes: Arc<Mutex<std::collections::HashMap<String, std::process::Child>>>,
    quickget_processes: Arc<Mutex<std::collections::HashMap<String, (u32, std::path::PathBuf)>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct QuickgetProgress {
    download_id: String,
    downloaded_bytes: u64,
    total_bytes: u64,
    percentage: f64,
}

fn emit_progress(app: &AppHandle, download_id: &str, percentage: f64) {
    let _ = app.emit(
        "download-progress",
        QuickgetProgress {
            download_id: download_id.to_string(),
            downloaded_bytes: 0,
            total_bytes: 0,
            percentage,
        },
    );
}

fn find_iso_in_tree(path: &Path) -> Option<String> {
    let entries = std::fs::read_dir(path).ok()?;
    for entry in entries.flatten() {
        let entry_path = entry.path();
        if entry_path.is_dir() {
            if let Some(iso_path) = find_iso_in_tree(&entry_path) {
                return Some(iso_path);
            }
            continue;
        }

        if entry_path.extension().is_some_and(|extension| extension == "iso") {
            return Some(entry_path.to_string_lossy().to_string());
        }

    }
    None
}

fn quickget_directory(storage_path: &str, os: &str, release: &str, option: Option<&str>) -> std::path::PathBuf {
    let folder_name = match option.filter(|value| !value.is_empty()) {
        Some(edition) => format!("{}-{}-{}", os, release, edition),
        None => format!("{}-{}", os, release),
    }
        .chars()
        .map(|character| if character == '/' || character == '\\' || character.is_whitespace() { '_' } else { character })
        .collect::<String>();
    Path::new(storage_path).join(folder_name)
}

fn read_quickget_output<R: Read>(mut reader: R, sender: &std::sync::mpsc::Sender<f64>, regex: &Regex) {
    let mut buffer = [0u8; 256];
    let mut line = String::new();

    while let Ok(bytes_read) = reader.read(&mut buffer) {
        if bytes_read == 0 {
            break;
        }

        for byte in &buffer[..bytes_read] {
            if *byte == b'\r' || *byte == b'\n' {
                if let Some(capture) = regex.captures(&line) {
                    if let Ok(percentage) = capture[1].parse::<f64>() {
                        let _ = sender.send(percentage.clamp(0.0, 100.0));
                    }
                }
                line.clear();
            } else {
                line.push(*byte as char);
            }
        }
    }

    if let Some(capture) = regex.captures(&line) {
                if let Ok(percentage) = capture[1].parse::<f64>() {
                    let _ = sender.send(percentage.clamp(0.0, 100.0));
                }
            }
}

#[tauri::command]
pub async fn quickget_download(
    app_handle: AppHandle,
    state: State<'_, QuickemuState>,
    download_id: String,
    os: String,
    release: String,
    option: Option<String>,
    storage_path: String,
) -> Result<String, String> {
    let quickget_processes = state.quickget_processes.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&storage_path)
            .map_err(|e| format!("Impossible de créer le dossier ISO : {}", e))?;

        let mut quickget = Command::new("quickget");
        quickget.args([&os, &release]);
        if let Some(option) = option.as_deref().filter(|value| !value.is_empty()) {
            quickget.arg(option);
        }
        let iso_directory = quickget_directory(&storage_path, &os, &release, option.as_deref());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            quickget.process_group(0);
        }
        let mut child = quickget
            .current_dir(&storage_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Impossible de lancer quickget : {}", e))?;
        quickget_processes.lock().unwrap().insert(
            download_id.clone(),
            (child.id(), iso_directory.clone()),
        );

        let stdout = child.stdout.take().ok_or("stdout quickget indisponible")?;
        let stderr = child.stderr.take().ok_or("stderr quickget indisponible")?;
        let (sender, receiver) = std::sync::mpsc::channel();
        let regex = Regex::new(r"(\d+(?:\.\d+)?)\s*%").map_err(|e| e.to_string())?;

        let stdout_sender = sender.clone();
        let stdout_regex = regex.clone();
        std::thread::spawn(move || {
            read_quickget_output(BufReader::new(stdout), &stdout_sender, &stdout_regex);
        });
        let stderr_sender = sender;
        std::thread::spawn(move || {
            read_quickget_output(BufReader::new(stderr), &stderr_sender, &regex);
        });

        for percentage in receiver {
            emit_progress(&app_handle, &download_id, percentage);
        }

        let status = child.wait().map_err(|e| format!("Erreur quickget : {}", e))?;
        let was_cancelled = quickget_processes
            .lock()
            .unwrap()
            .remove(&download_id)
            .is_none();
        if was_cancelled || !status.success() {
            let _ = std::fs::remove_dir_all(&iso_directory);
        }
        if was_cancelled {
            return Err("Téléchargement annulé; les fichiers temporaires ont été supprimés.".to_string());
        }
        if !status.success() {
            return Err(format!(
                "quickget a échoué (code {:?}) pour {} {}",
                status.code(), os, release
            ));
        }

        emit_progress(&app_handle, &download_id, 100.0);
        find_iso_in_tree(&iso_directory)
            .ok_or_else(|| format!("quickget a terminé sans créer d'ISO dans {}", iso_directory.display()))
    })
    .await
    .map_err(|e| format!("Tâche quickget interrompue : {}", e))?
}

#[tauri::command]
pub async fn download_iso_only(
    app_handle: AppHandle,
    state: State<'_, QuickemuState>,
    download_id: String,
    os: String,
    release: String,
    option: Option<String>,
    vm_storage_path: String,
    downloads_path: String,
) -> Result<String, String> {
    let temporary_vm = Path::new(&vm_storage_path).join(format!(".snakeden-download-{}", download_id));
    let iso_path = match quickget_download(
        app_handle,
        state,
        download_id,
        os,
        release,
        option,
        temporary_vm.to_string_lossy().to_string(),
    )
    .await
    {
        Ok(path) => path,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&temporary_vm);
            return Err(error);
        }
    };

    std::fs::create_dir_all(&downloads_path)
        .map_err(|e| format!("Impossible de créer le dossier des téléchargements : {}", e))?;
    let source = Path::new(&iso_path);
    let destination = Path::new(&downloads_path).join(
        source.file_name().ok_or("Nom d'ISO invalide")?,
    );
    std::fs::copy(source, &destination)
        .map_err(|e| format!("Impossible de copier l'ISO dans downloads : {}", e))?;
    std::fs::remove_dir_all(&temporary_vm)
        .map_err(|e| format!("ISO copiée mais nettoyage impossible : {}", e))?;
    Ok(destination.to_string_lossy().to_string())
}

#[tauri::command]
pub fn cancel_quickget_download(
    state: State<'_, QuickemuState>,
    download_id: String,
) -> Result<(), String> {
    let (pid, _) = state
        .quickget_processes
        .lock()
        .unwrap()
        .remove(&download_id)
        .ok_or_else(|| format!("Aucun téléchargement Quickget actif pour {}", download_id))?;

    #[cfg(unix)]
    unsafe {
        let process_group = -(pid as libc::pid_t);
        if libc::kill(process_group, libc::SIGTERM) != 0 {
            return Err(format!("Impossible d'arrêter Quickget pour {}", download_id));
        }
    }

    #[cfg(not(unix))]
    return Err("L'annulation de Quickget n'est disponible que sous Unix.".to_string());

    #[cfg(unix)]
    Ok(())
}

#[tauri::command]
pub fn ensure_hero_banner(app_handle: AppHandle) -> Result<String, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Impossible de déterminer le dossier applicatif : {}", e))?;
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Impossible de créer le dossier applicatif : {}", e))?;

    let banner_path = app_data_dir.join("hero-snake.png");
    if !banner_path.exists() {
        const HERO_BANNER: &[u8] = include_bytes!("../../../public/hero-snake.png");
        std::fs::write(&banner_path, HERO_BANNER)
            .map_err(|e| format!("Impossible d'installer la bannière SnakeDen : {}", e))?;
    }

    Ok(banner_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn ensure_os_icon(
    app_handle: AppHandle,
    os_id: String,
    icon_url: Option<String>,
) -> Result<String, String> {
    let icon_directory = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Impossible de déterminer le dossier applicatif : {}", e))?
        .join("OS_ICONS");
    std::fs::create_dir_all(&icon_directory)
        .map_err(|e| format!("Impossible de créer le dossier des icônes : {}", e))?;
    let icon_path = icon_directory.join(format!("{}.png", os_id));
    if icon_path.exists() {
        return Ok(icon_path.to_string_lossy().to_string());
    }

    let url = icon_url.ok_or_else(|| format!("Aucune URL d'icône pour {}", os_id))?;
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Erreur de téléchargement de l'icône {} : {}", os_id, e))?;
    if !response.status().is_success() {
        return Err(format!("Erreur HTTP {} pour l'icône {}", response.status(), os_id));
    }

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let path = Path::new(&icon_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, &bytes)
        .map_err(|e| format!("Impossible d'écrire l'icône : {}", e))?;
    Ok(icon_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn start_process(state: &QuickemuState, vm_id: String, config_path: String) -> Result<(), String> {
    let config_file = Path::new(&config_path);
    if process_running(config_file) {
        return Err(format!("La VM {} est déjà lancée", vm_id));
    }

    let mut processes = state.processes.lock().unwrap();
    if let Some(process) = processes.get_mut(&vm_id) {
        if process.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Err(format!("La VM {} est déjà lancée", vm_id));
        }
        processes.remove(&vm_id);
    }

    let log_path = Path::new(&config_path)
        .parent()
        .unwrap_or(Path::new("."))
        .join("quickemu.log");
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Impossible d'ouvrir le journal Quickemu : {}", e))?;
    let error_log = log_file
        .try_clone()
        .map_err(|e| format!("Impossible de préparer le journal Quickemu : {}", e))?;

    let child = Command::new("quickemu")
        .args(["--vm", &config_path])
        .current_dir(Path::new(&config_path).parent().unwrap_or(Path::new(".")))
        .stdout(log_file)
        .stderr(error_log)
        .spawn()
        .map_err(|e| format!("Impossible de lancer quickemu : {}. Journal : {}", e, log_path.display()))?;

    processes.insert(vm_id, child);
    Ok(())
}

pub fn stop_process(state: &QuickemuState, vm_id: &str, config_path: &Path) -> Result<(), String> {
    if process_running(config_path) {
        let output = Command::new("quickemu")
            .args(["--vm", config_path.to_string_lossy().as_ref(), "--kill"])
            .output()
            .map_err(|e| format!("Impossible de demander l'arrêt de {} à Quickemu : {}", vm_id, e))?;

        if !output.status.success() {
            return Err(format!(
                "Quickemu n'a pas pu arrêter {} : {}",
                vm_id,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }

    if let Some(mut child) = state.processes.lock().unwrap().remove(vm_id) {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    Ok(())
}

pub fn process_running(config_path: &Path) -> bool {
    #[cfg(unix)]
    {
        let Some(vm_name) = config_path.file_stem().and_then(|name| name.to_str()) else {
            return false;
        };
        let pid_path = config_path
            .parent()
            .unwrap_or(Path::new("."))
            .join(format!("{}.pid", vm_name));
        let Ok(pid) = std::fs::read_to_string(pid_path).map(|pid| pid.trim().parse::<libc::pid_t>()) else {
            return false;
        };
        let Ok(pid) = pid else {
            return false;
        };

        let proc_path = Path::new("/proc").join(pid.to_string());
        if !proc_path.exists() {
            return false;
        }
        let cmdline = std::fs::read(proc_path.join("cmdline")).unwrap_or_default();
        let cmdline = String::from_utf8_lossy(&cmdline);
        cmdline.contains(&format!("process={}", vm_name))
    }

    #[cfg(not(unix))]
    {
        let _ = config_path;
        false
    }
}

#[tauri::command]
pub fn start_quickemu(state: State<'_, QuickemuState>, vm_id: String, config_path: String) -> Result<(), String> {
    start_process(&state, vm_id, config_path)
}

#[tauri::command]
pub fn stop_quickemu(
    state: State<'_, QuickemuState>,
    vm_id: String,
    config_path: String,
) -> Result<(), String> {
    stop_process(&state, &vm_id, Path::new(&config_path))
}


/*
pub fn launch_quick_console() {
    let result = Command::new("x-terminal-emulator")
        .args([
            "--title",
            "SnakeDen Quick Console",
            "-e",
            "bash",
            "-lc",
            "printf '\\nSnakeDen Quick Console\\n'; printf 'quickget et quickemu sont disponibles ici.\\n\\n'; exec bash -i",
        ])
        .spawn();

    if let Err(error) = result {
        eprintln!("Console Quickemu non lancée : {}", error);
    }
}
*/
