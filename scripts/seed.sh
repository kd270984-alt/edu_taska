#!/usr/bin/env bash
# Демо-данные: несколько задач на текущую неделю, чтобы календарь был не пустым.
# Запуск:  bash scripts/seed.sh admin@example.com 'пароль'  [адрес]
# Адрес по умолчанию — http://127.0.0.1:8088
set -euo pipefail

EMAIL="${1:-}"; PASS="${2:-}"; BASE="${3:-http://127.0.0.1:8088}"
if [ -z "$EMAIL" ] || [ -z "$PASS" ]; then
  echo "Нужны логин и пароль: bash scripts/seed.sh admin@example.com 'пароль' [адрес]" >&2
  exit 1
fi

TOKEN=$(curl -fsS -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')
[ -n "$TOKEN" ] || { echo "Не удалось войти — проверьте логин и пароль" >&2; exit 1; }

ME=$(curl -fsS "$BASE/api/auth/me" -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["user"]["id"])')

day(){ python3 -c "import datetime,sys;print((datetime.date.today()+datetime.timedelta(days=int(sys.argv[1]))).isoformat())" "$1"; }

add(){ # add <сдвиг в днях> <название> [время]
  local d; d=$(day "$1")
  local body
  body=$(python3 - "$d" "$2" "${3:-}" "$ME" <<'PY'
import json,sys
d,name,tm,me=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]
b={"name":name,"due_date":d,"assignee_id":me}
if tm: b["due_time"]=tm
print(json.dumps(b,ensure_ascii=False))
PY
)
  curl -fsS -o /dev/null -X POST "$BASE/api/tasks" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d "$body"
  echo "  + $2 ($d${3:+, $3})"
}

echo "Создаю демо-задачи:"
add 0 "Планёрка команды" "10:00"
add 0 "Позвонить клиенту"
add 1 "Собрать отчёт за неделю"
add 2 "Согласовать смету"
add 3 "Встреча с подрядчиком" "15:30"
add 5 "Проверить остатки на складе"
echo "Готово. Откройте $BASE"
