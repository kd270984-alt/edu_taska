#!/usr/bin/env bash
# Дымовой прогон: проверяет, что живое приложение делает всё, что обещает.
# Запуск:  bash scripts/smoke.sh admin@example.com 'пароль' [адрес]   (первый параметр — логин)
set -uo pipefail

EMAIL="${1:-}"; PASS="${2:-}"; BASE="${3:-http://127.0.0.1:8088}"
[ -n "$EMAIL" ] && [ -n "$PASS" ] || { echo "Нужны логин и пароль" >&2; exit 1; }

OK=0; BAD=0
ok(){ echo "  ✓ $1"; OK=$((OK+1)); }
no(){ echo "  ✗ $1"; BAD=$((BAD+1)); }
check(){ # check <описание> <ожидаемый код> <curl-аргументы...>
  local msg="$1" want="$2"; shift 2
  local code; code=$(curl -s -o /tmp/smoke.out -w '%{http_code}' --max-time 10 "$@")
  [ "$code" = "$want" ] && ok "$msg" || no "$msg (ждали $want, получили $code)"
}
json(){ python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }

echo "Дымовой прогон: $BASE"

echo "Сервис"
check "страница отдаётся" 200 "$BASE/"
check "api живо" 200 "$BASE/api/health"

echo "Вход"
TOKEN=$(curl -s --max-time 10 -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | json "['token']")
[ -n "${TOKEN:-}" ] && ok "вход по паролю" || { no "вход по паролю"; echo "Дальше без токена нельзя"; exit 1; }
A=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')
ME=$(curl -s --max-time 10 "${A[@]}" "$BASE/api/auth/me" | json "['user']['id']")
[ -n "${ME:-}" ] && ok "сессия узнаёт пользователя" || no "сессия узнаёт пользователя"
check "чужой токен не пускает" 401 "$BASE/api/tasks" -H "Authorization: Bearer подделка"

echo "Удалённые возможности больше не отвечают"
for p in projects layouts stickers brush boards db/tables; do check "/api/$p → 404" 404 "$BASE/api/$p" "${A[@]}"; done

echo "Задачи"
TODAY=$(python3 -c "import datetime;print(datetime.date.today().isoformat())")
NEXT=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=3)).isoformat())")
ID=$(curl -s --max-time 10 -X POST "$BASE/api/tasks" "${A[@]}" \
  -d "{\"name\":\"[smoke] задача\",\"due_date\":\"$TODAY\",\"assignee_id\":\"$ME\"}" | json "['task']['id']")
[ -n "${ID:-}" ] && ok "создание задачи" || { no "создание задачи"; exit 1; }
check "без даты — отказ" 400 -X POST "$BASE/api/tasks" "${A[@]}" -d '{"name":"[smoke] без даты"}'
check "дату убрать нельзя" 400 -X PATCH "$BASE/api/tasks/$ID" "${A[@]}" -d '{"due_date":null}'
check "битая дата — отказ" 400 -X PATCH "$BASE/api/tasks/$ID" "${A[@]}" -d '{"due_date":"31.12.2026"}'
check "перенос на другой день" 200 -X PATCH "$BASE/api/tasks/$ID" "${A[@]}" -d "{\"due_date\":\"$NEXT\"}"
NEW=$(curl -s --max-time 10 "${A[@]}" "$BASE/api/tasks/$ID" | json "['task']['due_date'][:10]")
[ "$NEW" = "$NEXT" ] && ok "новая дата сохранилась" || no "новая дата сохранилась (в базе $NEW)"
check "комментарий" 201 -X POST "$BASE/api/tasks/$ID/comments" "${A[@]}" -d '{"text":"[smoke] комментарий"}'
check "подзадача" 201 -X POST "$BASE/api/tasks" "${A[@]}" -d "{\"name\":\"[smoke] подзадача\",\"due_date\":\"$NEXT\",\"parent_id\":\"$ID\",\"assignee_id\":\"$ME\"}"

echo "Архив и корзина"
check "завершение" 200 -X PATCH "$BASE/api/tasks/$ID" "${A[@]}" -d '{"archived":true}'
curl -s --max-time 10 "${A[@]}" "$BASE/api/tasks?archived=1" | grep -q "$ID" && ok "задача в архиве" || no "задача в архиве"
check "возврат в работу" 200 -X PATCH "$BASE/api/tasks/$ID" "${A[@]}" -d '{"archived":false}'
check "удаление в корзину" 200 -X DELETE "$BASE/api/tasks/$ID" "${A[@]}"
curl -s --max-time 10 "${A[@]}" "$BASE/api/tasks?deleted=1" | grep -q "$ID" && ok "задача в корзине" || no "задача в корзине"
check "возврат из корзины" 200 -X POST "$BASE/api/tasks/$ID/restore" "${A[@]}"

echo "Метки, люди, вложения"
TAG=$(curl -s --max-time 10 -X POST "$BASE/api/tags" "${A[@]}" -d '{"name":"[smoke] метка","color_key":"blue"}' | json "['tag']['id']")
[ -n "${TAG:-}" ] && ok "создание метки" || no "создание метки"
check "метка на задаче" 200 -X PUT "$BASE/api/tasks/$ID/tags" "${A[@]}" -d "{\"tag_ids\":[\"$TAG\"]}"
check "список людей" 200 "$BASE/api/users" "${A[@]}"
check "делегированные" 200 "$BASE/api/tasks/authored" "${A[@]}"
echo "[smoke] вложение" > /tmp/smoke-file.txt
AID=$(curl -s --max-time 20 -X POST "$BASE/api/tasks/$ID/attachments" -H "Authorization: Bearer $TOKEN" -F "file=@/tmp/smoke-file.txt" | json "['attachment']['id']")
[ -n "${AID:-}" ] && ok "загрузка вложения" || no "загрузка вложения"
[ -n "${AID:-}" ] && check "скачивание вложения" 200 "$BASE/api/attachments/$AID/download" "${A[@]}"
[ -n "${AID:-}" ] && check "удаление вложения" 200 -X DELETE "$BASE/api/attachments/$AID" "${A[@]}"
[ -n "${TAG:-}" ] && curl -s -o /dev/null --max-time 10 -X DELETE "$BASE/api/tags/$TAG" "${A[@]}"

echo "Уборка за собой"
for tid in $(curl -s --max-time 10 "${A[@]}" "$BASE/api/tasks" | python3 -c "
import sys,json
for t in json.load(sys.stdin)['tasks']:
    if t['name'].startswith('[smoke]'): print(t['id'])"); do
  curl -s -o /dev/null --max-time 10 -X DELETE "$BASE/api/tasks/$tid?purge=1" "${A[@]}"
done
ok "тестовые задачи стёрты"

echo
echo "Итог: успешно $OK, провалов $BAD"
[ "$BAD" = 0 ] || exit 1
