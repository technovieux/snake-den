![App Screenshot](https://github.com/technovieux/snake-den/public/snakeden-logo.png)


# SnakeDen MVP

SnakeDen est un gestionnaire de machines virtuelles avec une interface type App Store.

## Architecture

- Frontend : React + TypeScript + Vite
- Desktop : Tauri 2
- Backend : Rust
- Virtualisation : quickemu -> QEMU/KVM
- Disques : qcow2

Le MVP permet :
- lister les VMs Quickemu ;
- créer une VM depuis une ISO locale ;
- choisir CPU/RAM/disque ;
- démarrer une VM ;
- arrêter une VM ;
- gérer une bibliothèque d'OS côté interface.
- ouvrir une console Quickemu dédiée au démarrage ;
- télécharger les ISO avec `quickget` et remonter leur progression dans l'interface ;
- lancer et arrêter des processus `quickemu` depuis les commandes Tauri.

## Prérequis Debian

Installez les outils de virtualisation :

```bash
sudo apt update
sudo apt install qemu-system-x86 qemu-utils quickemu

# Préparer le stockage système utilisé par SnakeDen
sudo install -d -o "$USER" -g "$USER" /var/lib/snakeden/images
```

Ajoutez votre utilisateur au groupe nécessaire si votre configuration Debian l'utilise :

```bash
sudo usermod -aG kvm "$USER"
```

Déconnectez-vous/reconnectez-vous après cette modification.

Vérifiez :

```bash
qemu-img --version
```

## Installation du frontend

```bash
npm install
```

## Lancer en développement

```bash
npm run tauri:dev
```

## Compiler

```bash
npm run tauri:build
```

Le paquet Debian sera généré dans :

```text
src-tauri/target/release/bundle/deb/
```

## Stockage des disques

Par défaut :

```text
/var/lib/snakeden/images
```

Chaque VM est maintenant stockée dans son propre sous-dossier :

```text
/var/lib/snakeden/images/<nom-de-la-vm>/
├── <nom-de-la-vm>.qcow2
├── <nom-de-la-vm>.conf
└── <os>-<version>-<option>/
	└── <nom-variable>.iso
```

Les ISO téléchargées seules sont archivées dans le dossier Downloads de l'utilisateur :

```text
~/Downloads
```

## Créer une première VM

Dans SnakeDen :

1. Découvrir
2. Choisir une ditribution (Ubuntu/Debian/Fedora)
3. Choisir CPU/RAM/disque
4. Créer la VM
5. Aller dans Mes VMs
6. Démarrer

## Limites actuelles

- les VMs sont gérées par Quickemu
- pas encore de virtiofs
- pas de versions windows et mac

Pour le moment, le systeme est en français, une traduction est prévue ainsi que les implementations des fonctionnalitées manquantes.
