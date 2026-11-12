#!/bin/bash
# ВЫКЛЮЧИТЬ КОПИЮ ТАСКИ НА ЭТОМ MAC — одна команда:
#   bash ~/.taska-backup/uninstall-mac.sh
# Убирает расписание, скрипты и обе отметки на сервере (иначе ночной отчёт каждый день писал бы
# «ноутбук не забирал копию»). Сами копии — папку TaskaBackup — НЕ трогает.
set -u
HOST="${TASKA_HOST:-taska}"
REMOTE="${TASKA_REMOTE_DIR:-/root/taska-edu}"
DEST="${TASKA_BACKUP_DIR:-$HOME/TaskaBackup}"
APP="${TASKA_APP_DIR:-$HOME/.taska-backup}"
LABEL="${TASKA_LABEL:-local.taska.backup}"
SSH_BASE=(-o BatchMode=yes -o ConnectTimeout=10)
[ -n "${TASKA_SSH_CONFIG:-}" ] && SSH_BASE=(-F "$TASKA_SSH_CONFIG" "${SSH_BASE[@]}")

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf "$APP" "$DEST/.state/lock"
if ssh -n "${SSH_BASE[@]}" "$HOST" rm -f "$REMOTE/backups/.laptop-ok" "$REMOTE/backups/.laptop-files-ok" 2>/dev/null; then
  NOTE="отметки на сервере убрал"
else
  NOTE="сервер не ответил — отметки backups/.laptop-ok и backups/.laptop-files-ok на нём уберите потом сами (иначе ночной отчёт будет напоминать про ноутбук)"
fi
echo "Копия Таски на этом компьютере выключена: расписания и скриптов больше нет, $NOTE."
echo "Сами копии остались в папке $DEST — удалите её, если они не нужны."
