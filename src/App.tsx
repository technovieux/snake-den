import OS_LIST from "./OS_LIST.json";
import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Home, Store, Monitor, Download, Settings, Play, Square,
  ChevronRight, RefreshCw, X, CheckCircle2, AlertTriangle, Pencil, Trash2, Plus
} from "lucide-react";

async function testPing() {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      const message = await invoke<string>("ping", { name: "SnakeDen" });
      console.log("ok", message);
    } catch (error) {
      console.log("error", String(error));
    }
  } else {
    console.warn("Tauri n'est pas détecté. Lance l'application avec 'npm run tauri dev'.");
    console.log("error", "Environnement Tauri non détecté (navigateur web).");
  }
}

type VM = {
  name: string;
  osId?: string;
  state: string;
  memoryMb: number;
  vcpus: number;
  diskGb: number;
};

type OsVersion = {
  release: string;
  options: string[];
};

type Os = {
  id: string;
  name: string;
  category: string;
  releases: OsVersion[];
  description?: string;
  icon: string;
  iconUrl?: string;
  recommended_memory?: number;
  recommended_vcpus?: number;
};

type DownloadItem = {
  id: string;
  name: string;
  progress: number;
  status: "pending" | "downloading" | "completed" | "error";
  error?: string;
};

type ProgressPayload = {
  downloadId: string;
  downloadedBytes: number;
  totalBytes: number;
  percentage: number;
};

const os_list = OS_LIST as Os[];
const heroSnake = "./hero-snake.png";

function App() {
  const [page, setPage] = useState<"home" | "store" | "vms" | "downloads" | "settings">("home");
  const [vms, setVms] = useState<VM[]>([]);
  const [selectedOs, setSelectedOs] = useState<Os | null>(null);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [showCreateVMModal, setShowCreateVMModal] = useState(false);
  const [selectedVmForEdit, setSelectedVmForEdit] = useState<VmInfo | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [toast, setToast] = useState<{type: "ok"|"error", text: string} | null>(null);
  const [loading, setLoading] = useState(false);
  const [isoStoragePath, setIsoStoragePath] = useState("");
  const [vmStoragePath, setVmStoragePath] = useState("/var/lib/snakeden/images");
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState("Tous");
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [heroBannerSrc, setHeroBannerSrc] = useState<string | null>(null);

  async function refreshVMs() {
    try {
      const result = await invoke<VM[]>("list_vms", { storagePath: vmStoragePath });
      setVms(result);
    } catch (e) {
      console.log("error", String(e));
    }
  }

  useEffect(() => {
    refreshVMs();
    void invoke<string>("ensure_hero_banner")
      .then((path) => setHeroBannerSrc(convertFileSrc(path)))
      .catch((error) => console.error("Bannière SnakeDen indisponible :", error));
    void invoke<string>("user_downloads_path")
      .then(setIsoStoragePath)
      .catch((error) => console.error("Dossier Downloads introuvable :", error));

    const unlistenPromise = listen<ProgressPayload>("download-progress", (event) => {
      console.log("Événement reçu dans React:", event.payload);
      const { downloadId, percentage } = event.payload;

      setDownloads((prevDownloads) =>
        prevDownloads.map((dl) => {
          if (dl.id === downloadId) {
            return {
              ...dl,
              progress: percentage,
              status: percentage >= 100 ? "completed" : "downloading",
            };
          }
          return dl;
        })
      );
    });
    const vmRefreshTimer = setInterval(() => void refreshVMs(), 3000);

    return () => {
      clearInterval(vmRefreshTimer);
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [vmStoragePath]);

  function showToast(type: "ok"|"error", text: string) {
    setToast({ type, text });
    setTimeout(() => setToast(null), 4500);
  }

  async function startVM(name: string) {
    setLoading(true);
    try {
      await invoke("start_vm", { name, storagePath: vmStoragePath });
      showToast("ok", `${name} démarre.`);
      await refreshVMs();
    } catch (e) { showToast("error", String(e)); }
    finally { setLoading(false); }
  }

  async function stopVM(name: string) {
    setLoading(true);
    try {
      await invoke("stop_vm", { name, storagePath: vmStoragePath });
      showToast("ok", `${name} est arrêté.`);
      await refreshVMs();
    } catch (e) { showToast("error", String(e)); }
    finally { setLoading(false); }
  }

  async function deleteVM(name: string) {
    setLoading(true);
    try {
      await invoke("delete_vm", { name, storagePath: vmStoragePath });
      showToast("ok", `Machine ${name} supprimée.`);
      await refreshVMs();
    } catch (e) { showToast("error", String(e)); }
    finally { setLoading(false); }
  }

  async function handleStartDownload(
    osId: string,
    osName: string,
    version: string,
    storagePath = isoStoragePath,
    edition = ""
  ) {
    const downloadId = `dl-${Date.now()}`;

    setDownloads((prev) => [
      ...prev,
      { id: downloadId, name: `${osName} (${version})`, progress: 0, status: "pending" },
    ]);

    setPage("downloads");

    try {
      const downloadedIsoPath = await invoke<string>("quickget_download", {
        downloadId,
        os: osId,
        release: version,
        option: edition || null,
        storagePath,
      });

      setDownloads((prev) =>
        prev.map((dl) =>
          dl.id === downloadId ? { ...dl, progress: 100, status: "completed" } : dl
        )
      );
      showToast("ok", `Téléchargement de ${osName} terminé !`);
      return downloadedIsoPath;
    } catch (err) {
      setDownloads((prev) =>
        prev.map((dl) =>
          dl.id === downloadId ? { ...dl, status: "error", error: String(err) } : dl
        )
      );
      showToast("error", `Erreur téléchargement : ${err}`);
      throw err;
    }
  }

  async function handleCancelDownload(downloadId: string) {
    try {
      await invoke("cancel_quickget_download", { downloadId });
      setDownloads((prev) => prev.filter((dl) => dl.id !== downloadId));
      showToast("ok", "Téléchargement annulé et fichier supprimé.");
    } catch (err) {
      showToast("error", `Erreur d'annulation : ${err}`);
    }
  }

  const categories = ["Tous", "Linux", "Windows", "BSD", "Server"];

  const filteredOsList = os_list.filter((os) => {
    if (selectedCategory === "Tous") return true;
    return os.category.toLowerCase() === selectedCategory.toLowerCase();
  });

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand" onClick={() => setPage("home")}>
          <div className="snake-mark">
            <img src="/snakeden-logo.png" alt="SnakeDen" />
          </div>
          <div><strong>SnakeDen</strong></div>
        </div>

        <nav>
          <NavButton icon={<Home/>} label="Accueil" active={page==="home"} onClick={()=>setPage("home")}/>
          <NavButton icon={<Store/>} label="Découvrir" active={page==="store"} onClick={()=>setPage("store")}/>
          <NavButton icon={<Monitor/>} label="Mes VMs" active={page==="vms"} onClick={()=>setPage("vms")}/>
          <NavButton icon={<Download/>} label="Téléchargements" active={page==="downloads"} onClick={()=>setPage("downloads")}/>
        </nav>

        <div className="sidebar-bottom">
          <NavButton icon={<Settings/>} label="Paramètres" active={page==="settings"} onClick={()=>setPage("settings")}/>
        </div>
      </aside>

      <main>
        <header>
          <div>
            <span className="eyebrow">SNAKEDEN</span>
            <h1>{page === "home" ? "Votre tanière" : page === "store" ? "Découvrir des OS" : page === "vms" ? "Mes machines" : page === "downloads" ? "Téléchargements" : "Paramètres"}</h1>
          </div>
          <button className="icon-button" onClick={refreshVMs} title="Actualiser"><RefreshCw size={18}/></button>
        </header>

        {page === "home" && (
          <div className="content">
            <section className="hero">
              <img className="hero-image" src={heroBannerSrc || heroSnake} alt="" />
              <div className="hero-copy">
                <h2>Vos systèmes.<br/><em>Une seule tanière.</em></h2>
                <p>Installez et lancez vos systèmes d'exploitation comme des applications.</p>
                <button className="primary" onClick={()=>setPage("store")}>Explorer les OS <ChevronRight size={18}/></button>
              </div>
            </section>

            <SectionTitle title="Vos machines" action="Voir tout" onClick={()=>setPage("vms")}/>
            {vms.length === 0 ? (
              <EmptyVM onClick={() => setPage("store")} />
            ) : (
              <div className="vm-grid">
                {vms.slice(0, 4).map((vm) => (
                  <VMCard
                    key={vm.name}
                    vm={vm}
                    onStart={startVM}
                    onStop={stopVM}
                    onEdit={(targetVm) => {
                      setSelectedVmForEdit(targetVm);
                      setShowEditModal(true);
                    }}
                    onDelete={deleteVM}
                    loading={loading}
                  />
                ))}
              </div>
            )}
            <SectionTitle title="Recommandé pour vous" action="Tout voir" onClick={()=>setPage("store")}/>
            <div className="os-grid">
              {os_list.map(os => (
                <OSCard
                  key={os.id}
                  os={os}
                  onDownload={() => { setSelectedOs(os); setShowDownloadModal(true); }}
                  onCreateVM={() => { setSelectedOs(os); setShowCreateVMModal(true); }}
                />
              ))}
            </div>
          </div>
        )}

        {page === "store" && (
          <div className="content">
            <div className="section-intro">
              <p>Choisissez un système et téléchargez son ISO ou créez une machine virtuelle.</p>
            </div>
            
            <div className="category-row">
              {categories.map((cat) => (
                <span
                  key={cat}
                  className={`category ${selectedCategory === cat ? "active" : ""}`}
                  onClick={() => setSelectedCategory(cat)}
                  style={{ cursor: "pointer" }}
                >
                  {cat}
                </span>
              ))}
            </div>

            <div className="os-grid large">
              {filteredOsList.length > 0 ? (
                filteredOsList.map((os) => (
                  <OSCard
                    key={os.id}
                    os={os}
                    onDownload={() => { setSelectedOs(os); setShowDownloadModal(true); }}
                    onCreateVM={() => { setSelectedOs(os); setShowCreateVMModal(true); }}
                  />
                ))
              ) : (
                <p className="muted">Aucun système d'exploitation trouvé dans cette catégorie.</p>
              )}
            </div>
          </div>
        )}

        {page === "vms" && (
          <div className="content">
            <div className="toolbar">
              <p>{vms.length} machine{vms.length > 1 ? "s" : ""}</p>
              <button className="primary small" onClick={() => setPage("store")}>
                <Plus size={17}/> Nouvelle VM
              </button>
            </div>

            {vms.length === 0 ? (
              <EmptyVM onClick={() => setPage("store")} />
            ) : (
              <div className="vm-grid large">
                {vms.map((vm) => (
                  <VMCard
                    key={vm.name}
                    vm={vm}
                    onStart={startVM}
                    onStop={stopVM}
                    onEdit={(targetVm) => {
                      setSelectedVmForEdit(targetVm);
                      setShowEditModal(true);
                    }}
                    onDelete={deleteVM}
                    loading={loading}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {page === "downloads" && (
          <div className="content">
            <div className="section-intro">
              <h2>Centre de téléchargements</h2>
              <p>Suivi des fichiers ISO en cours de récupération.</p>
            </div>

            {downloads.length === 0 ? (
              <div className="download-panel">
                <Download size={28}/>
                <p>Aucun téléchargement en cours.</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {downloads.map((dl) => (
                  <div key={dl.id} className="settings-card" style={{ flexDirection: "column", alignItems: "stretch", gap: "8px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <strong>{dl.name}</strong>
                      <span style={{ fontSize: "0.85em", opacity: 0.8 }}>
                        {dl.status === "pending" && "Démarrage..."}
                        {dl.status === "downloading" && `${dl.progress}%`}
                        {dl.status === "completed" && "Terminé"}
                        {dl.status === "error" && "Échec"}
                      </span>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                      <div style={{ flex: 1, height: "8px", backgroundColor: "rgba(255,255,255,0.1)", borderRadius: "4px", overflow: "hidden" }}>
                        <div
                          style={{
                            width: `${dl.progress}%`,
                            height: "100%",
                            backgroundColor: dl.status === "error" ? "#e74c3c" : "#3498db",
                            transition: "width 0.2s ease-in-out",
                          }}
                        />
                      </div>

                      {dl.status !== "completed" && (
                        <button className="icon-button" onClick={() => handleCancelDownload(dl.id)}
                          title="Arrêter et supprimer le fichier"
                          style={{
                            background: "rgba(231, 76, 60, 0.2)",
                            border: "1px solid #e74c3c",
                            color: "#e74c3c",
                            padding: "6px",
                            borderRadius: "6px",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center"
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>

                    {dl.error && (
                      <p style={{ color: "#e74c3c", fontSize: "0.8em", margin: 0 }}>
                        {dl.error}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {page === "settings" && (
          <div className="content">
            <div className="settings-card">
              <div><h3>Moteur de virtualisation</h3><p>Backend utilisé par SnakeDen.</p></div>
              <span className="setting-value">Quickemu / QEMU / KVM</span>
            </div>

            <div className="settings-card">
              <div>
                <h3>Stockage des isos</h3>
                <p>Emplacement des images disques.</p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                {isEditingPath ? (
                  <input
                    type="text"
                    value={isoStoragePath}
                    onChange={(e) => setIsoStoragePath(e.target.value)}
                    onBlur={() => setIsEditingPath(false)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setIsEditingPath(false);
                    }}
                    autoFocus
                    style={{
                      background: "var(--bg-input, #1e1e2e)",
                      border: "1px solid var(--border, #333)",
                      color: "inherit",
                      padding: "4px 8px",
                      borderRadius: "4px"
                    }}
                  />
                ) : (
                  <span className="setting-value">{isoStoragePath}</span>
                )}
                <button
                  className="icon-button"
                  onClick={() => setIsEditingPath(!isEditingPath)}
                  title="Modifier le chemin"
                  style={{ background: "none", border: "none", cursor: "pointer" }}
                >
                  <Pencil size={16} />
                </button>
              </div>
            </div>

            <div className="settings-card">
              <div>
                <h3>Stockage des machines virtuelles</h3>
                <p>Emplacement des disques des machines virtuelles.</p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                {isEditingPath ? (
                  <input
                    type="text"
                    value={vmStoragePath}
                    onChange={(e) => setVmStoragePath(e.target.value)}
                    onBlur={() => setIsEditingPath(false)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setIsEditingPath(false);
                    }}
                    autoFocus
                    style={{
                      background: "var(--bg-input, #1e1e2e)",
                      border: "1px solid var(--border, #333)",
                      color: "inherit",
                      padding: "4px 8px",
                      borderRadius: "4px"
                    }}
                  />
                ) : (
                  <span className="setting-value">{vmStoragePath}</span>
                )}
                <button
                  className="icon-button"
                  onClick={() => setIsEditingPath(!isEditingPath)}
                  title="Modifier le chemin"
                  style={{ background: "none", border: "none", cursor: "pointer" }}
                >
                  <Pencil size={16} />
                </button>
              </div>
            </div>

            <div className="settings-card">
              <div><h3>Dossiers partagés</h3><p>La gestion virtiofs sera ajoutée dans la prochaine itération.</p></div>
              <span className="setting-value muted">MVP à venir</span>
            </div>
          </div>
        )}
      </main>

      {/* Modale Téléchargement ISO */}
      {showDownloadModal && selectedOs && (
        <DownloadISOModal 
          os={selectedOs} 
          onClose={() => setShowDownloadModal(false)}
          onDownload={(version, edition) => {
            setShowDownloadModal(false);
            const downloadId = `dl-${Date.now()}`;
            setDownloads((prev) => [
              ...prev,
              { id: downloadId, name: `${selectedOs.name} (${version})`, progress: 0, status: "pending" },
            ]);
            setPage("downloads");
            void invoke<string>("download_iso_only", {
              downloadId,
              os: selectedOs.id,
              release: version,
              option: edition || null,
              vmStoragePath,
              downloadsPath: isoStoragePath,
            }).then(() => {
              setDownloads((prev) => prev.map((dl) => dl.id === downloadId ? { ...dl, progress: 100, status: "completed" } : dl));
              showToast("ok", `Téléchargement de ${selectedOs.name} terminé !`);
            }).catch((error) => {
              setDownloads((prev) => prev.map((dl) => dl.id === downloadId ? { ...dl, status: "error", error: String(error) } : dl));
              showToast("error", `Erreur téléchargement : ${error}`);
            });
          }}
        />
      )}

      {/* Modale Création VM */}
      {showCreateVMModal && selectedOs && (
        <CreateVMModal
          os={selectedOs}
          onClose={() => setShowCreateVMModal(false)}
          onCreate={async (config) => {
            setShowCreateVMModal(false);

                      const vmDirectory = `${vmStoragePath}/${config.name}`;
                      let expectedIsoPath = "";

            try {
              showToast("ok", `Vérification de l'ISO ${selectedOs.name}...`);
              expectedIsoPath = await handleStartDownload(
                selectedOs.id,
                selectedOs.name,
                config.isoVersion,
                vmDirectory,
                config.edition
              );

              showToast("ok", `Création de la VM ${config.name}...`);
              await invoke("create_vm", {
                config: {
                  name: config.name,
                  osId: selectedOs.id,
                  vcpus: config.vcpus,
                  memoryMb: config.memoryMb,
                  diskGb: config.diskGb,
                  isoPath: expectedIsoPath,
                  edition: config.edition,
                  storagePath: vmStoragePath,
                },
              });

              showToast("ok", `Machine virtuelle ${config.name} créée avec succès !`);
              refreshVMs();
            } catch (err) {
              showToast("error", `Échec du processus : ${err}`);
            }
          }}
        />
      )}

      {/* Modale Édition VM */}
      {showEditModal && selectedVmForEdit && (
        <EditVMModal
          vm={selectedVmForEdit}
          onClose={() => setShowEditModal(false)}
          onSave={async (updatedConfig) => {
            setShowEditModal(false);
            setLoading(true);
            try {
              await invoke("update_vm_config", { config: updatedConfig });
              showToast("ok", `VM ${updatedConfig.name} mise à jour.`);
              await refreshVMs();
            } catch (err) {
              showToast("error", `Erreur lors de la modification : ${err}`);
            } finally {
              setLoading(false);
            }
          }}
        />
      )}

      {toast && <div className={`toast ${toast.type}`}>{toast.type==="ok" ? <CheckCircle2/> : <AlertTriangle/>}<span>{toast.text}</span><button onClick={()=>setToast(null)}><X size={15}/></button></div>}
    </div>
  );
}

function NavButton({icon,label,active,onClick}:{icon:React.ReactNode,label:string,active:boolean,onClick:()=>void}) {
  return <button className={`nav-button ${active?"active":""}`} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function SectionTitle({title,action,onClick}:{title:string,action:string,onClick:()=>void}) {
  return <div className="section-title"><h3>{title}</h3><button onClick={onClick}>{action}<ChevronRight size={15}/></button></div>;
}

function EmptyVM({onClick}:{onClick:()=>void}) {
  return <div className="empty"><div className="empty-icon"><Monitor size={28}/></div><h2>Votre tanière est vide</h2><p>Installez votre premier système d'exploitation pour commencer.</p><button className="primary" onClick={onClick}>Découvrir les OS</button></div>;
}

function OSCard({os, onDownload, onCreateVM}:{os:Os, onDownload:()=>void, onCreateVM:()=>void}) {
  return (
    <article className="os-card">
      <div className={`os-icon ${os.id}`}>
        <img className="os-icon-img" src={os.icon} alt={os.name} />
      </div>
      <div className="card-body">
        <div className="card-title"><h3>{os.name}</h3></div>
        <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
          <button className="secondary" onClick={onDownload} style={{ flex: 1, padding: "6px 8px", fontSize: "0.85em" }}>
            <Download size={14} /> ISO
          </button>
          <button className="primary" onClick={onCreateVM} style={{ flex: 1, padding: "6px 8px", fontSize: "0.85em" }}>
            <Plus size={14} /> Créer VM
          </button>
        </div>
      </div>
    </article>
  );
}

export interface VmInfo {
  name: string;
  osId?: string;
  state: string;
  vcpus: number;
  memoryMb: number;
  diskGb: number;
}

interface VMCardProps {
  vm: VmInfo;
  onStart: (name: string) => void;
  onStop: (name: string) => void;
  onEdit: (vm: VmInfo) => void;
  onDelete: (name: string) => void;
  loading: boolean;
}

export function VMCard({
  vm,
  onStart,
  onStop,
  onEdit,
  onDelete,
  loading,
}: VMCardProps) {
  const name = vm?.name || "Sans nom";
  const initials = name.slice(0, 2).toUpperCase();
  const inferredOs = os_list
    .filter((os) => name === os.id || name.startsWith(`${os.id}-`))
    .sort((left, right) => right.id.length - left.id.length)[0];
  const osIcon = os_list.find((os) => os.id === vm?.osId)?.icon || inferredOs?.icon;
  const isRunning =
    vm?.state?.toLowerCase().includes("running") ||
    vm?.state?.toLowerCase().includes("fonctionnement");

  const memoryGB = vm?.memoryMb ? (vm.memoryMb / 1024).toFixed(1) : "1.0";
  const cpus = vm?.vcpus || 1;
  const diskGB = vm?.diskGb || 10;

  const handleDelete = () => {
    if (confirm(`Supprimer définitivement la VM "${name}" et son disque ?`)) {
      onDelete(name);
    }
  };

  return (
    <div className="vm-card">

      
      <div className="vm-header">
        <div className="vm-avatar">
          {osIcon ? <img src={osIcon} alt="" /> : initials}
        </div>
        
        <h3 className="vm-title">{name}</h3>
        
        <div className="vm-status">
          <span className="status-text">{isRunning ? "En fonctionnement" : "Arrêtée"}</span>
        </div>
      </div>
      

      <div className="vm-specs">
        <span>⚙️ {cpus} CPU</span>
        <span>🧠 {memoryGB} GB</span>
        <span>💾 {diskGB} GB</span>
      </div>

      <div className="vm-controls-container" style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "12px" }}>
        
        {/* Ligne 1 : Contrôle de l'exécution & Affichage */}
        <div className="vm-actions-row" style={{ display: "flex", gap: "6px" }}>
          {!isRunning ? (
            <button
              className="btn-start"
              onClick={() => onStart(name)}
              disabled={loading}
              style={{ flex: 1, padding: "8px", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
            >
              <Play size={15} /> Démarrer
            </button>
          ) : (
            <>
              <button
                className="btn-stop"
                onClick={() => onStop(name)}
                disabled={loading}
                title="Arrêter la VM"
                style={{
                  padding: "8px 12px",
                  background: "rgba(231, 76, 60, 0.2)",
                  color: "#e74c3c",
                  border: "1px solid #e74c3c",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center"
                }}
              >
                <Square size={15} />
              </button>
            </>
          )}
        </div>

        {/* Ligne 2 : Édition & Suppression */}
        <div className="vm-management-row" style={{ display: "flex", gap: "6px" }}>
          <button
            className="secondary"
            onClick={() => onEdit(vm)}
            disabled={loading || isRunning}
            title={isRunning ? "Arrêtez la VM pour modifier ses paramètres" : "Modifier la configuration"}
            style={{ flex: 1, padding: "6px", fontSize: "0.85em", display: "flex", alignItems: "center", justifyContent: "center", gap: "4px" }}
          >
            <Pencil size={14} /> Modifier
          </button>

          <button
            className="btn-delete"
            onClick={handleDelete}
            disabled={loading}
            style={{
              flex: 1,
              padding: "6px",
              fontSize: "0.85em",
              background: "rgba(231, 76, 60, 0.15)",
              color: "#e74c3c",
              border: "1px solid rgba(231, 76, 60, 0.3)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "4px"
            }}
          >
            <Trash2 size={14} /> Supprimer
          </button>
        </div>

      </div>
    </div>
  );
}

function DownloadISOModal({
  os,
  onClose,
  onDownload,
}: {
  os: Os;
  onClose: () => void;
  onDownload: (version: string, edition: string) => void;
}) {
  const versions = os.releases;

  const [selectedVersion, setSelectedVersion] = useState<OsVersion>(versions[0]);

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-head">
          <div>
            <span className="eyebrow">TÉLÉCHARGEMENT</span>
            <h2>Télécharger l'ISO de {os.name}</h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="form" style={{ marginTop: "12px" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            Version de l'OS
            <select
              value={selectedVersion.release}
              onChange={(e) => {
                const found = versions.find((v) => v.release === e.target.value) || versions[0];
                setSelectedVersion(found);
              }}
              style={{ padding: "8px", borderRadius: "4px", background: "#1e1e2e", border: "1px solid #333", color: "white" }}
            >
              {versions.map((v) => (
                <option key={v.release} value={v.release}>
                  {v.release}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="modal-actions" style={{ marginTop: "16px", display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button className="secondary" onClick={onClose}>
            Annuler
          </button>
          <button
            className="primary"
            onClick={() => onDownload(selectedVersion.release, selectedVersion.options[0] || "")}
          >
            Télécharger l'ISO
          </button>
        </div>
      </div>
    </div>
  );
}





function CreateVMModal({
  os,
  onClose,
  onCreate,
}: {
  os: Os;
  onClose: () => void;
  onCreate: (config: {
    name: string;
    vcpus: number;
    memoryMb: number;
    diskGb: number;
    isoVersion: string;
    edition: string;
  }) => void;
}) {
  const versions = os.releases;

  const [vmName, setVmName] = useState(`${os?.id || "custom"}-vm`);
  const [vcpus, setVcpus] = useState(os?.recommended_vcpus || 2);
  const [memoryMb, setMemoryMb] = useState(os?.recommended_memory || 2048);
  const [diskGb, setDiskGb] = useState(20);
  const [selectedVersion, setSelectedVersion] = useState<OsVersion>(
    versions[0] || { release: "latest", options: [] }
  );
  const [selectedEdition, setSelectedEdition] = useState(versions[0]?.options[0] || "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onCreate({
      name: vmName,
      vcpus: Number(vcpus),
      memoryMb: Number(memoryMb),
      diskGb: Number(diskGb),
      isoVersion: selectedVersion.release,
      edition: selectedEdition,
    });
  };

  return (
    <div
      className="modal-backdrop"
      onWheel={(e) => e.stopPropagation()} // Intercepte le scroll pour préserver le fond
    >
      <div
        className="modal"
        style={{
          maxWidth: "450px",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* En-tête fixe */}
        <div className="modal-head" style={{ flexShrink: 0 }}>
          <div>
            <span className="eyebrow">CONFIGURATION</span>
            <h2>Créer une VM {os.name}</h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Formulaire complet */}
        <form
          onSubmit={handleSubmit}
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            overflow: "hidden",
            marginTop: "12px",
          }}
        >
          {/* Corps défilant du formulaire */}
          <div
            className="form"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              overflowY: "auto",
              paddingRight: "6px",
              flex: 1,
            }}
          >
            <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              Nom de la VM
              <input
                type="text"
                value={vmName}
                onChange={(e) => setVmName(e.target.value)}
                required
                style={{
                  padding: "8px",
                  borderRadius: "4px",
                  background: "#1e1e2e",
                  border: "1px solid #333",
                  color: "white",
                }}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              Version ISO (JSON)
              <select
                value={selectedVersion.release}
                onChange={(e) => {
                  const found = versions.find((v) => v.release === e.target.value) || versions[0];
                  setSelectedVersion(found);
                  setSelectedEdition(found.options[0] || "");
                }}
                style={{
                  padding: "8px",
                  borderRadius: "4px",
                  background: "#1e1e2e",
                  border: "1px solid #333",
                  color: "white",
                }}
              >
                {versions.map((v) => (
                  <option key={v.release} value={v.release}>
                    {v.release}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              Édition
              <select
                value={selectedEdition}
                onChange={(e) => setSelectedEdition(e.target.value)}
                disabled={selectedVersion.options.length === 0}
                style={{
                  padding: "8px",
                  borderRadius: "4px",
                  background: "#1e1e2e",
                  border: "1px solid #333",
                  color: "white",
                }}
              >
                {selectedVersion.options.length === 0 ? (
                  <option value="">Aucune édition</option>
                ) : (
                  selectedVersion.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))
                )}
              </select>
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                vCPUs
                <input
                  type="number"
                  min="1"
                  max="16"
                  value={vcpus}
                  onChange={(e) => setVcpus(Number(e.target.value))}
                  required
                  style={{
                    padding: "8px",
                    borderRadius: "4px",
                    background: "#1e1e2e",
                    border: "1px solid #333",
                    color: "white",
                  }}
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                RAM (Mo)
                <input
                  type="number"
                  min="512"
                  step="512"
                  value={memoryMb}
                  onChange={(e) => setMemoryMb(Number(e.target.value))}
                  required
                  style={{
                    padding: "8px",
                    borderRadius: "4px",
                    background: "#1e1e2e",
                    border: "1px solid #333",
                    color: "white",
                  }}
                />
              </label>
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              Disque virtuel (Go)
              <input
                type="number"
                min="5"
                value={diskGb}
                onChange={(e) => setDiskGb(Number(e.target.value))}
                required
                style={{
                  padding: "8px",
                  borderRadius: "4px",
                  background: "#1e1e2e",
                  border: "1px solid #333",
                  color: "white",
                }}
              />
            </label>
          </div>

          {/* Actions fixes en bas de la fenêtre */}
          <div
            className="modal-actions"
            style={{
              marginTop: "16px",
              paddingTop: "12px",
              borderTop: "1px solid rgba(255, 255, 255, 0.1)",
              display: "flex",
              justifyContent: "flex-end",
              gap: "8px",
              flexShrink: 0,
            }}
          >
            <button type="button" className="secondary" onClick={onClose}>
              Annuler
            </button>
            <button type="submit" className="primary">
              Créer la VM
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}





function EditVMModal({
  vm,
  onClose,
  onSave,
}: {
  vm: VmInfo;
  onClose: () => void;
  onSave: (config: { name: string; vcpus: number; memoryMb: number }) => void;
}) {
  const [vcpus, setVcpus] = useState(vm.vcpus || 2);
  const [memoryMb, setMemoryMb] = useState(vm.memoryMb || 2048);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      name: vm.name,
      vcpus: Number(vcpus),
      memoryMb: Number(memoryMb),
    });
  };

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ maxWidth: "450px" }}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">MODIFICATION</span>
            <h2>Éditer {vm.name}</h2>
          </div>
          <button className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} className="form" style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "12px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              vCPUs
              <input
                type="number"
                min="1"
                max="16"
                value={vcpus}
                onChange={(e) => setVcpus(Number(e.target.value))}
                required
                style={{ padding: "8px", borderRadius: "4px", background: "#1e1e2e", border: "1px solid #333", color: "white" }}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              RAM (Mo)
              <input
                type="number"
                min="512"
                step="512"
                value={memoryMb}
                onChange={(e) => setMemoryMb(Number(e.target.value))}
                required
                style={{ padding: "8px", borderRadius: "4px", background: "#1e1e2e", border: "1px solid #333", color: "white" }}
              />
            </label>
          </div>

          <div className="modal-actions" style={{ marginTop: "16px", display: "flex", justifyContent: "flex-end", gap: "8px" }}>
            <button type="button" className="secondary" onClick={onClose}>Annuler</button>
            <button type="submit" className="primary">Enregistrer</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default App;


