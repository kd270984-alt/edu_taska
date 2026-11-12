#!/usr/bin/env bash
# СПИСОК ФАЙЛОВ ЗАДАЧ ДЛЯ КОПИИ НА НОУТБУК. Запускается НА СЕРВЕРЕ, его зовёт ноутбук:
#   ssh taska bash /root/taska-edu/scripts/laptop/files-list.sh
# Печатает папку хранилища MinIO и все его файлы: «размер<TAB>время<TAB>путь». Ничего не меняет.
#
# Решение владельца 11.11.2026: на ноутбук — только новое, и без архивов на сервере (диск маленький).
# Поэтому ноутбук сравнивает этот список со своим и докачивает только недостающие файлы.
#
# ⚠️ Это НЕ сами вложения в обычном виде: MinIO хранит каждый файл папкой (xl.meta, крупные — ещё
#    part.1 с контрольными суммами внутри). Открыть договор из копии нельзя — его можно только вернуть
#    в Таску (scripts/restore.sh --files). Зато копия точная и вернётся вместе с аватарами.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2

# Папку тома берём у самого контейнера minio: имя тома зависит от имени проекта (taska-edu_miniodata),
# и гадать его — та же ошибка, что была в README (taska-edu_minio — пустой несуществующий том).
D=""
if command -v docker >/dev/null 2>&1; then
  C=$(docker compose ps -a -q minio 2>/dev/null | head -1)
  [ -n "$C" ] && D=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$C" 2>/dev/null)
fi
[ -n "$D" ] || D=/var/lib/docker/volumes/taska-edu_miniodata/_data
[ -f "$D/.minio.sys/format.json" ] || { echo "NO-STORAGE	$D"; exit 3; }

printf 'DIR\t%s\n' "$D"
# tmp и multipart — недописанные загрузки, их копировать нельзя (и незачем)
cd "$D" && find . -type f ! -path './.minio.sys/tmp/*' ! -path './.minio.sys/multipart/*' -printf '%s\t%Ts\t%P\n'
