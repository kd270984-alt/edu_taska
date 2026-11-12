#!/usr/bin/env bash
# CRM ДЛЯ ПРИМЕРА: включить, выключить, загрузить или стереть демо «Плёнка и Короб».
# Решение владельца 11.11.2026: простой раздел «CRM» в меню Таски — клиенты, сделки, товары.
#
#   bash scripts/crm-demo.sh on            включить раздел и загрузить пример (если в CRM пусто)
#   bash scripts/crm-demo.sh off           выключить раздел — данные CRM остаются в базе
#   bash scripts/crm-demo.sh reset --yes   стереть данные CRM и загрузить пример заново
#   bash scripts/crm-demo.sh clear --yes   стереть данные CRM (раздел остаётся включённым)
#   bash scripts/crm-demo.sh status        включена ли CRM и сколько в ней записей
#
# Людей, задачи и метки Таски скрипт НЕ трогает — только таблицы crm_*.
# Запускать в папке Таски (там, где docker-compose.yml и .env). Нужен docker compose.
# ⚠️ on и off перезапускают api: настройка из .env доезжает до контейнера только при его пересоздании.
#    Обычно минута-две (api заново ставит пакеты), при медленном интернете — до 10 минут.
#    Таска в это время не отвечает, данные не страдают.
set -euo pipefail
cd "$(dirname "$0")/.."
CMD="${1:-}"
YES="${2:-}"

[ -f docker-compose.yml ] && [ -f .env ] || { echo "Нет docker-compose.yml или .env — запустите скрипт в папке Таски" >&2; exit 1; }
[ -f api/src/crm.ts ] || { echo "В этой версии Таски ещё нет CRM — сначала обновите её с GitHub (git pull)" >&2; exit 1; }

# значение CRM_DEMO из .env: последняя строка, без пробелов и комментария
flag(){ grep -E '^CRM_DEMO=' .env | tail -1 | cut -d= -f2- | sed -E 's/[[:space:]]*#.*$//' | tr -d ' "\r' || true; }
set_flag(){
  if grep -qE '^CRM_DEMO=' .env; then
    sed -i.bak -E "s/^CRM_DEMO=.*/CRM_DEMO=$1/" .env && rm -f .env.bak   # -i.bak одинаково понимают Linux и Mac
  else
    [ -z "$(tail -c1 .env)" ] || echo >> .env                             # последняя строка без перевода — не склеиваем
    printf '\n# CRM для примера: 1 — раздел «CRM» в меню включён, 0 — выключен (bash scripts/crm-demo.sh on/off)\nCRM_DEMO=%s\n' "$1" >> .env
  fi
}
api_up(){ docker compose exec -T api node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; }
wait_api(){
  for _ in $(seq 1 300); do api_up && return 0; sleep 2; done
  echo "api не поднялся за 10 минут — посмотрите журнал: docker compose logs api --tail 50" >&2; exit 1
}
recreate_api(){
  echo "Перезапускаю api с новой настройкой — обычно минута-две, при медленном интернете дольше. Ждите…"
  local out; out=$(docker compose up -d --force-recreate --no-deps api 2>&1) || { echo "$out" >&2; echo "Не удалось перезапустить api — сообщение docker выше" >&2; exit 1; }
  wait_api
  local got; got=$(docker compose exec -T api printenv CRM_DEMO 2>/dev/null | tr -d '\r' || true)
  [ "$got" = "$1" ] || { echo "api запустился, но не видит CRM_DEMO=$1 (видит «$got») — проверьте .env" >&2; exit 1; }
}
cli(){ wait_api; docker compose exec -T api node_modules/.bin/tsx src/crm-cli.ts "$1"; }
sure(){ # стирание — только с явным согласием
  [ "$YES" = "--yes" ] && return 0
  if [ -t 0 ]; then
    read -r -p "$1 [да/нет] " a
    case "$a" in д|да|Да|ДА|y|Y|yes) return 0 ;; esac
    echo "Отменено."; exit 1
  fi
  echo "$1 Чтобы подтвердить, добавьте --yes: bash scripts/crm-demo.sh $CMD --yes" >&2; exit 1
}

case "$CMD" in
  on)
    set_flag 1
    recreate_api 1
    cli load
    echo "Готово: в меню Таски появился раздел «CRM». Обновите страницу (Ctrl+Shift+R)."
    ;;
  off)
    set_flag 0
    recreate_api 0
    echo "Раздел «CRM» выключен, данные CRM остались в базе. Включить снова: bash scripts/crm-demo.sh on"
    ;;
  reset)
    sure "Стереть ВСЕ данные CRM (клиентов, сделки, товары) и загрузить пример заново?"
    cli reset
    ;;
  clear)
    sure "Стереть ВСЕ данные CRM (клиентов, сделки, товары)?"
    cli clear
    ;;
  status)
    f=$(flag); echo "В .env: CRM_DEMO=${f:-не задано} — раздел «CRM» $([ "$f" = 1 ] && echo включён || echo выключен)"
    if api_up; then cli status; else echo "api сейчас не отвечает — сколько записей, не узнать"; fi
    ;;
  *)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
