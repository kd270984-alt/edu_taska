#!/usr/bin/env bash
# ВЕРНУТЬ БАЗУ ТАСКИ ИЗ КОПИИ. Запускается на сервере из папки проекта:
#   bash scripts/restore.sh backups/2026-11-12.sql.gz            — показать, что будет, и остановиться
#   bash scripts/restore.sh backups/2026-11-12.sql.gz --yes      — вернуть базу (ВСЁ текущее заменится)
#   bash scripts/restore.sh --files backups/restore-files --yes  — вернуть файлы задач из копии с ноутбука
#     (рядом можно положить backups/restore-files.gone — список удалённого на сервере, см. ниже)
#
# Возврат заменяет всё, что сейчас в Таске, поэтому без --yes скрипт только объясняет и выходит:
# помощник обязан спросить человека и лишь потом повторить с --yes (решение владельца 11.11.2026).
#
# Замечания критика 11.11.2026, учтённые здесь:
#   - backup.sh НЕ зовём: он перезаписал бы сегодняшнюю ночную копию испорченной базой, а при сломанной
#     базе упал бы и остановил возврат. Свою копию кладём в backups/before-restore-ГГГГММДД-ЧЧММСС.sql.gz —
#     это имя не трогают ни ноутбук, ни чистка старых копий;
#   - файл проверяем (gzip и шапка дампа) ДО того, как что-то стирать;
#   - бот останавливаем, только если его контейнер есть (бот необязательный);
#   - при любом сбое api запускается обратно (trap), чтобы Таска не осталась выключенной.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
[ -f .env ] || { echo "нет файла .env — запускать из папки проекта" >&2; exit 1; }
val(){ grep -E "^$1=" .env | tail -1 | cut -d= -f2- | tr -d '"'"'"; }
PGU=$(val POSTGRES_USER); PGD=$(val POSTGRES_DB)
PORT=$(val API_PORT); PORT="${PORT:-3000}"   # 127.0.0.1, а не localhost: в alpine localhost — это ::1, а api слушает IPv4

MODE=db; YES=0; NODUMP=0; SRC=""
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    --files) MODE=files ;;
    --without-safety-copy) NODUMP=1 ;;
    -*) echo "непонятный ключ: $a" >&2; exit 2 ;;
    *) SRC="$a" ;;
  esac
done
stop(){ echo "НЕ ВОЗВРАЩЕНО: $*" >&2; exit 1; }
[ -n "$SRC" ] || stop "укажите файл копии базы (или --files и папку с файлами задач)."

STOPPED=""
restart(){   # что остановили — запускаем обратно при любом исходе
  [ -n "$STOPPED" ] || return 0
  # shellcheck disable=SC2086
  docker compose start $STOPPED >/dev/null 2>&1 || echo "⚠️ не смог запустить: $STOPPED — выполните: docker compose up -d" >&2
  STOPPED=""
}
trap restart EXIT
trap 'exit 1' INT TERM HUP

health(){   # ждём, пока api ответит (до 2 минут: при запуске он ставит пакеты)
  local i
  for i in $(seq 1 60); do
    docker compose exec -T api wget -qO- "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | grep -q '"ok":true' && return 0
    sleep 2
  done
  return 1
}

# ---------------- файлы задач (хранилище MinIO) ----------------
if [ "$MODE" = files ]; then
  [ -f "$SRC/.minio.sys/format.json" ] || stop "в папке $SRC нет копии хранилища (нет .minio.sys/format.json). Нужна папка files из TaskaBackup целиком."
  C=$(docker compose ps -a -q minio | head -1)
  [ -n "$C" ] || stop "не найден контейнер minio — Таска запущена? (docker compose up -d)"
  VOL=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$C")
  [ -n "$VOL" ] || stop "не нашёл том с файлами у контейнера minio."
  SRCA=$(cd "$SRC" && pwd)
  # Удалённое на сервере ноутбук держит у себя ещё 30 дней в той же папке files. Вернуть его в хранилище —
  # значит засорить маленький диск «сиротами», на которые в базе нет ссылок (замечание критика 12.11.2026).
  # Поэтому пропускаем пути из списка ноутбука .state/files.gone, если его положили рядом: ПАПКА.gone.
  GONE="${SRCA}.gone"; LIST=$(mktemp); SKIP=0
  ( cd "$SRCA" && find . -type f | sed 's|^\./||' ) | sort > "$LIST.all"
  if [ -f "$GONE" ]; then
    cut -f2 "$GONE" | sed '/^$/d' | sort -u > "$LIST.gone"
    comm -23 "$LIST.all" "$LIST.gone" > "$LIST"
    SKIP=$(( $(wc -l < "$LIST.all") - $(wc -l < "$LIST") ))
  else
    cp "$LIST.all" "$LIST"
  fi
  rm -f "$LIST.all" "$LIST.gone"
  N=$(wc -l < "$LIST" | tr -d ' ')
  NEED=$(cd "$SRCA" && tr '\n' '\0' < "$LIST" | xargs -0 du -k 2>/dev/null | awk '{s+=$1} END{print s+0}')
  SZ=$(awk -v k="$NEED" 'BEGIN{ if (k<1024) printf "%d КБ", k; else if (k<1048576) printf "%.1f МБ", k/1024; else printf "%.1f ГБ", k/1048576 }' | tr . ,)
  echo "Будет: файлы задач из $SRC ($N файлов, $SZ) лягут в хранилище Таски (том $VOL)."
  if [ -f "$GONE" ]; then echo "Пропускаю $SKIP файлов, удалённых на сервере (список $GONE)."
  else echo "⚠️ Списка удалённого ($GONE) нет — вернутся и файлы, удалённые на сервере за последние 30 дней."; fi
  echo "Файлы с теми же именами заменятся копией, остальные останутся. Таска на минуту остановится."
  if [ "$YES" != 1 ]; then rm -f "$LIST"; echo; echo "Ничего не сделано. Спросите человека и повторите с --yes."; exit 3; fi
  FREE=$(df -Pk "$(docker volume inspect -f '{{.Mountpoint}}' "$VOL" 2>/dev/null || echo /)" 2>/dev/null | awk 'NR==2{print $4}')
  [ -z "$FREE" ] || [ "$FREE" -gt $(( NEED + 524288 )) ] || stop "на сервере мало места: нужно ещё $SZ и запас 0,5 ГБ."
  docker compose stop api minio >/dev/null || stop "не смог остановить Таску."
  STOPPED="minio api"
  # tar по списку: так пропуск удалённого работает, а права и время файлов сохраняются, как у cp -a
  docker run --rm -v "$VOL":/data -v "$SRCA":/src:ro -v "$LIST":/list:ro alpine:3.20 \
      sh -c 'cd /src && tar -cf - -T /list | tar -C /data -xpf -' \
    || { rm -f "$LIST"; stop "файлы скопировались не до конца — Таска запускается обратно, повторите команду (уже скопированное просто заменится тем же)."; }
  rm -f "$LIST"
  restart
  health || stop "Таска не ответила после возврата файлов: docker compose logs api --tail 50"
  echo "Готово: файлы задач возвращены, Таска работает. Откройте задачу с вложением и проверьте, что файл скачивается."
  exit 0
fi

# ---------------- база ----------------
[ -f "$SRC" ] || stop "нет файла $SRC."
gzip -t "$SRC" 2>/dev/null || stop "файл $SRC битый (архив не читается). Возьмите копию за другой день."
HEAD=$({ gzip -dc "$SRC" 2>/dev/null | head -5; } || true)
echo "$HEAD" | grep -q "PostgreSQL database dump" || stop "внутри $SRC не копия базы. Возьмите копию за другой день."
echo "Будет: база Таски заменится копией $SRC ($(du -h "$SRC" | cut -f1))."
echo "Всё, что сделано в Таске после этой копии, пропадёт. Таска остановится на минуту."
if [ "$YES" != 1 ]; then echo; echo "Ничего не сделано. Спросите человека и повторите с --yes."; exit 3; fi

mkdir -p backups
SAFE="backups/before-restore-$(date +%Y%m%d-%H%M%S).sql.gz"
if [ "$NODUMP" = 1 ]; then
  echo "• копию текущей базы НЕ делаю (--without-safety-copy)"
elif docker compose exec -T postgres pg_dump -U "$PGU" "$PGD" 2>/dev/null | gzip > "$SAFE.part" \
     && gzip -t "$SAFE.part" 2>/dev/null && gzip -dc "$SAFE.part" | head -5 | grep -q "PostgreSQL database dump"; then
  mv -f "$SAFE.part" "$SAFE"; echo "• текущая база сохранена: $SAFE"
else
  rm -f "$SAFE.part"
  stop "не вышло сохранить текущую базу (возможно, она и сломана). Если человек согласен вернуть копию без этого — повторите с --yes --without-safety-copy."
fi

HINT=""; [ -f "$SAFE" ] && HINT=" Верните сохранённую: bash scripts/restore.sh $SAFE --yes"
SVCS="api"; [ -n "$(docker compose ps -a -q bot 2>/dev/null)" ] && SVCS="api bot"
# shellcheck disable=SC2086
docker compose stop $SVCS >/dev/null || stop "не смог остановить Таску."
STOPPED="$SVCS"
docker compose exec -T postgres dropdb -U "$PGU" --if-exists --force "$PGD" || stop "не смог удалить старую базу — она осталась как была."
docker compose exec -T postgres createdb -U "$PGU" -O "$PGU" "$PGD" || stop "не смог создать базу.$HINT"
if ! gzip -dc "$SRC" | docker compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U "$PGU" -d "$PGD" >/dev/null; then
  stop "копия не легла в базу.$HINT"
fi
restart
health || stop "база возвращена, но Таска не ответила: docker compose logs api --tail 50"
echo "Готово: база возвращена из $SRC, Таска работает. Войдите и проверьте задачи."
[ -f "$SAFE" ] && echo "Прежняя база сохранена в $SAFE — если вернули не ту копию, верните её так же."
exit 0
