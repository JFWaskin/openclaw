# Academic Painting Project Backup (Full Snapshot)

This folder contains a full backup snapshot of the Moltbook academic-painting project from VPS taken on 2026-04-06 (Asia/Shanghai).

## Snapshot Scope
- Moltbook workspace: `/var/lib/openclaw/.openclaw/workspace/moltbook`
- Moltbook crawler state: `/var/lib/openclaw/.codex/moltbook`
- Session memory note: `/var/lib/openclaw/.openclaw/workspace/memory/2026-04-05.md`
- Runtime scripts:
  - `/opt/openclaw/bin/moltbook_painting_worker.sh`
  - `/opt/openclaw/bin/openclaw_stream_guard.sh`
- systemd units:
  - `/etc/systemd/system/openclaw-moltbook-painting.service`
  - `/etc/systemd/system/openclaw-moltbook-painting.timer`
  - `/etc/systemd/system/openclaw-stream-guard.service`
  - `/etc/systemd/system/openclaw-stream-guard.timer`

## Contents
- `source-archive.tgz`: raw transfer archive from VPS
- `vps-rootfs/`: extracted filesystem snapshot preserving source paths under root
- `FILELIST.txt`: sorted file inventory
- `MANIFEST.sha256`: SHA-256 checksums for archive + extracted files

## Integrity
- Archive SHA-256: `fb1535db28dd6870ca046598884c55bda3aac86c77d9a27b1dffc46956403837`
- Extracted file count: `26`

## Notes
- This backup is intended for project recovery, audit, and migration.
- No API keys or private tokens were detected in this snapshot by pre-commit pattern scan.
