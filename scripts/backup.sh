#!/usr/bin/env bash
# НОЧНАЯ КОПИЯ БАЗЫ. Снимает дамп, сжимает, ПРОВЕРЯЕТ, что архив не битый, удаляет старые
# и отчитывается админу в Телеграм.
#
#   bash scripts/backup.sh
#   строка для crontab -e:  20 3 * * * cd /путь/к/taska-edu && bash scripts/backup.sh
#
# ⚠️ Зачем скрипт вместо длинной строки в cron: в crontab знак % — особенный, его надо
#    экранировать, и строка с трубами ломается незаметно. Здесь этой ловушки нет.
# ⚠️ Зачем проверка и отчёт: молча сломавшаяся копия — худшее, что бывает, о ней узнают
#    в тот день, когда она понадобилась. Скрипт проверяет каждый архив и пишет админу.
#    Нет бота или никто не привязан — просто делает копию молча.
#
# Хранение: BACKUP_KEEP_DAYS дней (по умолчанию 30). Вложения из MinIO сюда НЕ входят.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "нет файла .env — запускать из папки проекта" >&2; exit 1; }

# пустое значение — это нормально (строки может не быть вовсе), поэтому ошибку grep гасим
val(){ { grep -E "^$1=" .env || true; } | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' | awk '{print $1}'; }
PGU=$(val POSTGRES_USER); PGD=$(val POSTGRES_DB)
TOKEN=$(val TELEGRAM_BOT_TOKEN)
KEEP=$(val BACKUP_KEEP_DAYS); KEEP="${KEEP:-30}"
DIR=backups; mkdir -p "$DIR"
FILE="$DIR/$(date +%F).sql.gz"

# отчёт админу: ищем тех, у кого админская роль И привязан Телеграм
tg(){
  [ -n "$TOKEN" ] || return 0
  local text="$1" ids
  ids=$(docker compose exec -T postgres psql -U "$PGU" -d "$PGD" -At \
        -c "select l.telegram_id from telegram_links l join users u on u.id = l.user_id where u.role = 'admin'" 2>/dev/null || true)
  [ -n "$ids" ] || return 0
  for id in $ids; do
    curl -s -o /dev/null -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
      -d "chat_id=$id" --data-urlencode "text=$text" || true
  done
}
beda(){ echo "копия НЕ сделана: $1" >&2; tg "⚠️ Копия базы Таски НЕ сделана: $1"; exit 1; }

docker compose exec -T postgres pg_dump -U "$PGU" "$PGD" | gzip > "$FILE" || beda "pg_dump не отработал"
gzip -t "$FILE" 2>/dev/null || beda "архив битый ($FILE)"
# шапка дампа — во второй строке, а не в первой; head обрывает gzip, поэтому терпим его код выхода
HEAD=$({ gzip -dc "$FILE" 2>/dev/null | head -5; } || true)
echo "$HEAD" | grep -q "PostgreSQL database dump" || beda "внутри архива не дамп базы ($FILE)"

find "$DIR" -name '*.sql.gz' -mtime "+$KEEP" -delete
SIZE=$(du -h "$FILE" | cut -f1); N=$(ls -1 "$DIR"/*.sql.gz 2>/dev/null | wc -l | tr -d ' ')
echo "$(date +%F' '%T) копия готова: $FILE ($SIZE), всего копий: $N"
tg "✅ Копия базы Таски за $(date +%d.%m) готова: $SIZE. Всего копий: $N, храню $KEEP дней."
