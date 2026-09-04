# Storage Options & Configuration

Olympus Dispatch is local-first and stores two categories of data:
1. **Olympus State** (`olympus-dispatch-state`): SQLite database (`olympus-dispatch.db`), project references, logs, and backups.
2. **Hermes Data** (`hermes-data`): Hermes session transcripts, credentials, skills, and project workspaces/repositories.

---

## 1. Default: Local VPS or Server (Zero Configuration)

By default, Olympus stores all repositories and state locally on the VPS or bare-metal server it runs on.

### Docker Compose
When you clone the repository and run:
```bash
docker compose up -d
```
Docker automatically creates standard local volumes on the VPS host filesystem (typically `/var/lib/docker/volumes/`):
- `olympus-dispatch-state`
- `hermes-data`

No environment variables or pre-created volumes are required.

### Bare-Metal (macOS / Linux without Docker)
When running natively via `./scripts/macos/install.sh` or `npm run dev`:
- Olympus state is kept under `~/.olympus-dispatch/`
- Hermes sessions and workspaces are kept under `~/.hermes/`
- Host projects reside in `~/Dev` or `~/.olympus-dispatch/workspace/`

---

## 2. Attached Block Storage (Hetzner Volume, AWS EBS, Secondary NVMe)

If your VPS primary disk is small and you attach a secondary block volume (e.g. `/mnt/storage` or Hetzner Cloud Volume `/mnt/HC_Volume_...`):

### Option A: Direct Bind Mount via `docker-compose.override.yml`
Create a `docker-compose.override.yml` file in the Olympus root directory:
```yaml
services:
  olympus-dispatch:
    volumes:
      - /mnt/storage/olympus-dispatch:/opt/data/olympus-dispatch
      - /mnt/storage/hermes:/opt/data
```
Ensure the directories exist and are owned by user `10000:10000`:
```bash
sudo mkdir -p /mnt/storage/olympus-dispatch /mnt/storage/hermes
sudo chown -R 10000:10000 /mnt/storage
```

### Option B: Named Docker Volume Backed by Mount Point
Create a local volume pointing to the mount:
```bash
docker volume create --driver local \
  --opt type=none \
  --opt device=/mnt/storage/hermes \
  --opt o=bind hermes-data
```
And set in `.env`:
```env
HERMES_DATA_VOLUME=hermes-data
```

### Option C: Bare-Metal Symlink or Environment Variable
On a local Mac or Linux machine without Docker, configure `.env`:
```env
OLYMPUS_DISPATCH_HOME=/Volumes/ExternalDrive/olympus-dispatch
HERMES_HOME=/Volumes/ExternalDrive/hermes
```
Or create a symlink:
```bash
ln -s /Volumes/ExternalDrive/olympus-dispatch ~/.olympus-dispatch
```

---

## 3. Remote Storage via SSH (SSHFS / NFS)

To store project repositories and agent files on another server or NAS using SSH:

> **Why mount at the OS level?**
> Olympus uses SQLite WAL mode for state and standard Git commands for project checkpoints. Both require atomic POSIX file locking and low-latency disk operations. Mounting remote storage via **SSHFS** (or NFS) at the host OS level provides the required POSIX filesystem semantics.

### Step 1: Install SSHFS on your VPS
- **Debian / Ubuntu**:
  ```bash
  sudo apt-get update && sudo apt-get install -y sshfs
  ```
- **macOS**:
  Install [macFUSE](https://macfuse.io/) and SSHFS:
  ```bash
  brew install --cask macfuse
  brew install gromgit/fuse/sshfs-mac
  ```

### Step 2: Mount the Remote Storage Directory
Mount the remote directory to a local mount point:
```bash
sudo mkdir -p /mnt/remote-storage
sudo sshfs user@remote-host:/path/to/remote/storage /mnt/remote-storage \
  -o allow_other,default_permissions,reconnect,ServerAliveInterval=15,ServerAliveCountMax=3
```

To automatically mount at boot, add an entry in `/etc/fstab`:
```
user@remote-host:/path/to/remote/storage /mnt/remote-storage fuse.sshfs _netdev,allow_other,reconnect,IdentityFile=/root/.ssh/id_ed25519 0 0
```

### Step 3: Connect Olympus to the Mount
Use the mount point in Docker or bare-metal just like an attached disk:
- In `docker-compose.override.yml`:
  ```yaml
  services:
    olympus-dispatch:
      volumes:
        - /mnt/remote-storage/olympus-dispatch:/opt/data/olympus-dispatch
        - /mnt/remote-storage/hermes:/opt/data
  ```
- On bare metal:
  ```env
  OLYMPUS_DISPATCH_HOME=/mnt/remote-storage/olympus-dispatch
  ```
