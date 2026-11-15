#!/usr/bin/env bash
# АДРЕС, ЛОГИН И ПАРОЛЬ ПЕРВОГО ВХОДА. Запуск в папке Таски (там, где docker-compose.yml и .env):
#   bash scripts/first-login.sh
#
# При первом запуске Таска сама заводит администратора и придумывает ему пароль. Пароль лежит
# в записке api/.first-login (права 0600, в git не попадает) — этот скрипт её показывает.
# Если Таска ещё запускается, скрипт ждёт её до 5 минут.
#
# Ответ при успехе — ровно три строки, код 0:
#   Адрес вашей Таски: https://203-0-113-10.sslip.io
#   Логин: admin
#   Пароль: xxxx-xxxx-xxxx
# Код 3 — записки нет или пароль из неё больше не подходит (его сменили, базу вернули из копии) —
#         записка тогда стирается, объяснение в stderr.
# Код 1 — не та папка или Таска не поднялась.
# Сменили пароль в профиле — записка стирается сама: хранить старый пароль незачем.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
[ -f docker-compose.yml ] && [ -f .env ] || { echo "Нет docker-compose.yml или .env — запустите скрипт в папке Таски" >&2; exit 1; }
[ -n "$(docker compose ps -q api 2>/dev/null)" ] || { echo "Таска не запущена — сначала: docker compose up -d" >&2; exit 1; }

api_up(){ docker compose exec -T api node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; }
if ! api_up; then
  echo "Жду, пока Таска запустится (при первом запуске — минута-две)…" >&2
  for _ in $(seq 1 150); do api_up && break; sleep 2; done
  api_up || { echo "Таска не ответила за 5 минут — посмотрите журнал: docker compose logs api --tail 50" >&2; exit 1; }
fi
exec docker compose exec -T api node_modules/.bin/tsx src/demo-cli.ts show
