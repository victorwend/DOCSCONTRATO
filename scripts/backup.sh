#!/usr/bin/env bash
# Backup do banco (pg_dump, formato custom). Agende no cron, ex.:
#   0 2 * * * cd /opt/pavidez-docs && ./scripts/backup.sh >> /var/log/pavidez-backup.log 2>&1
# Arquivos: com STORAGE_DRIVER=local, copie também a pasta ./storage (rsync/rclone).
#           com Supabase Storage, use a cópia do bucket (rclone com S3 do Supabase) e PITR do banco.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
: "${DATABASE_URL:?DATABASE_URL não definida}"
DEST="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
mkdir -p "$DEST"
FILE="$DEST/pavidez_docs_$(date +%Y%m%d_%H%M%S).dump"
pg_dump --format=custom --no-owner --file="$FILE" "$DATABASE_URL"
chmod 600 "$FILE"
find "$DEST" -name 'pavidez_docs_*.dump' -mtime +"$KEEP_DAYS" -delete
echo "Backup gerado: $FILE"
# Restaurar: pg_restore --clean --no-owner -d "$DATABASE_URL" arquivo.dump
