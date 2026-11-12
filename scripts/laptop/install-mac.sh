#!/bin/bash
# УСТАНОВЩИК КОПИИ ТАСКИ НА НОУТБУК (Mac). Его запускает помощник по промпту «Копия на ноутбук»:
#   scp taska:/root/taska-edu/scripts/laptop/install-mac.sh /tmp/ && bash /tmp/install-mac.sh
# Забирает с сервера остальные скрипты, делает первую копию, ставит расписание launchd и проверяет его.
# Повторный запуск безопасен — так же копия и обновляется (сами копии и их учёт не трогает).
#
# Замечания критика 11.11.2026, учтённые здесь:
#   - сначала первая копия напрямую (её вывод видит помощник), потом расписание: launchd запускает
#     задачу сразу при установке (RunAtLoad), и наоборот два запуска писали бы один файл;
#   - kickstart -k не нужен и опасен (обрывает идущую копию): ждём запуск от RunAtLoad;
#   - весь установщик укладывается в 90 с — у помощника тайм-аут на команду;
#   - в песочнице помощника launchd недоступен — говорим об этом прямо, а не падаем непонятно.
set -u
umask 077
T0=$(date +%s)
HOST="${TASKA_HOST:-taska}"
REMOTE="${TASKA_REMOTE_DIR:-/root/taska-edu}"
DEST="${TASKA_BACKUP_DIR:-$HOME/TaskaBackup}"
APP="${TASKA_APP_DIR:-$HOME/.taska-backup}"
LABEL="${TASKA_LABEL:-local.taska.backup}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UIDN=$(id -u)
SSH_BASE=(-o BatchMode=yes -o ConnectTimeout=15)
[ -n "${TASKA_SSH_CONFIG:-}" ] && SSH_BASE=(-F "$TASKA_SSH_CONFIG" "${SSH_BASE[@]}")
TMP=$(mktemp -d "${TMPDIR:-/tmp}/taska-install.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

say(){ echo "• $*"; }
stop(){ echo; echo "НЕ УСТАНОВЛЕНО: $*"; exit 1; }

echo "Ставлю копию Таски на этот компьютер…"
[ "$(uname -s)" = Darwin ] || stop "этот установщик — для Mac. На Windows — install-windows.ps1. Linux и WSL не поддерживаются: держите копию вручную (промпт «Скачать копию вручную» в памятке)."
[ "$UIDN" != 0 ] || stop "запущено от root (через sudo). Запустите без sudo, от своего пользователя."
CU=$(stat -f %Su /dev/console 2>/dev/null)
[ -z "$CU" ] || [ "$CU" = "$(id -un)" ] || stop "запущено не от того пользователя, кто сейчас за компьютером ($CU). Запустите от своего пользователя."
launchctl print "gui/$UIDN" >/dev/null 2>&1 \
  || stop "нет доступа к расписанию macOS: помощник работает в песочнице. Разрешите ему выполнить установщик вне песочницы и повторите."
mkdir -p "$HOME/Library/LaunchAgents" 2>/dev/null
touch "$HOME/Library/LaunchAgents/.taska-check-$$" 2>/dev/null && rm -f "$HOME/Library/LaunchAgents/.taska-check-$$" \
  || stop "нет права записи в ~/Library/LaunchAgents: помощник работает в песочнице. Разрешите ему выполнить установщик вне песочницы и повторите."

# ---------- сервер: вход, скрипты, копии. Ошибки ssh разбираем по тексту ----------
rcheck(){   # rcheck ФАЙЛ команда… ; две попытки, только если обрыв связи
  local out="$1" i rc; shift
  for i in 1 2; do
    ssh -n "${SSH_BASE[@]}" "$HOST" "$@" > "$out" 2> "$TMP/err"; rc=$?
    [ $rc = 0 ] && return 0
    case "$(tr -d '\r' < "$TMP/err")" in
      *"Could not resolve hostname $HOST:"*) stop "на этом компьютере нет входа «ssh $HOST». Сначала шаг «Подключить помощника» из памятки, потом этот промпт ещё раз." ;;
      *"Permission denied ("*|*"Too many authentication failures"*|*"no such identity"*|*"UNPROTECTED PRIVATE KEY"*|*"Load key"*)
        stop "ключ этого компьютера не подходит к серверу (так бывает, если «Подключить помощника» нажали на другом компьютере — это отключает ключ этого). Пройдите на этом компьютере шаг «Подключить помощника» и повторите." ;;
      *"IDENTIFICATION HAS CHANGED"*|*"Host key verification failed"*) stop "сервер переустановлен или заменён. Пройдите шаг «Подключить помощника» и повторите." ;;
    esac
    # нет блока Host taska (VPN с подменой DNS «находит» любое имя — смотрим саму настройку ssh)
    if [ $rc = 255 ] && case "$HOST" in *.*|*:*) false ;; *) true ;; esac \
       && ssh -G "${SSH_BASE[@]}" "$HOST" 2>/dev/null | awk '$1=="hostname"{print $2}' | grep -qx "$HOST"; then
      stop "на этом компьютере нет входа «ssh $HOST». Сначала шаг «Подключить помощника» из памятки, потом этот промпт ещё раз."
    fi
    [ $rc = 255 ] || return $rc   # сервер ответил, но команда не вышла
    [ $i = 1 ] && sleep 5
  done
  stop "нет связи с сервером. Проверьте интернет; рабочий Wi-Fi иногда закрывает вход на серверы — попробуйте другую сеть и повторите."
}
rcheck "$TMP/scripts" ls -1 "$REMOTE/scripts/laptop" \
  || stop "на сервере нет папки scripts/laptop — сначала обновите скрипты Таски на сервере (пункт 1 этого промпта)."
grep -qx taska-backup.sh "$TMP/scripts" || stop "на сервере неполная папка scripts/laptop — обновите скрипты Таски на сервере (пункт 1 этого промпта)."
rcheck "$TMP/ls" ls -1 "$REMOTE/backups" || true
grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.sql\.gz$' "$TMP/ls" \
  || stop "на сервере нет ни одной ночной копии. Сначала промпт 1 этого шага (ночная копия на сервере), потом этот ещё раз."
say "сервер на связи, ночные копии на нём есть"

AVAIL=$(df -k "$HOME" | awk 'NR==2{print $4}')
[ "${AVAIL:-0}" -gt 1048576 ] || stop "на этом компьютере свободно меньше 1 ГБ — освободите место и повторите."

# ---------- скрипты с сервера ----------
scp -q -r "${SSH_BASE[@]}" "$HOST:$REMOTE/scripts/laptop" "$TMP/" < /dev/null 2> "$TMP/err" \
  || stop "не скачались скрипты с сервера: $(tail -1 "$TMP/err")"
[ -s "$TMP/laptop/taska-backup.sh" ] || stop "не скачались скрипты с сервера."
# старый запуск по расписанию — остановить ДО первой копии, чтобы не было двух запусков сразу
launchctl bootout "gui/$UIDN/$LABEL" >/dev/null 2>&1
i=0; while [ $i -lt 10 ] && launchctl print "gui/$UIDN/$LABEL" >/dev/null 2>&1; do sleep 1; i=$((i+1)); done
mkdir -p "$APP" && cp -f "$TMP"/laptop/* "$APP"/ && chmod 700 "$APP"/*.sh || stop "не смог записать скрипты в $APP"
mkdir -p "$DEST/.state"
[ -f "$DEST/.state/installed" ] || date +%s > "$DEST/.state/installed"
say "скрипты версии $(head -1 "$APP/VERSION") — в $APP"

# ---------- первая копия: напрямую, чтобы помощник видел, что вышло ----------
echo "• первая копия базы:"
"$APP/taska-backup.sh" --now | sed 's/^/    /'
FIRST=${PIPESTATUS[0]}

# ---------- расписание: каждый час в :17, при входе в систему; после сна — сразу ----------
x(){ printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
ENVXML=""
for v in TASKA_HOST TASKA_REMOTE_DIR TASKA_BACKUP_DIR TASKA_SSH_CONFIG; do   # только для проверок; у учеников пусто
  eval "val=\${$v:-}"
  [ -n "$val" ] && ENVXML="$ENVXML<key>$v</key><string>$(x "$val")</string>"
done
[ -n "$ENVXML" ] && ENVXML="<key>EnvironmentVariables</key><dict>$ENVXML</dict>"
cat > "$PLIST.tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(x "$LABEL")</string>
  <key>ProgramArguments</key><array><string>$(x "$APP/taska-backup.sh")</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartCalendarInterval</key><dict><key>Minute</key><integer>17</integer></dict>
  <key>ProcessType</key><string>Background</string>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$(x "$APP/launchd.log")</string>
  <key>StandardErrorPath</key><string>$(x "$APP/launchd.log")</string>
  $ENVXML
</dict>
</plist>
EOF
plutil -lint "$PLIST.tmp" >/dev/null || stop "не вышел файл расписания (plist)."
mv -f "$PLIST.tmp" "$PLIST"
T1=$(date +%s)
launchctl enable "gui/$UIDN/$LABEL" 2>/dev/null   # если ученик когда-то выключал — включаем обратно
if ! launchctl bootstrap "gui/$UIDN" "$PLIST" 2> "$TMP/err"; then
  sleep 2; launchctl bootstrap "gui/$UIDN" "$PLIST" 2> "$TMP/err" || stop "macOS не принял расписание: $(tail -1 "$TMP/err")"
fi
# launchd сам запускает задачу при установке — ждём её отметку (не дольше минуты и в пределах 90 с)
OK=0
while [ $(( $(date +%s) - T1 )) -lt 60 ] && [ $(( $(date +%s) - T0 )) -lt 85 ]; do
  S=$(cat "$DEST/.state/last_sched" 2>/dev/null | tr -cd '0-9')
  [ -n "$S" ] && [ "$S" -ge "$T1" ] && { OK=1; break; }
  sleep 1
done
[ $OK = 1 ] || stop "расписание поставлено, но запуск по нему не прошёл за минуту. Покажите помощнику файл $APP/launchd.log."
say "расписание стоит и сработало: каждый час, при включении и сразу после сна"

# ---------- итог ----------
NEWEST=$(ls -1 "$DEST" 2>/dev/null | grep -E '^taska-[0-9]{4}-[0-9]{2}-[0-9]{2}\.sql\.gz$' | sort | tail -1)
echo
echo "Готово. Папка с копиями: $DEST"
[ -n "$NEWEST" ] && echo "Свежая копия базы: $NEWEST ($(du -h "$DEST/$NEWEST" | cut -f1 | tr -d ' ')). Файлы задач докачиваются в фоне."
echo "macOS может показать уведомление о фоновом объекте «taska-backup.sh» — это копия, так и задумано, не выключайте её."
[ "${TASKA_NO_OPEN:-}" = 1 ] || open "$DEST" 2>/dev/null
if [ "$FIRST" != 0 ]; then
  echo
  echo "НО ПЕРВАЯ КОПИЯ НЕ ВЫШЛА: $(head -1 "$DEST/Последняя копия.txt" | sed 's/^ВНИМАНИЕ: //')"
  exit 2
fi
exit 0
