#!/bin/bash
# КОПИЯ ТАСКИ НА НОУТБУК (Mac). Забирает с сервера свежую ночную копию базы и докачивает новые
# файлы задач. Ставит и обновляет — install-mac.sh, выключает — uninstall-mac.sh.
#
#   ~/.taska-backup/taska-backup.sh         — обычный запуск: так его зовёт launchd раз в час и при входе
#   ~/.taska-backup/taska-backup.sh --now   — сразу и без пропуска, только база (так зовёт установщик)
#
# Решения владельца 11.11.2026:
#   - база — свежий ночной дамп с сервера каждый день (он маленький), на ноутбуке 30 копий;
#   - файлы задач — полная копия, но докачивается только новое; прямо с сервера, без архивов на нём
#     (диск сервера маленький); удалённое на сервере у нас живёт ещё 30 дней.
#
# Что делает на сервере: читает (ls, sha256sum, список файлов, скачивание) и пишет только две отметки:
# backups/.laptop-ok (база забрана) и backups/.laptop-files-ok (файлы задач сверены). По ним ночная
# копия сервера пишет «ноутбук не забирал копию / файлы задач N дней»: этот сигнал работает, даже если
# ноутбук сломан, выключен или задачу выключили.
#
# ⚠️ /bin/bash на Mac — версия 3.2: без mapfile, ${x,,} и словарей. Утилиты BSD: stat -f, date -v.
# ⚠️ Окно тревоги показываем отдельным процессом и не ждём: иначе открытое окно держало бы запуск,
#    и launchd не начинал бы следующий (в plist для этого AbandonProcessGroup).
set -u
umask 077   # копии — данные команды: читать их может только хозяин компьютера

APP_DIR=$(cd "$(dirname "$0")" && pwd)
VERSION=$(head -1 "$APP_DIR/VERSION" 2>/dev/null || echo "?")
HOST="${TASKA_HOST:-taska}"
REMOTE="${TASKA_REMOTE_DIR:-/root/taska-edu}"
DEST="${TASKA_BACKUP_DIR:-$HOME/TaskaBackup}"
STATE="$DEST/.state"
FILES="$DEST/files"
LOG="$DEST/журнал.txt"
STATUS="$DEST/Последняя копия.txt"
KEEP=30        # копий базы — по счёту, а не по возрасту: выключенный на месяц ноутбук старое не сотрёт
GONE_DAYS=30   # файл удалили на сервере — у нас он живёт ещё столько дней
TAB=$(printf '\t')

MODE=sched; [ "${1:-}" = "--now" ] && MODE=now
# Установщик ждёт нас не дольше 90 с (у помощника тайм-аут на команду) — значит, 2 попытки за ~40 с.
# По расписанию спешить некуда: 3 попытки за ~3 минуты, дальше — следующий час.
if [ "$MODE" = now ]; then CT=15; RETRY_DELAYS="5"; else CT=20; RETRY_DELAYS="30 90"; fi
RETRY_DELAYS="${TASKA_RETRY_DELAYS:-$RETRY_DELAYS}"   # только для проверок
SSH_BASE=(-o BatchMode=yes -o ConnectTimeout=$CT -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
[ -n "${TASKA_SSH_CONFIG:-}" ] && SSH_BASE=(-F "$TASKA_SSH_CONFIG" "${SSH_BASE[@]}")

NOW=$(date +%s); TODAY=$(date +%F)
ts(){ date '+%d.%m.%Y %H:%M'; }
when(){ date -r "$1" '+%d.%m.%Y %H:%M'; }   # время из секунд
day(){ echo "$1" | awk -F- '{print $3"."$2}'; }   # 2026-11-12 → 12.11
log(){ printf '%s %s\n' "$(date '+%d.%m.%Y %H:%M:%S')" "$*" >> "$LOG"; [ "$MODE" = now ] && printf '%s\n' "$*"; return 0; }
hsize(){ awk -v b="$1" 'BEGIN{ if (b<1048576) printf "%d КБ", (b+1023)/1024; else if (b<1073741824) printf "%.1f МБ", b/1048576; else printf "%.1f ГБ", b/1073741824 }' | tr . ,; }
num(){ cat "$1" 2>/dev/null | head -1 | tr -cd '0-9'; }   # число из служебного файла (пусто, если нет)

mkdir -p "$DEST" "$STATE" || { echo "не могу создать папку $DEST" >&2; exit 1; }
TMPD=$(mktemp -d "${TMPDIR:-/tmp}/taska-backup.XXXXXX") || exit 1
ERRF="$TMPD/err"; : > "$ERRF"

# ---------- блокировка: два запуска сразу писали бы один файл (установщик + launchd, сон + вход) ----------
LOCK="$STATE/lock"
HUNG=${TASKA_HUNG_SECONDS:-43200}   # 12 часов (переменная — только для проверок): столько не идёт даже первая докачка большого хранилища на медленной связи
# ours PID ВРЕМЯ — жив, это наша копия и запущен не позже, чем взял блокировку: номер процесса мог
# достаться другому (после перезагрузки), и такую блокировку надо считать брошенной, а не «зависшей».
ours(){
  ps -p "$1" -o command= 2>/dev/null | grep -q 'taska-backup' || return 1
  local el; el=$(ps -p "$1" -o etime= 2>/dev/null | awk '{s=$1; d=0; if (index(s,"-")) {split(s,x,"-"); d=x[1]; s=x[2]}
     n=split(s,t,":"); print d*86400 + (n==3 ? t[1]*3600+t[2]*60+t[3] : t[1]*60+t[2])}')
  [ -n "$el" ] && [ $(( $(date +%s) - el )) -le $(( ${2:-0} + 5 )) ]
}
kill_tree(){ local c; for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done; kill -TERM "$1" 2>/dev/null; }
take_lock(){
  if mkdir "$LOCK" 2>/dev/null; then echo "$$ $NOW" > "$LOCK/info"; return 0; fi
  local pid="" t="" age
  read -r pid t < "$LOCK/info" 2>/dev/null
  if [ -z "$pid" ]; then   # хозяин только что создал папку и ещё не записал себя
    age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
    [ "$age" -lt 60 ] && return 1
  elif ours "$pid" "$t"; then
    # Живую копию НЕ перехватываем никогда (замечание критика 12.11.2026: перехват через 3 ч давал
    # два запуска в одной папке). Только явно зависшую дольше 12 ч — сначала убиваем вместе с sftp.
    [ $(( $(date +%s) - ${t:-0} )) -lt $HUNG ] && return 1
    log "прошлый запуск (PID $pid) висит больше 12 часов — останавливаю его"
    kill_tree "$pid"; sleep 3; ours "$pid" "$t" && return 1
  fi
  # брошенная: процесс умер (или его остановили выше)
  rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || return 1
  echo "$$ $NOW" > "$LOCK/info"; return 0
}
HAVE_LOCK=0; WD=""
cleanup(){
  [ -n "$WD" ] && kill "$WD" 2>/dev/null
  # снимаем только СВОЮ блокировку: если нас остановили как зависших, её уже взял другой запуск
  if [ "$HAVE_LOCK" = 1 ]; then local p=""; read -r p _ < "$LOCK/info" 2>/dev/null; [ "$p" = "$$" ] && rm -rf "$LOCK"; fi
  rm -rf "$TMPD" "$DEST"/.part-$$.sql.gz
}
trap cleanup EXIT
trap 'log "копию остановили, не дав закончить — продолжит следующий запуск"; exit 1' INT TERM HUP

# Установщик даёт нам только остаток своих 90 с (TASKA_DEADLINE, замечание критика 12.11.2026).
# Не уложились — сторож останавливает нас вместе с scp; копию доделает расписание.
if [ "$MODE" = now ] && [ -n "${TASKA_DEADLINE:-}" ]; then
  left=$(( TASKA_DEADLINE - $(date +%s) )); [ "$left" -lt 20 ] && left=20
  bash -c 'sleep "$1"; k(){ local c; for c in $(pgrep -P "$1"); do [ "$c" = "$$" ] || k "$c"; done; kill -TERM "$1" 2>/dev/null; }; k "$2"' _ "$left" "$$" > /dev/null 2>&1 &
  WD=$!
fi

if ! take_lock; then
  if [ "$MODE" = now ]; then   # установщику — подождать идущий запуск, но не дольше минуты
    i=0; while [ $i -lt 30 ] && ! take_lock; do sleep 2; i=$((i+1)); [ -n "${TASKA_DEADLINE:-}" ] && [ "$(date +%s)" -ge $(( TASKA_DEADLINE - 10 )) ] && i=30; done
    [ $i -lt 30 ] || { log "копия уже идёт другим запуском — подождите минуту и повторите"; exit 3; }
  else
    log "копия уже идёт другим запуском — этот пропускаю"; exit 0
  fi
fi
HAVE_LOCK=1

# журналы не растут без конца
trim(){ [ -f "$1" ] || return 0; [ "$(wc -l < "$1")" -gt $(( $2 + 100 )) ] || return 0
        tail -n "$2" "$1" > "$TMPD/trim" && cat "$TMPD/trim" > "$1"; }   # тот же файл: launchd держит его открытым
trim "$LOG" 1000; trim "$APP_DIR/launchd.log" 200

# ---------- ssh: ошибки разбираем по ТЕКСТУ ----------
# Код 255 — это и «нет связи», и «ключ не подходит», и «нет настройки taska». Повторять есть смысл
# только при обрыве связи; остальное само не пройдёт, и человеку нужен точный совет.
no_alias(){   # в настройке ssh нет своего адреса для «taska» — значит, блока Host taska нет
  case "$HOST" in *.*|*:*) return 1 ;; esac
  ssh -G "${SSH_BASE[@]}" "$HOST" 2>/dev/null | awk '$1=="hostname"{print $2}' | grep -qx "$HOST"
}
kind_of(){
  local rc="$1" e
  [ "$rc" = 0 ] && { echo ok; return; }
  e=$(tr -d '\r' < "$ERRF")
  # Нет блока «Host taska»: обычно «Could not resolve hostname», но VPN с подменой DNS (fake-ip)
  # «находит» любое имя, и ssh пишет просто «Connection closed». Поэтому спрашиваем саму настройку ssh.
  if [ "$rc" = 255 ] && no_alias; then echo nohost; return; fi
  case "$e" in
    *"Could not resolve hostname $HOST:"*) echo nohost ;;
    *"Permission denied ("*|*"Too many authentication failures"*|*"no such identity"*|*"UNPROTECTED PRIVATE KEY"*|*"Load key"*) echo key ;;
    *"IDENTIFICATION HAS CHANGED"*|*"Host key verification failed"*) echo hostkey ;;
    *"Connection refused"*|*"timed out"*|*"Connection closed"*|*"Connection reset"*|*"No route to host"*|*"Network is unreachable"*|*"Could not resolve hostname"*|*"kex_exchange_identification"*|*"Broken pipe"*) echo net ;;
    *) if [ "$rc" = 255 ]; then echo net; else echo remote; fi ;;
  esac
}
msg_of(){
  case "$1" in
    net)     echo "нет связи с сервером. Проверьте интернет; рабочий Wi-Fi иногда закрывает вход на серверы — попробуйте другую сеть. Копия сделается сама, когда связь появится." ;;
    key)     echo "ключ этого компьютера больше не подходит к серверу (так бывает, если «Подключить помощника» нажали на другом компьютере). Пройдите на этом компьютере шаг «Подключить помощника» из памятки." ;;
    hostkey) echo "сервер переустановлен или заменён. Пройдите шаг «Подключить помощника» из памятки." ;;
    nohost)  echo "на этом компьютере нет входа «ssh $HOST». Пройдите шаг «Подключить помощника» из памятки." ;;
    *)       echo "сервер ответил ошибкой: $(tr -d '\r' < "$ERRF" | tail -1)" ;;
  esac
}
# rssh ФАЙЛ команда… — команда на сервере; при обрыве связи повторяет. Итог — в KIND.
rssh(){
  local out="$1" d rc; shift
  for d in $RETRY_DELAYS last; do
    ssh -n "${SSH_BASE[@]}" "$HOST" "$@" > "$out" 2> "$ERRF"; rc=$?
    KIND=$(kind_of "$rc")
    [ "$KIND" = net ] && [ "$d" != last ] || return 0
    log "нет связи с сервером — ещё попытка через $d с"
    sleep "$d"
  done
}

PROBLEM=""; PMSG=""; CONTACT=0; DB_OK=0; RESULT=""; FPMSG=""

# ---------- база ----------
fetch_db(){   # $1 имя на сервере, $2 его sha256. 0 — готово, 1 — ошибка скачивания, 2 — файл на сервере битый
  local n="$1" sha="$2" part=".part-$$.sql.gz" rc got avail
  avail=$(df -k "$DEST" | awk 'NR==2{print $4}')
  [ "${avail:-0}" -gt 204800 ] || { PROBLEM=disk; PMSG="на этом компьютере кончается место (свободно $(hsize $(( ${avail:-0} * 1024 ))))."; return 1; }
  ( cd "$DEST" && scp -q "${SSH_BASE[@]}" "$HOST:$REMOTE/backups/$n" "$part" ) < /dev/null 2> "$ERRF"; rc=$?
  KIND=$(kind_of "$rc")
  if [ "$KIND" != ok ]; then
    rm -f "$DEST/$part"
    case "$KIND" in net|key|hostkey|nohost) PROBLEM=$KIND; PMSG=$(msg_of "$KIND") ;;
      *) PROBLEM=download; PMSG="копия не скачалась ($(tr -d '\r' < "$ERRF" | tail -1)). Попробую ещё раз при следующем запуске." ;; esac
    return 1
  fi
  got=$(shasum -a 256 "$DEST/$part" | cut -d' ' -f1)
  if [ "$got" != "$sha" ]; then
    rm -f "$DEST/$part"; PROBLEM=download; PMSG="копия скачалась с ошибкой. Попробую ещё раз при следующем запуске."; return 1
  fi
  # целый ли архив и настоящая ли внутри база (шапка pg_dump — в первых строках)
  if ! gzip -t "$DEST/$part" 2>/dev/null || ! { gzip -dc "$DEST/$part" 2>/dev/null | head -5 | grep -q "PostgreSQL database dump"; }; then
    rm -f "$DEST/$part"; return 2
  fi
  mv -f "$DEST/$part" "$DEST/taska-$n"
  echo "$NOW taska-$n $(stat -f %z "$DEST/taska-$n")" > "$STATE/last_copy"
  log "скачана копия базы taska-$n ($(hsize "$(stat -f %z "$DEST/taska-$n")")), проверена"
  return 0
}

db_step(){
  local n sha newest broken_newest=0 tries=0 got=""
  rssh "$TMPD/ls" ls -1 "$REMOTE/backups"
  case "$KIND" in
    ok) ;;
    remote) PROBLEM=server; PMSG="на сервере нет папки с копиями. Скажите помощнику: «настрой ночную копию по README» — это промпт 1 шага «Резервная копия»."; return ;;
    *) PROBLEM=$KIND; PMSG=$(msg_of "$KIND"); return ;;
  esac
  CONTACT=1
  grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.sql\.gz$' "$TMPD/ls" | sort -r > "$TMPD/names"
  newest=$(head -1 "$TMPD/names")
  if [ -z "$newest" ]; then
    PROBLEM=server; PMSG="на сервере нет ни одной ночной копии. Сначала промпт 1 шага «Резервная копия»."; return
  fi
  # Берём самую свежую, которой у нас нет. Битая на сервере — следующую по дате (но тревога будет).
  while read -r n; do
    [ -f "$DEST/taska-$n" ] && break           # эта уже есть — значит, и все старше неё
    tries=$((tries+1)); [ $tries -le 5 ] || break
    rssh "$TMPD/sha" sha256sum "$REMOTE/backups/$n"
    [ "$KIND" = ok ] || { [ "$KIND" = remote ] && continue; PROBLEM=$KIND; PMSG=$(msg_of "$KIND"); return; }
    sha=$(cut -d' ' -f1 < "$TMPD/sha")
    if grep -qx "$n $sha" "$STATE/bad" 2>/dev/null; then [ "$n" = "$newest" ] && broken_newest=1; continue; fi
    fetch_db "$n" "$sha"
    case $? in
      0) got=$n; break ;;
      2) echo "$n $sha" >> "$STATE/bad"; log "копия $n на сервере битая — не беру"
         [ "$n" = "$newest" ] && broken_newest=1 ;;
      *) return ;;
    esac
  done < "$TMPD/names"

  if [ $broken_newest = 1 ]; then
    PROBLEM=server; PMSG="свежая копия на сервере (за $(day "${newest%.sql.gz}")) битая — ночная копия работает неправильно. Скажите помощнику: «проверь ночную копию по README»."
  elif [ "${newest%.sql.gz}" \< "$(date -v-2d +%F)" ]; then
    # сервер перестал делать ночные копии: cron сломался, кончился диск…
    PROBLEM=server; PMSG="ночная копия на сервере не делается с $(day "${newest%.sql.gz}"). Скажите помощнику: «проверь ночную копию по README»."
    rssh "$TMPD/cron" crontab -l
    [ "$KIND" = net ] || grep -q 'backup\.sh' "$TMPD/cron" || PMSG="$PMSG В расписании сервера её нет."
  else
    DB_OK=1
  fi
  if [ -n "$got" ]; then RESULT="скачана новая копия taska-$got"
  elif [ -z "$PROBLEM" ]; then RESULT="новых копий на сервере пока нет, последняя (taska-$newest) уже здесь"; fi
  return 0
}

# ---------- файлы задач: только новое ----------
files_step(){
  local rdir need_n need_b avail rc missing=0
  rssh "$TMPD/flist" bash "$REMOTE/scripts/laptop/files-list.sh"
  case "$KIND" in
    ok) ;;
    remote) if grep -q '^NO-STORAGE' "$TMPD/flist"; then FPMSG="на сервере не нашёл хранилище файлов задач."
            else FPMSG="на сервере старая версия скриптов копии. Обновите её: повторите промпт 2 шага «Резервная копия»."; fi
            return 1 ;;
    *) FPMSG=$(msg_of "$KIND"); return 1 ;;
  esac
  rdir=$(awk -F'\t' 'NR==1 && $1=="DIR" {print $2}' "$TMPD/flist")
  # кавычки и шаблоны в путях сломали бы команду скачивания — такие пропускаем (у Таски их не бывает)
  awk -F'\t' 'NR>1 && NF==3 && $3 !~ /["\\*?[]/' "$TMPD/flist" > "$TMPD/remote"
  if [ -z "$rdir" ] || ! grep -q "${TAB}\.minio\.sys/format\.json\$" "$TMPD/remote"; then
    FPMSG="список файлов с сервера пришёл неполным — попробую в следующий раз."; return 1   # и ничего не трогаем
  fi
  mkdir -p "$FILES"; touch "$STATE/files.have" "$STATE/files.gone"
  : > "$TMPD/got"
  # Остатки оборванной докачки (сон, выключение, убитый процесс): докачанное целиком кладём на место,
  # а не качаем заново — иначе на медленной связи первая полная копия не закончилась бы никогда.
  # Берём файл, только если на сервере он всё тот же (размер и время из списка, по которому качали).
  local inc="$STATE/incoming" sz mt p
  if [ -f "$inc/.need" ]; then
    awk 'BEGIN{FS=OFS="\t"} FILENAME==ARGV[1]{r[$3]=$1 FS $2; next} ($3 in r) && r[$3]==$1 FS $2' \
        "$TMPD/remote" "$inc/.need" > "$TMPD/salv"
    while IFS="$TAB" read -r sz mt p; do
      if [ -f "$inc/$p" ] && [ "$(stat -f %z "$inc/$p")" = "$sz" ]; then
        mkdir -p "$FILES/$(dirname "$p")" && mv -f "$inc/$p" "$FILES/$p" && printf '%s\t%s\t%s\n' "$sz" "$mt" "$p" >> "$TMPD/got"
      fi
    done < "$TMPD/salv"
    [ -s "$TMPD/got" ] && log "файлы задач: с прошлой оборванной докачки взял готовых $(wc -l < "$TMPD/got" | tr -d ' ')"
    awk 'BEGIN{FS=OFS="\t"} FILENAME==ARGV[1]{got[$3]=1; print; next} !($3 in got)' "$TMPD/got" "$STATE/files.have" > "$TMPD/have0" \
      && cp "$TMPD/have0" "$STATE/files.have"
  fi
  rm -rf "$inc"
  ( cd "$FILES" && find . -type f -print0 | xargs -0 stat -f '%z%t%N' 2>/dev/null ) \
    | awk 'BEGIN{FS=OFS="\t"} {sub(/^\.\//,"",$2); print}' > "$TMPD/local"
  # нужно: нового нет у нас, изменился (размер/время на сервере) или наш файл пропал/недокачан
  awk 'BEGIN{FS=OFS="\t"}
       FILENAME==ARGV[1] {have[$3]=$1 FS $2; next}
       FILENAME==ARGV[2] {loc[$2]=$1; next}
       !(($3 in have) && have[$3]==$1 FS $2 && ($3 in loc) && loc[$3]==$1)' \
       "$STATE/files.have" "$TMPD/local" "$TMPD/remote" > "$TMPD/need"
  need_n=$(wc -l < "$TMPD/need" | tr -d ' ')
  need_b=$(awk -F'\t' '{s+=$1} END{printf "%.0f", s}' "$TMPD/need")
  if [ "$need_n" -gt 0 ]; then
    avail=$(df -k "$DEST" | awk 'NR==2{print $4}')
    if [ $(( need_b / 1024 + 1048576 )) -gt "${avail:-0}" ]; then
      FPMSG="на этом компьютере мало места: для файлов задач нужно ещё $(hsize "$need_b"), свободно $(hsize $(( ${avail:-0} * 1024 )))."; return 1
    fi
    log "файлы задач: докачиваю $need_n ($(hsize "$need_b"))"
    # Качаем во временную папку одним соединением, на место кладём только проверенное по размеру:
    # оборванная докачка не оставит в копии полфайла. Список .need — для подбора остатков (см. выше).
    mkdir -p "$inc" && cp "$TMPD/need" "$inc/.need"
    awk -F'\t' '{p=$3; if (sub(/\/[^\/]*$/,"",p)) print p}' "$TMPD/need" | sort -u | tr '\n' '\0' | ( cd "$inc" && xargs -0 mkdir -p )
    awk -F'\t' -v r="$rdir" '{printf "-get \"%s/%s\" \"%s\"\n", r, $3, $3}' "$TMPD/need" > "$TMPD/batch"
    ( cd "$inc" && sftp -q -b "$TMPD/batch" "${SSH_BASE[@]}" "$HOST" ) < /dev/null > /dev/null 2> "$ERRF"; rc=$?
    while IFS="$TAB" read -r sz mt p; do
      if [ -f "$inc/$p" ] && [ "$(stat -f %z "$inc/$p")" = "$sz" ]; then
        mkdir -p "$FILES/$(dirname "$p")" && mv -f "$inc/$p" "$FILES/$p" && printf '%s\t%s\t%s\n' "$sz" "$mt" "$p" >> "$TMPD/got"
      else missing=$((missing+1)); fi
    done < "$TMPD/need"
    rm -rf "$inc"
  else rc=0; fi
  # учёт: что у нас есть (по данным сервера) и что пропало с сервера
  awk 'BEGIN{FS=OFS="\t"} FILENAME==ARGV[1]{got[$3]=1; print; next} !($3 in got)' "$TMPD/got" "$STATE/files.have" > "$TMPD/have"
  awk 'BEGIN{FS=OFS="\t"} FILENAME==ARGV[1]{r[$3]=1; next} !($3 in r){print $3}' "$TMPD/remote" "$TMPD/have" > "$TMPD/gone_now"
  awk -v today="$TODAY" 'BEGIN{FS=OFS="\t"} FILENAME==ARGV[1]{d[$2]=$1; next} {print (($1 in d) ? d[$1] : today), $1}' \
      "$STATE/files.gone" "$TMPD/gone_now" > "$TMPD/gone"
  # удалённое на сервере держим GONE_DAYS дней — вдруг удалили по ошибке; потом убираем и у себя
  awk -F'\t' -v cut="$(date -v-${GONE_DAYS}d +%F)" '$1 < cut {print $2}' "$TMPD/gone" > "$TMPD/expired"
  if [ -s "$TMPD/expired" ]; then
    while IFS= read -r p; do rm -f "$FILES/$p"; done < "$TMPD/expired"
    awk 'BEGIN{FS=OFS="\t"} FILENAME==ARGV[1]{x[$1]=1; next} !($3 in x)' "$TMPD/expired" "$TMPD/have" > "$TMPD/have2" && mv -f "$TMPD/have2" "$TMPD/have"
    awk 'BEGIN{FS=OFS="\t"} FILENAME==ARGV[1]{x[$1]=1; next} !($2 in x)' "$TMPD/expired" "$TMPD/gone" > "$TMPD/gone2" && mv -f "$TMPD/gone2" "$TMPD/gone"
    find "$FILES" -mindepth 1 -type d -empty -delete 2>/dev/null
    log "файлы задач: убрал $(wc -l < "$TMPD/expired" | tr -d ' ') удалённых на сервере больше $GONE_DAYS дней назад"
  fi
  cp "$TMPD/have" "$STATE/files.have"; cp "$TMPD/gone" "$STATE/files.gone"
  if [ "$rc" != 0 ]; then
    KIND=$(kind_of "$rc"); FPMSG="докачка файлов задач оборвалась ($(wc -l < "$TMPD/got" | tr -d ' ') из $need_n готово) — продолжу в следующий раз."
    log "файлы задач: $FPMSG"; return 1
  fi
  [ "$missing" -gt 0 ] && log "файлы задач: $missing не скачались (их, видимо, только что удалили) — проверю в следующий раз"
  echo "$TODAY" > "$STATE/files_day"; echo "$NOW" > "$STATE/files_ok"
  log "файлы задач сверены: $(wc -l < "$STATE/files.have" | tr -d ' ') файлов, новых $(wc -l < "$TMPD/got" | tr -d ' ')"
  return 0
}

# ---------- запуск ----------
if [ "$MODE" = sched ]; then
  echo "$NOW" > "$STATE/last_sched"
  newest_local=$(ls -1 "$DEST" 2>/dev/null | grep -E '^taska-[0-9]{4}-[0-9]{2}-[0-9]{2}\.sql\.gz$' | sort | tail -1)
  nl_day=${newest_local#taska-}; nl_day=${nl_day%.sql.gz}
  # Решаем по файлам, а не по часам: копия с сегодняшней датой есть и файлы сегодня сверены — сеть не трогаем.
  # (Дата копии — по часам сервера; у тех, кто восточнее сервера, «сегодняшняя» придёт к обеду — это нормально.)
  # Отметки на сервере тоже должны быть сегодняшние: не поставилась (обрыв) — повторим через час.
  if [ -n "$nl_day" ] && ! [ "$nl_day" \< "$TODAY" ] && [ "$(cat "$STATE/files_day" 2>/dev/null)" = "$TODAY" ] \
     && [ "$(cat "$STATE/mark_day" 2>/dev/null)" = "$TODAY" ] && [ "$(cat "$STATE/fmark_day" 2>/dev/null)" = "$TODAY" ]; then
    log "запуск по расписанию: копия за сегодня уже есть"; exit 0
  fi
  log "запуск по расписанию (версия $VERSION)"
else
  log "запуск вручную (версия $VERSION)"
fi

db_step
FILES_RAN=0
if [ "$MODE" = sched ] && [ "$CONTACT" = 1 ] && [ "$(cat "$STATE/files_day" 2>/dev/null)" != "$TODAY" ]; then
  FILES_RAN=1; files_step
fi

# храним KEEP самых свежих копий базы
ls -1 "$DEST" | grep -E '^taska-[0-9]{4}-[0-9]{2}-[0-9]{2}\.sql\.gz$' | sort -r | tail -n +$((KEEP+1)) | while IFS= read -r f; do
  rm -f "$DEST/$f"; log "старая копия $f удалена (храню $KEEP)"
done

# Отметки для ночного отчёта сервера — раз в день, каждая своя (замечание критика 12.11.2026):
#   .laptop-ok        — база забрана;
#   .laptop-files-ok  — файлы задач сверены. Без неё сервер молчал бы, если файлы неделями не копируются
#                       (мало места на ноутбуке, обрыв, хранилище переехало). Первая отметка базы
#                       заводит и её, если её ещё нет, — от неё и пойдёт отсчёт «не забирал файлы».
if [ "$DB_OK" = 1 ]; then
  echo "$NOW" > "$STATE/last_good"
  if [ "$(cat "$STATE/mark_day" 2>/dev/null)" != "$TODAY" ]; then
    rssh /dev/null "touch $REMOTE/backups/.laptop-ok && { [ -e $REMOTE/backups/.laptop-files-ok ] || touch $REMOTE/backups/.laptop-files-ok; }"
    [ "$KIND" = ok ] && echo "$TODAY" > "$STATE/mark_day"
  fi
fi
if [ "$(cat "$STATE/files_day" 2>/dev/null)" = "$TODAY" ] && [ "$(cat "$STATE/fmark_day" 2>/dev/null)" != "$TODAY" ]; then
  rssh /dev/null touch "$REMOTE/backups/.laptop-files-ok"
  [ "$KIND" = ok ] && echo "$TODAY" > "$STATE/fmark_day"
fi
[ -n "$PROBLEM" ] && log "ОШИБКА: $PMSG"

# ---------- «Последняя копия.txt» ----------
LAST_GOOD=$(num "$STATE/last_good"); INSTALLED=$(num "$STATE/installed")
SINCE=${LAST_GOOD:-${INSTALLED:-$NOW}}
N_COPIES=$(ls -1 "$DEST" | grep -cE '^taska-[0-9]{4}-[0-9]{2}-[0-9]{2}\.sql\.gz$')
{
  if [ -n "$PROBLEM" ]; then
    if [ "$PROBLEM" = server ]; then echo "ВНИМАНИЕ: $PMSG"   # беда на сервере, а не у ноутбука
    else echo "ВНИМАНИЕ: копия не обновлялась с $(date -r "$SINCE" '+%d.%m.%Y'): $PMSG"; fi
    echo
  fi
  echo "Копия Таски на этом компьютере (версия $VERSION)."
  if [ -f "$STATE/last_copy" ]; then
    read -r lc_t lc_n lc_s < "$STATE/last_copy"
    echo "Последняя скачанная копия базы: $(when "$lc_t") — $lc_n ($(hsize "$lc_s")), проверена."
  else
    echo "Копий базы пока нет."
  fi
  if [ -f "$STATE/files_ok" ]; then
    fb=$(awk -F'\t' '{s+=$1} END{printf "%.0f", s}' "$STATE/files.have")
    echo "Файлы задач: $(wc -l < "$STATE/files.have" | tr -d ' ') файлов ($(hsize "$fb")), сверены с сервером $(when "$(num "$STATE/files_ok")")."
  else
    echo "Файлы задач: ещё не копировались."
  fi
  [ -n "$FPMSG" ] && echo "Файлы задач сейчас: $FPMSG"
  if [ -n "$PROBLEM" ]; then echo "Последняя проверка: $(ts) — не вышло (см. первую строку)."
  else echo "Последняя проверка: $(ts) — $RESULT."; fi
  echo "Копий базы на этом компьютере: $N_COPIES (храню $KEEP)."
  echo
  echo "Папка files — копия хранилища файлов Таски (договоры, фото). Открыть файл прямо из неё нельзя: её возвращают в Таску целиком, см. README «Копия на ноутбук»."
} > "$TMPD/status" && cp "$TMPD/status" "$STATUS"

# ---------- окно тревоги: не чаще раза в сутки и не блокируя запуск ----------
alarm(){
  local last; last=$(num "$STATE/last_alarm")
  [ $(( NOW - ${last:-0} )) -ge 86400 ] || return 0
  echo "$NOW" > "$STATE/last_alarm"          # сначала отметка, потом окно: упавшее окно не повторится каждый час
  log "показываю окно: $1"
  local title="Копия Таски не делается" text="$1

Подробности — в папке TaskaBackup, файл «Последняя копия.txt»."
  if [ -n "${TASKA_ALERT_CMD:-}" ]; then "$TASKA_ALERT_CMD" "$title" "$text" > /dev/null 2>&1 &
  else osascript -e 'on run argv' -e 'display alert (item 1 of argv) message (item 2 of argv) as critical giving up after 3600' -e 'end run' "$title" "$text" > /dev/null 2>&1 &
  fi
}
if [ "$MODE" = sched ]; then
  QUIET=$(( NOW - SINCE ))
  REASON=""
  case "$PROBLEM" in
    "") ;;
    server) REASON="$PMSG" ;;                                               # сам не пройдёт — сразу
    key|hostkey|nohost) [ $QUIET -ge 86400 ] && REASON="Копии нет с $(date -r "$SINCE" '+%d.%m'): $PMSG" ;;
    net) [ $QUIET -ge 259200 ] && REASON="Копии нет с $(date -r "$SINCE" '+%d.%m'): сервер не отвечает. Откройте свою Таску в браузере. Не открывается — сервер выключен или не оплачен: зайдите в кабинет hoster.kz. Открывается — рабочий Wi-Fi иногда закрывает вход на серверы: попробуйте другую сеть, а если не поможет, скажите помощнику «проверь копию Таски на этом компьютере по README»." ;;
    *) [ $QUIET -ge 259200 ] && REASON="Копии нет с $(date -r "$SINCE" '+%d.%m'): $PMSG" ;;   # прочее: 3 дня
  esac
  if [ -z "$REASON" ] && [ -n "$FPMSG" ]; then
    FOK=$(num "$STATE/files_ok"); [ $(( NOW - ${FOK:-${INSTALLED:-$NOW}} )) -ge 259200 ] && REASON="Файлы задач не копируются: $FPMSG"
  fi
  [ -n "$REASON" ] && alarm "$REASON"
fi

[ -n "$PROBLEM" ] && exit 1
exit 0
