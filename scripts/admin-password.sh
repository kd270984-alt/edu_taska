#!/usr/bin/env bash
# НОВЫЙ ПАРОЛЬ АДМИНИСТРАТОРУ, НИЧЕГО НЕ СТИРАЯ (проверка 16.11). Запуск в папке Таски:
#   bash scripts/admin-password.sh               — спросит «да/нет» и задаст новый пароль admin
#   bash scripts/admin-password.sh --yes         — без вопроса (для помощника — только после «да» человека)
#   bash scripts/admin-password.sh <логин> --yes — другому администратору (например, при DEMO_SEED=0)
# Без логина: admin, а если такого нет — ADMIN_EMAIL из .env.
#
# Когда нужен: пароль администратора потерян, а записки первого входа уже нет (first-login.sh — код 3).
# Люди, задачи, комментарии и вложения остаются как были. Прежний пароль перестаёт действовать, и все
# открытые входы под этим логином (другие устройства, посторонний) обрываются на следующем же запросе.
# Новый пароль кладётся в ту же записку api/.first-login, что и при первом запуске.
#
# Ответ при успехе — ровно три строки, код 0 (как у first-login.sh):
#   Адрес вашей Таски: https://203-0-113-10.sslip.io
#   Логин: admin
#   Пароль: xxxx-xxxx-xxxx
# Код 3 — ничего не изменено: нет такого администратора, он выключен, нет подтверждения (почему — в stderr).
# Код 4 — пароль задан, три строки напечатаны, но записку сохранить не удалось: перепишите пароль сейчас.
# Код 1 — не та папка или Таска не поднялась; код 2 — непонятный ключ.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
[ -f docker-compose.yml ] && [ -f .env ] || { echo "Нет docker-compose.yml или .env — запустите скрипт в папке Таски" >&2; exit 1; }

YES=0; LOGIN=""
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    -*) echo "непонятный ключ: $a (есть только --yes)" >&2; exit 2 ;;
    *) LOGIN="$a" ;;
  esac
done

# учётка агента из .env — ей пароль здесь не меняют (у неё свой скрипт agent-account.sh)
AGENT=$({ grep -E '^AGENT_EMAIL=' .env || true; } | tail -1 | cut -d= -f2- | sed -E 's/(^|[[:space:]])#.*$//' | tr -d ' "\r')
AGENT="${AGENT:-agent@taska.local}"

[ -n "$(docker compose ps -q api 2>/dev/null)" ] || { echo "Таска не запущена — сначала: docker compose up -d" >&2; exit 1; }
api_up(){ docker compose exec -T api node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; }
if ! api_up; then
  echo "Жду, пока Таска запустится (при первом запуске — минута-две)…" >&2
  for _ in $(seq 1 150); do api_up && break; sleep 2; done
  api_up || { echo "Таска не ответила за 5 минут — посмотрите журнал: docker compose logs api --tail 50" >&2; exit 1; }
fi
cli(){ docker compose exec -T -e KEEP_EMAIL="$AGENT" api node_modules/.bin/tsx src/demo-cli.ts "$@"; }

# кому — узнаём заранее, ничего не меняя (отказ — код 3, причина уже в stderr)
WHO=$(cli password-check "$LOGIN"); RC=$?
[ "$RC" = 0 ] || exit "$RC"

Q="Задать администратору $WHO новый пароль? Прежний пароль перестанет действовать, все открытые входы под $WHO (на всех устройствах) закроются. Люди, задачи и вложения не меняются."
if [ "$YES" != 1 ]; then
  if [ -t 0 ]; then
    read -r -p "$Q [да/нет] " ans
    case "$ans" in д|да|Да|ДА|y|Y|yes) ;; *) echo "Отменено, ничего не изменено." >&2; exit 3 ;; esac
  else
    echo "$Q" >&2
    echo "Ничего не изменено." >&2
    echo "Помощник: остановитесь и сами не подтверждайте. Спросите человека, согласен ли он сменить пароль администратора $WHO; только после его «да» повторите: bash scripts/admin-password.sh${LOGIN:+ $LOGIN} --yes" >&2
    exit 3
  fi
fi

cli password "$WHO"
