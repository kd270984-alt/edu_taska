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
#         записка тогда стирается; в stderr — почему и что делать.
# Код 4 — три строки напечатаны, но записку сохранить не удалось: перепишите пароль сейчас.
# Код 1 — не та папка или Таска не поднялась.
# Сменили пароль в профиле — записка стирается сама: хранить старый пароль незачем.
# Записку при запуске сохранить не удалось (кончился диск и т. п.) — тогда пароль один раз попал в журнал api:
# скрипт сам передаёт строки ADMIN_BOOTSTRAP из журнала в demo-cli, тот сверяет пароль с базой и, если он
# действует, печатает те же три строки и перекладывает пароль в записку (независимая проверка 16.11).
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
# «|| true»: строк в журнале нет — не ошибка (иначе pipefail отдал бы код grep вместо кода show)
{ docker compose logs api --no-log-prefix 2>/dev/null | grep -a 'ADMIN_BOOTSTRAP' | tail -n 50 || true; } \
  | docker compose exec -T api node_modules/.bin/tsx src/demo-cli.ts show --log
